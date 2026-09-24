const router = require('express').Router();
const { requireAuth, requireVendorMember } = require('../middleware/auth');
const { uploadVehiclePhotos } = require('../middleware/upload');

const vendorCtrl = require('../controllers/vendorController');
const vehicleCtrl = require('../controllers/vehicleController');

router.use(requireAuth);

/* --- Onboarding (tidak butuh sudah jadi member vendor) --- */
// POST /api/vendors  -> daftar jadi vendor baru
router.post('/', vendorCtrl.registerVendor);

/* --- Profil & manajemen vendor (butuh membership) --- */
// GET  /api/vendors/:vendorId
router.get('/:vendorId', requireVendorMember('staff'), vendorCtrl.getMyVendorProfile);
// PATCH /api/vendors/:vendorId  (min. manager)
router.patch('/:vendorId', requireVendorMember('manager'), vendorCtrl.updateVendorProfile);
// POST /api/vendors/:vendorId/bank-accounts (min. owner)
router.post('/:vendorId/bank-accounts', requireVendorMember('owner'), vendorCtrl.addBankAccount);
// POST /api/vendors/:vendorId/members (min. owner)
router.post('/:vendorId/members', requireVendorMember('owner'), vendorCtrl.addVendorMember);

/* --- Fasilitas master (read-only) --- */
// GET /api/vendors/:vendorId/facilities
router.get('/:vendorId/facilities', requireVendorMember('staff'), vehicleCtrl.listFacilities);

/* --- Denah kursi (seat layout) --- */
// POST /api/vendors/:vendorId/seat-layouts  (min. manager)
router.post('/:vendorId/seat-layouts', requireVendorMember('manager'), vehicleCtrl.createSeatLayout);
// GET  /api/vendors/:vendorId/seat-layouts
router.get('/:vendorId/seat-layouts', requireVendorMember('staff'), vehicleCtrl.listSeatLayouts);
// GET  /api/vendors/:vendorId/seat-layouts/:layoutId
router.get('/:vendorId/seat-layouts/:layoutId', requireVendorMember('staff'), vehicleCtrl.getSeatLayoutDetail);

/* --- Armada (vehicles) - fitur utama upload detail lengkap --- */
// POST /api/vendors/:vendorId/vehicles  (min. manager) - multipart, field 'photos' max 10
router.post(
  '/:vendorId/vehicles',
  requireVendorMember('manager'),
  uploadVehiclePhotos.array('photos', 10),
  vehicleCtrl.createVehicle
);
// GET  /api/vendors/:vendorId/vehicles
router.get('/:vendorId/vehicles', requireVendorMember('staff'), vehicleCtrl.listMyVehicles);
// GET  /api/vendors/:vendorId/vehicles/:id
router.get('/:vendorId/vehicles/:id', requireVendorMember('staff'), vehicleCtrl.getVehicleDetail);
// PATCH /api/vendors/:vendorId/vehicles/:id  (min. manager)
router.patch('/:vendorId/vehicles/:id', requireVendorMember('manager'), vehicleCtrl.updateVehicle);
// PUT  /api/vendors/:vendorId/vehicles/:id/facilities  (min. manager)
router.put('/:vendorId/vehicles/:id/facilities', requireVendorMember('manager'), vehicleCtrl.setVehicleFacilities);
// POST /api/vendors/:vendorId/vehicles/:id/photos  (min. manager)
router.post(
  '/:vendorId/vehicles/:id/photos',
  requireVendorMember('manager'),
  uploadVehiclePhotos.array('photos', 10),
  vehicleCtrl.addVehiclePhotos
);
// PATCH /api/vendors/:vendorId/vehicles/:id/photos/:photoId/cover  (min. manager)
router.patch(
  '/:vendorId/vehicles/:id/photos/:photoId/cover',
  requireVendorMember('manager'),
  vehicleCtrl.setCoverPhoto
);
// DELETE /api/vendors/:vendorId/vehicles/:id/photos/:photoId  (min. manager)
router.delete(
  '/:vendorId/vehicles/:id/photos/:photoId',
  requireVendorMember('manager'),
  vehicleCtrl.deleteVehiclePhoto
);
// DELETE /api/vendors/:vendorId/vehicles/:id  (nonaktifkan, min. owner)
router.delete('/:vendorId/vehicles/:id', requireVendorMember('owner'), vehicleCtrl.deactivateVehicle);

module.exports = router;
