const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'awgkcck8c8kgco0so8owwo48',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'FBoTK917rayL9D5u7usW3zKYOExW0rUD91diYvPE0AHLiO1LeZeCx5BVSfxA2M06',
  database: process.env.DB_NAME || 'bus',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 20),
  queueLimit: 0,
  timezone: 'Z',
  dateStrings: true
});

// ============================================================
// LOG KONEKSI DATABASE BERHASIL / TIDAK
// ============================================================
async function testConnection() {
  const start = Date.now();
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();

    console.log('✅ [DB] Koneksi database BERHASIL');
    console.log(`   └─ Host     : ${process.env.DB_HOST || 'awgkcck8c8kgco0so8owwo48'}`);
    console.log(`   └─ Port     : ${process.env.DB_PORT || 3306}`);
    console.log(`   └─ Database : ${process.env.DB_NAME || 'bus'}`);
    console.log(`   └─ User     : ${process.env.DB_USER || 'root'}`);
    console.log(`   └─ Waktu    : ${Date.now() - start} ms`);
    return true;
  } catch (err) {
    console.error('❌ [DB] Koneksi database GAGAL');
    console.error(`   └─ Host     : ${process.env.DB_HOST || 'awgkcck8c8kgco0so8owwo48'}`);
    console.error(`   └─ Port     : ${process.env.DB_PORT || 3306}`);
    console.error(`   └─ Database : ${process.env.DB_NAME || 'bus'}`);
    console.error(`   └─ Error    : ${err.code || ''} ${err.message}`);
    return false;
  }
}
// ============================================================

// Compatibility layer: source controller memakai placeholder PostgreSQL $1, $2...
// Di sini otomatis dikonversi ke placeholder MySQL '?'.
function convertPlaceholders(sql, params = []) {
  const converted = sql.replace(/\$(\d+)/g, '?');
  return { sql: converted, params };
}

function normalizeSql(sql) {
  return sql
    .replace(/\bILIKE\b/gi, 'LIKE')
    .replace(/::date\b/gi, '')
    .replace(/::timestamp\b/gi, '')
    .replace(/\bNOW\(\)/gi, 'NOW()')
    .replace(/\bTRUE\b/gi, '1')
    .replace(/\bFALSE\b/gi, '0');
}

async function execute(connection, rawSql, params = []) {
  let sql = normalizeSql(rawSql);
  const returning = /\s+RETURNING\s+\*/i.test(sql);
  let returnTable = null;
  let returnId = null;

  if (returning) {
    const m = sql.match(/\s+RETURNING\s+\*[\s;]*$/i);
    sql = sql.replace(m[0], '');
    const tm = sql.match(/^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+`?([a-zA-Z0-9_]+)`?/i);
    returnTable = tm?.[2] || null;
    const wm = sql.match(/\bWHERE\s+[^;]*?\bid\s*=\s*\$(\d+)/i);
    if (wm) returnId = params[Number(wm[1]) - 1];
  }

  if (/ON CONFLICT\s*\(([^)]+)\)\s*DO UPDATE SET/i.test(sql)) {
    const cm = sql.match(/ON CONFLICT\s*\(([^)]+)\)\s*DO UPDATE SET\s+(.+)$/is);
    const cols = cm[1].split(',').map(x => x.trim());
    let updates = cm[2]
      .replace(/EXCLUDED\.([a-zA-Z0-9_]+)/g, 'VALUES($1)')
      .replace(/VALUES\(\$1\)/g, (match, p1, offset, str) => match);
    updates = updates.replace(/EXCLUDED\.([a-zA-Z0-9_]+)/g, 'VALUES($1)');
    sql = sql.replace(cm[0], `ON DUPLICATE KEY UPDATE ${updates}`);
  }

  sql = sql.replace(/COALESCE\(\?,\s*'\{in_app,push\}'\)/gi, "COALESCE(?, 'in_app,push')");

  const { sql: mysqlSql, params: mysqlParams } = convertPlaceholders(sql, params);
  const [result] = await connection.execute(mysqlSql, mysqlParams);

  if (returning && returnTable) {
    let rows = [];
    if (result.insertId) {
      const [r] = await connection.query(`SELECT * FROM \`${returnTable}\` WHERE id = ? LIMIT 1`, [result.insertId]);
      rows = r;
    } else if (returnId !== null && returnId !== undefined) {
      const [r] = await connection.query(`SELECT * FROM \`${returnTable}\` WHERE id = ? LIMIT 1`, [returnId]);
      rows = r;
    }
    return { rows, rowCount: result.affectedRows, insertId: result.insertId, raw: result };
  }

  if (Array.isArray(result)) return { rows: result, rowCount: result.length, raw: result };
  return { rows: result, rowCount: result.affectedRows, insertId: result.insertId, raw: result };
}

async function query(text, params = []) {
  const start = Date.now();
  const res = await execute(pool, text, params);
  if (process.env.NODE_ENV === 'development') {
    console.log('[DB Query]', { text: text.split('\n')[0], duration: Date.now() - start, rows: res.rowCount });
  }
  return res;
}

async function withTransaction(fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const client = {
      query: (sql, params) => execute(connection, sql, params)
    };
    const result = await fn(client);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

pool.on('error', err => console.error('[DB] Unexpected pool error', err));

module.exports = { pool, query, withTransaction, testConnection };