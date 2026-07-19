const mysql = require('mysql2/promise');
const config = require('../config/database');

class BonusBbm {
    constructor() {
        this.pool = mysql.createPool(config);
        this.KM_PER_BONUS = 3; // 3 km = 1 bonus
        this.BONUS_PER_BLOCK = 10000; // Rp 10.000 per bonus
    }

    // AUTO BONUS: Proses bonus saat order selesai
    async processAutoBonus(orderData) {
        const {
            driver_username,
            driver_phone,
            order_no,
            distance_km,
            creation_date,
            total_price
        } = orderData;

        const connection = await this.pool.getConnection();
        await connection.beginTransaction();

        try {
            // 1. Dapatkan total bonus yang sudah didapat hari ini
            const today = new Date().toISOString().split('T')[0];
            const [todayBonuses] = await connection.execute(
                `SELECT SUM(amount) as total_bonus, SUM(achieved_km) as total_km
         FROM bonus_bbm 
         WHERE driver_username = ? AND DATE(created_at) = ? AND status = 'claimed'`,
                [driver_username, today]
            );

            const currentTotalBonus = todayBonuses[0]?.total_bonus || 0;
            const currentTotalKm = todayBonuses[0]?.total_km || 0;

            // 2. Hitung akumulasi km hari ini
            const totalKmToday = currentTotalKm + distance_km;

            // 3. Hitung bonus baru
            const bonusBlocks = Math.floor(totalKmToday / this.KM_PER_BONUS);
            const existingBlocks = Math.floor(currentTotalKm / this.KM_PER_BONUS);
            const newBlocks = bonusBlocks - existingBlocks;

            const createdBonuses = [];

            // 4. Buat bonus untuk setiap block baru
            for (let i = 0; i < newBlocks; i++) {
                const blockNumber = existingBlocks + i + 1;
                const achievedKm = Math.min(
                    (blockNumber * this.KM_PER_BONUS) - (currentTotalKm + (i * this.KM_PER_BONUS)),
                    this.KM_PER_BONUS
                );

                // Balance sebelum bonus
                const balanceBefore = currentTotalBonus + (i * this.BONUS_PER_BLOCK);
                const balanceAfter = balanceBefore + this.BONUS_PER_BLOCK;

                // Set expired 7 hari dari sekarang
                const expiredAt = new Date();
                expiredAt.setDate(expiredAt.getDate() + 7);

                // Insert bonus
                const [bonusResult] = await connection.execute(
                    `INSERT INTO bonus_bbm 
           (driver_username, driver_phone, order_no, achieved_km, target_km, 
            amount, bonus_type, status, balance_before, balance_after, 
            expired_at, created_at, source_order)
           VALUES (?, ?, ?, ?, ?, ?, 'masuk', 'pending', ?, ?, ?, NOW(), ?)`,
                    [
                        driver_username,
                        driver_phone,
                        order_no,
                        achievedKm,
                        this.KM_PER_BONUS,
                        this.BONUS_PER_BLOCK,
                        balanceBefore,
                        balanceAfter,
                        expiredAt,
                        order_no // source_order untuk tracking
                    ]
                );

                const bonusId = bonusResult.insertId;

                // Simpan order yang terkait dengan bonus ini
                await connection.execute(
                    `INSERT INTO bonus_bbm_orders (bonus_id, order_no, distance_km)
           VALUES (?, ?, ?)`,
                    [bonusId, order_no, distance_km]
                );

                createdBonuses.push({
                    id: bonusId,
                    amount: this.BONUS_PER_BLOCK,
                    achieved_km: achievedKm,
                    balance_before: balanceBefore,
                    balance_after: balanceAfter,
                    expired_at: expiredAt
                });
            }

            await connection.commit();

            return {
                success: true,
                new_bonuses: createdBonuses,
                total_bonus_today: currentTotalBonus + (createdBonuses.length * this.BONUS_PER_BLOCK),
                total_km_today: totalKmToday
            };

        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // Cek apakah order sudah memiliki bonus
    async hasOrderBonus(orderNo, driverUsername) {
        const [rows] = await this.pool.execute(
            `SELECT COUNT(*) as count 
       FROM bonus_bbm 
       WHERE driver_username = ? AND (order_no = ? OR source_order = ?)`,
            [driverUsername, orderNo, orderNo]
        );
        return rows[0].count > 0;
    }

    // Get bonus status for driver
    async getDriverBonusStatus(driverUsername) {
        const today = new Date().toISOString().split('T')[0];

        const [rows] = await this.pool.execute(
            `SELECT 
        SUM(achieved_km) as total_km_today,
        SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) as pending_bonus,
        SUM(CASE WHEN status = 'claimed' THEN amount ELSE 0 END) as claimed_bonus,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN status = 'claimed' THEN 1 END) as claimed_count
       FROM bonus_bbm 
       WHERE driver_username = ? AND DATE(created_at) = ?`,
            [driverUsername, today]
        );

        const totalKm = rows[0]?.total_km_today || 0;
        const bonusBlocks = Math.floor(totalKm / this.KM_PER_BONUS);
        const nextTarget = (bonusBlocks + 1) * this.KM_PER_BONUS;
        const progress = (totalKm % this.KM_PER_BONUS) / this.KM_PER_BONUS * 100;

        return {
            total_km_today: totalKm,
            bonus_blocks: bonusBlocks,
            next_target_km: nextTarget,
            progress: Math.min(progress, 100),
            pending_bonus: rows[0]?.pending_bonus || 0,
            claimed_bonus: rows[0]?.claimed_bonus || 0,
            pending_count: rows[0]?.pending_count || 0,
            claimed_count: rows[0]?.claimed_count || 0
        };
    }
}

module.exports = BonusBbm;