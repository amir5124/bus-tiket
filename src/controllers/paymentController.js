const axios = require('axios');
const crypto = require('crypto');
const moment = require('moment-timezone');
const { query } = require('../config/db');

const config = {
  clientId: process.env.LINKQU_CLIENT_ID || 'testing',
  clientSecret: process.env.LINKQU_CLIENT_SECRET || '123',
  username: process.env.LINKQU_USERNAME || 'LI307GXIN',
  pin: process.env.LINKQU_PIN || '2K2NPCBBNNTovgB',
  serverKey: process.env.LINKQU_SERVER_KEY || 'LinkQu@2020',
  baseUrl: process.env.LINKQU_BASE_URL || 'https://gateway-dev.linkqu.id/linkqu-partner',
};

const PAID = ['SUCCESS', 'SETTLED', 'PAID'];

function cleanValue(str) {
  return String(str).replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
}
function hmac256(serverKey, data) {
  return crypto.createHmac('sha256', serverKey).update(data).digest('hex');
}
function generateSignatureVA(fields) {
  const path = '/transaction/create/va';
  const method = 'POST';
  const raw = cleanValue(
    fields.amount + fields.expired + fields.bank_code + fields.partner_reff +
    fields.customer_id + fields.customer_name + fields.customer_email + config.clientId
  );
  return hmac256(config.serverKey, path + method + raw);
}
function generateSignatureQRIS(fields) {
  const path = '/transaction/create/qris';
  const method = 'POST';
  const raw = cleanValue(
    fields.amount + fields.expired + fields.partner_reff +
    fields.customer_id + fields.customer_name + fields.customer_email + config.clientId
  );
  return hmac256(config.serverKey, path + method + raw);
}
function normalizePhone(phone) {
  let p = String(phone || '').replace(/[^0-9]/g, '');
  if (p.startsWith('0')) p = '+62' + p.slice(1);
  else if (p.startsWith('8')) p = '+62' + p;
  else if (p.startsWith('62')) p = '+' + p;
  else if (!p.startsWith('+')) p = '+62' + p;
  return p.length < 10 ? '+628123456789' : p;
}

