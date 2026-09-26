const { query } = require('../config/db');
const { asyncHandler, ok } = require('../utils/helpers');

/**
 * GET /api/public/seat-templates?vehicle_type=bus
 * Daftar template kursi bawaan sistem.
 */
const listSeatTemplates = asyncHandler(async (req, res) => {
    const { vehicle_type } = req.query;
    const conds = ['is_active = 1'];
    const params = [];
    if (vehicle_type) {
        conds.push('vehicle_type = ?');
        params.push(vehicle_type);
    }

    const { rows } = await query(
        `SELECT id, code, name, vehicle_type, total_seats, \`rows\` AS row_count, cols AS col_count, grid
           FROM seat_layout_templates
          WHERE ${conds.join(' AND ')}
          ORDER BY vehicle_type, total_seats`,
        params
    );

    // Parse grid JSON (kalau driver MySQL balikin string)
    rows.forEach(r => {
        if (typeof r.grid === 'string') {
            try { r.grid = JSON.parse(r.grid); } catch (e) { r.grid = []; }
        }
    });

    ok(res, rows);
});

/**
 * GET /api/public/seat-templates/:code
 */
const getSeatTemplate = asyncHandler(async (req, res) => {
    const { code } = req.params;
    const { rows } = await query(
        `SELECT id, code, name, vehicle_type, total_seats, \`rows\` AS row_count, cols AS col_count, grid
           FROM seat_layout_templates
          WHERE code = ? AND is_active = 1 LIMIT 1`,
        [code]
    );
    if (!rows.length) {
        return res.status(404).json({ success: false, message: 'Template kursi tidak ditemukan' });
    }
    if (typeof rows[0].grid === 'string') {
        try { rows[0].grid = JSON.parse(rows[0].grid); } catch (e) { rows[0].grid = []; }
    }
    ok(res, rows[0]);
});

module.exports = { listSeatTemplates, getSeatTemplate };