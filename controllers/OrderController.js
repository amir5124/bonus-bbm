const BonusBbm = require('../models/BonusBbm');

class OrderController {
    constructor() {
        this.bonusModel = new BonusBbm();
    }

    // AUTO BONUS: dipanggil saat order selesai
    async completeOrder(req, res) {
        try {
            const {
                order_no,
                driver_username,
                driver_phone,
                distance_km,
                total_price,
                creation_date,          // waktu order selesai/dibuat (ISO). Kalau kosong = sekarang
                unique_id,              // ID unik order (dipakai frontend untuk membuka rute)
                status = 'completed'
            } = req.body;

            if (!order_no || !driver_username) {
                return res.status(400).json({
                    success: false,
                    message: 'Order number and driver username are required'
                });
            }

            const km = parseFloat(distance_km);
            let bonusResult = null;

            // Idempotensi sudah ditangani di model (tabel bonus_order_log),
            // jadi request yang diulang tidak akan menambah KM dua kali.
            if (km > 0) {
                bonusResult = await this.bonusModel.processAutoBonus({
                    driver_username,
                    driver_phone: driver_phone || '081257314693',
                    order_no,
                    unique_id: unique_id || null,
                    distance_km: km,
                    creation_date: creation_date || new Date().toISOString(),
                    total_price: parseFloat(total_price) || 0
                });
                console.log(`✅ Auto bonus processed for order ${order_no}:`, bonusResult);
            }

            res.json({
                success: true,
                message: 'Order completed successfully',
                data: { order_no, status, bonus: bonusResult }
            });
        } catch (error) {
            console.error('Complete order error:', error);
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    }

    // GET status bonus driver (progress KM hari ini WIB)
    async getDriverBonusStatus(req, res) {
        try {
            const { username } = req.params;
            if (!username) {
                return res.status(400).json({ success: false, message: 'Driver username is required' });
            }
            const status = await this.bonusModel.getDriverBonusStatus(username);
            res.json({ success: true, data: status });
        } catch (error) {
            console.error('Get bonus status error:', error);
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    }

    // GET bonus terbaru
    async getRecentBonuses(req, res) {
        try {
            const { username, limit = 10, offset = 0 } = req.query;
            if (!username) {
                return res.status(400).json({ success: false, message: 'Driver username is required' });
            }
            const bonuses = await this.bonusModel.getBonusesByDriver(username, {
                limit: parseInt(limit, 10),
                offset: parseInt(offset, 10)
            });
            res.json({ success: true, data: bonuses });
        } catch (error) {
            console.error('Get recent bonuses error:', error);
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    }
}

module.exports = OrderController;

