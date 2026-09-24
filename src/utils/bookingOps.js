// src/utils/bookingOps.js
// Operasi kursi & status booking yang dikerjakan di Node (tidak butuh stored procedure / trigger).
// Jika database kamu SUDAH punya trigger di tabel bookings, notifikasi vendor dilewati di sini
// agar tidak dobel; sisanya idempoten sehingga aman dijalankan bersama trigger.
const db = require('../config/db');   // { query, pool }
const { query } = db;

const HOLD_MINUTES = 30;               // masa tahan kursi = masa berlaku pembayaran

async function withTx(fn) {
    const c = await db.pool.getConnection();
    try {
        await c.beginTransaction();
        const r = await fn(c);
        await c.commit();
        return r;
    } catch (e) {
        await c.rollback().catch(() => { });
        throw e;
    } finally {
        c.release();
    }
}

let dbTriggers = null;
async function dbHandlesTransitions() {
    if (dbTriggers === null) {
        const { rows } = await query(
            "SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'bookings'");
        dbTriggers = Number(rows[0].n) > 0;
    }
    return dbTriggers;
}

// hitung ulang sisa kursi jadwal
const syncSeatCount = (c, scheduleId) => c.query(
    `UPDATE schedules SET seats_available =
     (SELECT COUNT(*) FROM schedule_seats WHERE schedule_id = ? AND status = 'available') WHERE id = ?`,
    [scheduleId, scheduleId]);

// tahan kursi; false jika ada kursi yang sudah diambil. Panggil di dalam transaksi.
async function holdSeats(c, scheduleId, seatNumbers, bookingId) {
    const [free] = await c.query(
        `SELECT id FROM schedule_seats
      WHERE schedule_id = ? AND seat_number IN (?)
        AND (status = 'available' OR (status = 'held' AND held_until < NOW()))
      FOR UPDATE`, [scheduleId, seatNumbers]);
    if (free.length !== seatNumbers.length) return false;
    await c.query(
        `UPDATE schedule_seats SET status = 'held', held_until = NOW() + INTERVAL ${HOLD_MINUTES} MINUTE,
            held_by_booking_id = ? WHERE id IN (?)`, [bookingId, free.map((r) => r.id)]);
    await syncSeatCount(c, scheduleId);
    return true;
}

async function releaseSeats(c, bookingId, scheduleId) {
    await c.query(
        `UPDATE schedule_seats SET status = 'available', held_until = NULL, held_by_booking_id = NULL
      WHERE held_by_booking_id = ? AND status IN ('held','booked')`, [bookingId]);
    await syncSeatCount(c, scheduleId);
}

// notifikasi ke semua anggota vendor sesuai channel pilihan mereka (best effort, tidak pernah menggagalkan transaksi)
async function notifyVendor(vendorId, type, title, body, data = {}) {
    try {
        if (await dbHandlesTransitions()) return;
        await query(
            `INSERT INTO notifications (recipient_user_id, vendor_id, type, channel, title, body, data)
       SELECT m.user_id, ?, ?, c.ch, ?, ?, ?
         FROM vendor_members m
         JOIN (SELECT 'in_app' AS ch UNION ALL SELECT 'push' UNION ALL SELECT 'email' UNION ALL SELECT 'whatsapp') c
           ON FIND_IN_SET(c.ch, m.notify_channels) > 0
        WHERE m.vendor_id = ? AND m.notify_enabled = 1`,
            [vendorId, type, title, body, JSON.stringify(data), vendorId]);
    } catch (e) { console.error('[notifyVendor]', e.message); }
}

// pembayaran diterima -> booking paid, kursi booked, komisi dihitung, vendor diberi tahu
async function settlePaid(bookingId) {
    let b;
    const res = await withTx(async (c) => {
        const [[row]] = await c.query(
            `SELECT id, vendor_id, schedule_id, booking_code, contact_name, seats_count, status
         FROM bookings WHERE id = ? FOR UPDATE`, [bookingId]);
        b = row;
        if (!b) return { ok: false, reason: 'not_found' };
        if (['paid', 'completed'].includes(b.status)) return { ok: true, already: true };
        if (b.status !== 'pending_payment') return { ok: false, reason: `booking_${b.status}` };
        const [mine] = await c.query(
            `SELECT id FROM schedule_seats WHERE held_by_booking_id = ? AND status IN ('held','booked') FOR UPDATE`, [bookingId]);
        if (mine.length !== Number(b.seats_count)) return { ok: false, reason: 'seats_lost' };  // kursi sudah dilepas/dijual lagi
        await c.query(
            `UPDATE bookings bk JOIN vendors v ON v.id = bk.vendor_id
          SET bk.status = 'paid', bk.paid_at = NOW(),
              bk.commission_amount = ROUND(bk.ticket_subtotal * v.commission_percent / 100)
        WHERE bk.id = ?`, [bookingId]);
        await c.query(`UPDATE schedule_seats SET status = 'booked', held_until = NULL WHERE held_by_booking_id = ?`, [bookingId]);
        await syncSeatCount(c, b.schedule_id);
        return { ok: true };
    });
    if (res.ok && !res.already)
        await notifyVendor(b.vendor_id, 'payment_paid', 'Pembayaran diterima ' + b.booking_code,
            `${b.seats_count} kursi lunas atas nama ${b.contact_name}.`, { booking_id: b.id, booking_code: b.booking_code });
    return res;
}

// batalkan pesanan yang belum dibayar & lepas kursinya
async function cancelPending(b, reason) {
    const done = await withTx(async (c) => {
        const [r] = await c.query(
            `UPDATE bookings SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = ?
        WHERE id = ? AND status = 'pending_payment'`, [reason, b.id]);
        if (!r.affectedRows) return false;
        await releaseSeats(c, b.id, b.schedule_id);
        return true;
    });
    if (done) await notifyVendor(b.vendor_id, 'booking_cancelled', 'Pesanan dibatalkan ' + b.booking_code,
        reason, { booking_id: b.id, booking_code: b.booking_code });
    return done;
}

// tandai pesanan kedaluwarsa & lepas kursi yang masa tahannya habis
async function expireStale() {
    const { rows } = await query(
        "SELECT id, schedule_id FROM bookings WHERE status = 'pending_payment' AND expires_at < NOW() LIMIT 200");
    for (const b of rows) {
        await withTx(async (c) => {
            const [r] = await c.query("UPDATE bookings SET status = 'expired' WHERE id = ? AND status = 'pending_payment'", [b.id]);
            if (r.affectedRows) await releaseSeats(c, b.id, b.schedule_id);
        });
    }
    const { rows: orphan } = await query("SELECT DISTINCT schedule_id FROM schedule_seats WHERE status = 'held' AND held_until < NOW()");
    if (orphan.length) {
        await query("UPDATE schedule_seats SET status = 'available', held_until = NULL, held_by_booking_id = NULL WHERE status = 'held' AND held_until < NOW()");
        for (const o of orphan) await syncSeatCount(db.pool, o.schedule_id);
    }
    return rows.length;
}

// panggil sekali di server.js:  require('./utils/bookingOps').startExpiryJob();
function startExpiryJob(ms = 60000) {
    const t = setInterval(() => expireStale().catch((e) => console.error('[expireStale]', e.message)), ms);
    t.unref();
    return t;
}

module.exports = { HOLD_MINUTES, withTx, holdSeats, releaseSeats, notifyVendor, settlePaid, cancelPending, expireStale, startExpiryJob };