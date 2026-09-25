const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/db');          // perlu mengekspor { query, pool } (mysql2/promise)
const { query } = db;
const { asyncHandler, ok } = require('../utils/helpers');
const bookingOps = require('../utils/bookingOps');

const HOLD_MINUTES = 30;   // masa tahan kursi = masa berlaku pembayaran
const fail = (status, message) => Object.assign(new Error(message), { status });
const bad = (res, status, message) => res.status(status).json({ success: false, message });

/* ---------- login opsional: token dari /api/auth/jagel ---------- */
const attachUser = asyncHandler(async (req, res, next) => {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) {
        let userId = null;
        try { userId = jwt.verify(h.slice(7), process.env.JWT_SECRET).userId; } catch (e) { /* token salah = tamu */ }
        if (userId) {
            const { rows } = await query(
                'SELECT id, username, full_name, phone, email FROM app_users WHERE id = ? AND is_active = 1', [userId]);
            if (rows[0]) req.user = rows[0];
        }
    }
    next();
});
const requireLogin = (req, res, next) => (req.user ? next() : bad(res, 401, 'Login diperlukan'));

/* ---------- validasi body ---------- */
function validate(b) {
    const err = [];
    const c = b.contact || {};
    const seats = Array.isArray(b.seats) ? b.seats.map(String) : [];
    const ps = Array.isArray(b.passengers) ? b.passengers : [];
    if (!(Number(b.schedule_id) >= 1)) err.push('schedule_id tidak valid');
    if (!seats.length || seats.length > 10 || new Set(seats).size !== seats.length || seats.some((s) => !s || s.length > 5))
        err.push('seats harus berisi 1-10 nomor kursi unik');
    if (!['Tuan', 'Nyonya', 'Nona'].includes(c.title)) err.push('contact.title harus Tuan/Nyonya/Nona');
    if (String(c.name || '').trim().length < 3) err.push('contact.name minimal 3 karakter');
    if (!/^\+?\d{9,15}$/.test(String(c.phone || '').replace(/[\s-]/g, ''))) err.push('contact.phone tidak valid');
    if (!/^\S+@\S+\.\S+$/.test(String(c.email || ''))) err.push('contact.email tidak valid');
    if (ps.length !== seats.length || new Set(ps.map((p) => String(p.seat))).size !== ps.length ||
        ps.some((p) => String(p.name || '').trim().length < 2 || !seats.includes(String(p.seat))))
        err.push('passengers harus satu per kursi, dengan name dan seat yang sesuai');
    if (b.terms_accepted !== true) err.push('terms_accepted harus true');
    return { err, seats, ps };
}

/* ---------- baca booking lengkap ---------- */
async function loadBooking(code) {
    const { rows } = await query(
        `SELECT b.id, b.booking_code, b.order_no, b.status, b.user_id, b.contact_title, b.contact_name,
            b.contact_phone, b.contact_email, b.seats_count, b.ticket_subtotal, b.insurance_total,
            b.discount_total, b.fee_total, b.total_amount, b.has_insurance, b.expires_at, b.paid_at, b.created_at,
            s.departure_at, s.arrival_at, s.cancel_before_hours,
            (s.departure_at > NOW() + INTERVAL s.cancel_before_hours HOUR) AS refundable,
            v.name AS vendor_name, veh.class_name, oc.name AS origin_city, dc.name AS destination_city
       FROM bookings b
       JOIN schedules s ON s.id = b.schedule_id
       JOIN vendors v ON v.id = b.vendor_id
       JOIN vehicles veh ON veh.id = s.vehicle_id
       JOIN routes r ON r.id = s.route_id
       JOIN cities oc ON oc.id = r.origin_city_id
       JOIN cities dc ON dc.id = r.destination_city_id
      WHERE b.booking_code = ? LIMIT 1`, [code]);
    const b = rows[0];
    if (!b) return null;
    const p = await query(
        `SELECT passenger_no, full_name, seat_number, ticket_code, insurance_selected, checked_in_at
       FROM booking_passengers WHERE booking_id = ? ORDER BY passenger_no`, [b.id]);
    const pay = await query(
        `SELECT p.id,
                p.amount,
                p.status          AS payment_status,
                p.va_number,
                p.qr_string,
                p.gateway_ref     AS payment_reff,
                p.expires_at      AS expired_date,
                p.paid_at         AS payment_date,
                pm.code           AS payment_method_code,
                pm.name           AS payment_method
           FROM payments p
           LEFT JOIN payment_methods pm ON pm.id = p.method_id
          WHERE p.booking_id = ?
          ORDER BY p.id DESC`, [b.id]);
    b.passengers = p.rows;
    b.payments = pay.rows;
    b.refundable = !!b.refundable;
    return b;
}

