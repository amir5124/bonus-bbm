const mysql = require('mysql2/promise');
const config = require('../config/database');

class BonusBbm {
    constructor() {
        this.pool = mysql.createPool(config);
    }

    async createBonus(data) {
        const {
            driver_username,
            driver_phone,
            order_no,
            achieved_km,
            target_km = 3.00,
            amount,
            balance_before,
            balance_after,
            bonus_type = 'masuk',
            status = 'pending'
        } = data;

        const expired_at = new Date();
        expired_at.setDate(expired_at.getDate() + 7); // 7 hari kadaluarsa

        const query = `
      INSERT INTO bonus_bbm 
      (driver_username, driver_phone, order_no, achieved_km, target_km, amount, 
       bonus_type, status, balance_before, balance_after, expired_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;

        const [result] = await this.pool.execute(query, [
            driver_username,
            driver_phone,
            order_no || null,
            achieved_km,
            target_km,
            amount,
            bonus_type,
            status,
            balance_before,
            balance_after,
            expired_at
        ]);

        return result.insertId;
    }

    async createBonusWithOrders(data) {
        const {
            driver_username,
            driver_phone,
            achieved_km,
            target_km = 3.00,
            amount,
            balance_before,
            orders = [],
            bonus_type = 'masuk'
        } = data;

        const expired_at = new Date();
        expired_at.setDate(expired_at.getDate() + 7);

        const connection = await this.pool.getConnection();
        await connection.beginTransaction();

        try {
            // Insert bonus utama
            const [bonusResult] = await connection.execute(
                `INSERT INTO bonus_bbm 
         (driver_username, driver_phone, achieved_km, target_km, amount, 
          bonus_type, status, balance_before, balance_after, expired_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NOW())`,
                [
                    driver_username,
                    driver_phone,
                    achieved_km,
                    target_km,
                    amount,
                    bonus_type,
                    balance_before,
                    balance_after || (balance_before + amount),
                    expired_at
                ]
            );

            const bonusId = bonusResult.insertId;

            // Insert order terkait
            if (orders.length > 0) {
                const orderQueries = orders.map(order =>
                    connection.execute(
                        `INSERT INTO bonus_bbm_orders (bonus_id, order_no, distance_km)
             VALUES (?, ?, ?)`,
                        [bonusId, order.order_no, order.distance_km || 0]
                    )
                );
                await Promise.all(orderQueries);
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
        const query = `
      UPDATE bonus_bbm 
      SET status = 'claimed', 
          bonus_type = 'digunakan',
          claimed_at = NOW(),
          updated_at = NOW()
      WHERE id = ? AND driver_username = ? AND status = 'pending' 
      AND expired_at > NOW()
    `;

        const [result] = await this.pool.execute(query, [bonusId, driverUsername]);
        return result.affectedRows > 0;
    }

    async getBonusById(id, driverUsername) {
        const query = `
      SELECT b.*, 
             (SELECT COUNT(*) FROM bonus_bbm_orders WHERE bonus_id = b.id) as order_count,
             (SELECT JSON_ARRAYAGG(
                JSON_OBJECT('order_no', order_no, 'distance_km', distance_km)
             ) FROM bonus_bbm_orders WHERE bonus_id = b.id) as orders
      FROM bonus_bbm b
      WHERE b.id = ? AND b.driver_username = ?
    `;

        const [rows] = await this.pool.execute(query, [id, driverUsername]);
        return rows[0] || null;
    }

    async getBonusesByDriver(driverUsername, filters = {}) {
        let { status, bonus_type, limit = 50, offset = 0 } = filters;
        let conditions = ['driver_username = ?'];
        let params = [driverUsername];

        if (status) {
            conditions.push('status = ?');
            params.push(status);
        }

        if (bonus_type) {
            conditions.push('bonus_type = ?');
            params.push(bonus_type);
        }

        const whereClause = conditions.join(' AND ');

        const query = `
      SELECT b.*, 
             (SELECT COUNT(*) FROM bonus_bbm_orders WHERE bonus_id = b.id) as order_count
      FROM bonus_bbm b
      WHERE ${whereClause}
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?
    `;

        const [rows] = await this.pool.execute(query, [...params, limit, offset]);

        // Get orders for each bonus
        for (const bonus of rows) {
            const [orders] = await this.pool.execute(
                'SELECT order_no, distance_km FROM bonus_bbm_orders WHERE bonus_id = ?',
                [bonus.id]
            );
            bonus.orders = orders;
        }

        return rows;
    }

    async getExpiredBonuses() {
        const query = `
      UPDATE bonus_bbm 
      SET status = 'expired', 
          bonus_type = 'kadaluarsa',
          updated_at = NOW()
      WHERE status = 'pending' AND expired_at <= NOW()
    `;

        const [result] = await this.pool.execute(query);
        return result.affectedRows;
    }

    async getBonusSummary(driverUsername) {
        const query = `
      SELECT 
        COUNT(*) as total_bonus,
        SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) as pending_amount,
        SUM(CASE WHEN status = 'claimed' THEN amount ELSE 0 END) as claimed_amount,
        SUM(CASE WHEN status = 'expired' THEN amount ELSE 0 END) as expired_amount,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) as claimed_count,
        SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired_count
      FROM bonus_bbm
      WHERE driver_username = ?
    `;

        const [rows] = await this.pool.execute(query, [driverUsername]);
        return rows[0] || {
            total_bonus: 0,
            pending_amount: 0,
            claimed_amount: 0,
            expired_amount: 0,
            pending_count: 0,
            claimed_count: 0,
            expired_count: 0
        };
    }

    async getTotalBonusEarned(driverUsername) {
        const query = `
      SELECT SUM(amount) as total_earned
      FROM bonus_bbm
      WHERE driver_username = ? AND status = 'claimed'
    `;

        const [rows] = await this.pool.execute(query, [driverUsername]);
        return rows[0]?.total_earned || 0;
    }

    async processExpiredBonuses() {
        const query = `
      UPDATE bonus_bbm 
      SET status = 'expired', 
          bonus_type = 'kadaluarsa',
          updated_at = NOW()
      WHERE status = 'pending' AND expired_at <= NOW()
    `;

        const [result] = await this.pool.execute(query);
        return result.affectedRows;
    }
}

module.exports = BonusBbm;