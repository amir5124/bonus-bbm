const mysql = require('mysql2/promise');
const axios = require('axios');
const config = require('../config/database');

const CONFIG = {
    jagelApiKey: process.env.JAGEL_APIKEY || 'c6wA9HlUkN2PYEpEOYmDwiehrw7QMIVAvPETMpR2NRN4jjnYPO',
};

class BonusBbm {
    constructor() {
        this.pool = mysql.createPool(config);
        this.KM_PER_BONUS = 3; // 3 km = 1 bonus
        this.BONUS_PER_BLOCK = 10000; // Rp 10.000 per bonus
    }

    // ============================================================
    // AUTO BONUS: Proses bonus saat order selesai
    // ============================================================
    async processAutoBonus(orderData) {
        const {
            driver_username,
            driver_phone,
            order_no,
            distance_km,
            creation_date,
            total_price,
            unique_id // opsional
        } = orderData;

        const connection = await this.pool.getConnection();
        await connection.beginTransaction();

        try {
            const today = new Date().toISOString().split('T')[0];
            const [todayBonuses] = await connection.execute(
                `SELECT SUM(amount) as total_bonus, SUM(achieved_km) as total_km
         FROM bonus_bbm 
         WHERE driver_username = ? AND DATE(created_at) = ? AND status = 'claimed'`,
                [driver_username, today]
            );

            const currentTotalBonus = todayBonuses[0]?.total_bonus || 0;
            const currentTotalKm = todayBonuses[0]?.total_km || 0;

            const totalKmToday = currentTotalKm + distance_km;

            const bonusBlocks = Math.floor(totalKmToday / this.KM_PER_BONUS);
            const existingBlocks = Math.floor(currentTotalKm / this.KM_PER_BONUS);
            const newBlocks = bonusBlocks - existingBlocks;

            const createdBonuses = [];

            for (let i = 0; i < newBlocks; i++) {
                const blockNumber = existingBlocks + i + 1;
                const achievedKm = Math.min(
                    (blockNumber * this.KM_PER_BONUS) - (currentTotalKm + (i * this.KM_PER_BONUS)),
                    this.KM_PER_BONUS
                );

                const balanceBefore = currentTotalBonus + (i * this.BONUS_PER_BLOCK);
                const balanceAfter = balanceBefore + this.BONUS_PER_BLOCK;

                const expiredAt = new Date();
                expiredAt.setDate(expiredAt.getDate() + 7);

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
                        order_no
                    ]
                );

                const bonusId = bonusResult.insertId;

                await connection.execute(
                    `INSERT INTO bonus_bbm_orders (bonus_id, order_no, distance_km, unique_id, order_date)
           VALUES (?, ?, ?, ?, ?)`,
                    [bonusId, order_no, distance_km, unique_id || null, creation_date || null]
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

    // ============================================================
    // STATUS / SUMMARY
    // ============================================================
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
            claimed_count: rows[0]?.claimed_count || 0,
            km_per_bonus: this.KM_PER_BONUS,
            bonus_per_block: this.BONUS_PER_BLOCK,
        };
    }

    // ============================================================
    // LIST / DETAIL BONUS
    // ============================================================

