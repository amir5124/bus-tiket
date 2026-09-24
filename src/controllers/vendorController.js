const { query, withTransaction } = require('../config/db');
const { asyncHandler, ok, created, randomCode } = require('../utils/helpers');

const registerVendor = asyncHandler(async (req, res) => {
  const {
    name, legal_name, address, npwp, nib,
    contact_phone, contact_email,
  } = req.body || {};

  if (!name) {
    return res.status(400).json({ success: false, message: 'name wajib diisi' });
  }

  // Cek apakah user sudah punya vendor (pending/active)
  const { rows: existing } = await query(
    `SELECT v.id, v.status FROM vendors v
       JOIN vendor_members vm ON vm.vendor_id = v.id
      WHERE vm.user_id = ? AND v.status IN ('pending','active') LIMIT 1`,
    [req.user.id]
  );
  if (existing.length) {
    return res.status(409).json({
      success: false,
      message: 'Anda sudah memiliki vendor yang sedang diproses / aktif.',
      vendor_id: existing[0].id,
      vendor_status: existing[0].status,
    });
  }

  const code = randomCode('VND');

  const result = await withTransaction(async (client) => {
    // 1. Insert vendor (status='pending')
    const r = await client.query(
      `INSERT INTO vendors
         (code, name, legal_name, address, npwp, nib,
          contact_phone, contact_email, owner_user_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
      [
        code, name, legal_name || null, address || null,
        npwp || null, nib || null,
        contact_phone || null, contact_email || null,
        req.user.id,
      ]
    );
    const vendorId = r.insertId;

    // 2. Insert vendor member owner
    await client.query(
      `INSERT INTO vendor_members
         (vendor_id, user_id, role, notify_channels, notify_enabled)
       VALUES (?, ?, 'owner', 'in_app,push,email', 1)
       ON DUPLICATE KEY UPDATE role = 'owner'`,
      [vendorId, req.user.id]
    );

    // 3. Notif ke semua admin (in-app)
    await client.query(
      `INSERT INTO notifications
         (recipient_user_id, vendor_id, type, channel, title, body, data)
       SELECT au.user_id, ?, 'system', 'in_app',
              'Vendor baru menunggu verifikasi',
              CONCAT('Vendor "', ?, '" menunggu verifikasi admin.'),
              JSON_OBJECT('vendor_id', ?, 'vendor_code', ?)
         FROM admin_users au
        WHERE au.is_active = 1`,
      [vendorId, name, vendorId, code]
    );

    // 4. Ambil vendor yang baru dibuat
    const v = await client.query(`SELECT * FROM vendors WHERE id = ?`, [vendorId]);
    return v.rows[0];
  });

  created(res, result);
});

const getMyVendorProfile = asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM v_vendor_profile WHERE vendor_id=?`, [req.vendorId]);
  if (!rows.length) return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });
  ok(res, rows[0]);
});

const updateVendorProfile = asyncHandler(async (req, res) => {
  const allowed = ['name', 'legal_name', 'npwp', 'nib', 'contact_phone', 'contact_email', 'address', 'logo_url', 'description'];
  const sets = [], values = [];
  for (const key of allowed) { if (req.body[key] !== undefined) { sets.push(`${key}=?`); values.push(req.body[key]); } }
  if (!sets.length) return res.status(400).json({ success: false, message: 'Tidak ada field untuk diupdate' });
  values.push(req.vendorId);
  await query(`UPDATE vendors SET ${sets.join(', ')} WHERE id=?`, values);
  const { rows } = await query(`SELECT * FROM vendors WHERE id=?`, [req.vendorId]);
  ok(res, rows[0]);
});

const addBankAccount = asyncHandler(async (req, res) => {
  const { bank_name, account_number, account_holder, is_primary } = req.body;
  if (!bank_name || !account_number || !account_holder) return res.status(400).json({ success: false, message: 'bank_name, account_number, account_holder wajib diisi' });
  const result = await withTransaction(async client => {
    if (is_primary) await client.query(`UPDATE vendor_bank_accounts SET is_primary=0 WHERE vendor_id=?`, [req.vendorId]);
    const r = await client.query(
      `INSERT INTO vendor_bank_accounts(vendor_id,bank_name,account_number,account_holder,is_primary)
       VALUES(?,?,?,?,?)`, [req.vendorId, bank_name, account_number, account_holder, is_primary ? 1 : 0]);
    const { rows } = await client.query(`SELECT * FROM vendor_bank_accounts WHERE id=?`, [r.insertId]);
    return rows[0];
  });
  created(res, result);
});

const addVendorMember = asyncHandler(async (req, res) => {
  const { user_id, role, notify_channels } = req.body;
  if (!user_id || !role) return res.status(400).json({ success: false, message: 'user_id, role wajib diisi' });
  await query(
    `INSERT INTO vendor_members(vendor_id,user_id,role,notify_channels)
     VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE role=VALUES(role),notify_channels=VALUES(notify_channels)`,
    [req.vendorId, user_id, role, notify_channels || 'in_app,push']);
  const { rows } = await query(`SELECT * FROM vendor_members WHERE vendor_id=? AND user_id=?`, [req.vendorId, user_id]);
  created(res, rows[0]);
});
module.exports = { registerVendor, getMyVendorProfile, updateVendorProfile, addBankAccount, addVendorMember };
