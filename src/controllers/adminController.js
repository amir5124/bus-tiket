const { query } = require('../config/db');
const { asyncHandler, ok, getPagination, buildMeta } = require('../utils/helpers');

/* =====================================================================
 * VENDOR MANAGEMENT
 * ===================================================================== */

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
       FROM vendors v
       JOIN app_users u ON u.id = v.owner_user_id
      WHERE ${where}
      ORDER BY v.created_at DESC
      LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );

  const { rows: countRows } = await query(
    `SELECT COUNT(*) AS count FROM vendors v WHERE ${where}`,
    params
  );

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
  const { rows: banks } = await query(
    `SELECT * FROM vendor_bank_accounts WHERE vendor_id = $1`,
    [req.params.id]
  );
  const { rows: members } = await query(
    `SELECT vm.role, u.username, u.full_name, u.phone
       FROM vendor_members vm
       JOIN app_users u ON u.id = vm.user_id
      WHERE vm.vendor_id = $1`,
    [req.params.id]
  );

  ok(res, { ...rows[0], vehicles, bank_accounts: banks, members });
});

/** Verifikasi / setujui vendor pending -> active */
const approveVendor = asyncHandler(async (req, res) => {
  const vendorId = Number(req.params.id);
  if (!vendorId) return res.status(400).json({ success: false, message: 'ID vendor tidak valid' });

  console.log('[approveVendor] vendorId =', vendorId, 'adminUserRowId =', req.adminUserRowId);

  // 1. Cek status
  const { rows: check } = await query(
    `SELECT id, status FROM vendors WHERE id = ? LIMIT 1`,
    [vendorId]
  );
  console.log('[approveVendor] check =', JSON.stringify(check));

  if (!check.length) {
    return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });
  }
  if (check[0].status !== 'pending') {
    return res.status(400).json({
      success: false,
      message: `Vendor tidak dalam status pending (saat ini: ${check[0].status})`
    });
  }

  // 2. Update — TANPA RETURNING *
  const adminId = req.adminUserRowId ? Number(req.adminUserRowId) : null;
  const upd = await query(
    `UPDATE vendors
        SET status = 'active',
            verified_at = NOW(),
            verified_by = ?,
            rejected_reason = NULL
      WHERE id = ? AND status = 'pending'`,
    [adminId, vendorId]
  );
  console.log('[approveVendor] updateResult =', JSON.stringify(upd));

  // 3. SELECT ulang
  const { rows } = await query(
    `SELECT * FROM vendors WHERE id = ? LIMIT 1`,
    [vendorId]
  );
  console.log('[approveVendor] after =', JSON.stringify(rows[0]));

  if (!rows.length || rows[0].status !== 'active') {
    return res.status(500).json({
      success: false,
      message: 'Gagal update status vendor',
      debug: process.env.NODE_ENV !== 'production' ? { check, updateResult: upd, after: rows[0] } : undefined,
    });
  }

  ok(res, rows[0]);
});
/** Tolak vendor pending */
const rejectVendor = asyncHandler(async (req, res) => {
  const vendorId = Number(req.params.id);
  if (!vendorId) return res.status(400).json({ success: false, message: 'ID vendor tidak valid' });

  const { reason } = req.body || {};

  const { rows: check } = await query(
    `SELECT id, status FROM vendors WHERE id = ? LIMIT 1`,
    [vendorId]
  );
  if (!check.length) return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });
  if (check[0].status !== 'pending') {
    return res.status(400).json({
      success: false,
      message: `Vendor tidak dalam status pending (saat ini: ${check[0].status})`
    });
  }

  const adminId = req.adminUserRowId ? Number(req.adminUserRowId) : null;
  await query(
    `UPDATE vendors
        SET status = 'rejected',
            rejected_reason = ?,
            verified_at = NOW(),
            verified_by = ?
      WHERE id = ? AND status = 'pending'`,
    [reason || 'Tidak memenuhi syarat', adminId, vendorId]
  );

  const { rows } = await query(`SELECT * FROM vendors WHERE id = ? LIMIT 1`, [vendorId]);
  ok(res, rows[0]);
});

