const router = require('express').Router();
const publicCtrl = require('../controllers/publicController');
const { optionalAuth } = require('../middleware/auth');

// GET /api/public/cities
router.get('/cities', publicCtrl.listCities);

// GET /api/public/facilities
router.get('/facilities', publicCtrl.listFacilities);

// GET /api/public/schedules/search?origin_city_id=&destination_city_id=&depart_date=&seats=&vehicle_type=&sort=
router.get('/schedules/search', optionalAuth, publicCtrl.searchSchedules);

// GET /api/public/schedules/:id  -> detail jadwal + armada lengkap + denah kursi
router.get('/schedules/:id', publicCtrl.getScheduleDetail);
// GET /api/public/payment-methods  -> daftar metode pembayaran aktif
router.get('/payment-methods', publicCtrl.listPaymentMethods);
// GET /api/public/vendors/:id  -> profil publik vendor + daftar armadanya
router.get('/vendors/:id', publicCtrl.getVendorPublicProfile);

module.exports = router;
