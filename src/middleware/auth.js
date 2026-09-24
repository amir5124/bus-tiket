const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// =====================================================================
// DEV MODE — user dikirim dari frontend via header
// Header yang dibaca:
//   x-dev-user-id     → jagel_user_id (wajib, mis. "123456")
//   x-dev-username    → username (mis. "amir")
//   x-dev-fullname    → full_name (mis. "Amir Munadir")
//   x-dev-phone       → phone (opsional)
//   x-dev-email       → email (opsional)
//   x-dev-vendor-id   → vendor_id (opsional, default 1)
//
// Aktif kalau DEV_MODE=true di .env.
// Kalau header tidak dikirim, fallback ke DEV_USER default.
// =====================================================================
const DEV_MODE = String(process.env.DEV_MODE || '').toLowerCase() === 'true';
const DEV_VENDOR_ID_DEFAULT = Number(process.env.DEV_VENDOR_ID || 1);

const DEV_USER_DEFAULT = {
  jagel_user_id: '123456',
  username: 'amir',
  full_name: 'Amir Munadir',
  phone: '082323907526',
  email: 'amir@example.com',
};

/**
 * Baca dev user dari header request (kalau DEV_MODE).
 * Fallback ke DEV_USER_DEFAULT.
 */
function getDevUserFromHeaders(req) {
  if (!DEV_MODE) return null;
  return {
    jagel_user_id: req.headers['x-dev-user-id'] || DEV_USER_DEFAULT.jagel_user_id,
    username: req.headers['x-dev-username'] || DEV_USER_DEFAULT.username,
    full_name: req.headers['x-dev-fullname'] || DEV_USER_DEFAULT.full_name,
    phone: req.headers['x-dev-phone'] || DEV_USER_DEFAULT.phone,
    email: req.headers['x-dev-email'] || DEV_USER_DEFAULT.email,
  };
}

/**
 * Upsert user ke DB berdasarkan data dev dari header.
 * Return user lengkap (dengan id DB).
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
      userData.phone || null,
      userData.email || null,
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

/**
 * Pastikan user adalah member vendor (dev mode: auto-insert owner).
 */
async function ensureVendorMember(vendorId, userId, role = 'owner') {
  await query(
    `INSERT INTO vendor_members (vendor_id, user_id, role, notify_channels, notify_enabled)
     VALUES (?, ?, ?, 'in_app,push,email,whatsapp', 1)
     ON DUPLICATE KEY UPDATE role = VALUES(role)`,
    [vendorId, userId, role]
  );
}

// =====================================================================
// requireAuth — Wajib login (kecuali DEV_MODE)
// =====================================================================
async function requireAuth(req, res, next) {
  // DEV BYPASS
  if (DEV_MODE) {
    try {
      const devUser = getDevUserFromHeaders(req);
      const user = await upsertUser(devUser);
      if (!user) return res.status(500).json({ success: false, message: 'Gagal upsert dev user' });
      req.user = user;
      return next();
    } catch (e) {
      console.error('[AUTH-DEV]', e.message);
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  // Normal auth
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Token tidak ditemukan' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
      `SELECT id, jagel_user_id, username, full_name, phone, email, is_active
         FROM app_users WHERE id = ?
         LIMIT 1`,
      [payload.userId]
    );
    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ success: false, message: 'Akun tidak valid / nonaktif' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token tidak valid atau kedaluwarsa' });
  }
}

// =====================================================================
// requireVendorMember
// =====================================================================
const ROLE_RANK = { owner: 3, manager: 2, staff: 1 };

function requireVendorMember(minRole = 'staff') {
  return async (req, res, next) => {
    try {
      const vendorIdParam = req.params.vendorId || req.body.vendor_id;

      // DEV BYPASS
      if (DEV_MODE) {
        const devUser = getDevUserFromHeaders(req);
        const user = req.user || await upsertUser(devUser);
        if (!user) return res.status(500).json({ success: false, message: 'Gagal upsert dev user' });

        const vendorId = Number(
          req.headers['x-dev-vendor-id'] ||
          vendorIdParam ||
          DEV_VENDOR_ID_DEFAULT
        );

        // Auto-insert membership
        await ensureVendorMember(vendorId, user.id, 'owner');

        req.user = user;
        req.vendorId = vendorId;
        req.vendorRole = 'owner';
        return next();
      }

      // Normal flow
      if (!vendorIdParam) {
        return res.status(400).json({ success: false, message: 'vendor_id wajib diisi' });
      }

      const { rows } = await query(
        `SELECT role FROM vendor_members WHERE vendor_id = ? AND user_id = ? LIMIT 1`,
        [vendorIdParam, req.user.id]
      );
      if (!rows.length) {
        return res.status(403).json({ success: false, message: 'Anda bukan anggota vendor ini' });
      }
      if (ROLE_RANK[rows[0].role] < ROLE_RANK[minRole]) {
        return res.status(403).json({ success: false, message: `Membutuhkan role minimal ${minRole}` });
      }
      req.vendorRole = rows[0].role;
      req.vendorId = Number(vendorIdParam);
      next();
    } catch (err) {
      console.error('[requireVendorMember]', err.message);
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
    // DEV BYPASS
    if (DEV_MODE) {
      req.adminRole = 'super_admin';
      req.adminUserRowId = 1;
      return next();
    }

    try {
      const { rows } = await query(
        `SELECT id, role, is_active FROM admin_users WHERE user_id = ? LIMIT 1`,
        [req.user.id]
      );
      if (!rows.length || !rows[0].is_active) {
        return res.status(403).json({ success: false, message: 'Akses admin ditolak' });
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
// optionalAuth — isi req.user kalau ada token / dev mode
// =====================================================================
async function optionalAuth(req, res, next) {
  // DEV BYPASS
  if (DEV_MODE) {
    try {
      const devUser = getDevUserFromHeaders(req);
      const user = await upsertUser(devUser);
      if (user) req.user = user;
    } catch (e) {
      console.error('[optionalAuth-DEV]', e.message);
    }
    return next();
  }

  // Normal
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next();

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
      `SELECT id, jagel_user_id, username, full_name, phone, email
         FROM app_users WHERE id = ? AND is_active = 1 LIMIT 1`,
      [payload.userId]
    );
    if (rows.length) req.user = rows[0];
    next();
  } catch {
    next();
  }
}

module.exports = { requireAuth, requireVendorMember, requireAdmin, optionalAuth };