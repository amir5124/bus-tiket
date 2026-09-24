// utils/mailer.js
const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
    if (_transporter) return _transporter;

    // Prioritas: process.env → fallback default
    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || 'false') === 'true';
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM || 'Bus & Travel <no-reply@siappgo.id>';

    // user & pass TIDAK boleh di-default — harus dari env
    if (!user || !pass) {
        console.error('[MAIL] ❌ SMTP_USER / SMTP_PASS tidak ter-set di environment!');
        console.error('[MAIL]    Pastikan file .env ada di root project dan berisi:');
        console.error('[MAIL]    SMTP_USER=your-email@gmail.com');
        console.error('[MAIL]    SMTP_PASS=your-app-password');
        console.error('[MAIL]    SMTP_HOST saat ini:', host, '(dari', process.env.SMTP_HOST ? 'env' : 'default', ')');
        throw new Error('SMTP_USER/SMTP_PASS belum di-set');
    }

    console.log(`[MAIL] 🔧 Init transporter → ${host}:${port} (secure=${secure}, user=${user})`);
    if (!process.env.SMTP_HOST) {
        console.warn('[MAIL] ⚠️ SMTP_HOST tidak ada di env, pakai default:', host);
    }

    _transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
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