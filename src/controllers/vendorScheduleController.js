const { query } = require('../config/db');
const { asyncHandler, ok, created } = require('../utils/helpers');

/**
 * GET /api/vendors/:vendorId/schedules
 */
const listVendorSchedules = asyncHandler(async (req, res) => {
    const { status, limit = 50, offset = 0 } = req.query;

    const conds = ['s.vendor_id = ?'];
    const params = [req.vendorId];
    if (status) {
        conds.push('s.status = ?');
        params.push(status);
    }

    const { rows } = await query(
        `SELECT s.*,
            r.name AS route_name,
            oc.name AS origin_city, dc.name AS destination_city,
            v.name AS vehicle_name, v.class_name, v.capacity,
            ps.name AS pickup_point, ds.name AS dropoff_point
       FROM schedules s
       JOIN routes r   ON r.id = s.route_id
       JOIN cities oc  ON oc.id = r.origin_city_id
       JOIN cities dc  ON dc.id = r.destination_city_id
       JOIN vehicles v ON v.id = s.vehicle_id
       LEFT JOIN stops ps ON ps.id = s.pickup_stop_id
       LEFT JOIN stops ds ON ds.id = s.dropoff_stop_id
      WHERE ${conds.join(' AND ')}
      ORDER BY s.departure_at DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
        params
    );
    ok(res, rows);
});

/**
 * Hitung arrival_at dari departure_at + duration_minutes.
 * @param {string} departureAt - 'YYYY-MM-DD HH:mm:ss'
 * @param {number} durationMin - menit (min 30, max 1440)
 * @returns {string} 'YYYY-MM-DD HH:mm:ss'
 */
function computeArrival(departureAt, durationMin) {
    const dur = Math.max(30, Math.min(Number(durationMin) || 180, 1440));
    const depDate = new Date(String(departureAt).replace(' ', 'T'));
    if (isNaN(depDate)) throw new Error('Format departure_at tidak valid');
    const arrDate = new Date(depDate.getTime() + dur * 60000);
    return arrDate.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * POST /api/vendors/:vendorId/schedules
 * Body: { ..., departure_at, duration_minutes, seat_config? }
 *
 * seat_config (opsional, untuk override denah kursi):
 *   - { type: 'layout' }                      → pakai seat_layout_id kendaraan (default)
 *   - { type: 'custom', seats: ['1A','1B'] }  → custom seat numbers
 *   - { type: 'custom', rows: [               → custom grid (lebih detail)
 *       { row: 1, cells: ['1A', '1B'] },
 *       { row: 2, cells: ['2A', '2B'] },
 *     ]}
 */
const createVendorSchedule = asyncHandler(async (req, res) => {
    const vendorId = Number(req.vendorId);
    const {
        route_id, vehicle_id, pickup_stop_id, dropoff_stop_id,
        departure_at, duration_minutes,
        price, original_price, discount_percent,
        insurance_available, insurance_product_id, direction, is_popular,
        seat_config,
    } = req.body || {};

    if (!route_id || !vehicle_id || !departure_at || !price) {
        return res.status(400).json({
            success: false,
            message: 'route_id, vehicle_id, departure_at, price wajib diisi',
        });
    }

    const durationMin = Math.max(30, Math.min(Number(duration_minutes) || 180, 1440));

    // 1. Ambil data vendor
    const { rows: vendors } = await query(
        `SELECT id, payment_system, markup_percent, status, topup_active_until
       FROM vendors WHERE id = ? LIMIT 1`,
        [vendorId]
    );
    if (!vendors.length) {
        return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });
    }
    const vendor = vendors[0];

    // 2. Cek status vendor
    if (vendor.status !== 'active') {
        return res.status(403).json({
            success: false,
            message: `Vendor belum aktif (status: ${vendor.status})`,
        });
    }

    // 3. Cek topup
    if (vendor.payment_system === 'topup') {
        const activeUntil = vendor.topup_active_until ? new Date(vendor.topup_active_until) : null;
        if (!activeUntil || activeUntil < new Date()) {
            return res.status(403).json({
                success: false,
                message: 'Masa aktif topup habis. Silakan perpanjang topup untuk upload jadwal.',
                topup_active_until: vendor.topup_active_until,
            });
        }
    }

    // 4. Hitung harga jual
    const priceVendor = Number(price);
    let priceJual = priceVendor;
    let markupAmount = 0;
    if (vendor.payment_system === 'markup') {
        const markupPct = Number(vendor.markup_percent) || 0;
        markupAmount = Math.round(priceVendor * markupPct / 100);
        priceJual = priceVendor + markupAmount;
    }

    // 5. Validasi route
    const { rows: routeRows } = await query(
        `SELECT id FROM routes WHERE id = ? AND vendor_id = ?`,
        [route_id, vendorId]
    );
    if (!routeRows.length) {
        return res.status(404).json({ success: false, message: 'Rute tidak ditemukan' });
    }

    // 6. Validasi vehicle
    const { rows: vehRows } = await query(
        `SELECT id, capacity, seat_layout_id FROM vehicles
          WHERE id = ? AND vendor_id = ? AND is_active = 1`,
        [vehicle_id, vendorId]
    );
    if (!vehRows.length) {
        return res.status(404).json({ success: false, message: 'Armada tidak ditemukan / nonaktif' });
    }
    const vehicle = vehRows[0];

    // 7. Hitung arrival_at
    let finalArrival;
    try {
        finalArrival = computeArrival(departure_at, durationMin);
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
    }

    // 8. Tentukan seat list (untuk seed schedule_seats)
    //    Prioritas: seat_config custom → seat_layout kendaraan
    let seatList = [];

    if (seat_config && seat_config.type === 'custom') {
        // Custom dari rows
        if (Array.isArray(seat_config.rows) && seat_config.rows.length) {
            for (const r of seat_config.rows) {
                if (!Array.isArray(r.cells)) continue;
                for (const cell of r.cells) {
                    // Skip cell yang bukan seat (kosong, driver)
                    if (cell == null || cell === '' || cell === 'driver' || cell === 'empty') continue;
                    seatList.push(String(cell));
                }
            }
        }
        // Custom dari seats array langsung
        else if (Array.isArray(seat_config.seats) && seat_config.seats.length) {
            seatList = seat_config.seats.map(String).filter(Boolean);
        }

        if (!seatList.length) {
            return res.status(400).json({
                success: false,
                message: 'seat_config custom harus berisi minimal 1 kursi',
            });
        }
    } else {
        // Pakai seat_layout dari kendaraan (perilaku default)
        const { rows: layoutRows } = await query(
            `SELECT c.seat_number FROM vehicles v
               JOIN seat_layout_cells c
                 ON c.layout_id = v.seat_layout_id AND c.cell_type = 'seat'
              WHERE v.id = ?
              ORDER BY c.row_no, c.col_no`,
            [vehicle_id]
        );
        seatList = layoutRows.map(r => r.seat_number);
    }

    if (!seatList.length) {
        return res.status(400).json({
            success: false,
            message: 'Tidak ada kursi untuk di-seed. Cek seat layout kendaraan atau seat_config.',
        });
    }

    const scheduleCode = `SCH-${vendorId}-${Date.now()}`;

    // 9. Insert schedule
    const result = await query(
        `INSERT INTO schedules
           (schedule_code, vendor_id, route_id, vehicle_id, direction,
            pickup_stop_id, dropoff_stop_id,
            departure_at, arrival_at, duration_minutes,
            price, original_price, discount_percent,
            insurance_available, insurance_product_id,
            is_popular, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, NOW())`,
        [
            scheduleCode, vendorId, route_id, vehicle_id, direction || 'pergi',
            pickup_stop_id || null, dropoff_stop_id || null,
            departure_at, finalArrival, durationMin,
            priceJual,
            original_price || null,
            discount_percent || 0,
            insurance_available ? 1 : 0,
            insurance_available ? (insurance_product_id || 1) : null,
            is_popular ? 1 : 0,
            req.user.id,
        ]
    );
    const scheduleId = result.insertId;

    // 10. Seed kursi (dari seatList yang sudah ditentukan)
    const values = seatList.map(sn => [scheduleId, sn]);
    await query(
        `INSERT INTO schedule_seats (schedule_id, seat_number) VALUES ?`,
        [values]
    );

    // 11. Update counter
    await query(
        `UPDATE schedules s
            SET s.seats_total = (SELECT COUNT(*) FROM schedule_seats WHERE schedule_id = s.id),
                s.seats_available = (SELECT COUNT(*) FROM schedule_seats WHERE schedule_id = s.id AND status = 'available')
          WHERE s.id = ?`,
        [scheduleId]
    );

    const { rows } = await query(`SELECT * FROM schedules WHERE id = ?`, [scheduleId]);
    created(res, {
        ...rows[0],
        _info: {
            payment_system: vendor.payment_system,
            price_vendor: priceVendor,
            price_customer: priceJual,
            markup_amount: markupAmount,
            seat_count: seatList.length,
            seat_source: seat_config?.type === 'custom' ? 'custom' : 'vehicle_layout',
        },
    });
});

/**
 * PUT /api/vendors/:vendorId/schedules/:id
 */
const updateVendorSchedule = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const allowed = [
        'route_id', 'vehicle_id', 'pickup_stop_id', 'dropoff_stop_id',
        'departure_at', 'duration_minutes', 'price', 'original_price', 'discount_percent',
        'insurance_available', 'insurance_product_id', 'direction', 'is_popular',
    ];

    // Ambil existing dulu untuk recompute arrival_at
    const { rows: existing } = await query(
        `SELECT departure_at, arrival_at, duration_minutes FROM schedules
          WHERE id = ? AND vendor_id = ? LIMIT 1`,
        [id, req.vendorId]
    );
    if (!existing.length) {
        return res.status(404).json({ success: false, message: 'Jadwal tidak ditemukan' });
    }

    const sets = [];
    const values = [];

    // Kalau departure_at atau duration_minutes berubah → recompute arrival_at
    const depChanged = req.body.departure_at !== undefined;
    const durChanged = req.body.duration_minutes !== undefined;

    if (depChanged || durChanged) {
        const newDep = depChanged ? req.body.departure_at : existing[0].departure_at;
        const newDur = durChanged ? Number(req.body.duration_minutes) : Number(existing[0].duration_minutes);

        let computedArrival;
        try {
            computedArrival = computeArrival(newDep, newDur);
        } catch (e) {
            return res.status(400).json({ success: false, message: e.message });
        }

        // Set duration_minutes kalau berubah
        if (durChanged) {
            sets.push('duration_minutes = ?');
            values.push(Math.max(30, Math.min(newDur, 1440)));
        }

        // Set arrival_at (selalu recompute)
        sets.push('arrival_at = ?');
        values.push(computedArrival);
    }

    for (const key of allowed) {
        // Skip departure_at & duration_minutes karena sudah di-handle di atas
        if (key === 'departure_at' || key === 'duration_minutes') continue;
        if (req.body[key] !== undefined) {
            sets.push(`${key} = ?`);
            values.push(req.body[key]);
        }
    }

    // Handle departure_at (setelah arrival_at & duration_minutes)
    if (depChanged) {
        sets.push('departure_at = ?');
        values.push(req.body.departure_at);
    }

    if (!sets.length) {
        return res.status(400).json({ success: false, message: 'Tidak ada field untuk diupdate' });
    }

    values.push(id, req.vendorId);
    await query(
        `UPDATE schedules SET ${sets.join(', ')} WHERE id = ? AND vendor_id = ?`,
        values
    );

    const { rows } = await query(
        `SELECT * FROM schedules WHERE id = ? AND vendor_id = ?`,
        [id, req.vendorId]
    );
    if (!rows.length) {
        return res.status(404).json({ success: false, message: 'Jadwal tidak ditemukan' });
    }
    ok(res, rows[0]);
});

/**
 * DELETE /api/vendors/:vendorId/schedules/:id
 */
const deleteVendorSchedule = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { rows: bkRows } = await query(
        `SELECT COUNT(*) AS n FROM bookings
          WHERE schedule_id = ? AND status IN ('paid','completed')`,
        [id]
    );
    if (Number(bkRows[0].n) > 0) {
        return res.status(409).json({
            success: false,
            message: 'Jadwal tidak bisa dihapus karena sudah ada booking yang dibayar.',
        });
    }

    await query(`DELETE FROM schedule_seats WHERE schedule_id = ?`, [id]);
    await query(`DELETE FROM schedules WHERE id = ? AND vendor_id = ?`, [id, req.vendorId]);

    ok(res, { deleted: true, id: Number(id) });
});

/**
 * POST /api/vendors/:vendorId/schedules/:id/publish
 */
const publishVendorSchedule = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { rows } = await query(
        `SELECT id, status FROM schedules WHERE id = ? AND vendor_id = ?`,
        [id, req.vendorId]
    );
    if (!rows.length) {
        return res.status(404).json({ success: false, message: 'Jadwal tidak ditemukan' });
    }

    const { rows: vendors } = await query(
        `SELECT id, status, payment_system, topup_active_until
           FROM vendors WHERE id = ? LIMIT 1`,
        [req.vendorId]
    );
    const vendor = vendors[0];

    if (vendor.status !== 'active') {
        return res.status(403).json({
            success: false,
            message: `Vendor belum aktif (status: ${vendor.status}).`,
        });
    }

    if (vendor.payment_system === 'topup') {
        const activeUntil = vendor.topup_active_until ? new Date(vendor.topup_active_until) : null;
        if (!activeUntil || activeUntil < new Date()) {
            return res.status(403).json({
                success: false,
                message: 'Masa aktif topup habis. Lakukan topup Rp 50.000 untuk publish jadwal.',
                need_topup: true,
                topup_active_until: vendor.topup_active_until,
            });
        }
    }

    await query(
        `UPDATE schedules SET status = 'published', published_at = NOW() WHERE id = ?`,
        [id]
    );

    ok(res, { published: true, id: Number(id) });
});

/* =====================================================================
 * CLONE SCHEDULE — duplikat jadwal lama ke tanggal baru
 * POST /api/vendors/:vendorId/schedules/:id/clone
 * Body: { departure_at: '2026-09-27 08:00:00', duration_minutes?: 180 }
 *
 * Semua config dari jadwal sumber disalin. Kursi di-seed ulang
 * (fresh, semua available).
 * ===================================================================== */
const cloneVendorSchedule = asyncHandler(async (req, res) => {
    const vendorId = Number(req.vendorId);
    const srcId = Number(req.params.id);
    const { departure_at, duration_minutes } = req.body || {};

    if (!departure_at) {
        return res.status(400).json({ success: false, message: 'departure_at wajib diisi' });
    }
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(String(departure_at).trim())) {
        return res.status(400).json({ success: false, message: 'Format departure_at: YYYY-MM-DD HH:mm' });
    }

    // 1. Ambil jadwal sumber
    const { rows: srcRows } = await query(
        `SELECT * FROM schedules WHERE id = ? AND vendor_id = ? LIMIT 1`,
        [srcId, vendorId]
    );
    if (!srcRows.length) {
        return res.status(404).json({ success: false, message: 'Jadwal sumber tidak ditemukan' });
    }
    const src = srcRows[0];

    // 2. Cek vendor
    const { rows: vendorRows } = await query(
        `SELECT id, status, payment_system, topup_active_until FROM vendors WHERE id = ? LIMIT 1`,
        [vendorId]
    );
    const vendor = vendorRows[0];
    if (!vendor || vendor.status !== 'active') {
        return res.status(403).json({ success: false, message: 'Vendor belum aktif' });
    }
    if (vendor.payment_system === 'topup') {
        const until = vendor.topup_active_until ? new Date(vendor.topup_active_until) : null;
        if (!until || until < new Date()) {
            return res.status(403).json({
                success: false,
                message: 'Topup expired. Perpanjang dulu.',
                need_topup: true,
            });
        }
    }

    // 3. Tentukan durasi & arrival_at
    //    Prioritas: duration_minutes dari body → duration_minutes dari src → fallback hitung dari selisih src
    let durMin = Number(duration_minutes);
    if (!Number.isFinite(durMin) || durMin <= 0) {
        durMin = Number(src.duration_minutes);
    }
    if (!Number.isFinite(durMin) || durMin <= 0) {
        // Fallback: hitung dari selisih arrival - departure src
        durMin = Math.round(
            (new Date(String(src.arrival_at).replace(' ', 'T')) -
                new Date(String(src.departure_at).replace(' ', 'T'))) / 60000
        );
    }
    durMin = Math.max(30, Math.min(durMin || 180, 1440));

    let finalArrival;
    try {
        finalArrival = computeArrival(departure_at, durMin);
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
    }

    const newCode = `SCH-${vendorId}-${Date.now()}`;

    // 4. Insert jadwal baru
    const insertResult = await query(
        `INSERT INTO schedules
           (schedule_code, vendor_id, route_id, vehicle_id, direction,
            pickup_stop_id, dropoff_stop_id,
            departure_at, arrival_at, duration_minutes,
            price, original_price, discount_percent,
            insurance_available, insurance_product_id,
            is_popular, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, NOW())`,
        [
            newCode, vendorId, src.route_id, src.vehicle_id, src.direction || 'pergi',
            src.pickup_stop_id, src.dropoff_stop_id,
            departure_at, finalArrival, durMin,
            src.price, src.original_price, src.discount_percent,
            src.insurance_available, src.insurance_product_id,
            src.is_popular,
            req.user.id,
        ]
    );
    const newId = insertResult.insertId;

    // 5. Copy seat dari jadwal sumber (seat_number-nya saja)
    //    Biar konsisten kalau ada custom seat di jadwal sumber
    const { rows: srcSeats } = await query(
        `SELECT seat_number FROM schedule_seats WHERE schedule_id = ? ORDER BY id`,
        [srcId]
    );

    if (srcSeats.length) {
        const values = srcSeats.map(r => [newId, r.seat_number]);
        await query(
            `INSERT INTO schedule_seats (schedule_id, seat_number) VALUES ?`,
            [values]
        );
    } else {
        // Fallback: pakai seat_layout kendaraan
        await query(
            `INSERT INTO schedule_seats (schedule_id, seat_number)
             SELECT ?, c.seat_number
               FROM vehicles v
               JOIN seat_layout_cells c
                 ON c.layout_id = v.seat_layout_id AND c.cell_type = 'seat'
              WHERE v.id = ?`,
            [newId, src.vehicle_id]
        );
    }

    // 6. Update counter
    await query(
        `UPDATE schedules s
            SET s.seats_total = (SELECT COUNT(*) FROM schedule_seats WHERE schedule_id = s.id),
                s.seats_available = (SELECT COUNT(*) FROM schedule_seats WHERE schedule_id = s.id AND status = 'available')
          WHERE s.id = ?`,
        [newId]
    );

    // 7. Copy T&C
    try {
        await query(
            `INSERT INTO schedule_terms (schedule_id, section, items, sort_order)
             SELECT ?, section, items, sort_order FROM schedule_terms WHERE schedule_id = ?`,
            [newId, srcId]
        );
    } catch (e) {
        console.warn('[clone] gagal copy schedule_terms:', e.message);
    }

    const { rows: createdRows } = await query(`SELECT * FROM schedules WHERE id = ?`, [newId]);
    res.status(201).json({ success: true, data: createdRows[0] });
});

module.exports = {
    listVendorSchedules,
    createVendorSchedule,
    updateVendorSchedule,
    deleteVendorSchedule,
    publishVendorSchedule,
    cloneVendorSchedule,
};