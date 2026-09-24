// utils/notifyVendor.js
const axios = require('axios');
const { query } = require('../config/db');
const { sendMail } = require('./mailer');

// Konfigurasi Jagel
const JAGEL_BASE_URL = process.env.JAGEL_BASE_URL || 'https://api.jagel.id/v1';
const JAGEL_API_KEY = process.env.JAGEL_API_KEY || 'c6wA9HlUkN2PYEpEOYmDwiehrw7QMIVAvPETMpR2NRN4jjnYPO';

// =====================================================================
// Kirim pesan ke user Jagel (by username)
// =====================================================================
async function sendJagelMessageByUsername(username, content) {
    if (!username) return { success: false, error: 'username kosong' };

    try {
        const resp = await axios.post(`${JAGEL_BASE_URL}/message/send`, {
            type: 'username',
            value: username,
            apikey: JAGEL_API_KEY,
            content: content,
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            timeout: 30000,
        });

        const data = resp.data || {};
        if (data.success === false) {
            throw new Error(data.message || 'Jagel tolak pesan');
        }
        console.log(`[NOTIFY-JAGEL] ✅ terkirim ke username=${username}`);
        return { success: true, data };
    } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        console.error(`[NOTIFY-JAGEL] ❌ gagal ke username=${username}:`, errMsg);
        return { success: false, error: errMsg };
    }
}

// =====================================================================
// Notifikasi ke VENDOR (via Jagel pakai username member + email)
// =====================================================================
async function notifyVendor({
    vendor_id,
    vendor_name,
    vendor_email,
    vendor_phone,
    type,
    title,
    body,
    data,
}) {
    try {
        // 1. Ambil semua member vendor + username Jagel-nya
        const { rows: members } = await query(
            `SELECT m.user_id,
              u.jagel_user_id,
              u.username,
              u.full_name,
              u.email    AS user_email,
              u.phone    AS user_phone
         FROM vendor_members m
         JOIN app_users u ON u.id = m.user_id
        WHERE m.vendor_id = ? AND m.notify_enabled = 1`,
            [vendor_id]
        );

        // 2. In-app notification (insert DB) + kirim WA via Jagel (by username)
        const jagelContent =
            `🔔 ${title}\n\n${body}\n\n` +
            `Booking: ${data?.booking_code || '-'}\n` +
            `Order ID: ${data?.order_no || '-'}\n` +
            `Total: Rp ${Number(data?.amount || 0).toLocaleString('id-ID')}\n` +
            `Metode: ${data?.method || '-'}`;

        for (const m of members) {
            // 2a. Insert in-app
            try {
                await query(
                    `INSERT INTO notifications
             (recipient_user_id, vendor_id, type, channel, title, body, data)
           VALUES (?, ?, ?, 'in_app', ?, ?, ?)`,
                    [m.user_id, vendor_id, type, title, body, JSON.stringify(data || {})]
                );
            } catch (e) {
                console.error('[NOTIFY-VENDOR] in-app insert gagal:', e.message);
            }

            // 2b. Kirim via Jagel (by username)
            if (m.username) {
                const result = await sendJagelMessageByUsername(m.username, jagelContent);
                if (result.success) {
                    // Log ke tabel notifications sebagai channel WA
                    try {
                        await query(
                            `INSERT INTO notifications
                 (recipient_user_id, vendor_id, type, channel, title, body, data, delivery_status, sent_at)
               VALUES (?, ?, ?, 'push', ?, ?, ?, 'sent', NOW())`,
                            [m.user_id, vendor_id, type, title, body, JSON.stringify(data || {})]
                        );
                    } catch (e) { /* silent */ }
                }
            }
        }
        console.log(`[NOTIFY-VENDOR] in-app + Jagel untuk ${members.length} member vendor ${vendor_id}`);

        // 3. Email ke vendor.contact_email (opsional — kalau vendor set email)
        if (vendor_email) {
            try {
                const html = vendorNotifyEmail({ vendor_name, title, body, data });
                await sendMail({
                    to: vendor_email,
                    subject: `[${vendor_name}] ${title}`,
                    html,
                });
                console.log(`[NOTIFY-VENDOR] email terkirim ke ${vendor_email}`);

                await query(
                    `INSERT INTO notifications
             (recipient_user_id, vendor_id, type, channel, title, body, data, delivery_status, sent_at)
           VALUES (NULL, ?, ?, 'email', ?, ?, ?, 'sent', NOW())`,
                    [vendor_id, type, title, body, JSON.stringify(data || {})]
                );
            } catch (e) {
                console.error('[NOTIFY-VENDOR] email gagal:', e.message);
            }
        }
    } catch (err) {
        console.error('[NOTIFY-VENDOR] error:', err.message);
        throw err;
    }
}

// =====================================================================
// Notifikasi ke CUSTOMER via username Jagel (kalau customer punya akun)
// =====================================================================
async function notifyCustomerByUsername(username, content) {
    return sendJagelMessageByUsername(username, content);
}

// =====================================================================
// Template email vendor
// =====================================================================
function vendorNotifyEmail({ vendor_name, title, body, data }) {
    const P = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#eef1f8;font-family:Arial,sans-serif">
<table width="100%" style="padding:24px 0"><tr><td align="center">
<table width="600" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.05)">
  <tr><td style="background:linear-gradient(120deg,#0d6e6a,#24b3ae);padding:20px 24px;color:#fff">
    <h1 style="margin:0;font-size:20px">${title}</h1>
    <p style="margin:6px 0 0;opacity:.9;font-size:13px">${vendor_name}</p>
  </td></tr>
  <tr><td style="padding:24px;font-size:14px;line-height:1.6;color:#2d2f36">
    <p>${body}</p>
    <table style="margin-top:16px;font-size:13px;color:#555">
      ${data?.booking_code ? `<tr><td>Booking</td><td><b>${data.booking_code}</b></td></tr>` : ''}
      ${data?.order_no ? `<tr><td>Order ID</td><td><b>${data.order_no}</b></td></tr>` : ''}
      ${data?.amount ? `<tr><td>Total</td><td><b>${P(data.amount)}</b></td></tr>` : ''}
      ${data?.method ? `<tr><td>Metode</td><td><b>${data.method}</b></td></tr>` : ''}
      ${data?.reference ? `<tr><td>Referensi</td><td><b>${data.reference}</b></td></tr>` : ''}
    </table>
  </td></tr>
  <tr><td style="background:#f6f8fc;padding:14px 24px;font-size:12px;color:#8a8f9c;text-align:center">
    Email ini dikirim otomatis oleh sistem Bus & Travel.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

module.exports = { notifyVendor, notifyCustomerByUsername, sendJagelMessageByUsername };