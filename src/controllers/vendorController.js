const axios = require('axios');
const moment = require('moment-timezone');
const crypto = require('crypto');
const { query, withTransaction } = require('../config/db');
const { asyncHandler, ok, created, randomCode } = require('../utils/helpers');
const { notifyVendor } = require('../utils/notifyVendor');
const { adjustJagelSaldo } = require('../utils/jagel');

/* =====================================================================
 * LINKQU — untuk topup vendor
 * ===================================================================== */
const linkqu = {
  clientId: process.env.LINKQU_CLIENT_ID || 'testing',
  clientSecret: process.env.LINKQU_CLIENT_SECRET || '123',
  username: process.env.LINKQU_USERNAME || 'LI307GXIN',
  pin: process.env.LINKQU_PIN || '2K2NPCBBNNTovgB',
  serverKey: process.env.LINKQU_SERVER_KEY || 'LinkQu@2020',
  baseUrl: process.env.LINKQU_BASE_URL || 'https://gateway-dev.linkqu.id/linkqu-partner',
};

const TOPUP_AMOUNT = 50000;
const TOPUP_DAYS = 30;
// Akun Jagel milik LinkU (platform), tempat penampungan dana topup vendor
const LINKU_JAGEL_USERNAME = process.env.LINKU_JAGEL_USERNAME || 'amir';

function cleanValue(s) {
  return String(s).replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
}
function hmac256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}
function signVA({ amount, expired, bank_code, partner_reff, customer_id, customer_name, customer_email }) {
  const raw = cleanValue(
    amount + expired + bank_code + partner_reff +
    customer_id + customer_name + customer_email + linkqu.clientId
  );
  return hmac256(linkqu.serverKey, '/transaction/create/vaPOST' + raw);
}
function signQRIS({ amount, expired, partner_reff, customer_id, customer_name, customer_email }) {
  const raw = cleanValue(
    amount + expired + partner_reff +
    customer_id + customer_name + customer_email + linkqu.clientId
  );
  return hmac256(linkqu.serverKey, '/transaction/create/qrisPOST' + raw);
}

/* =====================================================================
 * REGISTER VENDOR
 * ===================================================================== */
const registerVendor = asyncHandler(async (req, res) => {
  const {
    name, legal_name, address, npwp, nib,
    contact_phone, contact_email,
    payment_system = 'commission',
    markup_percent = 0,
    commission_percent = 5.00, // default hanya dipakai kalau system === 'commission'
  } = req.body || {};

  if (!name) {
    return res.status(400).json({ success: false, message: 'name wajib diisi' });
  }

  const validSystems = ['topup', 'commission', 'markup'];
  const system = validSystems.includes(payment_system) ? payment_system : 'commission';

  // Cek user sudah punya vendor
  const { rows: existing } = await query(
    `SELECT v.id, v.status FROM vendors v
       JOIN vendor_members vm ON vm.vendor_id = v.id
      WHERE vm.user_id = ? AND v.status IN ('pending','active') LIMIT 1`,
    [req.user.id]
  );
  if (existing.length) {
    return res.status(409).json({
      success: false,
      message: 'Anda sudah memiliki vendor.',
      vendor_id: existing[0].id,
      vendor_status: existing[0].status,
    });
  }

  const code = randomCode('VND');

  // Hanya isi persen sesuai payment_system yang dipilih; yang lain dipaksa 0
  const markupPct = system === 'markup' ? (Number(markup_percent) || 0) : 0;
  const commissionPct = system === 'commission' ? (Number(commission_percent) || 0) : 0;

  const result = await withTransaction(async (client) => {
    const r = await client.query(
      `INSERT INTO vendors
         (code, name, legal_name, address, npwp, nib,
          contact_phone, contact_email, owner_user_id,
          status, payment_system, commission_percent, markup_percent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NOW())`,
      [
        code, name, legal_name || null, address || null,
        npwp || null, nib || null,
        contact_phone || null, contact_email || null,
        req.user.id, system, commissionPct, markupPct,
      ]
    );
    const vendorId = r.insertId;

    await client.query(
      `INSERT INTO vendor_members
         (vendor_id, user_id, role, notify_channels, notify_enabled)
       VALUES (?, ?, 'owner', 'in_app,push,email', 1)
       ON DUPLICATE KEY UPDATE role = 'owner'`,
      [vendorId, req.user.id]
    );

    await client.query(
      `INSERT INTO notifications
         (recipient_user_id, vendor_id, type, channel, title, body, data)
       SELECT au.user_id, ?, 'system', 'in_app',
              'Vendor baru menunggu verifikasi',
              CONCAT('Vendor "', ?, '" (sistem: ', ?, ') menunggu verifikasi.'),
              JSON_OBJECT('vendor_id', ?, 'payment_system', ?)
         FROM admin_users au WHERE au.is_active = 1`,
      [vendorId, name, system, vendorId, system]
    );

    const v = await client.query(`SELECT * FROM vendors WHERE id = ?`, [vendorId]);
    return v.rows[0];
  });

  created(res, result);
});