/** Suspend vendor aktif */
const suspendVendor = asyncHandler(async (req, res) => {
  const vendorId = Number(req.params.id);
  if (!vendorId) return res.status(400).json({ success: false, message: 'ID vendor tidak valid' });

  const { reason } = req.body || {};

  const { rows: check } = await query(
    `SELECT id, status FROM vendors WHERE id = ? LIMIT 1`,
    [vendorId]
  );
  if (!check.length) return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });
  if (check[0].status !== 'active') {
    return res.status(400).json({
      success: false,
      message: `Vendor tidak dalam status active (saat ini: ${check[0].status})`
    });
  }

  await query(
    `UPDATE vendors
        SET status = 'suspended',
            rejected_reason = ?
      WHERE id = ? AND status = 'active'`,
    [reason || 'Disuspend oleh admin', vendorId]
  );

  const { rows } = await query(`SELECT * FROM vendors WHERE id = ? LIMIT 1`, [vendorId]);
  ok(res, rows[0]);
});

/** Ubah komisi vendor */
const setCommission = asyncHandler(async (req, res) => {
  const vendorId = Number(req.params.id);
  const { commission_percent } = req.body || {};
  const p = Number(commission_percent);

  if (!vendorId) return res.status(400).json({ success: false, message: 'ID vendor tidak valid' });
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    return res.status(400).json({ success: false, message: 'commission_percent harus 0-100' });
  }

  await query(
    `UPDATE vendors SET commission_percent = ? WHERE id = ?`,
    [p, vendorId]
  );

  const { rows } = await query(`SELECT * FROM vendors WHERE id = ? LIMIT 1`, [vendorId]);
  if (!rows.length) return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });
  ok(res, rows[0]);
});

/* =====================================================================
 * ARMADA MONITORING
 * ===================================================================== */

/** Monitoring seluruh armada (semua vendor) */
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
       FROM vehicles v
       JOIN vendors vd ON vd.id = v.vendor_id
      WHERE ${where}
      ORDER BY v.created_at DESC
      LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );

  const { rows: countRows } = await query(
    `SELECT COUNT(*) AS count FROM vehicles v WHERE ${where}`,
    params
  );

  ok(res, rows, buildMeta(page, limit, countRows[0].count));
});

/* =====================================================================
 * TRANSAKSI
 * ===================================================================== */

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
  if (q) {
    conds.push(`(booking_code LIKE $${i} OR order_no LIKE $${i} OR contact_name LIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }
  const where = conds.join(' AND ');

  const { rows } = await query(
    `SELECT * FROM v_admin_transactions
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );

  const { rows: countRows } = await query(
    `SELECT COUNT(*) AS count FROM v_admin_transactions WHERE ${where}`,
    params
  );

  ok(res, rows, buildMeta(page, limit, countRows[0].count));
});

