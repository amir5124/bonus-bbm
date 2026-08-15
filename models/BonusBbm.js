const mysql = require('mysql2/promise');
const axios = require('axios');
const pool = require('../config/database');

const CONFIG = {
    jagelApiKey: process.env.JAGEL_APIKEY || 'c6wA9HlUkN2PYEpEOYmDwiehrw7QMIVAvPETMpR2NRN4jjnYPO',
};

// ============================================================
// HELPER: Konversi Date/ISO-string ke format MySQL DATETIME
// MySQL (terutama strict mode) menolak format ISO 8601 seperti
// '2026-08-15T03:07:36.985Z' — harus 'YYYY-MM-DD HH:MM:SS'.
// Kalau input sudah string dengan format itu (mis. dari Jagel:
// "2026-08-15 08:52:24"), akan dipakai apa adanya tanpa geser jam.
// ============================================================
function toMySQLDateTime(dateInput) {
    if (!dateInput) return null;

    // Kalau sudah string format 'YYYY-MM-DD HH:MM:SS' (tanpa T/Z),
    // anggap sudah valid untuk MySQL — pakai langsung, jangan diparse
    // ulang lewat Date() supaya tidak ikut kegeser timezone lokal.
    if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateInput)) {
        return dateInput;
    }

    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return null;

    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
         + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

class BonusBbm {
    constructor() {
        this.pool = pool;
        this.KM_PER_BONUS = 10;
        this.BONUS_PER_BLOCK = 10000;
        console.log('🚀 [BONUS] BonusBbm initialized');
        console.log(`📊 [BONUS] KM per bonus: ${this.KM_PER_BONUS}km`);
        console.log(`📊 [BONUS] Bonus per block: Rp${this.BONUS_PER_BLOCK}`);
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
            unique_id
        } = orderData;

        console.log('═'.repeat(60));
        console.log('🔄 [PROCESS-BONUS] Starting auto bonus processing');
        console.log('═'.repeat(60));
        console.log(`📋 [PROCESS-BONUS] Order: ${order_no}`);
        console.log(`📋 [PROCESS-BONUS] Driver: ${driver_username}`);
        console.log(`📋 [PROCESS-BONUS] Distance: ${distance_km}km`);
        console.log(`📋 [PROCESS-BONUS] Phone: ${driver_phone}`);
        console.log(`📋 [PROCESS-BONUS] Total Price: Rp${total_price || 0}`);
        console.log(`📋 [PROCESS-BONUS] Unique ID: ${unique_id || 'N/A'}`);

        // ── Normalisasi creation_date SEKALI di sini, dipakai untuk
        //    semua insert order_date di bawah ──
        const orderDateForDb = toMySQLDateTime(creation_date) || toMySQLDateTime(new Date());
        console.log(`📅 [PROCESS-BONUS] Order date (normalized for DB): ${orderDateForDb}`);

        const connection = await this.pool.getConnection();
        console.log('✅ [PROCESS-BONUS] Database connection acquired');

        await connection.beginTransaction();
        console.log('🔓 [PROCESS-BONUS] Transaction started');