// =====================================================================
// POST /api/payments/create
// =====================================================================
const createPayment = async (req, res) => {
  try {
    const {
      booking_id, booking_code, customer_name, customer_phone, customer_email,
      method = 'QRIS', bank_code, admin_fee_applied,
    } = req.body;

    if (!booking_id && !booking_code)
      return res.status(400).json({ status: 'Error', message: 'booking_id atau booking_code wajib diisi' });
    if (!['VA', 'QRIS'].includes(method) || (method === 'VA' && !bank_code))
      return res.status(400).json({ status: 'Error', message: 'method harus VA (dengan bank_code) atau QRIS' });

    const { rows: booking } = await query(
      `SELECT b.*, TIMESTAMPDIFF(SECOND, NOW(), b.expires_at) AS ttl
         FROM bookings b
        WHERE ${booking_id ? 'b.id' : 'b.booking_code'} = ? LIMIT 1`,
      [booking_id || booking_code]
    );
    if (!booking.length)
      return res.status(404).json({ status: 'Error', message: 'Booking tidak ditemukan' });

    const b = booking[0];
    if (b.status !== 'pending_payment')
      return res.status(409).json({ status: 'Error', message: `Pesanan tidak menunggu pembayaran (status: ${b.status})` });
    if (b.ttl < 120)
      return res.status(409).json({ status: 'Error', message: 'Waktu pemesanan sudah habis atau hampir habis' });

    const adminFee = Math.min(
      Math.max(Math.round(Number(admin_fee_applied) || 0), 0),
      Number(process.env.MAX_ADMIN_FEE || 10000)
    );
    const finalAmount = Math.round(Number(b.total_amount)) + adminFee;
    if (finalAmount < 1000)
      return res.status(400).json({ status: 'Error', message: 'Nominal minimal Rp1.000' });

    const finalCustomerName = (customer_name || b.contact_name || 'Customer').substring(0, 30).trim();
    const finalCustomerEmail = (customer_email || b.contact_email || 'guest@mail.com').trim();
    const phone = normalizePhone(customer_phone || b.contact_phone);
    const partner_reff = `PAY-BUS-${Date.now()}`;

    const expired = moment.tz('Asia/Jakarta')
      .add(b.ttl - 60, 'seconds')
      .format('YYYYMMDDHHmmss');

    const callback = process.env.LINKQU_CALLBACK_URL
      || `${process.env.BASE_URL || 'https://bus.siappgo.id'}/api/payments/callback`;

    // Hitung signature sesuai urutan LinkQu (contek backend topup)
    let signature;
    if (method === 'VA') {
      signature = generateSignatureVA({
        amount: finalAmount, expired, bank_code, partner_reff,
        customer_id: phone, customer_name: finalCustomerName, customer_email: finalCustomerEmail,
      });
    } else {
      signature = generateSignatureQRIS({
        amount: finalAmount, expired, partner_reff,
        customer_id: phone, customer_name: finalCustomerName, customer_email: finalCustomerEmail,
      });
    }

    const payload = {
      amount: finalAmount,
      customer_id: phone,
      customer_name: finalCustomerName,
      customer_email: finalCustomerEmail,
      customer_phone: phone,
      partner_reff,
      username: config.username,
      pin: config.pin,
      expired,
      signature,
      url_callback: callback,
    };
    if (method === 'VA') payload.bank_code = bank_code;

    const endpoint = method === 'VA' ? '/transaction/create/va' : '/transaction/create/qris';

    console.log('[LinkQu] POST', config.baseUrl + endpoint);
    console.log('[LinkQu] Payload:', JSON.stringify({ ...payload, pin: '***' }));

    const resp = await axios.post(
      `${config.baseUrl}${endpoint}`,
      payload,
      {
        headers: {
          'client-id': config.clientId,
          'client-secret': config.clientSecret,
          'Content-Type': 'application/json',
        },
        validateStatus: s => s < 600,
        timeout: 30000,
      }
    );

    const data = resp.data;
    console.log('[LinkQu] Response:', JSON.stringify(data));

    if (data.response_code && data.response_code !== '00') {
      return res.status(400).json({
        status: 'Error',
        message: data.response_desc || 'LinkQu menolak permintaan',
        debug: process.env.NODE_ENV !== 'production' ? data : undefined,
      });
    }

    const va = data.virtual_account || data.va_number || data.data?.va_number || null;
    const qr = data.imageqris || data.qr_url || data.data?.qr_url || null;
    if (!va && !qr) throw new Error('LinkQu tidak mengembalikan VA/QRIS: ' + JSON.stringify(data));

    const expiredAt = moment(expired, 'YYYYMMDDHHmmss').format('YYYY-MM-DD HH:mm:ss');

    // =================================================================
    // Simpan ke tabel `payments` (bukan `bus_payments`)
    // Mapping kolom:
    //   partner_reff   → gateway_ref
    //   qris_url       → qr_string
    //   payment_status → status
    //   expired_date   → expires_at
    //   payment_method → method_id  (cari berdasarkan code)
    // =================================================================

    // Cari method_id berdasarkan code (qris / bca_va / dll)
    const methodCode = method === 'VA'
      ? `${String(bank_code).toLowerCase()}_va`  // 002 → "002_va"? → mapping
      : 'qris';

    // Mapping bank_code numerik → code di payment_methods
    const BANK_TO_CODE = {
      '002': 'bri_va',
      '008': 'mandiri_va',
      '009': 'bni_va',
      '014': 'bca_va',
      '451': 'bsi_va',
      '022': 'cimb_va',
      '011': 'danamon_va',
      '013': 'permata_va',
      '028': 'ocbc_va',
    };
    const lookupCode = method === 'VA'
      ? (BANK_TO_CODE[String(bank_code)] || `${String(bank_code).toLowerCase()}_va`)
      : 'qris';

    const { rows: methodRows } = await query(
      `SELECT id FROM payment_methods WHERE code = ? LIMIT 1`,
      [lookupCode]
    );
    const methodId = methodRows[0]?.id || null;

    // Cek apakah sudah ada payment PENDING untuk booking ini → update
    const { rows: existing } = await query(
      `SELECT id FROM payments
        WHERE booking_id = ? AND status = 'pending' LIMIT 1`,
      [b.id]
    );

    if (existing.length) {
      await query(
        `UPDATE payments
            SET gateway_ref  = ?,
                method_id    = ?,
                va_number    = ?,
                qr_string    = ?,
                amount       = ?,
                expires_at   = ?,
                gateway_payload = ?
          WHERE id = ?`,
        [
          partner_reff, methodId, va, qr, finalAmount, expiredAt,
          JSON.stringify(data), existing[0].id,
        ]
      );
    } else {
      await query(
        `INSERT INTO payments
           (booking_id, method_id, amount, status,
            va_number, qr_string, gateway_ref, gateway_payload,
            expires_at, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, NOW())`,
        [
          b.id, methodId, finalAmount, va, qr, partner_reff,
          JSON.stringify(data), expiredAt,
        ]
      );
    }

    res.json({
      status: 'Success',
      partner_reff,
      payment_info: {
        method,
        bank_code: bank_code || null,
        va_number: va,
        qris_url: qr,
        amount: finalAmount,
        expired_at: expiredAt,
      },
    });
  } catch (err) {
    console.error('[PAYMENT CREATE]', err.response?.data || err.message);
    res.status(500).json({
      status: 'Error',
      message: 'Gagal membuat kode pembayaran.',
      ...(process.env.NODE_ENV !== 'production' && {
        debug: err.response?.data || err.message,
      }),
    });
  }
};

