const router = require('express').Router();
const c = require('../controllers/bookingController');

router.use(c.attachUser);                                  // login opsional (tamu boleh memesan)
router.post('/', c.createBooking);                         // buat pesanan + tahan kursi
router.get('/', c.requireLogin, c.myBookings);             // pesanan saya
router.get('/:code', c.getBooking);                        // detail (pemilik, atau tamu + ?email=)
router.post('/:code/cancel', c.cancelBooking);             // batalkan (belum dibayar)
router.post('/:code/refund', c.requireLogin, c.requestRefund); // ajukan refund (sudah dibayar)

module.exports = router;