/** Detail 1 transaksi (booking + passengers + payments + logs + refunds) */
const getTransactionDetail = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // 1. Booking (dari view)
  const { rows } = await query(
    `SELECT * FROM v_admin_transactions WHERE booking_id = $1 LIMIT 1`,
    [id]
  );
  if (!rows.length) {
    return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan' });
  }
  const tx = rows[0];

  // 2. Penumpang
  const { rows: passengers } = await query(
    `SELECT passenger_no, full_name, seat_number, ticket_code,
            insurance_selected, insurance_price, checked_in_at
       FROM booking_passengers
      WHERE booking_id = $1
      ORDER BY passenger_no`,
    [id]
  );

  // 3. Semua payment (bukan cuma terakhir)
  const { rows: payments } = await query(
    `SELECT p.id, p.amount, p.status, p.va_number, p.qr_string,
            p.gateway_ref, p.expires_at, p.paid_at, p.created_at,
            pm.code AS method_code, pm.name AS method_name
       FROM payments p
       LEFT JOIN payment_methods pm ON pm.id = p.method_id
      WHERE p.booking_id = $1
      ORDER BY p.id DESC`,
    [id]
  );

  // 4. Log perubahan status
  const { rows: statusLogs } = await query(
    `SELECT id, from_status, to_status, note, created_at
       FROM booking_status_logs
      WHERE booking_id = $1
      ORDER BY id DESC`,
    [id]
  );

  // 5. Refund (kalau ada)
  const { rows: refunds } = await query(
    `SELECT id, amount, reason, status, requested_at, processed_at
       FROM refunds
      WHERE booking_id = $1
      ORDER BY id DESC`,
    [id]
  );

  ok(res, {
    ...tx,
    passengers,
    payments,
    status_logs: statusLogs,
    refunds,
  });
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
    `SELECT * FROM v_admin_daily_summary ${where} ORDER BY trx_date DESC LIMIT 90`,
    params
  );
  ok(res, rows);
});

/** Penjualan per vendor (leaderboard) */
const vendorSales = asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM v_vendor_sales ORDER BY gross_amount DESC`);
  ok(res, rows);
});

/* =====================================================================
 * REFUND
 * ===================================================================== */

/** Daftar refund yang butuh ditinjau */
const listRefunds = asyncHandler(async (req, res) => {
  const { status = 'requested' } = req.query;
  const { rows } = await query(
    `SELECT r.*, b.booking_code, b.contact_name, b.vendor_id, v.name AS vendor_name
       FROM refunds r
       JOIN bookings b ON b.id = r.booking_id
       JOIN vendors v ON v.id = b.vendor_id
      WHERE r.status = $1
      ORDER BY r.requested_at`,
    [status]
  );
  ok(res, rows);
});

/** Proses refund (approve/reject) */
const reviewRefund = asyncHandler(async (req, res) => {
  const { action } = req.body;
  if (!['approved', 'rejected'].includes(action)) {
    return res.status(400).json({ success: false, message: "action harus 'approved' atau 'rejected'" });
  }

  const { rows } = await query(
    `UPDATE refunds
        SET status = $2, reviewed_by = $3, processed_at = NOW()
      WHERE id = $1 AND status = 'requested'
      RETURNING *`,
    [req.params.id, action, req.adminUserRowId]
  );
  if (!rows.length) {
    return res.status(400).json({ success: false, message: 'Refund tidak dalam status requested' });
  }

  if (action === 'approved') {
    await query(`UPDATE bookings SET status = 'refunded' WHERE id = $1`, [rows[0].booking_id]);
  }
  ok(res, rows[0]);
});

/* =====================================================================
 * AUDIT LOG
 * ===================================================================== */

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
    `SELECT a.*, u.username AS actor_username, u.full_name AS actor_name
       FROM audit_logs a
       LEFT JOIN app_users u ON u.id = a.actor_user_id
      WHERE ${where}
      ORDER BY a.created_at DESC
      LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );

  const { rows: countRows } = await query(
    `SELECT COUNT(*) AS count FROM audit_logs WHERE ${where}`,
    params
  );

  ok(res, rows, buildMeta(page, limit, countRows[0].count));
});

/* =====================================================================
 * EXPORTS
 * ===================================================================== */
module.exports = {
  // Vendor
  listVendors,
  getVendorDetail,
  approveVendor,
  rejectVendor,
  suspendVendor,
  setCommission,

  // Armada
  listAllVehicles,

  // Transaksi
  listTransactions,
  getTransactionDetail,   // ← TAMBAHAN

  // Summary
  dailySummary,
  vendorSales,

  // Refund
  listRefunds,
  reviewRefund,

  // Audit
  listAuditLogs,
};