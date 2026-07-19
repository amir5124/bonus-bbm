const express = require('express');
const router = express.Router();
const OrderController = require('../controllers/OrderController');

const orderController = new OrderController();

// POST /api/driver/order/complete - Auto bonus trigger
router.post('/complete', (req, res) => orderController.completeOrder(req, res));

// GET /api/driver/bonus-status/:username
router.get('/bonus-status/:username', (req, res) => orderController.getDriverBonusStatus(req, res));

// GET /api/driver/recent-bonuses
router.get('/recent-bonuses', (req, res) => orderController.getRecentBonuses(req, res));

module.exports = router;