        try {
            const today = new Date().toISOString().split('T')[0];
            console.log(`📅 [PROCESS-BONUS] Today: ${today}`);

            // 🔥 Cek total jarak hari ini (pending + claimed, expired dikecualikan)
            console.log('🔍 [PROCESS-BONUS] Fetching today\'s bonus data...');
            const [todayBonuses] = await connection.execute(
                `SELECT 
                    COALESCE(SUM(amount), 0) as total_bonus, 
                    COALESCE(SUM(achieved_km), 0) as total_km,
                    COUNT(*) as total_count
                 FROM bonus_bbm 
                 WHERE driver_username = ? AND DATE(created_at) = ? 
                   AND status IN ('pending', 'claimed')`,
                [driver_username, today]
            );

            console.log(`📊 [PROCESS-BONUS] Today's stats:`);
            console.log(`   - Total Bonus: Rp${todayBonuses[0]?.total_bonus || 0}`);
            console.log(`   - Total KM: ${todayBonuses[0]?.total_km || 0}km`);
            console.log(`   - Total Count: ${todayBonuses[0]?.total_count || 0}`);

            const currentTotalBonus = Number(todayBonuses[0]?.total_bonus) || 0;
            const currentTotalKm = Number(todayBonuses[0]?.total_km) || 0;

            const totalKmToday = currentTotalKm + distance_km;
            const bonusBlocks = Math.floor(totalKmToday / this.KM_PER_BONUS);
            const existingBlocks = Math.floor(currentTotalKm / this.KM_PER_BONUS);
            const newBlocks = bonusBlocks - existingBlocks;

            console.log(`📊 [PROCESS-BONUS] Calculation:`);
            console.log(`   - Current KM: ${currentTotalKm}km`);
            console.log(`   - New KM: ${totalKmToday}km`);
            console.log(`   - Current Blocks: ${existingBlocks}`);
            console.log(`   - Total Blocks: ${bonusBlocks}`);
            console.log(`   - New Blocks: ${newBlocks}`);

            const createdBonuses = [];

            if (newBlocks <= 0) {
                console.log(`⏭️ [PROCESS-BONUS] No new bonus (need ${this.KM_PER_BONUS}km per block)`);
                console.log(`   - Next target: ${(bonusBlocks + 1) * this.KM_PER_BONUS}km`);
                await connection.commit();
                console.log('✅ [PROCESS-BONUS] Transaction committed (no new bonus)');
                console.log('═'.repeat(60));

                return {
                    success: true,
                    new_bonuses: [],
                    message: 'Belum mencapai target bonus',
                    total_km_today: totalKmToday,
                    total_bonus_today: currentTotalBonus,
                    next_target: (bonusBlocks + 1) * this.KM_PER_BONUS
                };
            }

            console.log(`📝 [PROCESS-BONUS] Creating ${newBlocks} new bonus(es)...`);

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

                console.log(`📝 [PROCESS-BONUS] Bonus #${blockNumber}:`);
                console.log(`   - Achieved KM: ${achievedKm}km`);
                console.log(`   - Amount: Rp${this.BONUS_PER_BLOCK}`);
                console.log(`   - Balance Before: Rp${balanceBefore}`);
                console.log(`   - Balance After: Rp${balanceAfter}`);
                console.log(`   - Expired At: ${expiredAt.toISOString()}`);

                const [bonusResult] = await connection.execute(
                    `INSERT INTO bonus_bbm 
                     (driver_username, driver_phone, order_no, achieved_km, target_km, 
                      amount, bonus_type, status, balance_before, balance_after, 
                      expired_at, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, 'masuk', 'pending', ?, ?, ?, NOW())`,
                    [
                        driver_username,
                        driver_phone,
                        order_no,
                        achievedKm,
                        this.KM_PER_BONUS,
                        this.BONUS_PER_BLOCK,
                        balanceBefore,
                        balanceAfter,
                        toMySQLDateTime(expiredAt)
                    ]
                );

                const bonusId = bonusResult.insertId;
                console.log(`✅ [PROCESS-BONUS] Bonus inserted with ID: ${bonusId}`);

                await connection.execute(
                    `INSERT INTO bonus_bbm_orders (bonus_id, order_no, distance_km, unique_id, order_date)
                     VALUES (?, ?, ?, ?, ?)`,
                    [bonusId, order_no, distance_km, unique_id || null, orderDateForDb]
                );
                console.log(`✅ [PROCESS-BONUS] Order linked to bonus ID: ${bonusId}`);

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
            console.log('✅ [PROCESS-BONUS] Transaction committed');

            console.log(`📊 [PROCESS-BONUS] Summary:`);
            console.log(`   - Total New Bonuses: ${createdBonuses.length}`);
            console.log(`   - Total Bonus Today: Rp${currentTotalBonus + (createdBonuses.length * this.BONUS_PER_BLOCK)}`);
            console.log(`   - Total KM Today: ${totalKmToday}km`);
            console.log(`   - Next Target: ${(bonusBlocks + 1) * this.KM_PER_BONUS}km`);
            console.log('═'.repeat(60));

            return {
                success: true,
                new_bonuses: createdBonuses,
                total_bonus_today: currentTotalBonus + (createdBonuses.length * this.BONUS_PER_BLOCK),
                total_km_today: totalKmToday,
                next_target: (bonusBlocks + 1) * this.KM_PER_BONUS
            };

        } catch (error) {
            await connection.rollback();
            console.error('❌ [PROCESS-BONUS] Error:', error);
            console.error('❌ [PROCESS-BONUS] Stack:', error.stack);
            console.log('🔓 [PROCESS-BONUS] Transaction rolled back');
            console.log('═'.repeat(60));
            throw error;
        } finally {
            connection.release();
            console.log('🔓 [PROCESS-BONUS] Database connection released');
        }
    }

    // Cek apakah order sudah memiliki bonus
    async hasOrderBonus(orderNo, driverUsername) {
        console.log(`🔍 [HAS-BONUS] Checking order ${orderNo} for driver ${driverUsername}`);

        const [rows] = await this.pool.execute(
            `SELECT COUNT(*) as count 
             FROM bonus_bbm 
             WHERE driver_username = ? AND order_no = ?`,
            [driverUsername, orderNo]
        );

        const hasBonus = rows[0].count > 0;
        console.log(`🔍 [HAS-BONUS] Result: ${hasBonus} (${rows[0].count} bonuses found)`);
        return hasBonus;
    }

    // ============================================================
    // STATUS / SUMMARY
    // ============================================================
    async getDriverBonusStatus(driverUsername) {
        console.log(`📊 [STATUS] Getting bonus status for ${driverUsername}`);

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

        const status = {
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

        console.log(`📊 [STATUS] Status for ${driverUsername}:`, status);
        return status;
    }

    // ============================================================
    // LIST / DETAIL BONUS
    // ============================================================

    async getBonusesByDriver(driverUsername, opts = {}) {
        const { status, from, to, limit = 10, offset = 0 } = opts;

        console.log(`📋 [LIST] Getting bonuses for ${driverUsername}`);
        console.log(`📋 [LIST] Options:`, { status, from, to, limit, offset });

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
                    expired_at, created_at, claimed_at
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

        console.log(`📋 [LIST] Found ${bonusRows.length} bonuses (total: ${total})`);

        const enriched = await this._attachOrders(bonusRows);

        return {
            items: enriched,
            total,
            limit,
            offset,
        };
    }

    async getBonusDetail(bonusId) {
        console.log(`🔍 [DETAIL] Getting bonus detail for ID: ${bonusId}`);

        const [rows] = await this.pool.execute(
            `SELECT id, driver_username, driver_phone, order_no, achieved_km, target_km,
                    amount, bonus_type, status, balance_before, balance_after,
                    expired_at, created_at, claimed_at
             FROM bonus_bbm WHERE id = ?`,
            [bonusId]
        );

        if (rows.length === 0) {
            console.log(`❌ [DETAIL] Bonus ID ${bonusId} not found`);
            return null;
        }

        const [enriched] = await this._attachOrders(rows);
        console.log(`✅ [DETAIL] Bonus found: ID ${bonusId}, status: ${enriched.status}`);
        return enriched;
    }

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

    async getBonusHistory(driverUsername, opts = {}) {
        console.log(`📜 [HISTORY] Getting bonus history for ${driverUsername}`);
        const result = await this.getBonusesByDriver(driverUsername, { limit: 100, ...opts });
        return result.items;
    }

    // ============================================================
    // KLAIM BONUS: adjust saldo penuh + notif
    // ============================================================
    async _adjustBalanceAndNotify({ username, amount, note }) {
        console.log('─'.repeat(40));
        console.log(`📤 [ADJUST-BALANCE] Starting for ${username}`);
        console.log(`📤 [ADJUST-BALANCE] Amount: Rp${amount}`);
        console.log(`📤 [ADJUST-BALANCE] Note: ${note}`);

        const adjustPayload = {
            type: "username",
            value: username,
            apikey: CONFIG.jagelApiKey,
            amount: amount,
            adjust_balance_admin: 0,
            note: note,
        };

        console.log(`📤 [ADJUST-BALANCE] Payload:`, JSON.stringify(adjustPayload));

        try {
            const adjustResponse = await axios.post(
                'https://api.jagel.id/v1/balance/adjust',
                adjustPayload,
                {
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    timeout: 30000,
                }
            );

            console.log(`✅ [ADJUST-BALANCE] Response:`, adjustResponse.data);

            if (adjustResponse.data?.success !== true) {
                throw new Error("Adjust balance gagal: " + JSON.stringify(adjustResponse.data));
            }

            // Kirim notifikasi
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
                console.log(`✅ [ADJUST-BALANCE] Message sent:`, msgResponse.data);
            } catch (msgErr) {
                console.error(`⚠️ [ADJUST-BALANCE] Failed to send message:`, msgErr.message);
            }

            console.log('─'.repeat(40));
            return adjustResponse.data;

        } catch (error) {
            console.error(`❌ [ADJUST-BALANCE] Error:`, error.message);
            throw error;
        }
    }

    async claimBonus(bonusId) {
        console.log('═'.repeat(60));
        console.log(`💰 [CLAIM] Claiming bonus ID: ${bonusId}`);
        console.log('═'.repeat(60));

        const connection = await this.pool.getConnection();
        await connection.beginTransaction();

        try {
            const [rows] = await connection.execute(
                `SELECT * FROM bonus_bbm WHERE id = ? FOR UPDATE`,
                [bonusId]
            );

            const bonus = rows[0];
            if (!bonus) {
                console.log(`❌ [CLAIM] Bonus ID ${bonusId} not found`);
                throw new Error('Bonus tidak ditemukan');
            }

            console.log(`📋 [CLAIM] Bonus found:`);
            console.log(`   - Driver: ${bonus.driver_username}`);
            console.log(`   - Amount: Rp${bonus.amount}`);
            console.log(`   - Status: ${bonus.status}`);
            console.log(`   - Order: ${bonus.order_no}`);
            console.log(`   - Achieved KM: ${bonus.achieved_km}km`);

            if (bonus.status !== 'pending') {
                console.log(`❌ [CLAIM] Bonus already ${bonus.status}`);
                throw new Error(`Bonus sudah berstatus '${bonus.status}', tidak bisa diklaim ulang`);
            }

            if (bonus.expired_at && new Date(bonus.expired_at) < new Date()) {
                console.log(`❌ [CLAIM] Bonus expired at ${bonus.expired_at}`);
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

            console.log(`📝 [CLAIM] Updating status to 'claimed'...`);
            await connection.execute(
                `UPDATE bonus_bbm SET status = 'claimed', claimed_at = NOW() WHERE id = ?`,
                [bonusId]
            );

            await connection.commit();
            console.log(`✅ [CLAIM] Database updated successfully`);

            console.log(`📤 [CLAIM] Adjusting balance...`);
            const jagelResult = await this._adjustBalanceAndNotify({ username, amount, note });

            console.log('═'.repeat(60));
            console.log(`✅ [CLAIM] Bonus claimed successfully!`);
            console.log(`   - Bonus ID: ${bonusId}`);
            console.log(`   - Driver: ${username}`);
            console.log(`   - Amount: Rp${amount}`);
            console.log('═'.repeat(60));

            return {
                success: true,
                bonus_id: bonusId,
                driver_username: username,
                amount,
                note,
                jagel_response: jagelResult?.data,
            };

        } catch (error) {
            await connection.rollback();
            console.error(`❌ [CLAIM] Error:`, error.message);
            console.log('═'.repeat(60));
            throw error;
        } finally {
            connection.release();
        }
    }

    async claimAllPendingBonus(driverUsername) {
        console.log('═'.repeat(60));
        console.log(`💰 [CLAIM-ALL] Claiming all pending bonuses for ${driverUsername}`);
        console.log('═'.repeat(60));

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
                console.log(`⏭️ [CLAIM-ALL] No pending bonuses found`);
                await connection.commit();
                return {
                    success: true,
                    message: 'Tidak ada bonus pending untuk diklaim',
                    claimed_count: 0,
                    total_amount: 0,
                };
            }

            console.log(`📋 [CLAIM-ALL] Found ${rows.length} pending bonuses`);
            rows.forEach((b, idx) => {
                console.log(`   - #${idx + 1}: ID ${b.id}, Rp${b.amount}, ${b.achieved_km}km`);
            });

            const ids = rows.map(r => r.id);
const totalAmount = rows.reduce((sum, r) => sum + Number(r.amount), 0);
            const totalKm = rows.reduce((sum, r) => sum + Number(r.achieved_km), 0);

            await connection.query(
                `UPDATE bonus_bbm SET status = 'claimed', claimed_at = NOW() WHERE id IN (?)`,
                [ids]
            );

            await connection.commit();

            const username = driverUsername.trim();
            const formattedAmount = totalAmount.toLocaleString('id-ID');
            const note = `Bonus BBM Cair || total Rp. ${formattedAmount} || ${rows.length} bonus (${totalKm} km) || Klaim Batch`;

            console.log(`📤 [CLAIM-ALL] Adjusting balance: Rp${totalAmount}`);
            const jagelResult = await this._adjustBalanceAndNotify({
                username,
                amount: totalAmount,
                note,
            });

            console.log('═'.repeat(60));
            console.log(`✅ [CLAIM-ALL] ${rows.length} bonuses claimed successfully!`);
            console.log(`   - Total Amount: Rp${totalAmount}`);
            console.log(`   - Total KM: ${totalKm}km`);
            console.log('═'.repeat(60));

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
            await connection.rollback();
            console.error(`❌ [CLAIM-ALL] Error:`, error.message);
            console.log('═'.repeat(60));
            throw error;
        } finally {
            connection.release();
        }
    }

    // ============================================================
    // PROSES BONUS EXPIRED
    // ============================================================
    async markExpiredBonuses() {
        console.log(`⏰ [EXPIRE] Marking expired bonuses...`);

        const [result] = await this.pool.execute(
            `UPDATE bonus_bbm 
             SET status = 'expired' 
             WHERE status = 'pending' AND expired_at IS NOT NULL AND expired_at < NOW()`
        );

        console.log(`✅ [EXPIRE] ${result.affectedRows} bonuses marked as expired`);
        return { expired_count: result.affectedRows };
    }
}

module.exports = BonusBbm;