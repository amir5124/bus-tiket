const { query } = require('../config/db');
const { asyncHandler, ok, getPagination, buildMeta } = require('../utils/helpers');

/** Daftar semua vendor (dengan filter status) untuk verifikasi admin */
const listVendors = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPagination(req);
  const { status, q } = req.query;

  const conds = ['1=1'];
  const params = [];
  let i = 1;
  if (status) { conds.push(`v.status = $${i++}`); params.push(status); }
  if (q) { conds.push(`(v.name LIKE $${i} OR v.code LIKE $${i})`); params.push(`%${q}%`); i++; }
  const where = conds.join(' AND ');

  const { rows } = await query(
    `SELECT v.*, u.username AS owner_username, u.full_name AS owner_name,
            (SELECT COUNT(*) FROM vehicles WHERE vendor_id = v.id) AS vehicle_count
     FROM vendors v JOIN app_users u ON u.id = v.owner_user_id
     WHERE ${where} ORDER BY v.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await query(`SELECT COUNT(*) FROM vendors v WHERE ${where}`, params);

  ok(res, rows, buildMeta(page, limit, countRows[0].count));
});

/** Detail vendor + armada, bank account, staff */
const getVendorDetail = asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM v_vendor_profile WHERE vendor_id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });

  const { rows: vehicles } = await query(
    `SELECT v.*, (SELECT url FROM vehicle_photos WHERE vehicle_id = v.id AND is_cover LIMIT 1) AS cover_photo
     FROM vehicles v WHERE v.vendor_id = $1 ORDER BY v.created_at DESC`,
    [req.params.id]
  );
  const { rows: banks } = await query(`SELECT * FROM vendor_bank_accounts WHERE vendor_id = $1`, [req.params.id]);
  const { rows: members } = await query(
    `SELECT vm.role, u.username, u.full_name, u.phone FROM vendor_members vm
     JOIN app_users u ON u.id = vm.user_id WHERE vm.vendor_id = $1`,
    [req.params.id]
  );

  ok(res, { ...rows[0], vehicles, bank_accounts: banks, members });
});

/** Verifikasi / setujui vendor pending -> active */
const approveVendor = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE vendors SET status = 'active', verified_at = now(), verified_by = $2
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [req.params.id, req.adminUserRowId]
  );
  if (!rows.length) return res.status(400).json({ success: false, message: 'Vendor tidak dalam status pending' });
  ok(res, rows[0]);
});

/** Tolak vendor pending */
const rejectVendor = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const { rows } = await query(
    `UPDATE vendors SET status = 'rejected', rejected_reason = $2
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [req.params.id, reason || null]
  );
  if (!rows.length) return res.status(400).json({ success: false, message: 'Vendor tidak dalam status pending' });
  ok(res, rows[0]);
});

/** Suspend vendor aktif (mis. pelanggaran) */
const suspendVendor = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE vendors SET status = 'suspended' WHERE id = $1 AND status = 'active' RETURNING *`,
    [req.params.id]
  );
  if (!rows.length) return res.status(400).json({ success: false, message: 'Vendor tidak dalam status active' });
  ok(res, rows[0]);
});

/** Monitoring seluruh armada (semua vendor) - untuk QC / audit admin */
const listAllVehicles = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPagination(req);
  const { vendor_id, vehicle_type, is_active, q } = req.query;

  const conds = ['1=1'];
  const params = [];
  let i = 1;
  if (vendor_id) { conds.push(`v.vendor_id = $${i++}`); params.push(vendor_id); }
  if (vehicle_type) { conds.push(`v.vehicle_type = $${i++}`); params.push(vehicle_type); }
  if (is_active !== undefined) { conds.push(`v.is_active = $${i++}`); params.push(is_active === 'true'); }
  if (q) { conds.push(`(v.name LIKE $${i} OR v.plate_number LIKE $${i})`); params.push(`%${q}%`); i++; }
  const where = conds.join(' AND ');

  const { rows } = await query(
    `SELECT v.*, vd.name AS vendor_name, vd.status AS vendor_status,
            (SELECT url FROM vehicle_photos WHERE vehicle_id = v.id AND is_cover LIMIT 1) AS cover_photo,
            (SELECT COUNT(*) FROM vehicle_photos WHERE vehicle_id = v.id) AS photo_count
     FROM vehicles v JOIN vendors vd ON vd.id = v.vendor_id
     WHERE ${where} ORDER BY v.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM vehicles v WHERE ${where}`, params
  );

  ok(res, rows, buildMeta(page, limit, countRows[0].count));
});

/** Monitoring transaksi (semua vendor) */
const listTransactions = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPagination(req);
  const { status, vendor_id, date_from, date_to, q } = req.query;

  const conds = ['1=1'];
  const params = [];
  let i = 1;
  if (status) { conds.push(`booking_status = $${i++}`); params.push(status); }
  if (vendor_id) { conds.push(`vendor_id = $${i++}`); params.push(vendor_id); }
  if (date_from) { conds.push(`created_at >= $${i++}`); params.push(date_from); }
  if (date_to) { conds.push(`created_at <= $${i++}`); params.push(date_to); }
  if (q) { conds.push(`(booking_code LIKE $${i} OR order_no LIKE $${i} OR contact_name LIKE $${i})`); params.push(`%${q}%`); i++; }
  const where = conds.join(' AND ');

  const { rows } = await query(
    `SELECT * FROM v_admin_transactions WHERE ${where} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await query(`SELECT COUNT(*) FROM v_admin_transactions WHERE ${where}`, params);

  ok(res, rows, buildMeta(page, limit, countRows[0].count));
});

