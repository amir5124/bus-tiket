const { query } = require('../config/db');
const { asyncHandler, ok, created } = require('../utils/helpers');

/* =====================================================================
 * Helper: hitung arrival_at dari departure_at + duration
 * ===================================================================== */
function computeArrival(departureAt, durationMin) {
    const dur = Math.max(30, Math.min(Number(durationMin) || 180, 1440));
    const depDate = new Date(String(departureAt).replace(' ', 'T'));
    if (isNaN(depDate)) throw new Error('Format departure_at tidak valid');
    const arrDate = new Date(depDate.getTime() + dur * 60000);
    return arrDate.toISOString().slice(0, 19).replace('T', ' ');
}

/* =====================================================================
 * Helper: ambil seat list dari seat_config / kendaraan
 * ===================================================================== */
async function resolveSeatList(vehicleId, seatConfig) {
    let seatList = [];

    if (seatConfig && seatConfig.type === 'custom') {
        if (Array.isArray(seatConfig.rows) && seatConfig.rows.length) {
            for (const r of seatConfig.rows) {
                for (const cell of (r.cells || [])) {
                    if (cell == null || cell === '' || cell === 'driver' || cell === 'empty') continue;
                    seatList.push(String(cell));
                }
            }
        } else if (Array.isArray(seatConfig.seats) && seatConfig.seats.length) {
            seatList = seatConfig.seats.map(String).filter(Boolean);
        }
    } else if (seatConfig && seatConfig.type === 'template' && seatConfig.template_id) {
        const { rows: tplRows } = await query(
            `SELECT grid FROM seat_layout_templates WHERE id = ? AND is_active = 1 LIMIT 1`,
            [seatConfig.template_id]
        );
        if (tplRows.length) {
            let grid = tplRows[0].grid;
            if (typeof grid === 'string') {
                try { grid = JSON.parse(grid); } catch (e) { grid = []; }
            }
            for (const row of (grid || [])) {
                for (const cell of (row.cells || [])) {
                    if (cell == null || cell === '' || cell === 'driver' || cell === 'empty') continue;
                    seatList.push(String(cell));
                }
            }
        }
    } else {
        // Default: dari seat_layout kendaraan
        const { rows: layoutRows } = await query(
            `SELECT c.seat_number FROM vehicles v
               JOIN seat_layout_cells c
                 ON c.layout_id = v.seat_layout_id AND c.cell_type = 'seat'
              WHERE v.id = ?
              ORDER BY c.row_no, c.col_no`,
            [vehicleId]
        );
        seatList = layoutRows.map(r => r.seat_number);
    }

    return seatList;
}

/* =====================================================================
 * GET /api/vendors/:vendorId/schedule-templates
 * ===================================================================== */
const listTemplates = asyncHandler(async (req, res) => {
    const { rows } = await query(
        `SELECT st.*,
                r.name AS route_name,
                oc.name AS origin_city, dc.name AS destination_city,
                v.name AS vehicle_name, v.class_name,
                (SELECT COUNT(*) FROM schedules WHERE template_id = st.id) AS generated_count
           FROM schedule_templates st
           JOIN routes r ON r.id = st.route_id
           JOIN cities oc ON oc.id = r.origin_city_id
           JOIN cities dc ON dc.id = r.destination_city_id
           JOIN vehicles v ON v.id = st.vehicle_id
          WHERE st.vendor_id = ?
          ORDER BY st.is_active DESC, st.departure_time, st.id DESC`,
        [req.vendorId]
    );
    ok(res, rows);
});

/* =====================================================================
 * POST /api/vendors/:vendorId/schedule-templates
 * ===================================================================== */
