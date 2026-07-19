const express = require('express');
const router = express.Router();
const BonusController = require('../controllers/BonusController');

const bonusController = new BonusController();

// GET /api/driver/bonus/:username
router.get('/:username', (req, res) => bonusController.getBonuses(req, res));

// GET /api/driver/bonus/detail/:id
router.get('/detail/:id', (req, res) => bonusController.getBonusDetail(req, res));

// POST /api/driver/bonus/create
router.post('/create', (req, res) => bonusController.createBonus(req, res));

// POST /api/driver/bonus/claim/:id
router.post('/claim/:id', (req, res) => bonusController.claimBonus(req, res));

// GET /api/driver/bonus/summary/:username
router.get('/summary/:username', (req, res) => bonusController.getBonusSummary(req, res));

// POST /api/driver/bonus/process-expired
router.post('/process-expired', (req, res) => bonusController.processExpired(req, res));

module.exports = router;