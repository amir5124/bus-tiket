// controllers/paymentController.js
const axios = require('axios');
const crypto = require('crypto');
const moment = require('moment-timezone');
const { query } = require('../config/db');
const { sendMail } = require('../utils/mailer');
const { invoiceEmail } = require('../utils/invoiceTemplate');
const { notifyVendor, notifyCustomerByUsername } = require('../utils/notifyVendor');

// ✅ Cukup require dari utils/jagel — JANGAN deklarasi ulang fungsinya
const { fetchJagelSaldo, adjustJagelSaldo } = require('../utils/jagel');

// =====================================================================
// Kredensial LinkQu
// =====================================================================
const config = {
  clientId: process.env.LINKQU_CLIENT_ID || 'testing',
  clientSecret: process.env.LINKQU_CLIENT_SECRET || '123',
  username: process.env.LINKQU_USERNAME || 'LI307GXIN',
  pin: process.env.LINKQU_PIN || '2K2NPCBBNNTovgB',
  serverKey: process.env.LINKQU_SERVER_KEY || 'LinkQu@2020',
  baseUrl: process.env.LINKQU_BASE_URL || 'https://gateway-dev.linkqu.id/linkqu-partner',
};

const PAID = ['SUCCESS', 'SETTLED', 'PAID'];

const LINKU_JAGEL_USERNAME = process.env.LINKU_JAGEL_USERNAME || 'amir';

// =====================================================================
// SIGNATURE — contek dari backend topup yang WORK
// =====================================================================
function cleanValue(str) {
  return String(str).replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
}
function hmac256(serverKey, data) {
  return crypto.createHmac('sha256', serverKey).update(data).digest('hex');
}
function generateSignatureVA(fields) {
  const raw = cleanValue(
    fields.amount + fields.expired + fields.bank_code + fields.partner_reff +
    fields.customer_id + fields.customer_name + fields.customer_email + config.clientId
  );
  return hmac256(config.serverKey, '/transaction/create/va' + 'POST' + raw);
}
function generateSignatureQRIS(fields) {
  const raw = cleanValue(
    fields.amount + fields.expired + fields.partner_reff +
    fields.customer_id + fields.customer_name + fields.customer_email + config.clientId
  );
  return hmac256(config.serverKey, '/transaction/create/qris' + 'POST' + raw);
}

// =====================================================================
// Helper
// =====================================================================
function normalizePhone(phone) {
  let p = String(phone || '').replace(/[^0-9]/g, '');
  if (p.startsWith('0')) p = '+62' + p.slice(1);
  else if (p.startsWith('8')) p = '+62' + p;
  else if (p.startsWith('62')) p = '+' + p;
  else if (!p.startsWith('+')) p = '+62' + p;
  return p.length < 10 ? '+628123456789' : p;
}

const BANK_TO_CODE = {
  '002': 'bri_va', '008': 'mandiri_va', '009': 'bni_va', '014': 'bca_va',
  '451': 'bsi_va', '022': 'cimb_va', '011': 'danamon_va', '013': 'permata_va',
  '028': 'ocbc_va', '016': 'maybank_va', '019': 'panin_va',
};

// ❌ SUDAH TIDAK ADA fetchJagelSaldo & adjustJagelSaldo DI SINI
// (sudah diimpor dari ../utils/jagel di atas)