/* =====================================================================
 * GET MY VENDOR PROFILE
 * ===================================================================== */
const getMyVendorProfile = asyncHandler(async (req, res) => {
  const vendorId = Number(req.vendorId);

  const { rows } = await query(
    `SELECT 
        v.id AS vendor_id, v.code, v.name, v.legal_name, v.npwp, v.nib,
        v.contact_phone, v.contact_email, v.address, v.logo_url, v.description,
        v.status, v.payment_system, v.commission_percent, v.markup_percent,
        v.topup_active_until, v.topup_last_paid_at,
        v.rating_avg, v.rating_count, v.verified_at, v.rejected_reason,
        v.created_at, v.updated_at,
        u.jagel_user_id, u.username,
        u.full_name AS owner_name, u.phone AS owner_phone, u.email AS owner_email
       FROM vendors v
       JOIN app_users u ON u.id = v.owner_user_id
      WHERE v.id = ? LIMIT 1`,
    [vendorId]
  );
  if (!rows.length) {
    return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });
  }
  const vendor = rows[0];

  // Flag topup aktif
  if (vendor.payment_system === 'topup') {
    const activeUntil = vendor.topup_active_until ? new Date(vendor.topup_active_until) : null;
    vendor.topup_active = activeUntil && activeUntil > new Date();
  }

  const { rows: banks } = await query(
    `SELECT id, bank_name, account_number, account_holder, is_primary, created_at
       FROM vendor_bank_accounts WHERE vendor_id = ?
       ORDER BY is_primary DESC, id`,
    [vendorId]
  );

  const { rows: members } = await query(
    `SELECT vm.role, vm.notify_enabled, u.username, u.full_name, u.phone, u.email
       FROM vendor_members vm
       JOIN app_users u ON u.id = vm.user_id
      WHERE vm.vendor_id = ? ORDER BY vm.role DESC`,
    [vendorId]
  );

  const { rows: stats } = await query(
    `SELECT 
        (SELECT COUNT(*) FROM vehicles WHERE vendor_id = ?) AS total_vehicles,
        (SELECT COUNT(*) FROM routes WHERE vendor_id = ?) AS total_routes,
        (SELECT COUNT(*) FROM schedules WHERE vendor_id = ?) AS total_schedules,
        (SELECT COUNT(*) FROM schedules WHERE vendor_id = ? AND status = 'published') AS published_schedules`,
    [vendorId, vendorId, vendorId, vendorId]
  );

  res.json({
    success: true,
    data: { ...vendor, bank_accounts: banks, members, stats: stats[0] || {} },
  });
});

/* =====================================================================
 * UPDATE VENDOR PROFILE (npwp/nib boleh null)
 * ===================================================================== */
