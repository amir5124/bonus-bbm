// cron/bonusExpiry.js
const cron = require('node-cron');
const BonusBbm = require('../models/BonusBbm');

const bonusModel = new BonusBbm();

// Jalankan setiap jam 00:00
cron.schedule('0 0 * * *', async () => {
    console.log('Running bonus expiry checker...');
    try {
        const count = await bonusModel.processExpiredBonuses();
        console.log(`✅ ${count} expired bonuses processed`);
    } catch (error) {
        console.error('❌ Error processing expired bonuses:', error);
    }
});

// Jalankan juga setiap jam untuk safety
cron.schedule('0 * * * *', async () => {
    console.log('Running hourly bonus expiry check...');
    try {
        const count = await bonusModel.processExpiredBonuses();
        if (count > 0) {
            console.log(`✅ ${count} expired bonuses processed (hourly check)`);
        }
    } catch (error) {
        console.error('❌ Error in hourly bonus expiry check:', error);
    }
});