// =====================================================================
// KIRIM INVOICE VIA EMAIL
// =====================================================================
async function sendInvoiceEmail(bookingId) {
  try {
    const { rows: checkRows } = await query(
      `SELECT eticket_sent_at, contact_email, booking_code FROM bookings WHERE id = ? LIMIT 1`,
      [bookingId]
    );
    if (!checkRows.length) {
      console.warn('[INVOICE] booking tidak ditemukan:', bookingId);
      return;
    }
    if (checkRows[0].eticket_sent_at) {
      console.log('[INVOICE] sudah dikirim sebelumnya:', checkRows[0].booking_code);
      return;
    }

    const { rows: bookingRows } = await query(
      `SELECT b.*,
              v.name AS vendor_name,
              s.departure_at, s.arrival_at,
              veh.class_name,
              oc.name AS origin_city, dc.name AS destination_city
         FROM bookings b
         JOIN vendors v ON v.id = b.vendor_id
         JOIN schedules s ON s.id = b.schedule_id
         JOIN vehicles veh ON veh.id = s.vehicle_id
         JOIN routes r ON r.id = s.route_id
         JOIN cities oc ON oc.id = r.origin_city_id
         JOIN cities dc ON dc.id = r.destination_city_id
        WHERE b.id = ?
        LIMIT 1`,
      [bookingId]
    );
    if (!bookingRows.length) {
      console.warn('[INVOICE] booking tidak ditemukan (query lengkap):', bookingId);
      return;
    }
    const booking = bookingRows[0];

    const { rows: passengers } = await query(
      `SELECT passenger_no, full_name, seat_number, ticket_code, insurance_selected
         FROM booking_passengers
        WHERE booking_id = ?
        ORDER BY passenger_no`,
      [bookingId]
    );
    booking.passengers = passengers;

    const { rows: payments } = await query(
      `SELECT p.amount, p.status, p.paid_at,
              pm.name AS payment_method
         FROM payments p
         LEFT JOIN payment_methods pm ON pm.id = p.method_id
        WHERE p.booking_id = ?
        ORDER BY p.id DESC LIMIT 1`,
      [bookingId]
    );
    booking.payments = payments;

    const html = invoiceEmail(booking);

    await sendMail({
      to: booking.contact_email,
      subject: `E-Ticket & Invoice ${booking.booking_code} — ${booking.origin_city} → ${booking.destination_city}`,
      html,
    });

    await query(`UPDATE bookings SET eticket_sent_at = NOW() WHERE id = ?`, [bookingId]);

    console.log('[INVOICE] ✅ terkirim untuk booking', bookingId, '→', booking.contact_email);
  } catch (err) {
    console.error('[INVOICE] ❌ gagal kirim untuk booking', bookingId, ':', err.message);
  }
}

