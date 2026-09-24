const { query } = require('../config/db');
const { asyncHandler, ok, created } = require('../utils/helpers');

/**
 * GET /api/vendors/:vendorId/routes
 */
const listVendorRoutes = asyncHandler(async (req, res) => {
    const { rows } = await query(
        `SELECT r.*,
            oc.name AS origin_city, dc.name AS destination_city,
            (SELECT COUNT(*) FROM schedules s WHERE s.route_id = r.id) AS schedules_count
       FROM routes r
       JOIN cities oc ON oc.id = r.origin_city_id
       JOIN cities dc ON dc.id = r.destination_city_id
      WHERE r.vendor_id = ?
      ORDER BY r.id DESC`,
        [req.vendorId]
    );
    ok(res, rows);
});

/**
 * POST /api/vendors/:vendorId/routes
 * Body: { origin_city_id, destination_city_id, name? }
 */
const createVendorRoute = asyncHandler(async (req, res) => {
    const { origin_city_id, destination_city_id, name } = req.body || {};

    if (!origin_city_id || !destination_city_id) {
        return res.status(400).json({
            success: false,
            message: 'origin_city_id dan destination_city_id wajib diisi'
        });
    }
    if (Number(origin_city_id) === Number(destination_city_id)) {
        return res.status(400).json({
            success: false,
            message: 'Kota asal dan tujuan tidak boleh sama'
        });
    }

    // Ambil nama kota untuk auto-name
    const { rows: cityRows } = await query(
        `SELECT id, name FROM cities WHERE id IN (?, ?)`,
        [origin_city_id, destination_city_id]
    );
    const originCity = cityRows.find(c => c.id === Number(origin_city_id));
    const destCity = cityRows.find(c => c.id === Number(destination_city_id));

    const finalName = name || `${originCity?.name || 'Kota'} - ${destCity?.name || 'Kota'}`;

    const result = await query(
        `INSERT INTO routes (vendor_id, origin_city_id, destination_city_id, name, is_active)
     VALUES (?, ?, ?, ?, 1)`,
        [req.vendorId, origin_city_id, destination_city_id, finalName]
    );

    const { rows } = await query(
        `SELECT r.*, oc.name AS origin_city, dc.name AS destination_city
       FROM routes r
       JOIN cities oc ON oc.id = r.origin_city_id
       JOIN cities dc ON dc.id = r.destination_city_id
      WHERE r.id = ?`,
        [result.insertId]
    );

    created(res, rows[0]);
});

/**
 * DELETE /api/vendors/:vendorId/routes/:id
 */
const deleteVendorRoute = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { rows: schedRows } = await query(
        `SELECT COUNT(*) AS n FROM schedules WHERE route_id = ?`,
        [id]
    );
    if (Number(schedRows[0].n) > 0) {
        return res.status(409).json({
            success: false,
            message: `Rute tidak bisa dihapus karena masih dipakai di ${schedRows[0].n} jadwal.`
        });
    }

    await query(`DELETE FROM routes WHERE id = ? AND vendor_id = ?`, [id, req.vendorId]);
    ok(res, { deleted: true, id: Number(id) });
});

module.exports = { listVendorRoutes, createVendorRoute, deleteVendorRoute };