const createTemplate = asyncHandler(async (req, res) => {
    const vendorId = Number(req.vendorId);
    const {
        route_id, vehicle_id, direction = 'pergi',
        pickup_stop_id, dropoff_stop_id,
        departure_time, duration_minutes = 180,
        price, original_price, discount_percent = 0,
        insurance_available = 0, insurance_product_id = null,
        is_popular = 0,
        seat_config = null,
        days_of_week = '1,2,3,4,5,6,7',
        active_from, active_until = null,
        generate_days_ahead = 30,
    } = req.body || {};

    if (!route_id || !vehicle_id || !departure_time || !price || !active_from) {
        return res.status(400).json({
            success: false,
            message: 'route_id, vehicle_id, departure_time, price, active_from wajib',
        });
    }
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(String(departure_time))) {
        return res.status(400).json({ success: false, message: 'Format departure_time: HH:mm' });
    }

    // Cek vendor
    const { rows: vRows } = await query(
        `SELECT id, status, payment_system, topup_active_until FROM vendors WHERE id = ? LIMIT 1`,
        [vendorId]
    );
    if (!vRows.length) return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });
    const vendor = vRows[0];
    if (vendor.status !== 'active') {
        return res.status(403).json({ success: false, message: 'Vendor belum aktif' });
    }
    if (vendor.payment_system === 'topup') {
        const until = vendor.topup_active_until ? new Date(vendor.topup_active_until) : null;
        if (!until || until < new Date()) {
            return res.status(403).json({ success: false, message: 'Topup expired', need_topup: true });
        }
    }

    // Validasi route & vehicle
    const { rows: routeRows } = await query(
        `SELECT id FROM routes WHERE id = ? AND vendor_id = ?`, [route_id, vendorId]);
    if (!routeRows.length) return res.status(404).json({ success: false, message: 'Rute tidak ditemukan' });

    const { rows: vehRows } = await query(
        `SELECT id FROM vehicles WHERE id = ? AND vendor_id = ? AND is_active = 1`, [vehicle_id, vendorId]);
    if (!vehRows.length) return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });

    const result = await query(
        `INSERT INTO schedule_templates
           (vendor_id, route_id, vehicle_id, direction, pickup_stop_id, dropoff_stop_id,
            departure_time, duration_minutes, price, original_price, discount_percent,
            insurance_available, insurance_product_id, is_popular,
            seat_config, days_of_week, active_from, active_until, generate_days_ahead, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            vendorId, route_id, vehicle_id, direction,
            pickup_stop_id || null, dropoff_stop_id || null,
            departure_time, Number(duration_minutes) || 180,
            Number(price), original_price || null, Number(discount_percent) || 0,
            insurance_available ? 1 : 0, insurance_product_id || null, is_popular ? 1 : 0,
            seat_config ? JSON.stringify(seat_config) : null,
            days_of_week,
            active_from, active_until || null,
            Number(generate_days_ahead) || 30,
            req.user.id,
        ]
    );

    const { rows } = await query(`SELECT * FROM schedule_templates WHERE id = ?`, [result.insertId]);
    created(res, rows[0]);
});

/* =====================================================================
 * PUT /api/vendors/:vendorId/schedule-templates/:id
 * ===================================================================== */
const updateTemplate = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const allowed = [
        'route_id', 'vehicle_id', 'direction', 'pickup_stop_id', 'dropoff_stop_id',
        'departure_time', 'duration_minutes', 'price', 'original_price', 'discount_percent',
        'insurance_available', 'insurance_product_id', 'is_popular',
        'days_of_week', 'active_from', 'active_until', 'generate_days_ahead', 'is_active',
    ];
    const sets = [], values = [];
    for (const k of allowed) {
        if (req.body[k] !== undefined) {
            sets.push(`${k} = ?`);
            values.push(req.body[k]);
        }
    }
    // Handle seat_config separately (JSON)
    if (req.body.seat_config !== undefined) {
        sets.push('seat_config = ?');
        values.push(req.body.seat_config ? JSON.stringify(req.body.seat_config) : null);
    }

    if (!sets.length) return res.status(400).json({ success: false, message: 'Tidak ada field diupdate' });

    values.push(id, req.vendorId);
    await query(
        `UPDATE schedule_templates SET ${sets.join(', ')} WHERE id = ? AND vendor_id = ?`,
        values
    );

    const { rows } = await query(
        `SELECT * FROM schedule_templates WHERE id = ? AND vendor_id = ?`, [id, req.vendorId]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Template tidak ditemukan' });
    ok(res, rows[0]);
});

/* =====================================================================
 * DELETE /api/vendors/:vendorId/schedule-templates/:id
 * ===================================================================== */
const deleteTemplate = asyncHandler(async (req, res) => {
    await query(
        `DELETE FROM schedule_templates WHERE id = ? AND vendor_id = ?`,
        [req.params.id, req.vendorId]
    );
    ok(res, { deleted: true });
});

/* =====================================================================
 * POST /api/vendors/:vendorId/schedule-templates/:id/generate
 * Body: { days_ahead?: 30, reset?: false }
 *
 * Generate jadwal dari template untuk N hari ke depan.
 * Kalau jadwal dengan template_id + departure_at sama sudah ada, skip.
 * ===================================================================== */
const generateFromTemplate = asyncHandler(async (req, res) => {
    const vendorId = Number(req.vendorId);
    const templateId = Number(req.params.id);
    const daysAhead = Math.min(Math.max(Number(req.body?.days_ahead) || 0, 0), 90);

    const { rows: tRows } = await query(
        `SELECT * FROM schedule_templates WHERE id = ? AND vendor_id = ? LIMIT 1`,
        [templateId, vendorId]
    );
    if (!tRows.length) return res.status(404).json({ success: false, message: 'Template tidak ditemukan' });
    const tpl = tRows[0];
    if (!tpl.is_active) return res.status(400).json({ success: false, message: 'Template tidak aktif' });

    const days = daysAhead || tpl.generate_days_ahead || 30;
    const allowedDays = new Set(String(tpl.days_of_week || '1,2,3,4,5,6,7').split(',').map(s => Number(s.trim())));

    const pad = n => String(n).padStart(2, '0');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const activeFrom = new Date(tpl.active_from + 'T00:00:00');
    const activeUntil = tpl.active_until ? new Date(tpl.active_until + 'T23:59:59') : null;

    // Resolve seat list sekali (biar cepat)
    let seatConfig = tpl.seat_config;
    if (typeof seatConfig === 'string') {
        try { seatConfig = JSON.parse(seatConfig); } catch (e) { seatConfig = null; }
    }
    const seatList = await resolveSeatList(tpl.vehicle_id, seatConfig);
    if (!seatList.length) {
        return res.status(400).json({
            success: false,
            message: 'Tidak ada kursi untuk di-seed. Cek seat config / layout kendaraan.',
        });
    }

    let generated = 0, skipped = 0;
    const generatedIds = [];

    for (let i = 0; i < days; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() + i);

        if (d < activeFrom) { skipped++; continue; }
        if (activeUntil && d > activeUntil) break;

        const dow = d.getDay() === 0 ? 7 : d.getDay();   // 1=Senin...7=Minggu
        if (!allowedDays.has(dow)) { skipped++; continue; }

        const dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        const [hh, mm] = String(tpl.departure_time).split(':');
        const depAt = `${dateStr} ${pad(hh)}:${pad(mm)}:00`;

        // Cek existing (biar idempoten)
        const { rows: exist } = await query(
            `SELECT id FROM schedules
              WHERE vendor_id = ? AND route_id = ? AND vehicle_id = ?
                AND departure_at = ? LIMIT 1`,
            [vendorId, tpl.route_id, tpl.vehicle_id, depAt]
        );
        if (exist.length) { skipped++; continue; }

        const arrAt = computeArrival(depAt, tpl.duration_minutes);
        const code = `SCH-${vendorId}-${Date.now()}-${i}-${tpl.id}`;

        try {
            const r = await query(
                `INSERT INTO schedules
                   (schedule_code, vendor_id, route_id, vehicle_id, direction,
                    pickup_stop_id, dropoff_stop_id,
                    departure_at, arrival_at, duration_minutes,
                    price, original_price, discount_percent,
                    insurance_available, insurance_product_id,
                    is_popular, status, created_by, template_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, NOW())`,
                [
                    code, vendorId, tpl.route_id, tpl.vehicle_id, tpl.direction || 'pergi',
                    tpl.pickup_stop_id, tpl.dropoff_stop_id,
                    depAt, arrAt, Number(tpl.duration_minutes) || 180,
                    tpl.price, tpl.original_price, tpl.discount_percent,
                    tpl.insurance_available, tpl.insurance_product_id,
                    tpl.is_popular,
                    tpl.created_by, tpl.id,
                ]
            );
            const newId = r.insertId;

            // Seed kursi
            if (seatList.length) {
                const placeholders = seatList.map(() => '(?, ?)').join(', ');
                const flat = seatList.flatMap(sn => [newId, sn]);
                await query(
                    `INSERT INTO schedule_seats (schedule_id, seat_number) VALUES ${placeholders}`,
                    flat
                );
            }
            // Update counter
            await query(
                `UPDATE schedules s
                    SET s.seats_total = (SELECT COUNT(*) FROM schedule_seats WHERE schedule_id = s.id),
                        s.seats_available = (SELECT COUNT(*) FROM schedule_seats WHERE schedule_id = s.id AND status = 'available')
                  WHERE s.id = ?`,
                [newId]
            );

            generated++;
            generatedIds.push(newId);
        } catch (e) {
            console.error('[generate-template] gagal insert', depAt, e.message);
        }
    }

    res.json({
        success: true,
        message: `${generated} jadwal berhasil digenerate, ${skipped} dilewati`,
        data: { generated, skipped, schedule_ids: generatedIds },
    });
});

module.exports = {
    listTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    generateFromTemplate,
};