/** Ringkasan harian (dashboard grafik) */
const dailySummary = asyncHandler(async (req, res) => {
  const { date_from, date_to } = req.query;
  const conds = [];
  const params = [];
  let i = 1;
  if (date_from) { conds.push(`trx_date >= $${i++}`); params.push(date_from); }
  if (date_to) { conds.push(`trx_date <= $${i++}`); params.push(date_to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT * FROM v_admin_daily_summary ${where} ORDER BY trx_date DESC LIMIT 90`, params
  );
  ok(res, rows);
});

/** Penjualan per vendor (leaderboard) */
const vendorSales = asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM v_vendor_sales ORDER BY gross_amount DESC`);
  ok(res, rows);
});

/** Daftar refund yang butuh ditinjau */
const listRefunds = asyncHandler(async (req, res) => {
  const { status = 'requested' } = req.query;
  const { rows } = await query(
    `SELECT r.*, b.booking_code, b.contact_name, b.vendor_id, v.name AS vendor_name
     FROM refunds r JOIN bookings b ON b.id = r.booking_id JOIN vendors v ON v.id = b.vendor_id
     WHERE r.status = $1 ORDER BY r.requested_at`,
    [status]
  );
  ok(res, rows);
});

/** Proses refund (approve/reject) */
const reviewRefund = asyncHandler(async (req, res) => {
  const { action } = req.body; // 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(action)) {
    return res.status(400).json({ success: false, message: "action harus 'approved' atau 'rejected'" });
  }
  const { rows } = await query(
    `UPDATE refunds SET status = $2, reviewed_by = $3, processed_at = now()
     WHERE id = $1 AND status = 'requested' RETURNING *`,
    [req.params.id, action, req.adminUserRowId]
  );
  if (!rows.length) return res.status(400).json({ success: false, message: 'Refund tidak dalam status requested' });

  if (action === 'approved') {
    await query(`UPDATE bookings SET status = 'refunded' WHERE id = $1`, [rows[0].booking_id]);
  }
  ok(res, rows[0]);
});

/** Log audit untuk investigasi */
const listAuditLogs = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPagination(req);
  const { entity, entity_id } = req.query;
  const conds = ['1=1'];
  const params = [];
  let i = 1;
  if (entity) { conds.push(`entity = $${i++}`); params.push(entity); }
  if (entity_id) { conds.push(`entity_id = $${i++}`); params.push(entity_id); }
  const where = conds.join(' AND ');

  const { rows } = await query(
    `SELECT * FROM audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await query(`SELECT COUNT(*) FROM audit_logs WHERE ${where}`, params);
  ok(res, rows, buildMeta(page, limit, countRows[0].count));
});

module.exports = {
  listVendors, getVendorDetail, approveVendor, rejectVendor, suspendVendor,
  listAllVehicles, listTransactions, dailySummary, vendorSales,
  listRefunds, reviewRefund, listAuditLogs,
};