const updateVendorProfile = asyncHandler(async (req, res) => {
  const allowed = ['name', 'legal_name', 'npwp', 'nib', 'contact_phone', 'contact_email', 'address', 'logo_url', 'description'];
  const sets = [], values = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`${key}=?`);
      values.push(req.body[key] === '' ? null : req.body[key]);
    }
  }
  if (!sets.length) {
    return res.status(400).json({ success: false, message: 'Tidak ada field untuk diupdate' });
  }
  values.push(req.vendorId);
  await query(`UPDATE vendors SET ${sets.join(', ')} WHERE id=?`, values);
  const { rows } = await query(`SELECT * FROM vendors WHERE id=?`, [req.vendorId]);
  ok(res, rows[0]);
});

/* =====================================================================
 * BANK & MEMBER
 * ===================================================================== */
const addBankAccount = asyncHandler(async (req, res) => {
  const { bank_name, account_number, account_holder, is_primary } = req.body || {};
  if (!bank_name || !account_number || !account_holder) {
    return res.status(400).json({ success: false, message: 'bank_name, account_number, account_holder wajib' });
  }
  const result = await withTransaction(async (client) => {
    if (is_primary) {
      await client.query(`UPDATE vendor_bank_accounts SET is_primary=0 WHERE vendor_id=?`, [req.vendorId]);
    }
    const r = await client.query(
      `INSERT INTO vendor_bank_accounts(vendor_id,bank_name,account_number,account_holder,is_primary)
       VALUES(?,?,?,?,?)`,
      [req.vendorId, bank_name, account_number, account_holder, is_primary ? 1 : 0]
    );
    const { rows } = await client.query(`SELECT * FROM vendor_bank_accounts WHERE id=?`, [r.insertId]);
    return rows[0];
  });
  created(res, result);
});

const addVendorMember = asyncHandler(async (req, res) => {
  const { user_id, role, notify_channels } = req.body || {};
  if (!user_id || !role) {
    return res.status(400).json({ success: false, message: 'user_id, role wajib' });
  }
  await query(
    `INSERT INTO vendor_members(vendor_id,user_id,role,notify_channels)
     VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE role=VALUES(role),notify_channels=VALUES(notify_channels)`,
    [req.vendorId, user_id, role, notify_channels || 'in_app,push']
  );
  const { rows } = await query(`SELECT * FROM vendor_members WHERE vendor_id=? AND user_id=?`, [req.vendorId, user_id]);
  created(res, rows[0]);
});

/* =====================================================================
 * TOPUP — Buat VA/QRIS LinkQu
 * ===================================================================== */

/**
 * POST /api/vendors/:vendorId/topup
 * Body: { method: 'VA' | 'QRIS', bank_code?: '002' }
 */
