const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { asyncHandler, ok } = require('../utils/helpers');

const loginWithJagel = asyncHandler(async (req, res) => {
  const { jagel_user_id, username, full_name, phone, email } = req.body;
  if (!jagel_user_id || !username || !full_name) {
    return res.status(400).json({ success:false, message:'jagel_user_id, username, full_name wajib diisi' });
  }

  await query(`
    INSERT INTO app_users (jagel_user_id, username, full_name, phone, email, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
    ON DUPLICATE KEY UPDATE
      username=VALUES(username), full_name=VALUES(full_name),
      phone=VALUES(phone), email=VALUES(email), is_active=1
  `, [jagel_user_id, username, full_name, phone || null, email || null]);

  const { rows } = await query(
    `SELECT id, jagel_user_id, username, full_name, phone, email
     FROM app_users WHERE jagel_user_id = ? LIMIT 1`,
    [jagel_user_id]
  );
  const user = rows[0];
  const token = jwt.sign({ userId:user.id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
  ok(res, { token, user });
});

const me = asyncHandler(async (req,res) => {
  const { rows: vendorRows } = await query(`
    SELECT v.id, v.code, v.name, v.status, vm.role
    FROM vendor_members vm JOIN vendors v ON v.id=vm.vendor_id
    WHERE vm.user_id=? ORDER BY v.id`, [req.user.id]);
  const { rows: adminRows } = await query(
    `SELECT role FROM admin_users WHERE user_id=? AND is_active=1`, [req.user.id]);
  ok(res,{ user:req.user, vendors:vendorRows, admin_role:adminRows[0]?.role || null });
});
module.exports={loginWithJagel,me};
