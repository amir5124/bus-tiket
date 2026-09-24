const { query } = require('../config/db');
const { asyncHandler, ok } = require('../utils/helpers');

/**
 * GET /api/admin/vendors?status=pending&page=1&limit=20
 */
const listVendors = asyncHandler(async (req, res) => {
    const { status, search, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const conds = [];
    const params = [];

    if (status) {
        conds.push('v.status = ?');
        params.push(status);
    }
    if (search) {
        conds.push('(v.name LIKE ? OR v.code LIKE ? OR u.username LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const { rows } = await query(
        `SELECT v.id, v.code, v.name, v.legal_name, v.status,
            v.contact_phone, v.contact_email, v.address,
            v.created_at, v.verified_at, v.rejected_reason,
            u.username AS owner_username, u.full_name AS owner_name,
            (SELECT COUNT(*) FROM vehicles WHERE vendor_id = v.id) AS vehicles_count,
            (SELECT COUNT(*) FROM schedules WHERE vendor_id = v.id) AS schedules_count
       FROM vendors v
       JOIN app_users u ON u.id = v.owner_user_id
       ${where}
       ORDER BY
         CASE v.status
           WHEN 'pending' THEN 1
           WHEN 'active' THEN 2
           ELSE 3
         END,
         v.created_at DESC
       LIMIT ${Number(limit)} OFFSET ${offset}`,
        params
    );

    ok(res, rows);
});

/**
 * GET /api/admin/vendors/:id
 */
const getVendorDetail = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { rows: vendorRows } = await query(
        `SELECT v.*, u.username AS owner_username, u.full_name AS owner_name,
            u.email AS owner_email, u.phone AS owner_phone
       FROM vendors v
       JOIN app_users u ON u.id = v.owner_user_id
      WHERE v.id = ? LIMIT 1`,
        [id]
    );
    if (!vendorRows.length) {
        return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });
    }

    const { rows: bankRows } = await query(
        `SELECT * FROM vendor_bank_accounts WHERE vendor_id = ?`, [id]
    );
    const { rows: memberRows } = await query(
        `SELECT vm.*, u.username, u.full_name
       FROM vendor_members vm
       JOIN app_users u ON u.id = vm.user_id
      WHERE vm.vendor_id = ?`, [id]
    );

    ok(res, { ...vendorRows[0], bank_accounts: bankRows, members: memberRows });
});

/**
 * PATCH /api/admin/vendors/:id/approve
 */
const approveVendor = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { rows } = await query(
        `SELECT id, status FROM vendors WHERE id = ? LIMIT 1`, [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });

    await query(
        `UPDATE vendors
        SET status = 'active',
            verified_at = NOW(),
            verified_by = ?,
            rejected_reason = NULL
      WHERE id = ?`,
        [req.adminUserRowId || null, id]
    );

    ok(res, { approved: true, vendor_id: Number(id) });
});

/**
 * PATCH /api/admin/vendors/:id/reject
 * Body: { reason }
 */
const rejectVendor = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body || {};

    await query(
        `UPDATE vendors
        SET status = 'rejected',
            rejected_reason = ?,
            verified_at = NOW(),
            verified_by = ?
      WHERE id = ?`,
        [reason || 'Tidak memenuhi syarat', req.adminUserRowId || null, id]
    );

    ok(res, { rejected: true, vendor_id: Number(id) });
});

/**
 * PATCH /api/admin/vendors/:id/suspend
 * Body: { reason }
 */
const suspendVendor = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body || {};

    await query(
        `UPDATE vendors
        SET status = 'suspended',
            rejected_reason = ?
      WHERE id = ?`,
        [reason || 'Disuspend oleh admin', id]
    );

    ok(res, { suspended: true, vendor_id: Number(id) });
});

module.exports = { listVendors, getVendorDetail, approveVendor, rejectVendor, suspendVendor };