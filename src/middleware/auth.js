const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

/**
 * Wajib login. Mengisi req.user = { id, jagel_user_id, username, ... }
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Token tidak ditemukan' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
      `SELECT id, jagel_user_id, username, full_name, phone, email, is_active
       FROM app_users WHERE id = $1`,
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

/**
 * Pastikan user adalah member vendor tertentu (:vendorId di params)
 * dengan role minimal `minRole` (owner > manager > staff).
 */
const ROLE_RANK = { owner: 3, manager: 2, staff: 1 };

function requireVendorMember(minRole = 'staff') {
  return async (req, res, next) => {
    try {
      const vendorId = req.params.vendorId || req.body.vendor_id;
      if (!vendorId) return res.status(400).json({ success: false, message: 'vendor_id wajib diisi' });

      const { rows } = await query(
        `SELECT role FROM vendor_members WHERE vendor_id = $1 AND user_id = $2`,
        [vendorId, req.user.id]
      );
      if (!rows.length) {
        return res.status(403).json({ success: false, message: 'Anda bukan anggota vendor ini' });
      }
      if (ROLE_RANK[rows[0].role] < ROLE_RANK[minRole]) {
        return res.status(403).json({ success: false, message: `Membutuhkan role minimal ${minRole}` });
      }
      req.vendorRole = rows[0].role;
      req.vendorId = Number(vendorId);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Wajib admin, dengan role minimal tertentu.
 */
const ADMIN_RANK = { viewer: 1, support: 2, finance: 3, super_admin: 4 };

function requireAdmin(minRole = 'viewer') {
  return async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT id, role, is_active FROM admin_users WHERE user_id = $1`,
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

/**
 * Auth opsional: jika ada token valid, isi req.user; jika tidak, lanjut tanpa error.
 * Dipakai di endpoint publik yang ingin tahu identitas user bila sedang login.
 */
async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next();

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
      `SELECT id, jagel_user_id, username, full_name, phone, email FROM app_users WHERE id = $1 AND is_active=1`,
      [payload.userId]
    );
    if (rows.length) req.user = rows[0];
    next();
  } catch {
    next(); // token invalid -> tetap lanjut sebagai guest
  }
}

module.exports = { requireAuth, requireVendorMember, requireAdmin, optionalAuth };
