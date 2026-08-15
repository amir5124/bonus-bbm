const BonusBbm = require('../models/BonusBbm');

class OrderController {
    constructor() {
        this.bonusModel = new BonusBbm();
    }

    // AUTO BONUS: Dipanggil saat order selesai
    // POST /api/driver/order/complete
    async completeOrder(req, res) {
        try {
            console.log('═'.repeat(60));
            console.log('📦 [ORDER-COMPLETE] Request received');
            console.log('═'.repeat(60));

            const {
                order_no,
                driver_username,
                driver_phone,
                distance_km,
                total_price,
                unique_id,
                status = 'completed',
                order_type,
                category,
                creation_date // ← BARU: waktu order asli (dari Jagel/UFood), kalau dikirim
            } = req.body;

            // Log request body
            console.log(`📋 [REQUEST] Order No: ${order_no}`);
            console.log(`📋 [REQUEST] Driver: ${driver_username}`);
            console.log(`📋 [REQUEST] Distance: ${distance_km}km`);
            console.log(`📋 [REQUEST] Total Price: ${total_price}`);
            console.log(`📋 [REQUEST] Order Type: ${order_type || 'N/A'}`);
            console.log(`📋 [REQUEST] Category: ${category || 'N/A'}`);
            console.log(`📋 [REQUEST] Unique ID: ${unique_id || 'N/A'}`);
            console.log(`📋 [REQUEST] Creation Date (asli): ${creation_date || 'N/A (pakai waktu proses)'}`);

            // Validasi
            if (!order_no || !driver_username) {
                console.log('❌ [VALIDATION] Missing required fields');
                return res.status(400).json({
                    success: false,
                    message: 'Order number and driver username are required'
                });
            }

            // 🔥 Cek apakah order sudah memiliki bonus
            console.log('🔍 [CHECK] Checking if order already has bonus...');
            const hasBonus = await this.bonusModel.hasOrderBonus(order_no, driver_username);
            console.log(`🔍 [CHECK] Has bonus: ${hasBonus}`);

            // 🔥 Cek tipe order FOOD
            const isFoodOrder = order_type === 'food' || category === 3 || req.body.use_expedition === 1;
            console.log(`🔍 [CHECK] Is food order: ${isFoodOrder}`);
            console.log(`🔍 [CHECK] Distance > 0: ${distance_km > 0}`);

            let bonusResult = null;

            // Proses bonus otomatis hanya jika:
            // 1. Belum ada bonus untuk order ini
            // 2. Distance > 0
            // 3. Order tipe FOOD
            if (!hasBonus && distance_km > 0 && isFoodOrder) {
                console.log('✅ [BONUS] All conditions met, processing auto bonus...');
                console.log('─'.repeat(40));

                bonusResult = await this.bonusModel.processAutoBonus({
                    driver_username,
                    driver_phone: driver_phone || '081257314693',
                    order_no,
                    distance_km: parseFloat(distance_km),
                    // Pakai waktu order ASLI kalau dikirim (mis. "2026-08-15 08:52:24"
                    // dari Jagel/UFood), fallback ke waktu proses sekarang kalau tidak ada.
                    // Konversi ke format aman-MySQL dilakukan di dalam BonusBbm.processAutoBonus.
                    creation_date: creation_date || new Date().toISOString(),
                    total_price: parseFloat(total_price) || 0,
                    unique_id: unique_id || null,
                });

                console.log('─'.repeat(40));
                console.log(`✅ [BONUS] Auto bonus result:`);
                console.log(`   - Success: ${bonusResult.success}`);
                console.log(`   - New Bonuses: ${bonusResult.new_bonuses?.length || 0}`);
                console.log(`   - Total Bonus Today: Rp${bonusResult.total_bonus_today || 0}`);
                console.log(`   - Total KM Today: ${bonusResult.total_km_today || 0}km`);

                if (bonusResult.new_bonuses && bonusResult.new_bonuses.length > 0) {
                    bonusResult.new_bonuses.forEach((b, idx) => {
                        console.log(`   - Bonus #${idx + 1}: ID ${b.id}, Rp${b.amount}, ${b.achieved_km}km`);
                    });
                }
            } else {
                console.log('⏭️ [SKIP] Bonus not processed:');
                if (hasBonus) console.log('   - Order already has bonus');
                if (!(distance_km > 0)) console.log(`   - Distance (${distance_km}km) <= 0`);
                if (!isFoodOrder) console.log('   - Not a food order');
            }

            console.log('═'.repeat(60));
            console.log('✅ [ORDER-COMPLETE] Order completed successfully');
            console.log('═'.repeat(60));

            res.json({
                success: true,
                message: 'Order completed successfully',
                data: {
                    order_no,
                    status,
                    bonus: bonusResult,
                    is_food_order: isFoodOrder,
                    has_existing_bonus: hasBonus
                }
            });

        } catch (error) {
            console.error('❌ [ERROR] Complete order error:', error);
            console.error('❌ [ERROR] Stack:', error.stack);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    }

    // GET driver bonus status
    // GET /api/driver/order/bonus-status/:username
    async getDriverBonusStatus(req, res) {
        try {
            const { username } = req.params;

            console.log(`📊 [BONUS-STATUS] Request for ${username}`);

            if (!username) {
                return res.status(400).json({
                    success: false,
                    message: 'Driver username is required'
                });
            }

            const status = await this.bonusModel.getDriverBonusStatus(username);
            console.log(`📊 [BONUS-STATUS] Status:`, status);

            res.json({
                success: true,
                data: status
            });

        } catch (error) {
            console.error('❌ [ERROR] Get bonus status error:', error);
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

            console.log(`📋 [RECENT-BONUSES] Request for ${username}, limit: ${limit}, offset: ${offset}`);

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

            console.log(`📋 [RECENT-BONUSES] Found ${result.items.length} bonuses, total: ${result.total}`);

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
            console.error('❌ [ERROR] Get recent bonuses error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    }
}

module.exports = OrderController;