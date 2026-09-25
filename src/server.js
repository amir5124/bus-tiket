// =====================================================================
// server.js
// Bus & Travel API — entry point
// =====================================================================
require('dotenv').config();

// === VALIDASI ENV WAJIB (fail fast) ===
const REQUIRED_ENV = [
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'JWT_SECRET',
  'LINKQU_CLIENT_ID', 'LINKQU_CLIENT_SECRET',
  'LINKQU_USERNAME', 'LINKQU_PIN', 'LINKQU_SERVER_KEY',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ [Server] ENV berikut belum diset:', missing.join(', '));
  console.error('   Pastikan file .env ada dan ter-load (Docker: pakai env_file / --env-file).');
  process.exit(1);
}
console.log('✅ [Server] Semua ENV wajib tersedia.');

const app = require('./app');
const { pool, testConnection, query } = require('./config/db'); // ✅ path diperbaiki + query diimport
const bookingOps = require('./utils/bookingOps');

const PORT = process.env.PORT || 4000;
const EXPIRY_JOB_MS = Number(process.env.EXPIRY_JOB_MS || 60_000);

(async () => {
  // -----------------------------------------------------------------
  // 1. Cek koneksi database
  // -----------------------------------------------------------------
  console.log('🔌 [Server] Memeriksa koneksi database...');
  const dbOk = await testConnection();

  if (!dbOk) {
    console.error('⚠️  [Server] Server tetap dijalankan, tapi database TIDAK terhubung.');
    console.error('    Periksa konfigurasi .env (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME).');
  }

  // -----------------------------------------------------------------
  // 2. Jalankan HTTP server
  // -----------------------------------------------------------------
  const server = app.listen(PORT, () => {
    console.log(`🚌 Bus & Travel API berjalan di port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });

  // -----------------------------------------------------------------
  // 3. Background job: expire booking pending
  // -----------------------------------------------------------------
  let expiryJob = null;
  if (dbOk) {
    expiryJob = bookingOps.startExpiryJob(EXPIRY_JOB_MS);
    console.log(`⏱️  [Server] Expiry job aktif (setiap ${EXPIRY_JOB_MS / 1000}s)`);
  } else {
    console.warn('⏱️  [Server] Expiry job TIDAK dijalankan karena database tidak terhubung.');
  }

  // -----------------------------------------------------------------
  // 3b. Cron: auto-unpublish topup expired (setiap 30 menit)
  //     ✅ Tidak lagi pakai require('./src/config/db') yang salah path
  // -----------------------------------------------------------------
  const topupCron = setInterval(async () => {
    try {
      const { rows: expiredVendors } = await query(
        `SELECT id, name FROM vendors
          WHERE payment_system = 'topup'
            AND status = 'active'
            AND topup_active_until IS NOT NULL
            AND topup_active_until < NOW()`
      );

      for (const v of expiredVendors) {
        const r = await query(
          `UPDATE schedules SET status = 'unpublished'
            WHERE vendor_id = ? AND status = 'published'`,
          [v.id]
        );

        if (r.rowCount > 0) {
          await query(
            `INSERT INTO notifications
               (recipient_user_id, vendor_id, type, channel, title, body, data)
             SELECT vm.user_id, ?, 'system', 'in_app',
                    'Topup expired',
                    'Masa aktif topup habis. Jadwal di-unpublish. Silakan topup ulang.',
                    JSON_OBJECT('vendor_id', ?)
               FROM vendor_members vm
              WHERE vm.vendor_id = ? AND vm.role = 'owner'`,
            [v.id, v.id, v.id]
          );
          console.log(`[TOPUP-CRON] Vendor ${v.id} (${v.name}): ${r.rowCount} jadwal di-unpublish`);
        }
      }
    } catch (e) {
      console.error('[TOPUP-CRON]', e.message);
    }
  }, 30 * 60 * 1000);
  topupCron.unref?.(); // biar tidak menahan process saat shutdown

  // -----------------------------------------------------------------
  // 4. Graceful shutdown
  // -----------------------------------------------------------------
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[Server] Menerima ${signal}, mematikan server dengan aman...`);

    if (expiryJob) {
      clearInterval(expiryJob);
      console.log('[Server] Expiry job dihentikan.');
    }
    if (topupCron) {
      clearInterval(topupCron);
      console.log('[Server] Topup cron dihentikan.');
    }

    const forceTimer = setTimeout(() => {
      console.error('[Server] Timeout menutup server, paksa keluar.');
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    server.close(async (err) => {
      if (err) console.error('[Server] Error saat close:', err);

      try {
        await pool.end();
        console.log('[Server] Database pool ditutup.');
      } catch (e) {
        console.error('[Server] Error menutup pool:', e.message);
      }

      clearTimeout(forceTimer);
      console.log('[Server] Selesai. Sampai jumpa!');
      process.exit(0);
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // -----------------------------------------------------------------
  // 5. Safety net
  // -----------------------------------------------------------------
  process.on('unhandledRejection', (reason) => {
    console.error('[Unhandled Rejection]', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[Uncaught Exception]', err);
    shutdown('uncaughtException');
  });
})();