// =====================================================================
// Check status ke LinkQu
// =====================================================================
async function fetchGatewayStatus(reff) {
  const resp = await axios.get(
    `${config.baseUrl}/transaction/check-status`,
    {
      params: { partner_reff: reff, username: config.username, pin: config.pin },
      headers: {
        'client-id': config.clientId,
        'client-secret': config.clientSecret,
      },
      validateStatus: s => s < 500,
      timeout: 30000,
    }
  );
  return resp.data || {};
}

const isSuccess = (d) =>
  ['SUCCESS', 'SETTLED'].includes(String(d.status || '').toUpperCase())
  || d.response_code === '00'
  || String(d.response_desc || '').toUpperCase().includes('SUCCESS');

// =====================================================================
// markPaid — sudah pakai tabel `payments`
// =====================================================================
const markPaid = async (partner_reff) => {
  const { rows } = await query(
    `SELECT p.booking_id, p.amount, p.status AS payment_status,
            b.status AS booking_status, b.total_amount
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE p.gateway_ref = ?
      LIMIT 1`,
    [partner_reff]
  );
  if (!rows.length) return null;
  const p = rows[0];

  if (PAID.includes(String(p.payment_status).toUpperCase())) return p.booking_id;

  // Karena kolom `admin_fee` tidak ada di tabel `payments`, bandingkan langsung amount vs total booking
  if (Number(p.amount) < Number(p.total_amount)) {
    console.error('[PAYMENT] nominal kurang dari total booking', partner_reff);
    return null;
  }

  await query(
    `UPDATE payments
        SET status = 'paid',
            paid_at = NOW()
      WHERE gateway_ref = ?`,
    [partner_reff]
  );

  if (p.booking_status !== 'pending_payment') {
    console.error(`[PAYMENT] ${partner_reff} dibayar, tapi booking ${p.booking_id} berstatus ${p.booking_status}. Perlu refund manual.`);
    return null;
  }

  await query(
    `UPDATE bookings b
       JOIN vendors v ON v.id = b.vendor_id
        SET b.status            = 'paid',
            b.paid_at           = NOW(),
            b.commission_amount = ROUND(b.ticket_subtotal * v.commission_percent / 100)
      WHERE b.id = ? AND b.status = 'pending_payment'`,
    [p.booking_id]
  );

  return p.booking_id;
};

// =====================================================================
// Callback
// =====================================================================
const handleCallback = async (req, res) => {
  try {
    const { partner_reff } = req.body || {};
    console.log('[PAYMENT CALLBACK] received:', partner_reff, req.body);

    if (partner_reff && isSuccess(await fetchGatewayStatus(partner_reff))) {
      const bookingId = await markPaid(partner_reff);
      console.log('[PAYMENT CALLBACK] marked paid:', partner_reff, 'booking:', bookingId);
    }
    res.json({ message: 'OK' });
  } catch (err) {
    console.error('[PAYMENT CALLBACK]', err.message);
    res.status(500).json({ status: 'ERROR' });
  }
};

// =====================================================================
// Check status (dari DB + LinkQu) — sudah pakai tabel `payments`
// =====================================================================
const checkStatus = async (req, res) => {
  const { reff } = req.params;
  try {
    const { rows } = await query(
      `SELECT status, booking_id FROM payments WHERE gateway_ref = ? LIMIT 1`,
      [reff]
    );

    if (rows.length && PAID.includes(String(rows[0].status).toUpperCase())) {
      return res.json({ status: 'SUCCESS', payment_status: 'SUCCESS' });
    }

    const d = await fetchGatewayStatus(reff);
    console.log('[PAYMENT STATUS]', reff, JSON.stringify(d));

    if (isSuccess(d)) {
      await markPaid(reff);
      return res.json({ status: 'SUCCESS', payment_status: 'SUCCESS', data: d });
    }

    res.json({ status: 'PENDING', message: 'Menunggu pembayaran', data: d });
  } catch (err) {
    console.error('[PAYMENT STATUS]', err.message);
    res.json({ status: 'PENDING', error: err.message });
  }
};

module.exports = { createPayment, handleCallback, checkStatus };