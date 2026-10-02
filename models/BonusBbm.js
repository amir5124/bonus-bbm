const pool = require('../config/database');
const { getWibDateString } = require('../utils/wibDay');

const KM_PER_BONUS = parseFloat(process.env.KM_PER_BONUS || '10');
const BONUS_PER_BLOCK = parseFloat(process.env.BONUS_PER_BLOCK || '10000');
const EXPIRE_DAYS = 7;

class BonusBbm {
    constructor() {
        this.pool = pool; // pakai pool bersama dari config/database.js
        this.KM_PER_BONUS = KM_PER_BONUS;
        this.BONUS_PER_BLOCK = BONUS_PER_BLOCK;
    }

    // ─────────────────────────────────────────────
    // AUTO BONUS: dipanggil saat order selesai
    // ─────────────────────────────────────────────
    async processAutoBonus(orderData) {
        const { driver_username, driver_phone, order_no, creation_date } = orderData;
        const uniqueId = orderData.unique_id || null;
        const distanceKm = parseFloat(orderData.distance_km) || 0;

        const orderDate = creation_date ? new Date(creation_date) : new Date();
        const wibDate = getWibDateString(orderDate); // hari WIB tempat order dihitung

        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();

            // 1) Idempotensi: order yang sama tidak boleh dihitung dua kali
            const [logResult] = await connection.execute(
                `INSERT IGNORE INTO bonus_order_log (order_no, driver_username, distance_km, wib_date)
                 VALUES (?, ?, ?, ?)`,
                [order_no, driver_username, distanceKm, wibDate]
            );
            if (logResult.affectedRows === 0) {
                await connection.rollback();
                return { success: true, skipped: true, new_bonuses: [] };
            }

            // 2) Tambah KM hari WIB ini
            await connection.execute(
                `INSERT INTO driver_daily_km (driver_username, wib_date, total_km)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE total_km = total_km + VALUES(total_km)`,
                [driver_username, wibDate, distanceKm]
            );
            const [kmRows] = await connection.execute(
                `SELECT total_km FROM driver_daily_km
                 WHERE driver_username = ? AND wib_date = ? FOR UPDATE`,
                [driver_username, wibDate]
            );
            const totalKmToday = parseFloat(kmRows[0].total_km);
            const prevKm = totalKmToday - distanceKm;

            // 3) Berapa blok bonus baru yang tercapai
            const newBlocks = Math.floor(totalKmToday / KM_PER_BONUS) - Math.floor(prevKm / KM_PER_BONUS);

            // 4) Saldo bonus berjalan (pending + claimed)
            const [balRows] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) AS total
                 FROM bonus_bbm
                 WHERE driver_username = ? AND status IN ('pending','claimed')`,
                [driver_username]
            );
            let runningBalance = parseFloat(balRows[0].total) || 0;

            const expiredAt = new Date(Date.now() + EXPIRE_DAYS * 24 * 60 * 60 * 1000);
            const createdBonuses = [];

            for (let i = 0; i < newBlocks; i++) {
                const balanceBefore = runningBalance;
                const balanceAfter = balanceBefore + BONUS_PER_BLOCK;

                const [bonusResult] = await connection.execute(
                    `INSERT INTO bonus_bbm
                     (driver_username, driver_phone, order_no, achieved_km, target_km,
                      amount, bonus_type, status, balance_before, balance_after,
                      expired_at, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, 'masuk', 'pending', ?, ?, ?, UTC_TIMESTAMP())`,
                    [
                        driver_username,
                        driver_phone,
                        order_no,
                        KM_PER_BONUS,
                        KM_PER_BONUS,
                        BONUS_PER_BLOCK,
                        balanceBefore,
                        balanceAfter,
                        expiredAt
                    ]
                );
                const bonusId = bonusResult.insertId;

                await connection.execute(
                    `INSERT INTO bonus_bbm_orders (bonus_id, order_no, distance_km, unique_id, order_date)
                     VALUES (?, ?, ?, ?, ?)`,
                    [bonusId, order_no, distanceKm, uniqueId, orderDate]
                );

                runningBalance = balanceAfter;
                createdBonuses.push({
                    id: bonusId,
                    amount: BONUS_PER_BLOCK,
                    achieved_km: KM_PER_BONUS,
                    balance_before: balanceBefore,
                    balance_after: balanceAfter,
                    expired_at: expiredAt
                });
            }

            await connection.commit();

            return {
                success: true,
                skipped: false,
                new_bonuses: createdBonuses,
                total_km_today: totalKmToday,
                wib_date: wibDate
            };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // Cek apakah order sudah pernah diproses
    async hasOrderBonus(orderNo, driverUsername) {
        const [rows] = await this.pool.execute(
            `SELECT COUNT(*) AS count FROM bonus_order_log
             WHERE driver_username = ? AND order_no = ?`,
            [driverUsername, orderNo]
        );
        return rows[0].count > 0;
    }

    // Status bonus + progress KM hari ini (WIB)
    async getDriverBonusStatus(driverUsername) {
        const wibDate = getWibDateString();

        const [kmRows] = await this.pool.execute(
            `SELECT total_km FROM driver_daily_km WHERE driver_username = ? AND wib_date = ?`,
            [driverUsername, wibDate]
        );
        const totalKm = kmRows[0] ? parseFloat(kmRows[0].total_km) : 0;

        const [rows] = await this.pool.execute(
            `SELECT
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount END), 0) AS pending_bonus,
                COALESCE(SUM(CASE WHEN status = 'claimed' THEN amount END), 0) AS claimed_bonus,
                COALESCE(SUM(CASE WHEN status = 'expired' THEN amount END), 0) AS expired_bonus,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_count,
                COUNT(CASE WHEN status = 'claimed' THEN 1 END) AS claimed_count,
                COUNT(CASE WHEN status = 'expired' THEN 1 END) AS expired_count
             FROM bonus_bbm
             WHERE driver_username = ?`,
            [driverUsername]
        );
        const r = rows[0] || {};

        const bonusBlocks = Math.floor(totalKm / KM_PER_BONUS);
        const progress = ((totalKm % KM_PER_BONUS) / KM_PER_BONUS) * 100;

        return {
            wib_date: wibDate,
            total_km_today: totalKm,
            bonus_blocks: bonusBlocks,
            next_target_km: (bonusBlocks + 1) * KM_PER_BONUS,
            progress: Math.min(progress, 100),
            pending_bonus: parseFloat(r.pending_bonus) || 0,
            claimed_bonus: parseFloat(r.claimed_bonus) || 0,
            expired_bonus: parseFloat(r.expired_bonus) || 0,
            pending_count: Number(r.pending_count) || 0,
            claimed_count: Number(r.claimed_count) || 0,
            expired_count: Number(r.expired_count) || 0
        };
    }

    // ─────────────────────────────────────────────
    // CRUD
    // ─────────────────────────────────────────────
    async createBonus(data) {
        const {
            driver_username, driver_phone, order_no, achieved_km,
            target_km = KM_PER_BONUS, amount, balance_before, balance_after,
            bonus_type = 'masuk', status = 'pending'
        } = data;

        const expired_at = new Date(Date.now() + EXPIRE_DAYS * 24 * 60 * 60 * 1000);

        const [result] = await this.pool.execute(
            `INSERT INTO bonus_bbm
             (driver_username, driver_phone, order_no, achieved_km, target_km, amount,
              bonus_type, status, balance_before, balance_after, expired_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
            [
                driver_username, driver_phone, order_no || null, achieved_km, target_km,
                amount, bonus_type, status, balance_before, balance_after, expired_at
            ]
        );
        return result.insertId;
    }

    async createBonusWithOrders(data) {
        const {
            driver_username, driver_phone, achieved_km, target_km = KM_PER_BONUS,
            amount, balance_before, orders = [], bonus_type = 'masuk'
        } = data;

        const expired_at = new Date(Date.now() + EXPIRE_DAYS * 24 * 60 * 60 * 1000);

        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();

            const [bonusResult] = await connection.execute(
                `INSERT INTO bonus_bbm
                 (driver_username, driver_phone, achieved_km, target_km, amount,
                  bonus_type, status, balance_before, balance_after, expired_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, UTC_TIMESTAMP())`,
                [
                    driver_username, driver_phone, achieved_km, target_km, amount,
                    bonus_type, balance_before, data.balance_after || (balance_before + amount),
                    expired_at
                ]
            );
            const bonusId = bonusResult.insertId;

            for (const order of orders) {
                await connection.execute(
                    `INSERT INTO bonus_bbm_orders (bonus_id, order_no, distance_km, unique_id, order_date)
                     VALUES (?, ?, ?, ?, ?)`,
                    [
                        bonusId,
                        order.order_no,
                        order.distance_km || 0,
                        order.unique_id || null,
                        order.order_date ? new Date(order.order_date) : new Date()
                    ]
                );
            }

            await connection.commit();
            return bonusId;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async claimBonus(bonusId, driverUsername) {
        const [result] = await this.pool.execute(
            `UPDATE bonus_bbm
             SET status = 'claimed', bonus_type = 'digunakan',
                 claimed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
             WHERE id = ? AND driver_username = ? AND status = 'pending'
               AND expired_at > UTC_TIMESTAMP()`,
            [bonusId, driverUsername]
        );
        return result.affectedRows > 0;
    }

    async getBonusById(id, driverUsername) {
        const [rows] = await this.pool.execute(
            `SELECT b.*,
                (SELECT COUNT(*) FROM bonus_bbm_orders WHERE bonus_id = b.id) AS order_count
             FROM bonus_bbm b
             WHERE b.id = ? AND b.driver_username = ?`,
            [id, driverUsername]
        );
        const bonus = rows[0];
        if (!bonus) return null;
        bonus.orders = await this._getOrdersOfBonus(bonus);
        return bonus;
    }

    async getBonusesByDriver(driverUsername, filters = {}) {
        const { status, bonus_type } = filters;
        const limit = parseInt(filters.limit, 10) || 50;
        const offset = parseInt(filters.offset, 10) || 0;

        const conditions = ['driver_username = ?'];
        const params = [driverUsername];
        if (status) { conditions.push('status = ?'); params.push(status); }
        if (bonus_type) { conditions.push('bonus_type = ?'); params.push(bonus_type); }

        // pool.query (bukan execute) supaya LIMIT/OFFSET angka aman di MySQL 8
        const [rows] = await this.pool.query(
            `SELECT b.*,
                (SELECT COUNT(*) FROM bonus_bbm_orders WHERE bonus_id = b.id) AS order_count
             FROM bonus_bbm b
             WHERE ${conditions.join(' AND ')}
             ORDER BY b.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        for (const bonus of rows) {
            bonus.orders = await this._getOrdersOfBonus(bonus);
        }
        return rows;
    }

    // order_date: pakai tanggal order asli; data lama (NULL) jatuh ke created_at bonus
    async _getOrdersOfBonus(bonus) {
        const [orders] = await this.pool.execute(
            `SELECT order_no, distance_km, unique_id, order_date
             FROM bonus_bbm_orders WHERE bonus_id = ?`,
            [bonus.id]
        );
        return orders.map(o => ({ ...o, order_date: o.order_date || bonus.created_at }));
    }

    async getBonusSummary(driverUsername) {
        const [rows] = await this.pool.execute(
            `SELECT
                COUNT(*) AS total_bonus,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount END), 0) AS pending_amount,
                COALESCE(SUM(CASE WHEN status = 'claimed' THEN amount END), 0) AS claimed_amount,
                COALESCE(SUM(CASE WHEN status = 'expired' THEN amount END), 0) AS expired_amount,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 END), 0) AS pending_count,
                COALESCE(SUM(CASE WHEN status = 'claimed' THEN 1 END), 0) AS claimed_count,
                COALESCE(SUM(CASE WHEN status = 'expired' THEN 1 END), 0) AS expired_count
             FROM bonus_bbm
             WHERE driver_username = ?`,
            [driverUsername]
        );
        return rows[0];
    }

    async getTotalBonusEarned(driverUsername) {
        const [rows] = await this.pool.execute(
            `SELECT COALESCE(SUM(amount), 0) AS total_earned
             FROM bonus_bbm WHERE driver_username = ? AND status = 'claimed'`,
            [driverUsername]
        );
        return rows[0]?.total_earned || 0;
    }

    async processExpiredBonuses() {
        const [result] = await this.pool.execute(
            `UPDATE bonus_bbm
             SET status = 'expired', bonus_type = 'kadaluarsa', updated_at = UTC_TIMESTAMP()
             WHERE status = 'pending' AND expired_at <= UTC_TIMESTAMP()`
        );
        return result.affectedRows;
    }

    // alias lama
    async getExpiredBonuses() {
        return this.processExpiredBonuses();
    }
}

module.exports = BonusBbm;

