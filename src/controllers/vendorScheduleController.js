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
 * POST /api/vendors/:vendorId/schedules
 * Handle sistem: commission / markup / topup
 */
const createVendorSchedule = asyncHandler(async (req, res) => {
    const vendorId = Number(req.vendorId);
    const {
        route_id, vehicle_id, pickup_stop_id, dropoff_stop_id,
        departure_at, arrival_at, price, original_price, discount_percent,
        insurance_available, insurance_product_id, direction, is_popular,
    } = req.body || {};

    if (!route_id || !vehicle_id || !departure_at || !price) {
        return res.status(400).json({
            success: false,
            message: 'route_id, vehicle_id, departure_at, price wajib diisi',
        });
    }

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

    // 3. Cek topup kalau sistem topup
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

    // 7. Hitung arrival_at
    let finalArrival = arrival_at;
    if (!finalArrival) {
        const depDate = new Date(String(departure_at).replace(' ', 'T'));
        depDate.setHours(depDate.getHours() + 3);
        finalArrival = depDate.toISOString().slice(0, 19).replace('T', ' ');
    }

    const scheduleCode = `SCH-${vendorId}-${Date.now()}`;

    // 8. Insert schedule dengan price = harga jual
    const result = await query(
        `INSERT INTO schedules
       (schedule_code, vendor_id, route_id, vehicle_id, direction,
        pickup_stop_id, dropoff_stop_id,
        departure_at, arrival_at, price, original_price, discount_percent,
        insurance_available, insurance_product_id,
        is_popular, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, NOW())`,
        [
            scheduleCode, vendorId, route_id, vehicle_id, direction || 'pergi',
            pickup_stop_id || null, dropoff_stop_id || null,
            departure_at, finalArrival,
            priceJual,                              // ← harga jual (setelah markup)
            original_price || null,
            discount_percent || 0,
            insurance_available ? 1 : 0,
            insurance_available ? (insurance_product_id || 1) : null,
            is_popular ? 1 : 0,
            req.user.id,
        ]
    );

    // 9. Seed kursi
    await query(
        `INSERT INTO schedule_seats (schedule_id, seat_number)
     SELECT ?, c.seat_number
       FROM vehicles v
       JOIN seat_layout_cells c
         ON c.layout_id = v.seat_layout_id AND c.cell_type = 'seat'
      WHERE v.id = ?`,
        [result.insertId, vehicle_id]
    );

    // 10. Update counter
    await query(
        `UPDATE schedules s
        SET s.seats_total = (SELECT COUNT(*) FROM schedule_seats WHERE schedule_id = s.id),
            s.seats_available = (SELECT COUNT(*) FROM schedule_seats WHERE schedule_id = s.id AND status = 'available')
      WHERE s.id = ?`,
        [result.insertId]
    );

    const { rows } = await query(`SELECT * FROM schedules WHERE id = ?`, [result.insertId]);
    created(res, {
        ...rows[0],
        _info: {
            payment_system: vendor.payment_system,
            price_vendor: priceVendor,
            price_customer: priceJual,
            markup_amount: markupAmount,
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
        'departure_at', 'arrival_at', 'price', 'original_price', 'discount_percent',
        'insurance_available', 'insurance_product_id', 'direction', 'is_popular',
    ];

    const sets = [];
    const values = [];
    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            sets.push(`${key} = ?`);
            values.push(req.body[key]);
        }
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

    // Cek vendor
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

module.exports = {
    listVendorSchedules,
    createVendorSchedule,
    updateVendorSchedule,
    deleteVendorSchedule,
    publishVendorSchedule,
};