const BonusBbm = require('../models/BonusBbm');

class OrderController {
    constructor() {
        this.bonusModel = new BonusBbm();
    }

    // AUTO BONUS: Dipanggil saat order selesai
    // POST /api/driver/order/complete
   // OrderController.js
async completeOrder(req, res) {
    try {
        const {
            order_no,
            driver_username,
            driver_phone,
            distance_km,
            total_price,
            unique_id,
            status = 'completed',
            order_type // Tambahkan parameter ini dari request
        } = req.body;

        // Validasi
        if (!order_no || !driver_username) {
            return res.status(400).json({
                success: false,
                message: 'Order number and driver username are required'
            });
        }

        // 🔥 PERBAIKAN: Hanya proses bonus untuk tipe FOOD
        // Asumsikan order_type = 'food' atau category = 3
        const isFoodOrder = order_type === 'food' || req.body.category === 3;
        
        let bonusResult = null;

        // Proses bonus otomatis hanya jika:
        // 1. Belum ada bonus untuk order ini
        // 2. Distance > 0
        // 3. Order tipe FOOD
        if (!hasBonus && distance_km > 0 && isFoodOrder) {
            bonusResult = await this.bonusModel.processAutoBonus({
                driver_username,
                driver_phone: driver_phone || '081257314693',
                order_no,
                distance_km: parseFloat(distance_km),
                creation_date: new Date().toISOString(),
                total_price: parseFloat(total_price) || 0,
                unique_id: unique_id || null,
            });

            console.log(`✅ Auto bonus processed for order ${order_no}:`, bonusResult);
        } else if (!isFoodOrder) {
            console.log(`⏭️ Skip bonus for non-food order: ${order_no}`);
        }

        res.json({
            success: true,
            message: 'Order completed successfully',
            data: {
                order_no,
                status,
                bonus: bonusResult,
                is_food_order: isFoodOrder
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
    // GET /api/driver/order/bonus-status/:username
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
    // GET /api/driver/order/recent-bonuses?username=xxx&limit=10&offset=0
    async getRecentBonuses(req, res) {
        try {
            const { username, limit = 10, offset = 0 } = req.query;

            if (!username) {
                return res.status(400).json({
                    success: false,
                    message: 'Driver username is required'
                });
            }

            const result = await this.bonusModel.getBonusesByDriver(username, {
                limit: parseInt(limit, 10),
                offset: parseInt(offset, 10)
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
            console.error('Get recent bonuses error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    }
}

module.exports = OrderController;