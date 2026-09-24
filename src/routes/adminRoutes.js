const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const adminCtrl = require('../controllers/adminController');
const vehicleCtrl = require('../controllers/vehicleController');

router.use(requireAuth, requireAdmin('viewer'));

/* --- Vendor management --- */
// GET   /api/admin/vendors?status=&q=&page=&limit=
router.get('/vendors', adminCtrl.listVendors);
// GET   /api/admin/vendors/:id
router.get('/vendors/:id', adminCtrl.getVendorDetail);
// POST  /api/admin/vendors/:id/approve  (min. support)
router.post('/vendors/:id/approve', requireAdmin('support'), adminCtrl.approveVendor);
// POST  /api/admin/vendors/:id/reject   (min. support)
router.post('/vendors/:id/reject', requireAdmin('support'), adminCtrl.rejectVendor);
// POST  /api/admin/vendors/:id/suspend  (min. super_admin)
router.post('/vendors/:id/suspend', requireAdmin('super_admin'), adminCtrl.suspendVendor);

/* --- Armada monitoring (semua vendor) --- */
// GET /api/admin/vehicles?vendor_id=&vehicle_type=&is_active=&q=&page=&limit=
router.get('/vehicles', adminCtrl.listAllVehicles);
// GET /api/admin/vehicles/:id  -> pakai helper detail lengkap yang sama dengan vendor
router.get('/vehicles/:id', async (req, res, next) => {
  try {
    const full = await vehicleCtrl.getVehicleFullById(req.params.id);
    if (!full) return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });
    res.json({ success: true, data: full });
  } catch (err) { next(err); }
});

/* --- Transaksi & keuangan --- */
// GET /api/admin/transactions?status=&vendor_id=&date_from=&date_to=&q=&page=&limit=
router.get('/transactions', adminCtrl.listTransactions);
// GET /api/admin/summary/daily?date_from=&date_to=
router.get('/summary/daily', adminCtrl.dailySummary);
// GET /api/admin/summary/vendor-sales
router.get('/summary/vendor-sales', adminCtrl.vendorSales);

/* --- Refund --- */
// GET  /api/admin/refunds?status=requested
router.get('/refunds', requireAdmin('finance'), adminCtrl.listRefunds);
// POST /api/admin/refunds/:id/review  { action: 'approved' | 'rejected' }
router.post('/refunds/:id/review', requireAdmin('finance'), adminCtrl.reviewRefund);

/* --- Audit log --- */
// GET /api/admin/audit-logs?entity=&entity_id=&page=&limit=
router.get('/audit-logs', requireAdmin('support'), adminCtrl.listAuditLogs);

module.exports = router;
