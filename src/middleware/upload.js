const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const VEHICLE_DIR = path.join(process.cwd(), UPLOAD_DIR, 'vehicles');
const VENDOR_DIR = path.join(process.cwd(), UPLOAD_DIR, 'vendors');

[VEHICLE_DIR, VENDOR_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

function makeStorage(destDir) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, destDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const unique = crypto.randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${unique}${ext}`);
    },
  });
}

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME.includes(file.mimetype)) {
    return cb(new Error('Format file harus JPG, PNG, atau WEBP'), false);
  }
  cb(null, true);
}

const maxBytes = (Number(process.env.MAX_UPLOAD_MB) || 5) * 1024 * 1024;

const uploadVehiclePhotos = multer({
  storage: makeStorage(VEHICLE_DIR),
  fileFilter,
  limits: { fileSize: maxBytes, files: 10 },
});

const uploadVendorAsset = multer({
  storage: makeStorage(VENDOR_DIR),
  fileFilter,
  limits: { fileSize: maxBytes, files: 3 },
});

function toPublicUrl(req, filename, sub = 'vehicles') {
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/${UPLOAD_DIR}/${sub}/${filename}`;
}

module.exports = { uploadVehiclePhotos, uploadVendorAsset, toPublicUrl, UPLOAD_DIR };