// =====================================================================
// POST /api/payments/create — LinkQu VA/QRIS
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
        WHERE ${booking_id ? 'b.id' : 'b.booking_code'} = ?
        LIMIT 1`,
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

    const lookupCode = method === 'VA'
      ? (BANK_TO_CODE[String(bank_code)] || `${String(bank_code).toLowerCase()}_va`)
      : 'qris';

    const { rows: methodRows } = await query(
      `SELECT id FROM payment_methods WHERE code = ? LIMIT 1`,
      [lookupCode]
    );
    const methodId = methodRows[0]?.id || null;

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
// COIN — Cek saldo (langsung ke Jagel)
// GET /api/payments/coin/balance?user=amir
// =====================================================================
const checkCoinBalance = async (req, res) => {
  const { user } = req.query;
  if (!user) return res.status(400).json({ status: 'Error', message: 'user wajib diisi' });

  try {
    const saldoObj = await fetchJagelSaldo(user);
    if (!saldoObj) {
      return res.status(404).json({
        status: 'Error',
        message: 'User tidak ditemukan atau saldo tidak terbaca',
      });
    }

    res.json({
      status: 'Success',
      user,
      balance: saldoObj.balance,
      balance_active: saldoObj.balance_active,
    });
  } catch (err) {
    console.error('[COIN-BALANCE]', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
};

// =====================================================================
// COIN — Potong saldo & tandai booking paid
// POST /api/payments/coin/pay
// =====================================================================
const payWithCoin = async (req, res) => {
  const { user, amount, booking_code, order_no, description } = req.body || {};
  if (!user || !amount) {
    return res.status(400).json({ status: 'Error', message: 'user dan amount wajib' });
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ status: 'Error', message: 'amount tidak valid' });
  }

  try {
    const saldoObj = await fetchJagelSaldo(user);
    if (!saldoObj) {
      return res.status(404).json({ status: 'Error', message: 'Gagal membaca saldo user' });
    }

    const saldoAktif = saldoObj.balance_active;
    if (saldoAktif < amt) {
      return res.status(400).json({
        status: 'Error',
        message: `Saldo tidak cukup. Saldo aktif: ${saldoAktif}, butuh: ${amt}`,
        balance_active: saldoAktif,
      });
    }

    const reference = 'COIN-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const note = description || `Pembayaran booking ${booking_code || '-'} | Ref: ${reference}`;
    await adjustJagelSaldo(user, -Math.abs(amt), note);

    const newBalance = saldoAktif - amt;
    console.log(`[COIN-PAY] ${user} dipotong ${amt}: ${saldoAktif} → ${newBalance}`);

    if (booking_code) {
      try {
        await coinConfirmInternal({ user, amount: amt, booking_code, order_no, reference });
      } catch (e) {
        console.error('[COIN-PAY] ❌ coinConfirm internal gagal:', e.message, e.stack);
        return res.status(500).json({
          status: 'Error',
          message: 'Saldo sudah dipotong, tapi gagal update booking: ' + e.message,
          reference,
          balance_after: newBalance,
          booking_code,
        });
      }
    }

    res.json({
      status: 'Success',
      user,
      amount: amt,
      balance_before: saldoAktif,
      balance_after: newBalance,
      reference,
      booking_code: booking_code || null,
    });
  } catch (err) {
    console.error('[COIN-PAY] error:', err.message, err.stack);
    res.status(500).json({ status: 'Error', message: err.message });
  }
};

// =====================================================================
// COIN — Konfirmasi pembayaran coin
// POST /api/payments/coin-confirm
// =====================================================================
const coinConfirm = async (req, res) => {
  try {
    const { user, amount, booking_code, order_no, reference } = req.body || {};
    const internalKey = req.headers['x-internal-key'];

    if (process.env.BUS_INTERNAL_KEY && internalKey && internalKey !== process.env.BUS_INTERNAL_KEY) {
      return res.status(401).json({ status: 'Error', message: 'Invalid internal key' });
    }
    if (!booking_code) {
      return res.status(400).json({ status: 'Error', message: 'booking_code wajib' });
    }

    const result = await coinConfirmInternal({ user, amount, booking_code, order_no, reference });
    res.json({ status: 'Success', ...result });
  } catch (err) {
    console.error('[COIN-CONFIRM]', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
};

// =====================================================================
// coinConfirmInternal — update booking, invoice, notif vendor & customer
// =====================================================================
async function coinConfirmInternal({ user, amount, booking_code, order_no, reference }) {
  console.log('[COIN-CONFIRM] mulai untuk booking_code=', booking_code);

  const { rows } = await query(
    `SELECT b.*,
            v.id AS vendor_id, v.name AS vendor_name,
            v.contact_email AS vendor_email, v.contact_phone AS vendor_phone,
            s.departure_at, s.arrival_at,
            veh.class_name,
            oc.name AS origin_city, dc.name AS destination_city
       FROM bookings b
       JOIN vendors v ON v.id = b.vendor_id
       JOIN schedules s ON s.id = b.schedule_id
       JOIN vehicles veh ON veh.id = s.vehicle_id
       JOIN routes r ON r.id = s.route_id
       JOIN cities oc ON oc.id = r.origin_city_id
       JOIN cities dc ON dc.id = r.destination_city_id
      WHERE b.booking_code = ? LIMIT 1`,
    [booking_code]
  );
  if (!rows.length) {
    console.error('[COIN-CONFIRM] ❌ booking tidak ditemukan:', booking_code);
    throw new Error('Booking tidak ditemukan: ' + booking_code);
  }
  const booking = rows[0];

  if (booking.status === 'paid') {
    console.log('[COIN-CONFIRM] sudah paid (skip):', booking_code);
    return { booking_code, already_paid: true };
  }

  if (amount && Number(amount) < Number(booking.total_amount)) {
    throw new Error('Nominal kurang dari total booking');
  }

  const { rows: coinMethod } = await query(
    `SELECT id FROM payment_methods WHERE code = 'coin' LIMIT 1`
  );
  const coinMethodId = coinMethod[0]?.id || null;
  if (!coinMethodId) {
    throw new Error('payment_methods code "coin" belum ada. Jalankan INSERT INTO payment_methods (code, name, type, icon) VALUES (\'coin\',\'Koin LinkU\',\'ewallet\',\'mdi:hand-coin\');');
  }

  const ref = reference || ('COIN-' + Date.now());

  const { rows: existing } = await query(
    `SELECT id FROM payments WHERE booking_id = ? AND status = 'pending' LIMIT 1`,
    [booking.id]
  );
  if (existing.length) {
    await query(
      `UPDATE payments
          SET gateway_ref = ?, method_id = ?, amount = ?, status = 'paid', paid_at = NOW(),
              qr_string = NULL, va_number = NULL
        WHERE id = ?`,
      [ref, coinMethodId, amount || booking.total_amount, existing[0].id]
    );
  } else {
    await query(
      `INSERT INTO payments
         (booking_id, method_id, amount, status, gateway_ref, paid_at, created_at)
       VALUES (?, ?, ?, 'paid', ?, NOW(), NOW())`,
      [booking.id, coinMethodId, amount || booking.total_amount, ref]
    );
  }

  await query(
    `UPDATE bookings b
       JOIN vendors v ON v.id = b.vendor_id
        SET b.status = 'paid',
            b.paid_at = NOW(),
            b.commission_amount = ROUND(b.ticket_subtotal * v.commission_percent / 100)
      WHERE b.id = ? AND b.status = 'pending_payment'`,
    [booking.id]
  );

  console.log(`[COIN-CONFIRM] ✅ Booking ${booking_code} paid via coin (user=${user})`);

  try {
    await sendInvoiceEmail(booking.id);
  } catch (e) {
    console.error('[COIN-CONFIRM] ❌ invoice gagal:', e.message, e.stack);
  }

  try {
    await notifyVendor({
      vendor_id: booking.vendor_id,
      vendor_name: booking.vendor_name,
      vendor_email: booking.vendor_email,
      vendor_phone: booking.vendor_phone,
      type: 'payment_paid',
      title: `Pembayaran diterima — ${booking.booking_code}`,
      body: `Customer ${booking.contact_name} membayar ${booking.seats_count} kursi via Koin LinkU.`,
      data: {
        booking_code: booking.booking_code,
        order_no: booking.order_no,
        amount: booking.total_amount,
        method: 'COIN',
        user,
        reference: ref,
      },
    });
  } catch (e) {
    console.error('[COIN-CONFIRM] ❌ notif vendor gagal:', e.message);
  }

  if (booking.user_id) {
    try {
      const { rows: userRows } = await query(
        `SELECT username FROM app_users WHERE id = ? LIMIT 1`,
        [booking.user_id]
      );
      if (userRows.length && userRows[0].username) {
        await notifyCustomerByUsername(
          userRows[0].username,
          `✅ Pembayaran BERHASIL\n\n` +
          `Booking: ${booking.booking_code}\n` +
          `Rute: ${booking.origin_city} → ${booking.destination_city}\n` +
          `Total: Rp ${Number(booking.total_amount).toLocaleString('id-ID')}\n` +
          `Metode: Koin LinkU\n\n` +
          `E-tiket dikirim ke email ${booking.contact_email}. Terima kasih!`
        );
      }
    } catch (e) {
      console.error('[COIN-CONFIRM] ❌ notif customer gagal:', e.message);
    }
  }

  return { booking_code, paid: true };
}

const markPaid = async (partner_reff) => {
  const { rows } = await query(
    `SELECT p.booking_id, p.amount, p.status AS payment_status,
            b.status AS booking_status, b.booking_code, b.order_no,
            b.total_amount, b.ticket_subtotal, b.vendor_id,
            v.name AS vendor_name, v.contact_email AS vendor_email, v.contact_phone AS vendor_phone,
            v.payment_system, v.commission_percent, v.markup_percent,
            u.username AS vendor_owner_username,
            pm.name AS method_name
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN vendors v ON v.id = b.vendor_id
       JOIN app_users u ON u.id = v.owner_user_id
       LEFT JOIN payment_methods pm ON pm.id = p.method_id
      WHERE p.gateway_ref = ?
      LIMIT 1`,
    [partner_reff]
  );
  if (!rows.length) {
    console.warn('[markPaid] payment tidak ditemukan:', partner_reff);
    return null;
  }
  const p = rows[0];

  if (PAID.includes(String(p.payment_status).toUpperCase())) {
    console.log('[markPaid] sudah paid (skip):', partner_reff);
    return p.booking_id;
  }

  if (Number(p.amount) < Number(p.total_amount)) {
    console.error('[markPaid] nominal kurang', partner_reff);
    return null;
  }

  const totalAmount = Number(p.total_amount);
  const ticketSubtotal = Number(p.ticket_subtotal);
  let platformAmount = 0;
  let vendorAmount = totalAmount;
  let markupAmount = 0;
  let commissionAmount = 0;

  if (p.payment_system === 'commission') {
    commissionAmount = Math.round(ticketSubtotal * Number(p.commission_percent) / 100);
    platformAmount = commissionAmount;
    vendorAmount = totalAmount - platformAmount;
  } else if (p.payment_system === 'markup') {
    markupAmount = Math.round(ticketSubtotal * Number(p.markup_percent) / 100);
    platformAmount = markupAmount;
    vendorAmount = totalAmount - markupAmount;
  } else if (p.payment_system === 'topup') {
    platformAmount = 0;
    vendorAmount = totalAmount;
  }

  console.log(`[markPaid] ✅ booking ${p.booking_id} paid
  - Sistem: ${p.payment_system}
  - Total: Rp ${totalAmount}
  - Vendor dapat: Rp ${vendorAmount}
  - Platform dapat: Rp ${platformAmount}`);

  await query(
    `UPDATE payments SET status = 'paid', paid_at = NOW() WHERE gateway_ref = ?`,
    [partner_reff]
  );

  if (p.booking_status !== 'pending_payment') {
    console.error(
      `[markPaid] ${partner_reff} dibayar, tapi booking ${p.booking_id} berstatus ${p.booking_status}. Perlu refund manual.`
    );
    return null;
  }

  await query(
    `UPDATE bookings
        SET status = 'paid',
            paid_at = NOW(),
            payment_system = ?,
            commission_amount = ?,
            platform_amount = ?,
            vendor_amount = ?,
            markup_amount = ?
      WHERE id = ? AND status = 'pending_payment'`,
    [p.payment_system, commissionAmount, platformAmount, vendorAmount, markupAmount, p.booking_id]
  );

  if (p.payment_system === 'topup') {
    if (p.vendor_owner_username) {
      try {
        await adjustJagelSaldo(
          p.vendor_owner_username,
          totalAmount,
          `Penjualan tiket booking ${p.booking_code} (${partner_reff}) — sistem topup, tanpa potongan`
        );
        console.log(`[markPaid] ✅ Rp ${totalAmount} masuk Jagel vendor @${p.vendor_owner_username}`);
      } catch (e) {
        console.error(`[markPaid] ❌ gagal kredit Jagel vendor @${p.vendor_owner_username}:`, e.message);
      }
    } else {
      console.error('[markPaid] ❌ vendor tidak punya username Jagel, tidak bisa adjust saldo');
    }
  } else if (p.payment_system === 'commission' || p.payment_system === 'markup') {
    try {
      await adjustJagelSaldo(
        LINKU_JAGEL_USERNAME,
        totalAmount,
        `Escrow booking ${p.booking_code} (${partner_reff}) — sistem ${p.payment_system}, ` +
        `dipotong ${platformAmount}, hak vendor ${vendorAmount}`
      );
      console.log(`[markPaid] ✅ Rp ${totalAmount} masuk escrow Jagel @${LINKU_JAGEL_USERNAME}`);
    } catch (e) {
      console.error(`[markPaid] ❌ gagal kredit Jagel escrow @${LINKU_JAGEL_USERNAME}:`, e.message);
    }
  }

  try {
    await notifyVendor({
      vendor_id: p.vendor_id,
      vendor_name: p.vendor_name,
      vendor_email: p.vendor_email,
      vendor_phone: p.vendor_phone,
      type: 'payment_paid',
      title: `Pembayaran diterima — ${p.booking_code}`,
      body: `Pembayaran booking ${p.booking_code} berhasil diterima customer.`,
      data: {
        booking_code: p.booking_code,
        order_no: p.order_no,
        total_amount: totalAmount,
        payment_system: p.payment_system,
        commission_amount: commissionAmount,
        markup_amount: markupAmount,
        platform_amount: platformAmount,
        vendor_amount: vendorAmount,
        method: p.method_name || null,
      },
    });
    console.log('[markPaid] ✅ notif vendor terkirim');
  } catch (e) {
    console.error('[markPaid] ❌ notif vendor gagal:', e.message);
  }

  sendInvoiceEmail(p.booking_id).catch(err =>
    console.error('[INVOICE] async error:', err.message)
  );

  return p.booking_id;
};

// =====================================================================
// POST /api/payments/callback
// =====================================================================
const handleCallback = async (req, res) => {
  try {
    const body = req.body || {};
    const { partner_reff, status, response_code, response_desc } = body;

    console.log('[PAYMENT CALLBACK] received:', partner_reff, JSON.stringify(body));

    if (!partner_reff) {
      return res.status(400).json({ status: 'ERROR', message: 'partner_reff missing' });
    }

    const isPaid =
      String(status || '').toUpperCase() === 'SUCCESS' ||
      String(response_code || '') === '00';

    if (!isPaid) {
      console.log('[PAYMENT CALLBACK] belum paid:', partner_reff, status, response_code, response_desc);
      return res.json({ message: 'OK - not paid yet' });
    }

    const bookingId = await markPaid(partner_reff);
    console.log('[PAYMENT CALLBACK] marked paid:', partner_reff, 'booking:', bookingId);

    res.json({ message: 'OK' });
  } catch (err) {
    console.error('[PAYMENT CALLBACK]', err.message);
    res.status(500).json({ status: 'ERROR' });
  }
};

// =====================================================================
// GET /api/payments/status/:reff
// =====================================================================
const checkStatus = async (req, res) => {
  const { reff } = req.params;
  try {
    const { rows } = await query(
      `SELECT status, booking_id FROM payments WHERE gateway_ref = ? LIMIT 1`,
      [reff]
    );

    if (!rows.length) {
      return res.json({ status: 'PENDING', message: 'Pembayaran belum terdaftar' });
    }

    const st = String(rows[0].status).toUpperCase();
    if (PAID.includes(st)) {
      return res.json({
        status: 'SUCCESS',
        payment_status: 'SUCCESS',
        booking_id: rows[0].booking_id,
      });
    }

    res.json({ status: 'PENDING', message: 'Menunggu pembayaran' });
  } catch (err) {
    console.error('[PAYMENT STATUS]', err.message);
    res.json({ status: 'PENDING', error: err.message });
  }
};

// =====================================================================
// POST /api/payments/resend-invoice/:bookingCode
// =====================================================================
const resendInvoice = async (req, res) => {
  try {
    const { bookingCode } = req.params;
    const { rows } = await query(
      `SELECT id, contact_email, status FROM bookings WHERE booking_code = ? LIMIT 1`,
      [bookingCode]
    );
    if (!rows.length)
      return res.status(404).json({ status: 'Error', message: 'Booking tidak ditemukan' });
    if (rows[0].status !== 'paid')
      return res.status(400).json({ status: 'Error', message: 'Booking belum dibayar' });

    await query(`UPDATE bookings SET eticket_sent_at = NULL WHERE id = ?`, [rows[0].id]);
    await sendInvoiceEmail(rows[0].id);

    res.json({ status: 'Success', message: 'Invoice dikirim ke ' + rows[0].contact_email });
  } catch (err) {
    console.error('[RESEND INVOICE]', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
};

// =====================================================================
// GET /api/payments/notifications/vendor?vendor_id=1
// =====================================================================
const getVendorNotifications = async (req, res) => {
  const { vendor_id } = req.query;
  if (!vendor_id) return res.status(400).json({ status: 'Error', message: 'vendor_id wajib' });

  try {
    const { rows } = await query(
      `SELECT id, type, channel, title, body, data, is_read, created_at
         FROM notifications
        WHERE vendor_id = ?
        ORDER BY created_at DESC
        LIMIT 100`,
      [vendor_id]
    );
    res.json({ status: 'Success', data: rows });
  } catch (err) {
    console.error('[VENDOR-NOTIF]', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
};

// =====================================================================
// EXPORTS
// =====================================================================
module.exports = {
  createPayment,
  handleCallback,
  checkStatus,
  resendInvoice,
  coinConfirm,
  checkCoinBalance,
  payWithCoin,
  getVendorNotifications,
  adjustJagelSaldo,   // re-export dari utils/jagel
};