    /**
     * List bonus milik driver, dengan filter opsional & pagination.
     * @param {string} driverUsername
     * @param {object} opts { status, from, to, limit=10, offset=0 }
     */
    async getBonusesByDriver(driverUsername, opts = {}) {
        const { status, from, to, limit = 10, offset = 0 } = opts;

        const where = ['driver_username = ?'];
        const params = [driverUsername];

        if (status) {
            where.push('status = ?');
            params.push(status);
        }
        if (from) {
            where.push('DATE(created_at) >= ?');
            params.push(from);
        }
        if (to) {
            where.push('DATE(created_at) <= ?');
            params.push(to);
        }

        const [bonusRows] = await this.pool.query(
            `SELECT id, driver_username, driver_phone, order_no, achieved_km, target_km,
              amount, bonus_type, status, balance_before, balance_after,
              expired_at, created_at, claimed_at, source_order
       FROM bonus_bbm
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const [[{ total }]] = await this.pool.query(
            `SELECT COUNT(*) as total FROM bonus_bbm WHERE ${where.join(' AND ')}`,
            params
        );

        const enriched = await this._attachOrders(bonusRows);

        return {
            items: enriched,
            total,
            limit,
            offset,
        };
    }

    /**
     * Detail satu bonus (dengan daftar order penyusunnya).
     */
    async getBonusDetail(bonusId) {
        const [rows] = await this.pool.execute(
            `SELECT id, driver_username, driver_phone, order_no, achieved_km, target_km,
              amount, bonus_type, status, balance_before, balance_after,
              expired_at, created_at, claimed_at, source_order
       FROM bonus_bbm WHERE id = ?`,
            [bonusId]
        );

        if (rows.length === 0) return null;

        const [enriched] = await this._attachOrders(rows);
        return enriched;
    }

    /** Helper: lampirkan daftar order (bonus_bbm_orders) ke tiap baris bonus. */
    async _attachOrders(bonusRows) {
        if (bonusRows.length === 0) return [];

        const bonusIds = bonusRows.map(b => b.id);
        const [orderRows] = await this.pool.query(
            `SELECT bonus_id, order_no, distance_km, unique_id, order_date
       FROM bonus_bbm_orders
       WHERE bonus_id IN (?)
       ORDER BY order_date ASC, id ASC`,
            [bonusIds]
        );

        const ordersByBonus = {};
        orderRows.forEach(o => {
            (ordersByBonus[o.bonus_id] = ordersByBonus[o.bonus_id] || []).push({
                order_no: o.order_no,
                distance_km: o.distance_km,
                unique_id: o.unique_id,
                order_date: o.order_date,
            });
        });

        return bonusRows.map(b => ({
            id: b.id,
            driver_username: b.driver_username,
            driver_phone: b.driver_phone,
            type: b.bonus_type,
            status: b.status,
            achieved_km: Number(b.achieved_km),
            target_km: Number(b.target_km),
            amount: b.amount,
            balance_before: b.balance_before,
            balance_after: b.balance_after,
            created_at: b.created_at,
            claimed_at: b.claimed_at,
            expired_at: b.expired_at,
            order_no: b.order_no,
            orders: ordersByBonus[b.id] || [],
        }));
    }

    // Alias — nama historis, dipakai kalau perlu ambil full history tanpa pagination
    async getBonusHistory(driverUsername, opts = {}) {
        const result = await this.getBonusesByDriver(driverUsername, { limit: 100, ...opts });
        return result.items;
    }

    // ============================================================
    // KLAIM BONUS: adjust saldo penuh (TANPA potongan admin) + notif
    // ============================================================
    async _adjustBalanceAndNotify({ username, amount, note }) {
        const adjustPayload = {
            type: "username",
            value: username,
            apikey: CONFIG.jagelApiKey,
            amount: amount, // penuh, tanpa potongan admin
            adjust_balance_admin: 0,
            note: note,
        };

        console.log(`📤 [CLAIM-BONUS] Adjust Payload:`, JSON.stringify(adjustPayload));

        const adjustResponse = await axios.post(
            'https://api.jagel.id/v1/balance/adjust',
            adjustPayload,
            {
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                timeout: 30000,
            }
        );

        console.log("✅ Adjust Balance Response:", adjustResponse.data);

        if (adjustResponse.data?.success !== true) {
            throw new Error("Adjust balance gagal: " + JSON.stringify(adjustResponse.data));
        }

        try {
            const msgResponse = await axios.post(
                'https://api.jagel.id/v1/message/send',
                {
                    type: "username",
                    value: username,
                    apikey: CONFIG.jagelApiKey,
                    content: note,
                },
                {
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    timeout: 30000,
                }
            );
            console.log("✅ Message Sent Response:", msgResponse.data);
        } catch (msgErr) {
            console.error("⚠️ Gagal kirim message (Ignored):", msgErr.message);
        }

        return adjustResponse.data;
    }

    async claimBonus(bonusId) {
        const connection = await this.pool.getConnection();
        await connection.beginTransaction();

        try {
            const [rows] = await connection.execute(
                `SELECT * FROM bonus_bbm WHERE id = ? FOR UPDATE`,
                [bonusId]
            );

            const bonus = rows[0];
            if (!bonus) {
                throw new Error('Bonus tidak ditemukan');
            }
            if (bonus.status !== 'pending') {
                throw new Error(`Bonus sudah berstatus '${bonus.status}', tidak bisa diklaim ulang`);
            }
            if (bonus.expired_at && new Date(bonus.expired_at) < new Date()) {
                await connection.execute(
                    `UPDATE bonus_bbm SET status = 'expired' WHERE id = ?`,
                    [bonusId]
                );
                await connection.commit();
                throw new Error('Bonus sudah expired');
            }

            const amount = bonus.amount;
            const username = bonus.driver_username.trim();
            const formattedAmount = amount.toLocaleString('id-ID');
            const note = `Bonus BBM Cair || nominal Rp. ${formattedAmount} || jarak tempuh ${bonus.achieved_km} km || Order ${bonus.order_no}`;

            await connection.execute(
                `UPDATE bonus_bbm SET status = 'claimed', claimed_at = NOW() WHERE id = ?`,
                [bonusId]
            );

            await connection.commit();

            const jagelResult = await this._adjustBalanceAndNotify({ username, amount, note });

            return {
                success: true,
                bonus_id: bonusId,
                driver_username: username,
                amount,
                note,
                jagel_response: jagelResult?.data,
            };

        } catch (error) {
            try { await connection.rollback(); } catch (_) {}
            throw error;
        } finally {
            connection.release();
        }
    }

    async claimAllPendingBonus(driverUsername) {
        const connection = await this.pool.getConnection();
        await connection.beginTransaction();

        try {
            const [rows] = await connection.execute(
                `SELECT * FROM bonus_bbm 
         WHERE driver_username = ? AND status = 'pending'
         AND (expired_at IS NULL OR expired_at >= NOW())
         FOR UPDATE`,
                [driverUsername]
            );

            if (rows.length === 0) {
                await connection.commit();
                return {
                    success: true,
                    message: 'Tidak ada bonus pending untuk diklaim',
                    claimed_count: 0,
                    total_amount: 0,
                };
            }

            const ids = rows.map(r => r.id);
            const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0);
            const totalKm = rows.reduce((sum, r) => sum + Number(r.achieved_km), 0);

            await connection.query(
                `UPDATE bonus_bbm SET status = 'claimed', claimed_at = NOW() WHERE id IN (?)`,
                [ids]
            );

            await connection.commit();

            const username = driverUsername.trim();
            const formattedAmount = totalAmount.toLocaleString('id-ID');
            const note = `Bonus BBM Cair || total Rp. ${formattedAmount} || ${rows.length} bonus (${totalKm} km) || Klaim Batch`;

            const jagelResult = await this._adjustBalanceAndNotify({
                username,
                amount: totalAmount,
                note,
            });

            return {
                success: true,
                driver_username: username,
                claimed_count: rows.length,
                claimed_ids: ids,
                total_amount: totalAmount,
                total_km: totalKm,
                note,
                jagel_response: jagelResult?.data,
            };

        } catch (error) {
            try { await connection.rollback(); } catch (_) {}
            throw error;
        } finally {
            connection.release();
        }
    }

    // ============================================================
    // PROSES BONUS EXPIRED (idealnya dipanggil lewat cron job harian)
    // ============================================================
    async markExpiredBonuses() {
        const [result] = await this.pool.execute(
            `UPDATE bonus_bbm 
       SET status = 'expired' 
       WHERE status = 'pending' AND expired_at IS NOT NULL AND expired_at < NOW()`
        );
        return { expired_count: result.affectedRows };
    }
}

module.exports = BonusBbm;