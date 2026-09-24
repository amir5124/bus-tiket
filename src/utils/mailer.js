// utils/mailer.js
const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
    if (_transporter) return _transporter;

    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = String(process.env.SMTP_SECURE) === 'true';
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    // Validasi supaya gagalnya jelas
    if (!host) {
        console.error('[MAIL] ❌ SMTP_HOST tidak ter-set di environment!');
        console.error('[MAIL]    Cek file .env harus ada di root project.');
        throw new Error('SMTP_HOST belum di-set');
    }
    if (!user || !pass) {
        console.error('[MAIL] ❌ SMTP_USER / SMTP_PASS kosong.');
        throw new Error('SMTP_USER/SMTP_PASS belum di-set');
    }

    console.log(`[MAIL] 🔧 Init transporter → ${host}:${port} (secure=${secure}, user=${user})`);

    _transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
        // Timeout biar tidak menggantung
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
    });

    return _transporter;
}

async function sendMail({ to, subject, html, text, attachments }) {
    try {
        const transporter = getTransporter();
        const info = await transporter.sendMail({
            from: process.env.SMTP_FROM || 'Bus & Travel <no-reply@siappgo.id>',
            to, subject, html,
            text: text || undefined,
            attachments: attachments || undefined,
        });
        console.log('[MAIL] ✅ terkirim:', to, info.messageId);
        return info;
    } catch (err) {
        console.error('[MAIL] ❌ gagal:', err.message);
        if (err.code) console.error('[MAIL]    code:', err.code);
        if (err.response) console.error('[MAIL]    response:', err.response);
        throw err;
    }
}

module.exports = { sendMail };