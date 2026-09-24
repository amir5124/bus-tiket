const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE) === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

async function sendMail({ to, subject, html, text, attachments }) {
    try {
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
        throw err;
    }
}

module.exports = { sendMail };