const requestTopup = asyncHandler(async (req, res) => {
  const vendorId = Number(req.vendorId);
  const { method = 'QRIS', bank_code } = req.body || {};

  if (!['VA', 'QRIS'].includes(method)) {
    return res.status(400).json({ success: false, message: 'method harus VA atau QRIS' });
  }
  if (method === 'VA' && !bank_code) {
    return res.status(400).json({ success: false, message: 'bank_code wajib untuk VA' });
  }

  // Ambil data vendor + owner
  const { rows: vendors } = await query(
    `SELECT v.id, v.name, v.contact_email, v.contact_phone, v.status,
            v.payment_system, v.topup_active_until,
            u.username, u.full_name AS owner_name,
            u.phone AS user_phone, u.email AS user_email
       FROM vendors v
       JOIN app_users u ON u.id = v.owner_user_id
      WHERE v.id = ? LIMIT 1`,
    [vendorId]
  );
  if (!vendors.length) {
    return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });
  }
  const vendor = vendors[0];

  if (vendor.payment_system !== 'topup') {
    return res.status(400).json({
      success: false,
      message: `Vendor tidak memakai sistem topup (saat ini: ${vendor.payment_system})`,
    });
  }
  if (vendor.status !== 'active') {
    return res.status(403).json({ success: false, message: 'Vendor belum diverifikasi admin' });
  }

  // Hitung periode
  const now = new Date();
  let periodStart = now;
  let periodEnd = new Date(now.getTime() + TOPUP_DAYS * 24 * 60 * 60 * 1000);
  if (vendor.topup_active_until && new Date(vendor.topup_active_until) > now) {
    periodStart = new Date(vendor.topup_active_until);
    periodEnd = new Date(periodStart.getTime() + TOPUP_DAYS * 24 * 60 * 60 * 1000);
  }

  const partner_reff = `TOPUP-${vendorId}-${Date.now()}`;

  // Buat record topup pending
  const { rows: insertResult } = await query(
    `INSERT INTO vendor_topups 
       (vendor_id, amount, period_start, period_end, status, payment_reff)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    [vendorId, TOPUP_AMOUNT, periodStart, periodEnd, partner_reff]
  );
  const topupId = insertResult.insertId;

  // Data customer
  const expired = moment.tz('Asia/Jakarta').add(30, 'minutes').format('YYYYMMDDHHmmss');
  const phone = vendor.user_phone || vendor.contact_phone || '081234567890';
  const customer_id = phone.startsWith('+') ? phone : '+62' + phone.replace(/^0/, '');
  const customer_name = (vendor.owner_name || vendor.name || 'Vendor').substring(0, 30);
  const customer_email = vendor.user_email || vendor.contact_email || 'vendor@example.com';

  let endpoint, signature, payload;

  if (method === 'VA') {
    signature = signVA({
      amount: TOPUP_AMOUNT, expired, bank_code, partner_reff,
      customer_id, customer_name, customer_email,
    });
    endpoint = '/transaction/create/va';
    payload = {
      amount: TOPUP_AMOUNT, bank_code, customer_id, customer_name, customer_email,
      customer_phone: customer_id, partner_reff,
      username: linkqu.username, pin: linkqu.pin,
      expired, signature,
      url_callback: 'https://bus.siappgo.id/api/vendors/topup/callback',
    };
  } else {
    signature = signQRIS({
      amount: TOPUP_AMOUNT, expired, partner_reff,
      customer_id, customer_name, customer_email,
    });
    endpoint = '/transaction/create/qris';
    payload = {
      amount: TOPUP_AMOUNT, customer_id, customer_name, customer_email,
      customer_phone: customer_id, partner_reff,
      username: linkqu.username, pin: linkqu.pin,
      expired, signature,
      url_callback: 'https://bus.siappgo.id/api/vendors/topup/callback',
    };
  }

  console.log('[TOPUP-LINKQU] POST', linkqu.baseUrl + endpoint);
  console.log('[TOPUP-LINKQU] Payload:', JSON.stringify({ ...payload, pin: '***' }));

  const resp = await axios.post(`${linkqu.baseUrl}${endpoint}`, payload, {
    headers: {
      'client-id': linkqu.clientId,
      'client-secret': linkqu.clientSecret,
      'Content-Type': 'application/json',
    },
    validateStatus: s => s < 600,
    timeout: 30000,
  });

  const data = resp.data;
  console.log('[TOPUP-LINKQU] Response:', JSON.stringify(data));

  if (data.response_code && data.response_code !== '00') {
    return res.status(400).json({
      status: 'Error',
      message: data.response_desc || 'LinkQu menolak permintaan',
    });
  }

  const va = data.virtual_account || data.va_number || data.data?.va_number || null;
  const qr = data.imageqris || data.qr_url || data.data?.qr_url || null;
  if (!va && !qr) {
    throw new Error('LinkQu tidak mengembalikan VA/QRIS');
  }

  const expiredAt = moment(expired, 'YYYYMMDDHHmmss').format('YYYY-MM-DD HH:mm:ss');

  await query(
    `UPDATE vendor_topups SET va_number = ?, qris_url = ? WHERE id = ?`,
    [va, qr, topupId]
  );

  res.json({
    success: true,
    data: {
      topup_id: topupId,
      partner_reff,
      amount: TOPUP_AMOUNT,
      method,
      bank_code: bank_code || null,
      va_number: va,
      qris_url: qr,
      expired_at: expiredAt,
      period_start: periodStart,
      period_end: periodEnd,
      message: `Bayar Rp ${TOPUP_AMOUNT.toLocaleString('id-ID')} sebelum ${expiredAt}`,
    },
  });
});

/**
 * POST /api/vendors/topup/callback
 * Callback dari LinkQu saat vendor bayar topup
 */
const topupCallback = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { partner_reff, status, response_code } = body;

  console.log('[TOPUP-CALLBACK] received:', partner_reff, JSON.stringify(body));

  if (!partner_reff) {
    return res.status(400).json({ message: 'partner_reff missing' });
  }

  const isPaid = String(status || '').toUpperCase() === 'SUCCESS'
    || String(response_code) === '00';

  if (!isPaid) {
    return res.json({ message: 'OK - not paid yet' });
  }

  const { rows: topups } = await query(
    `SELECT t.id, t.vendor_id, t.amount, t.period_start, t.period_end, t.status,
            v.name AS vendor_name, v.contact_email AS vendor_email, v.contact_phone AS vendor_phone
       FROM vendor_topups t
       JOIN vendors v ON v.id = t.vendor_id
      WHERE t.payment_reff = ? LIMIT 1`,
    [partner_reff]
  );
  if (!topups.length) {
    console.warn('[TOPUP-CALLBACK] topup tidak ditemukan:', partner_reff);
    return res.json({ message: 'OK' });
  }
  const topup = topups[0];

  if (topup.status === 'paid') {
    console.log('[TOPUP-CALLBACK] sudah paid (skip):', partner_reff);
    return res.json({ message: 'OK' });
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE vendor_topups SET status='paid', paid_at=NOW() WHERE id=?`,
      [topup.id]
    );
    await client.query(
      `UPDATE vendors SET topup_active_until=?, topup_last_paid_at=NOW() WHERE id=?`,
      [topup.period_end, topup.vendor_id]
    );
  });

  console.log(`[TOPUP-CALLBACK] ✅ Vendor ${topup.vendor_id} aktif s/d ${topup.period_end}`);

  // ===== ADJUST SALDO JAGEL — masuk ke akun penampungan LinkU (amir) =====
  try {
    await adjustJagelSaldo(
      LINKU_JAGEL_USERNAME,
      Number(topup.amount),
      `Topup langganan vendor "${topup.vendor_name}" (vendor_id=${topup.vendor_id}) — ${partner_reff}`
    );
    console.log(`[TOPUP-CALLBACK] ✅ Rp ${topup.amount} masuk Jagel @${LINKU_JAGEL_USERNAME}`);
  } catch (e) {
    console.error(`[TOPUP-CALLBACK] ❌ gagal kredit Jagel @${LINKU_JAGEL_USERNAME}:`, e.message);
    // status topup tetap 'paid'; kalau gagal kredit saldo, perlu rekonsiliasi manual
  }

  try {
    await notifyVendor({
      vendor_id: topup.vendor_id,
      vendor_name: topup.vendor_name,
      vendor_email: topup.vendor_email,
      vendor_phone: topup.vendor_phone,
      type: 'topup_paid',
      title: 'Topup berhasil — akun berjualan aktif',
      body: `Pembayaran topup langganan berhasil. Vendor aktif berjualan sampai periode berikutnya.`,
      data: {
        vendor_id: topup.vendor_id,
        amount: topup.amount,
        period_start: topup.period_start,
        period_end: topup.period_end,
        partner_reff,
      },
    });
    console.log('[TOPUP-CALLBACK] ✅ notif vendor terkirim');
  } catch (e) {
    console.warn('[TOPUP-CALLBACK] notif gagal:', e.message);
  }

  res.json({ message: 'OK' });
});

