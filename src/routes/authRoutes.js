const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { query } = require('../config/db');

/**
 * GET /api/auth/me
 * Return user + daftar vendor miliknya.
 * Frontend pakai ini untuk tahu user sudah punya vendor atau belum.
 */
router.get('/me', requireAuth, async (req, res) => {
    try {
        const { rows: vendors } = await query(
            `SELECT v.id AS vendor_id, v.code, v.name, v.legal_name,
              v.status, v.rejected_reason, v.verified_at,
              vm.role
         FROM vendor_members vm
         JOIN vendors v ON v.id = vm.vendor_id
        WHERE vm.user_id = ?
        ORDER BY v.id`,
            [req.user.id]
        );

        res.json({
            success: true,
            data: {
                user: req.user,
                vendors: vendors,
            },
        });
    } catch (err) {
        console.error('[auth/me]', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;