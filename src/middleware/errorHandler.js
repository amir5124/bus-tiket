function notFound(req, res, next) {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} tidak ditemukan` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[Error]', err);

  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ success: false, message: 'Data duplikat / sudah ada', detail: err.detail });
  }
  if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_ROW_IS_REFERENCED_2') {
    return res.status(400).json({ success: false, message: 'Referensi data tidak valid', detail: err.detail });
  }
  if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
    return res.status(400).json({ success: false, message: 'Data melanggar aturan validasi (CHECK constraint)', detail: err.detail });
  }
  if (err.name === 'MulterError') {
    return res.status(400).json({ success: false, message: `Upload gagal: ${err.message}` });
  }

  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: err.message || 'Terjadi kesalahan pada server',
  });
}

module.exports = { notFound, errorHandler };