/**
 * GET /api/vendors/:vendorId/topup/history
 */
const listTopups = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, amount, period_start, period_end, status,
            va_number, qris_url, payment_reff, paid_at, created_at
       FROM vendor_topups
      WHERE vendor_id = ?
      ORDER BY id DESC LIMIT 20`,
    [req.vendorId]
  );
  ok(res, rows);
});

/**
 * POST /api/vendors/:vendorId/topup/:topupId/confirm
 * Manual confirm (dev/test)
 */
const confirmTopupManual = asyncHandler(async (req, res) => {
  const topupId = Number(req.params.topupId);
  const vendorId = Number(req.vendorId);

  const { rows: topups } = await query(
    `SELECT t.*, v.name AS vendor_name, v.contact_email AS vendor_email, v.contact_phone AS vendor_phone
       FROM vendor_topups t
       JOIN vendors v ON v.id = t.vendor_id
      WHERE t.id = ? AND t.vendor_id = ? LIMIT 1`,
    [topupId, vendorId]
  );
  if (!topups.length) {
    return res.status(404).json({ success: false, message: 'Topup tidak ditemukan' });
  }
  const topup = topups[0];

  if (topup.status === 'paid') {
    return res.json({ success: true, message: 'Sudah paid' });
  }

  await withTransaction(async (client) => {
    await client.query(`UPDATE vendor_topups SET status='paid', paid_at=NOW() WHERE id=?`, [topupId]);
    await client.query(
      `UPDATE vendors SET topup_active_until=?, topup_last_paid_at=NOW() WHERE id=?`,
      [topup.period_end, vendorId]
    );
  });

  // ===== ADJUST SALDO JAGEL — masuk ke akun penampungan LinkU (amir) =====
  try {
    await adjustJagelSaldo(
      LINKU_JAGEL_USERNAME,
      Number(topup.amount),
      `Topup langganan (manual confirm) vendor "${topup.vendor_name}" (vendor_id=${vendorId}) — topup_id=${topupId}`
    );
    console.log(`[TOPUP-CONFIRM-MANUAL] ✅ Rp ${topup.amount} masuk Jagel @${LINKU_JAGEL_USERNAME}`);
  } catch (e) {
    console.error(`[TOPUP-CONFIRM-MANUAL] ❌ gagal kredit Jagel @${LINKU_JAGEL_USERNAME}:`, e.message);
  }

  try {
    await notifyVendor({
      vendor_id: vendorId,
      vendor_name: topup.vendor_name,
      vendor_email: topup.vendor_email,
      vendor_phone: topup.vendor_phone,
      type: 'topup_paid',
      title: 'Topup berhasil — akun berjualan aktif',
      body: `Topup dikonfirmasi manual. Vendor aktif berjualan sampai periode berikutnya.`,
      data: {
        vendor_id: vendorId,
        amount: topup.amount,
        period_start: topup.period_start,
        period_end: topup.period_end,
      },
    });
  } catch (e) {
    console.warn('[TOPUP-CONFIRM-MANUAL] notif gagal:', e.message);
  }

  res.json({
    success: true,
    message: 'Topup dikonfirmasi',
    data: { period_end: topup.period_end },
  });
});

/**
 * GET /api/vendors/:vendorId/stops?city_id=1
 * List titik naik/turun (stops) untuk satu kota, yang boleh dipakai vendor:
 * - stops publik (vendor_id IS NULL, milik siapa saja)
 * - stops privat milik vendor itu sendiri (vendor_id = req.vendorId)
 */
const listStops = asyncHandler(async (req, res) => {
  const vendorId = Number(req.vendorId);
  const cityId = Number(req.query.city_id);

  if (!cityId) {
    return res.status(400).json({ success: false, message: 'city_id wajib diisi' });
  }

  const { rows } = await query(
    `SELECT id, city_id, vendor_id, name, address, latitude, longitude
       FROM stops
      WHERE city_id = ?
        AND is_active = 1
        AND (vendor_id IS NULL OR vendor_id = ?)
      ORDER BY vendor_id IS NULL DESC, name`,
    [cityId, vendorId]
  );

  ok(res, rows);
});

module.exports = {
  registerVendor,
  getMyVendorProfile,
  updateVendorProfile,
  addBankAccount,
  addVendorMember,
  requestTopup,
  topupCallback,
  listTopups,
  confirmTopupManual,
  listStops,
};