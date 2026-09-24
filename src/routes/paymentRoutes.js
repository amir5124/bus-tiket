const router = require('express').Router();
const ctrl = require('../controllers/paymentController');

router.post('/create', ctrl.createPayment);
router.post('/callback', ctrl.handleCallback);
router.get('/status/:reff', ctrl.checkStatus);
router.post('/resend-invoice/:bookingCode', ctrl.resendInvoice);   // ← baru

module.exports = router;