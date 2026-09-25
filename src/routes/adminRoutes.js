const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const adminCtrl = require('../controllers/adminController');
const vehicleCtrl = require('../controllers/vehicleController');

router.use(requireAuth, requireAdmin('viewer'));

/* =====================================================================
 * VENDOR MANAGEMENT
 * ===================================================================== */
// GET   /api/admin/vendors?status=&q=&page=&limit=
router.get('/vendors', adminCtrl.listVendors);

// GET   /api/admin/vendors/:id
router.get('/vendors/:id', adminCtrl.getVendorDetail);

// POST  /api/admin/vendors/:id/approve (min. support)
router.post('/vendors/:id/approve', requireAdmin('support'), adminCtrl.approveVendor);

// POST  /api/admin/vendors/:id/reject (min. support)
router.post('/vendors/:id/reject', requireAdmin('support'), adminCtrl.rejectVendor);

// POST  /api/admin/vendors/:id/suspend (min. super_admin)
router.post('/vendors/:id/suspend', requireAdmin('super_admin'), adminCtrl.suspendVendor);

// PATCH /api/admin/vendors/:id/commission (min. finance)
router.patch('/vendors/:id/commission', requireAdmin('finance'), adminCtrl.setCommission);

/* =====================================================================
 * ARMADA MONITORING
 * ===================================================================== */
router.get('/vehicles', adminCtrl.listAllVehicles);

router.get('/vehicles/:id', async (req, res, next) => {
  try {
    const full = await vehicleCtrl.getVehicleFullById(req.params.id);
    if (!full) return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });
    res.json({ success: true, data: full });
  } catch (err) { next(err); }
});

/* =====================================================================
 * TRANSAKSI
 * ===================================================================== */
// GET /api/admin/transactions
router.get('/transactions', adminCtrl.listTransactions);

// GET /api/admin/transactions/:id   ← TAMBAHAN
router.get('/transactions/:id', adminCtrl.getTransactionDetail);

/* =====================================================================
 * SUMMARY
 * ===================================================================== */
router.get('/summary/daily', adminCtrl.dailySummary);
router.get('/summary/vendor-sales', adminCtrl.vendorSales);

/* =====================================================================
 * REFUND
 * ===================================================================== */
router.get('/refunds', requireAdmin('finance'), adminCtrl.listRefunds);
router.post('/refunds/:id/review', requireAdmin('finance'), adminCtrl.reviewRefund);

/* =====================================================================
 * AUDIT LOG
 * ===================================================================== */
router.get('/audit-logs', requireAdmin('support'), adminCtrl.listAuditLogs);

module.exports = router;