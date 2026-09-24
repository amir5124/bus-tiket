// routes/paymentRoutes.js
const router = require('express').Router();
const ctrl = require('../controllers/paymentController');

// =====================================================================
// LinkQu VA/QRIS
// =====================================================================
router.post('/create', ctrl.createPayment);
router.post('/callback', ctrl.handleCallback);
router.get('/status/:reff', ctrl.checkStatus);
router.post('/resend-invoice/:bookingCode', ctrl.resendInvoice);

// =====================================================================
// COIN (via Jagel, tanpa tabel lokal)
// =====================================================================
router.get('/coin/balance', ctrl.checkCoinBalance);      // GET  ?user=amir
router.post('/coin/pay', ctrl.payWithCoin);              // POST { user, amount, booking_code, ... }
router.post('/coin-confirm', ctrl.coinConfirm);          // POST (internal / webhook)

// =====================================================================
// Vendor notifications (in-app)
// =====================================================================
router.get('/notifications/vendor', ctrl.getVendorNotifications);  // GET ?vendor_id=1

module.exports = router;