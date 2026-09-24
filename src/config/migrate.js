require('dotenv').config();
const { pool } = require('./db');

const REQUIRED_TABLES = [
  'app_users','vendors','vendor_members','vehicles','seat_layouts',
  'seat_layout_cells','vehicle_facilities','vehicle_photos','facilities',
  'routes','schedules','schedule_seats','bookings','payments',
  'notifications','admin_users','cities','vendor_bank_accounts'
];

(async () => {
  try {
    await pool.query('SELECT 1');
    const [rows] = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = DATABASE()
    `);
    const existing = new Set(rows.map(r => r.table_name));
    const missing = REQUIRED_TABLES.filter(t => !existing.has(t));
    if (missing.length) {
      console.error('[Migrate] Tabel belum ada:\n - ' + missing.join('\n - '));
      process.exit(1);
    }
    console.log('[Migrate] MySQL OK. Semua tabel inti tersedia.');
    process.exit(0);
  } catch (err) {
    console.error('[Migrate] Gagal:', err.message);
    process.exit(1);
  }
})();
