const BonusBbm = require('../models/BonusBbm');

class BonusController {
    constructor() {
        this.bonusModel = new BonusBbm();
    }

    // GET /api/driver/bonus/:username
    // Query opsional: ?status=pending|claimed|expired&limit=10&offset=0&from=YYYY-MM-DD&to=YYYY-MM-DD
    async getBonuses(req, res) {
        try {
            const { username } = req.params;
            const { status, from, to, limit = 10, offset = 0 } = req.query;

            if (!username) {
                return res.status(400).json({
                    success: false,
                    message: 'Driver username is required'
                });
            }

            const result = await this.bonusModel.getBonusesByDriver(username, {
                status: status || undefined,
                from: from || undefined,
                to: to || undefined,
                limit: parseInt(limit, 10),
                offset: parseInt(offset, 10),
            });

            res.json({
                success: true,
                data: result.items,
                pagination: {
                    total: result.total,
                    limit: result.limit,
                    offset: result.offset,
                }
            });
        } catch (error) {
            console.error('Get bonuses error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    }

    // GET /api/driver/bonus/detail/:id
    async getBonusDetail(req, res) {
        try {
            const { id } = req.params;

            const detail = await this.bonusModel.getBonusDetail(id);

            if (!detail) {
                return res.status(404).json({
                    success: false,
                    message: 'Bonus tidak ditemukan'
                });
            }

            res.json({
                success: true,
                data: detail
            });
        } catch (error) {
            console.error('Get bonus detail error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    }

    // POST /api/driver/bonus/create
    // Body: { driver_username, driver_phone, order_no, distance_km, creation_date?, total_price?, unique_id? }
    // Dipakai untuk trigger manual (mis. testing) — trigger otomatis normal
    // tetap lewat OrderController.completeOrder saat order selesai.
    async createBonus(req, res) {
        try {
            const {
                driver_username,
                driver_phone,
                order_no,
                distance_km,
                creation_date,
                total_price,
                unique_id
            } = req.body;

            if (!driver_username || !order_no || !distance_km) {
                return res.status(400).json({
                    success: false,
                    message: 'driver_username, order_no, dan distance_km wajib diisi'
                });
            }

            const hasBonus = await this.bonusModel.hasOrderBonus(order_no, driver_username);
            if (hasBonus) {
                return res.status(409).json({
                    success: false,
                    message: 'Order ini sudah memiliki bonus'
                });
            }

            const result = await this.bonusModel.processAutoBonus({
                driver_username,
                driver_phone: driver_phone || null,
                order_no,
                distance_km: parseFloat(distance_km),
                creation_date: creation_date || new Date().toISOString(),
                total_price: parseFloat(total_price) || 0,
                unique_id: unique_id || null,
            });

            res.json(result);
        } catch (error) {
            console.error('Create bonus error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    }

    // POST /api/driver/bonus/claim/:id
    // Klaim satu bonus: update status jadi claimed, adjust saldo Jagel
    // penuh (tanpa potongan admin), kirim notifikasi.
    async claimBonus(req, res) {
        try {
            const { id } = req.params;

            const result = await this.bonusModel.claimBonus(id);
            res.json(result);
        } catch (error) {
            console.error('Claim bonus error:', error);
            res.status(400).json({
                success: false,
                message: error.message || 'Gagal klaim bonus'
            });
        }
    }

    // GET /api/driver/bonus/summary/:username
    async getBonusSummary(req, res) {
        try {
            const { username } = req.params;

            if (!username) {
                return res.status(400).json({
                    success: false,
                    message: 'Driver username is required'
                });
            }

            const status = await this.bonusModel.getDriverBonusStatus(username);

            res.json({
                success: true,
                data: status
            });
        } catch (error) {
            console.error('Get bonus summary error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    }

    // POST /api/driver/bonus/process-expired
    // Sapu semua bonus pending yang sudah lewat expired_at -> status 'expired'.
    // Idealnya dipanggil oleh cron job harian, bukan dari sisi user/driver.
    async processExpired(req, res) {
        try {
            const result = await this.bonusModel.markExpiredBonuses();
            res.json({
                success: true,
                ...result
            });
        } catch (error) {
            console.error('Process expired bonus error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    }
}

module.exports = BonusController;