// pemilik (login) atau tamu yang menyertakan email pemesan
const canAccess = (req, b, email) =>
    (req.user && b.user_id === req.user.id) ||
    (email && String(email).toLowerCase() === String(b.contact_email).toLowerCase());
const publicView = ({ user_id, ...rest }) => rest;

/* ---------- POST /api/bookings ---------- */
const createBooking = asyncHandler(async (req, res) => {
    const b = req.body || {};
    const { err, seats, ps } = validate(b);
    if (err.length) return bad(res, 400, err.join('; '));
    const scheduleId = Number(b.schedule_id), n = seats.length, c = b.contact;

    const conn = await db.pool.getConnection();
    let bookingCode;
    try {
        await conn.beginTransaction();

        // ✅ Ambil discount_percent dari schedules
        const [[s]] = await conn.query(
            `SELECT s.id, s.vendor_id, s.price, s.original_price, s.discount_percent,
                    s.insurance_available, s.insurance_product_id,
                    ip.price_per_passenger
               FROM schedules s
               JOIN vendors v ON v.id = s.vendor_id AND v.status = 'active'
               LEFT JOIN insurance_products ip ON ip.id = s.insurance_product_id AND ip.is_active = 1
              WHERE s.id = ? AND s.status = 'published' AND s.departure_at > NOW()`, [scheduleId]);
        if (!s) throw fail(404, 'Jadwal tidak ditemukan atau sudah tidak tersedia');

        const wantIns = b.insurance === true;
        if (wantIns && !(s.insurance_available && s.price_per_passenger))
            throw fail(400, 'Jadwal ini tidak menyediakan asuransi');

        const [seatRows] = await conn.query(
            'SELECT id, seat_number FROM schedule_seats WHERE schedule_id = ? AND seat_number IN (?)',
            [scheduleId, seats]);
        if (seatRows.length !== n) throw fail(400, 'Ada nomor kursi yang tidak valid');

        // ============================================================
        // HITUNG HARGA (server-side)
        // ============================================================
        const unit = Number(s.price);                                       // harga jual per kursi
        const insTotal = wantIns ? Number(s.price_per_passenger) * n : 0;

        const ticketSubtotal = unit * n;                                    // subtotal tiket
        const discPct = Number(s.discount_percent) || 0;                    // diskon dari DB
        const discountTotal = Math.round(ticketSubtotal * discPct / 100);   // diskon Rp

        // total_amount TIDAK dihitung di sini — MySQL hitung otomatis dari:
        //   (ticket_subtotal + insurance_total) - discount_total + fee_total
        // fee_total default 0, jadi total_amount = ticketSubtotal + insTotal - discountTotal

        console.log(`[BOOKING] unit=${unit} x ${n} | subtotal=${ticketSubtotal} | disc=${discPct}% (${discountTotal}) | ins=${insTotal} | total(excl. fee)=${ticketSubtotal + insTotal - discountTotal}`);

        let bookingId = null;
        for (let i = 0; i < 3 && !bookingId; i++) {
            const code = 'BT' + Date.now().toString(36).toUpperCase() + crypto.randomInt(0, 46656).toString(36).toUpperCase().padStart(3, '0');
            const order = String(crypto.randomInt(1000000000, 9999999999));
            try {
                // ✅ total_amount TIDAK dimasukkan ke INSERT (generated column)
                const [ins] = await conn.query(
                    `INSERT INTO bookings (booking_code, order_no, user_id, buyer_username, schedule_id, vendor_id,
                        contact_title, contact_name, contact_phone, contact_email, seats_count,
                        ticket_subtotal, insurance_total, discount_total,
                        has_insurance, insurance_product_id,
                        terms_accepted, terms_accepted_at, status, expires_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NOW(),'pending_payment',NOW() + INTERVAL ${HOLD_MINUTES} MINUTE)`,
                    [
                        code, order, req.user?.id || null, req.user?.username || null,
                        scheduleId, s.vendor_id,
                        c.title, c.name.trim(), String(c.phone).replace(/[\s-]/g, ''), c.email.trim(), n,
                        ticketSubtotal, insTotal, discountTotal,
                        wantIns ? 1 : 0, wantIns ? s.insurance_product_id : null,
                    ]);
                bookingId = ins.insertId;
                bookingCode = code;
            } catch (e) {
                if (e.code !== 'ER_DUP_ENTRY' || i === 2) throw e;
            }
        }

        // tahan kursi (anti double-booking)
        const okHold = await bookingOps.holdSeats(conn, scheduleId, seats, bookingId);
        if (!okHold) throw fail(409, 'Kursi sudah dipesan orang lain, silakan pilih kursi lain');

        const rows = ps.map((p, i) => [
            bookingId, i + 1, String(p.name).trim(),
            seatRows.find((r) => r.seat_number === String(p.seat)).id, String(p.seat),
            wantIns ? 1 : 0, wantIns ? Number(s.price_per_passenger) : 0, `${bookingCode}-${i + 1}`,
        ]);
        await conn.query(
            `INSERT INTO booking_passengers (booking_id, passenger_no, full_name, schedule_seat_id, seat_number,
                insurance_selected, insurance_price, ticket_code) VALUES ?`, [rows]);

        await conn.commit();
    } catch (e) {
        await conn.rollback();
        if (e.status) return bad(res, e.status, e.message);
        throw e;
    } finally {
        conn.release();
    }
    res.status(201).json({ success: true, data: publicView(await loadBooking(bookingCode)) });
});

