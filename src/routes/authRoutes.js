const router = require('express').Router();
const { loginWithJagel, me } = require('../controllers/authController');
const { requireAuth } = require('../middleware/auth');

// POST /api/auth/login  -> sync akun Jagel & terbitkan JWT
router.post('/login', loginWithJagel);

// GET /api/auth/me  -> profil user login + daftar vendor & role admin
router.get('/me', requireAuth, me);

module.exports = router;
