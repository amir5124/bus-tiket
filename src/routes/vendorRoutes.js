const router = require('express').Router();
const { requireAuth, requireVendorMember, requireActiveVendor } = require('../middleware/auth');
const { uploadVehiclePhotos } = require('../middleware/upload');

const vendorCtrl = require('../controllers/vendorController');
const vehicleCtrl = require('../controllers/vehicleController');
const vendorRouteCtrl = require('../controllers/vendorRouteController');
const vendorScheduleCtrl = require('../controllers/vendorScheduleController');

/* =====================================================================
 * PUBLIC (tanpa auth) — dipanggil LinkQu
 * ===================================================================== */
router.post('/topup/callback', vendorCtrl.topupCallback);

/* =====================================================================
 * AUTH — semua di bawah ini butuh user
 * ===================================================================== */
router.use(requireAuth);

// Register
router.post('/', vendorCtrl.registerVendor);

// Profil
router.get('/:vendorId', requireVendorMember('staff'), vendorCtrl.getMyVendorProfile);
router.patch('/:vendorId', requireVendorMember('manager'), vendorCtrl.updateVendorProfile);
router.post('/:vendorId/bank-accounts', requireVendorMember('owner'), vendorCtrl.addBankAccount);
router.post('/:vendorId/members', requireVendorMember('owner'), vendorCtrl.addVendorMember);

// Topup
router.post('/:vendorId/topup', requireVendorMember('owner'), vendorCtrl.requestTopup);
router.get('/:vendorId/topup/history', requireVendorMember('staff'), vendorCtrl.listTopups);
router.post('/:vendorId/topup/:topupId/confirm', requireVendorMember('owner'), vendorCtrl.confirmTopupManual);

/* =====================================================================
 * FASILITAS MASTER
 * ===================================================================== */
router.get('/:vendorId/facilities', requireVendorMember('staff'), vehicleCtrl.listFacilities);

/* =====================================================================
 * DENAH KURSI
 * ===================================================================== */
router.post('/:vendorId/seat-layouts',
  requireVendorMember('manager'), requireActiveVendor(), vehicleCtrl.createSeatLayout);
router.get('/:vendorId/seat-layouts', requireVendorMember('staff'), vehicleCtrl.listSeatLayouts);
router.get('/:vendorId/seat-layouts/:layoutId', requireVendorMember('staff'), vehicleCtrl.getSeatLayoutDetail);

/* =====================================================================
 * ARMADA
 * ===================================================================== */
router.post('/:vendorId/vehicles',
  requireVendorMember('manager'), requireActiveVendor(),
  uploadVehiclePhotos.array('photos', 10), vehicleCtrl.createVehicle);
router.get('/:vendorId/vehicles', requireVendorMember('staff'), vehicleCtrl.listMyVehicles);
router.get('/:vendorId/vehicles/:id', requireVendorMember('staff'), vehicleCtrl.getVehicleDetail);
router.patch('/:vendorId/vehicles/:id',
  requireVendorMember('manager'), requireActiveVendor(),
  uploadVehiclePhotos.array('photos', 10), vehicleCtrl.updateVehicle);
router.put('/:vendorId/vehicles/:id/facilities',
  requireVendorMember('manager'), requireActiveVendor(), vehicleCtrl.setVehicleFacilities);
router.post('/:vendorId/vehicles/:id/photos',
  requireVendorMember('manager'), requireActiveVendor(),
  uploadVehiclePhotos.array('photos', 10), vehicleCtrl.addVehiclePhotos);
router.patch('/:vendorId/vehicles/:id/photos/:photoId/cover',
  requireVendorMember('manager'), requireActiveVendor(), vehicleCtrl.setCoverPhoto);
router.delete('/:vendorId/vehicles/:id/photos/:photoId',
  requireVendorMember('manager'), requireActiveVendor(), vehicleCtrl.deleteVehiclePhoto);
router.delete('/:vendorId/vehicles/:id',
  requireVendorMember('owner'), requireActiveVendor(), vehicleCtrl.deactivateVehicle);
router.get('/:vendorId/stops', requireVendorMember('staff'), vendorCtrl.listStops);

/* =====================================================================
 * RUTE
 * ===================================================================== */
router.get('/:vendorId/routes', requireVendorMember('staff'), vendorRouteCtrl.listVendorRoutes);
router.post('/:vendorId/routes',
  requireVendorMember('manager'), requireActiveVendor(), vendorRouteCtrl.createVendorRoute);
router.put('/:vendorId/routes/:id',
  requireVendorMember('manager'), requireActiveVendor(), vendorRouteCtrl.updateVendorRoute);
router.delete('/:vendorId/routes/:id',
  requireVendorMember('manager'), requireActiveVendor(), vendorRouteCtrl.deleteVendorRoute);


/* =====================================================================
 * JADWAL
 * ===================================================================== */
router.get('/:vendorId/schedules', requireVendorMember('staff'), vendorScheduleCtrl.listVendorSchedules);
router.post('/:vendorId/schedules',
  requireVendorMember('manager'), requireActiveVendor(), vendorScheduleCtrl.createVendorSchedule);
router.put('/:vendorId/schedules/:id',
  requireVendorMember('manager'), requireActiveVendor(), vendorScheduleCtrl.updateVendorSchedule);
router.delete('/:vendorId/schedules/:id',
  requireVendorMember('manager'), requireActiveVendor(), vendorScheduleCtrl.deleteVendorSchedule);
router.post('/:vendorId/schedules/:id/publish',
  requireVendorMember('manager'), requireActiveVendor(), vendorScheduleCtrl.publishVendorSchedule);

module.exports = router;