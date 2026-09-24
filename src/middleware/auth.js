const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// =====================================================================
// Baca data user Jagel dari header (dikirim frontend)
// Header:
//   x-user-id       → jagel_user_id (wajib)
//   x-username      → username (wajib)
//   x-fullname      → full_name (wajib)
//   x-phone         → phone (opsional)
//   x-email         → email (opsional)
// =====================================================================
function getUserFromHeaders(req) {
  const user_id = req.headers['x-user-id'];
  const username = req.headers['x-username'];
  const fullname = req.headers['x-fullname'];

  if (!user_id || !username || !fullname) return null;

  return {
    jagel_user_id: String(user_id).trim(),
    username: String(username).trim(),
    full_name: String(fullname).trim(),
    phone: (req.headers['x-phone'] || '').trim() || null,
    email: (req.headers['x-email'] || '').trim() || null,
  };
}

/**
 * Upsert user ke app_users, return row lengkap.
 */
async function upsertUser(userData) {
  await query(
    `INSERT INTO app_users (jagel_user_id, username, full_name, phone, email, is_active)
     VALUES (?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       username = VALUES(username),
       full_name = VALUES(full_name),
       phone = VALUES(phone),
       email = VALUES(email),
       is_active = 1,
       last_synced_at = NOW()`,
    [
      userData.jagel_user_id,
      userData.username,
      userData.full_name,
      userData.phone,
      userData.email,
    ]
  );

  const { rows } = await query(
    `SELECT id, jagel_user_id, username, full_name, phone, email, is_active
       FROM app_users
      WHERE jagel_user_id = ?
      LIMIT 1`,
    [userData.jagel_user_id]
  );
  return rows[0] || null;
}

// =====================================================================
// requireAuth — WAJIB ada header user dari frontend
// =====================================================================
async function requireAuth(req, res, next) {
  try {
    const userData = getUserFromHeaders(req);

    // Kalau tidak ada header, cek token (fallback)
    if (!userData) {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;

      if (!token) {
        return res.status(401).json({
          success: false,
          message: 'Header user (X-User-Id, X-Username, X-FullName) wajib dikirim',
        });
      }

      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const { rows } = await query(
        `SELECT id, jagel_user_id, username, full_name, phone, email, is_active
           FROM app_users WHERE id = ? LIMIT 1`,
        [payload.userId]
      );
      if (!rows.length || !rows[0].is_active) {
        return res.status(401).json({ success: false, message: 'Akun tidak valid' });
      }
      req.user = rows[0];
      return next();
    }

    // Upsert dari header
    const user = await upsertUser(userData);
    if (!user) {
      return res.status(500).json({ success: false, message: 'Gagal upsert user' });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('[requireAuth]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// =====================================================================
// requireVendorMember
// =====================================================================
const ROLE_RANK = { owner: 3, manager: 2, staff: 1 };

function requireVendorMember(minRole = 'staff') {
  return async (req, res, next) => {
    try {
      const vendorId = Number(req.params.vendorId || req.body.vendor_id);
      if (!vendorId) {
        return res.status(400).json({ success: false, message: 'vendor_id wajib' });
      }

      const { rows } = await query(
        `SELECT role FROM vendor_members WHERE vendor_id = ? AND user_id = ? LIMIT 1`,
        [vendorId, req.user.id]
      );
      if (!rows.length) {
        return res.status(403).json({ success: false, message: 'Anda bukan anggota vendor ini' });
      }
      if (ROLE_RANK[rows[0].role] < ROLE_RANK[minRole]) {
        return res.status(403).json({ success: false, message: `Butuh role minimal ${minRole}` });
      }

      req.vendorRole = rows[0].role;
      req.vendorId = vendorId;
      next();
    } catch (err) {
      console.error('[requireVendorMember]', err.message);
      next(err);
    }
  };
}

// =====================================================================
// requireActiveVendor
// =====================================================================
function requireActiveVendor() {
  return async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT id, status FROM vendors WHERE id = ? LIMIT 1`,
        [req.vendorId]
      );
      if (!rows.length) {
        return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });
      }
      if (rows[0].status !== 'active') {
        return res.status(403).json({
          success: false,
          message: `Vendor belum aktif (status: ${rows[0].status})`,
          vendor_status: rows[0].status,
        });
      }
      req.vendorStatus = rows[0].status;
      next();
    } catch (err) {
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
      const { rows } = await query(
        `SELECT id, role, is_active FROM admin_users WHERE user_id = ? LIMIT 1`,
        [req.user.id]
      );
      if (!rows.length || !rows[0].is_active) {
        return res.status(403).json({ success: false, message: 'Akses admin ditolak' });
      }
      if (ADMIN_RANK[rows[0].role] < ADMIN_RANK[minRole]) {
        return res.status(403).json({ success: false, message: `Butuh role admin minimal ${minRole}` });
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
// optionalAuth
// =====================================================================
async function optionalAuth(req, res, next) {
  try {
    const userData = getUserFromHeaders(req);
    if (userData) {
      const user = await upsertUser(userData);
      if (user) req.user = user;
      return next();
    }

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
        if (rows.length) req.user = rows[0];
      } catch { /* ignore */ }
    }
    next();
  } catch {
    next();
  }
}

module.exports = {
  requireAuth,
  requireVendorMember,
  requireActiveVendor,
  requireAdmin,
  optionalAuth,
};