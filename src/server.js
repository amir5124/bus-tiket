require('dotenv').config();
const app = require('./app');
const { pool, testConnection } = require('./config/db');

const PORT = process.env.PORT || 4000;

// Jalankan server setelah cek koneksi database
(async () => {
  console.log('🔌 [Server] Memeriksa koneksi database...');
  const dbOk = await testConnection();

  if (!dbOk) {
    console.error('⚠️  [Server] Server tetap dijalankan, tapi database TIDAK terhubung.');
    console.error('    Periksa konfigurasi .env (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME).');
  }

  const server = app.listen(PORT, () => {
    console.log(`🚌 Bus & Travel API berjalan di port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });

  async function shutdown(signal) {
    console.log(`\n[Server] Menerima ${signal}, mematikan server dengan aman...`);
    server.close(async () => {
      await pool.end();
      console.log('[Server] Selesai. Sampai jumpa!');
      process.exit(0);
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[Unhandled Rejection]', reason);
  });
})();