const BonusBbm = require('../models/BonusBbm');

class OrderController {
    constructor() {
        this.bonusModel = new BonusBbm();
    }

    // AUTO BONUS: Dipanggil saat order selesai
    async completeOrder(req, res) {
        try {
            const {
                order_no,
                driver_username,
                driver_phone,
                distance_km,
                total_price,
                status = 'completed'
            } = req.body;

            // Validasi
            if (!order_no || !driver_username) {
                return res.status(400).json({
                    success: false,
                    message: 'Order number and driver username are required'
                });
            }

            // Cek apakah order sudah memiliki bonus
            const hasBonus = await this.bonusModel.hasOrderBonus(order_no, driver_username);

            let bonusResult = null;

            // Proses bonus otomatis jika belum ada bonus untuk order ini
            if (!hasBonus && distance_km > 0) {
                bonusResult = await this.bonusModel.processAutoBonus({
                    driver_username,
                    driver_phone: driver_phone || '081257314693',
                    order_no,
                    distance_km: parseFloat(distance_km),
                    creation_date: new Date().toISOString(),
                    total_price: parseFloat(total_price) || 0
                });

                console.log(`✅ Auto bonus processed for order ${order_no}:`, bonusResult);
            }

            // Update status order di database order (implementasi sesuai kebutuhan)
            // await this.orderModel.updateStatus(order_no, status);

            res.json({
                success: true,
                message: 'Order completed successfully',
                data: {
                    order_no,
                    status,
                    bonus: bonusResult
                }
            });

        } catch (error) {
            console.error('Complete order error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    }

    // GET driver bonus status
    async getDriverBonusStatus(req, res) {
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
            console.error('Get bonus status error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    }

    // Get recent bonuses with pagination
    async getRecentBonuses(req, res) {
        try {
            const { username, limit = 10, offset = 0 } = req.query;

            if (!username) {
                return res.status(400).json({
                    success: false,
                    message: 'Driver username is required'
                });
            }

            const bonuses = await this.bonusModel.getBonusesByDriver(username, {
                limit: parseInt(limit),
                offset: parseInt(offset)
            });

            res.json({
                success: true,
                data: bonuses
            });

        } catch (error) {
            console.error('Get recent bonuses error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    }
}

module.exports = OrderController;