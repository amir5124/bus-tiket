// utils/notifyVendor.js
const axios = require('axios');
const { query } = require('../config/db');
const { sendMail } = require('./mailer');

// Konfigurasi Jagel
const JAGEL_BASE_URL = process.env.JAGEL_BASE_URL || 'https://api.jagel.id/v1';
const JAGEL_API_KEY = process.env.JAGEL_API_KEY || 'c6wA9HlUkN2PYEpEOYmDwiehrw7QMIVAvPETMpR2NRN4jjnYPO';

const P = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const D = d => d ? require('moment-timezone')(d).tz('Asia/Jakarta').format('DD MMM YYYY HH:mm') : '-';

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
// Bangun baris rincian (dipakai untuk WA/Jagel & email) — dinamis
// sesuai "type" notifikasi, supaya tidak ada field kosong "-"
// =====================================================================
function buildDetailLines(type, data = {}) {
    const lines = [];

    if (type === 'payment_paid') {
        // Notifikasi booking dibayar customer (commission/markup/topup)
        if (data.booking_code) lines.push(['Booking', data.booking_code]);
        if (data.order_no) lines.push(['Order ID', data.order_no]);
        if (data.total_amount !== undefined) lines.push(['Total bayar customer', P(data.total_amount)]);

        if (data.payment_system === 'commission' && data.commission_amount !== undefined) {
            lines.push(['Dipotong komisi', `- ${P(data.commission_amount)}`]);
        } else if (data.payment_system === 'markup' && data.markup_amount !== undefined) {
            lines.push(['Dipotong markup', `- ${P(data.markup_amount)}`]);
        } else if (data.payment_system === 'topup') {
            lines.push(['Potongan', 'Tidak ada (sistem topup)']);
        }

        if (data.vendor_amount !== undefined) lines.push(['Diterima vendor', P(data.vendor_amount)]);
        if (data.method) lines.push(['Metode', data.method]);

    } else if (type === 'topup_paid') {
        // Notifikasi vendor sukses bayar langganan topup
        if (data.amount !== undefined) lines.push(['Nominal topup', P(data.amount)]);
        if (data.period_start) lines.push(['Aktif mulai', D(data.period_start)]);
        if (data.period_end) lines.push(['Aktif sampai', D(data.period_end)]);
        if (data.partner_reff) lines.push(['Referensi', data.partner_reff]);

    } else {
        // Fallback generik — tampilkan semua field data apa adanya
        for (const [k, v] of Object.entries(data || {})) {
            if (v === undefined || v === null || v === '') continue;
            lines.push([k, String(v)]);
        }
    }

    return lines;
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

        const detailLines = buildDetailLines(type, data);

        // 2. In-app notification (insert DB) + kirim WA via Jagel (by username)
        const detailText = detailLines.map(([k, v]) => `${k}: ${v}`).join('\n');
        const jagelContent = `🔔 ${title}\n\n${body}${detailText ? `\n\n${detailText}` : ''}`;

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
                const html = vendorNotifyEmail({ vendor_name, title, body, detailLines });
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
// Template email vendor — sekarang render dari detailLines (dinamis)
// =====================================================================
function vendorNotifyEmail({ vendor_name, title, body, detailLines }) {
    const rows = (detailLines || [])
        .map(([k, v]) => `<tr><td style="padding:4px 8px 4px 0;color:#8a8f9c">${k}</td><td><b>${v}</b></td></tr>`)
        .join('');

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
    <p style="white-space:pre-line">${body}</p>
    ${rows ? `<table style="margin-top:16px;font-size:13px;color:#555;border-collapse:collapse">${rows}</table>` : ''}
  </td></tr>
  <tr><td style="background:#f6f8fc;padding:14px 24px;font-size:12px;color:#8a8f9c;text-align:center">
    Email ini dikirim otomatis oleh sistem Bus & Travel.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

module.exports = { notifyVendor, notifyCustomerByUsername, sendJagelMessageByUsername };