const router=require('express').Router();
const ctrl=require('../controllers/paymentController');
router.post('/create',ctrl.createPayment);
router.post('/callback',ctrl.handleCallback);
router.get('/status/:reff',ctrl.checkStatus);
module.exports=router;
