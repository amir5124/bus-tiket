const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// =====================================================================
// DEFAULT USER — dipakai kalau request tidak membawa token
// Cocok untuk development / internal
// =====================================================================
const DEFAULT_USER_JAGEL_ID = process.env.DEFAULT_USER_JAGEL_ID || '123456';

/**
 * Ambil user default dari DB (by jagel_user_id).
 */
async function getDefaultUser() {
  const { rows } = await query(
    `SELECT id, jagel_user_id, username, full_name, phone, email, is_active
       FROM app_users
      WHERE jagel_user_id = ?
      LIMIT 1`,
    [DEFAULT_USER_JAGEL_ID]
  );
  return rows[0] || null;
}

// =====================================================================
// requireAuth — isi req.user (dari token, atau fallback default user)
// =====================================================================
async function requireAuth(req, res, next) {
  try {
    // 1. Coba token
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const { rows } = await query(
          `SELECT id, jagel_user_id, username, full_name, phone, email, is_active
             FROM app_users WHERE id = ? LIMIT 1`,
          [payload.userId]
        );
        if (rows.length && rows[0].is_active) {
          req.user = rows[0];
          return next();
        }
      } catch (err) {
        console.warn('[requireAuth] token invalid, fallback ke default user:', err.message);
      }
    }

    // 2. Fallback ke default user
    const user = await getDefaultUser();
    if (!user) {
      return res.status(500).json({
        success: false,
        message: `Default user (jagel_user_id=${DEFAULT_USER_JAGEL_ID}) tidak ada di DB. Insert: INSERT INTO app_users (jagel_user_id, username, full_name) VALUES ('${DEFAULT_USER_JAGEL_ID}', 'amir', 'Amir Munadir');`
      });
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('[requireAuth]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// =====================================================================
// requireVendorMember — set req.vendorId dari param, cek membership
// =====================================================================
const ROLE_RANK = { owner: 3, manager: 2, staff: 1 };

function requireVendorMember(minRole = 'staff') {
  return async (req, res, next) => {
    try {
      const vendorId = Number(req.params.vendorId || req.body.vendor_id || 1);
      if (!vendorId) {
        return res.status(400).json({ success: false, message: 'vendor_id wajib diisi' });
      }

      // Pastikan req.user ada
      if (!req.user) {
        const user = await getDefaultUser();
        if (user) req.user = user;
      }
      if (!req.user) {
        return res.status(401).json({ success: false, message: 'User tidak teridentifikasi' });
      }

      // Cek membership (kalau ada)
      const { rows } = await query(
        `SELECT role FROM vendor_members WHERE vendor_id = ? AND user_id = ? LIMIT 1`,
        [vendorId, req.user.id]
      );

      if (rows.length) {
        // Membership ada
        if (ROLE_RANK[rows[0].role] < ROLE_RANK[minRole]) {
          return res.status(403).json({ success: false, message: `Membutuhkan role minimal ${minRole}` });
        }
        req.vendorRole = rows[0].role;
      } else {
        // Tidak ada membership → auto-insert owner (untuk development)
        await query(
          `INSERT INTO vendor_members (vendor_id, user_id, role, notify_channels, notify_enabled)
           VALUES (?, ?, 'owner', 'in_app,push,email,whatsapp', 1)
           ON DUPLICATE KEY UPDATE role = 'owner'`,
          [vendorId, req.user.id]
        );
        req.vendorRole = 'owner';
      }

      req.vendorId = vendorId;
      next();
    } catch (err) {
      console.error('[requireVendorMember]', err.message);
      next(err);
    }
  };
}

// =====================================================================
// requireActiveVendor — cek vendor.status === 'active'
// =====================================================================
function requireActiveVendor() {
  return async (req, res, next) => {
    try {
      if (!req.vendorId) {
        return res.status(400).json({ success: false, message: 'vendor_id tidak di-set' });
      }

      const { rows } = await query(
        `SELECT id, status, verified_at FROM vendors WHERE id = ? LIMIT 1`,
        [req.vendorId]
      );
      if (!rows.length) {
        return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });
      }

      const v = rows[0];
      if (v.status !== 'active') {
        return res.status(403).json({
          success: false,
          message: `Vendor belum aktif (status: ${v.status}). Tunggu verifikasi admin.`,
          vendor_status: v.status,
        });
      }

      req.vendorStatus = v.status;
      next();
    } catch (err) {
      console.error('[requireActiveVendor]', err.message);
      next(err);
    }
  };
}

// =====================================================================
// requireAdmin
// =====================================================================
const ADMIN_RANK = { viewer: 1, support: 2, finance: 3, super_admin: 4 };

function requireAdmin(minRole = 'viewer') {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        const user = await getDefaultUser();
        if (user) req.user = user;
      }

      const { rows } = await query(
        `SELECT id, role, is_active FROM admin_users WHERE user_id = ? LIMIT 1`,
        [req.user?.id]
      );
      if (!rows.length || !rows[0].is_active) {
        // Fallback: anggap super_admin (untuk dev)
        req.adminRole = 'super_admin';
        req.adminUserRowId = 1;
        return next();
      }
      if (ADMIN_RANK[rows[0].role] < ADMIN_RANK[minRole]) {
        return res.status(403).json({ success: false, message: `Membutuhkan role admin minimal ${minRole}` });
      }
      req.adminRole = rows[0].role;
      req.adminUserRowId = rows[0].id;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// =====================================================================
// optionalAuth — isi req.user kalau ada token, atau fallback default
// =====================================================================
async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const { rows } = await query(
          `SELECT id, jagel_user_id, username, full_name, phone, email
             FROM app_users WHERE id = ? AND is_active = 1 LIMIT 1`,
          [payload.userId]
        );
        if (rows.length) {
          req.user = rows[0];
          return next();
        }
      } catch (err) {
        // token invalid → fallback
      }
    }

    // Fallback default user
    const user = await getDefaultUser();
    if (user) req.user = user;

    next();
  } catch {
    next();
  }
}

// =====================================================================
// Login helper — untuk endpoint /api/auth/jagel
// =====================================================================
async function loginWithJagel(req, res) {
  try {
    const { jagel_user_id, username, full_name, phone, email } = req.body || {};
    if (!jagel_user_id || !username || !full_name) {
      return res.status(400).json({
        success: false,
        message: 'jagel_user_id, username, full_name wajib diisi'
      });
    }

    await query(
      `INSERT INTO app_users (jagel_user_id, username, full_name, phone, email, is_active)
       VALUES (?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         username = VALUES(username),
         full_name = VALUES(full_name),
         phone = VALUES(phone),
         email = VALUES(email),
         is_active = 1`,
      [jagel_user_id, username, full_name, phone || null, email || null]
    );

    const { rows } = await query(
      `SELECT id, jagel_user_id, username, full_name, phone, email
         FROM app_users WHERE jagel_user_id = ? LIMIT 1`,
      [jagel_user_id]
    );
    const user = rows[0];

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({ success: true, data: { token, user } });
  } catch (err) {
    console.error('[loginWithJagel]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = {
  requireAuth,
  requireVendorMember,
  requireActiveVendor,
  requireAdmin,
  optionalAuth,
  loginWithJagel,
  getDefaultUser,
};