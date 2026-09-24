const crypto = require('crypto');

/** Bungkus handler async agar error otomatis diteruskan ke errorHandler */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Ambil & normalisasi parameter pagination dari query string */
function getPagination(req, defaultLimit = 20, maxLimit = 100) {
  let page = parseInt(req.query.page, 10);
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function buildMeta(page, limit, total) {
  return {
    page,
    limit,
    total: Number(total),
    total_pages: Math.max(1, Math.ceil(Number(total) / limit)),
  };
}

function randomCode(prefix, length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[crypto.randomInt(0, chars.length)];
  return `${prefix}${out}`;
}

function ok(res, data, meta) {
  return res.json({ success: true, data, ...(meta ? { meta } : {}) });
}

function created(res, data) {
  return res.status(201).json({ success: true, data });
}

module.exports = { asyncHandler, getPagination, buildMeta, randomCode, ok, created };