/* ---------- GET /api/bookings (pesanan saya) ---------- */
const myBookings = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const okStatus = ['pending_payment', 'paid', 'cancelled', 'expired', 'refunded', 'completed'];
    const st = okStatus.includes(req.query.status) ? req.query.status : null;
    const { rows } = await query(
        `SELECT b.booking_code, b.order_no, b.status, b.seats_count, b.total_amount, b.expires_at, b.created_at,
            s.departure_at, v.name AS vendor_name, oc.name AS origin_city, dc.name AS destination_city
       FROM bookings b
       JOIN schedules s ON s.id = b.schedule_id JOIN vendors v ON v.id = b.vendor_id
       JOIN routes r ON r.id = s.route_id JOIN cities oc ON oc.id = r.origin_city_id JOIN cities dc ON dc.id = r.destination_city_id
      WHERE b.user_id = ? ${st ? 'AND b.status = ?' : ''}
      ORDER BY b.created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        st ? [req.user.id, st] : [req.user.id]);
    ok(res, rows);
});

/* ---------- GET /api/bookings/:code ---------- */
const getBooking = asyncHandler(async (req, res) => {
    const b = await loadBooking(req.params.code);
    if (!b) return bad(res, 404, 'Booking tidak ditemukan');
    if (!canAccess(req, b, req.query.email)) return bad(res, 403, 'Tidak punya akses ke booking ini');
    ok(res, publicView(b));
});

/* ---------- POST /api/bookings/:code/cancel (belum dibayar) ---------- */
const cancelBooking = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const b = await loadBooking(req.params.code);
    if (!b) return bad(res, 404, 'Booking tidak ditemukan');
    if (!canAccess(req, b, body.email || req.query.email)) return bad(res, 403, 'Tidak punya akses ke booking ini');
    if (b.status !== 'pending_payment') return bad(res, 409, 'Hanya pesanan yang belum dibayar yang bisa dibatalkan. Untuk pesanan lunas ajukan refund.');
    await query(
        "UPDATE bookings SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = ? WHERE id = ? AND status = 'pending_payment'",
        [String(body.reason || 'Dibatalkan pembeli').slice(0, 250), b.id]);
    ok(res, publicView(await loadBooking(b.booking_code)));
});

/* ---------- POST /api/bookings/:code/refund (sudah dibayar) ---------- */
const requestRefund = asyncHandler(async (req, res) => {
    const b = await loadBooking(req.params.code);
    if (!b) return bad(res, 404, 'Booking tidak ditemukan');
    if (!canAccess(req, b, null)) return bad(res, 403, 'Tidak punya akses ke booking ini');
    if (b.status !== 'paid') return bad(res, 409, 'Refund hanya untuk pesanan yang sudah dibayar');
    if (!b.refundable) return bad(res, 409, `Batas refund (${b.cancel_before_hours} jam sebelum berangkat) sudah lewat`);
    const dup = await query("SELECT id FROM refunds WHERE booking_id = ? AND status IN ('requested','approved','processed')", [b.id]);
    if (dup.rows.length) return bad(res, 409, 'Permintaan refund sudah pernah diajukan');
    await query('INSERT INTO refunds (booking_id, amount, reason, requested_by) VALUES (?,?,?,?)',
        [b.id, b.total_amount, String((req.body || {}).reason || 'Permintaan pembeli').slice(0, 250), req.user.id]);
    ok(res, { message: 'Permintaan refund diajukan dan menunggu persetujuan' });
});

module.exports = { attachUser, requireLogin, createBooking, myBookings, getBooking, cancelBooking, requestRefund };