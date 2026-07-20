const mysql = require('mysql2/promise');

const dbConfig = {
    host: process.env.DB_HOST || 'c40sk40kc044440gc08s0swo',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'Uk62UEtopsORTE7ZsQeZIS1qydlVikTMYeeNlqm65f6qhTBRNMT33JtzNv8QyrNU',
    database: process.env.DB_NAME || 'bonus',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// Log sederhana status koneksi
(async () => {
    try {
        const connection = await pool.getConnection();
        console.log(`✅ Berhasil terkoneksi ke database "${dbConfig.database}" di ${dbConfig.host}`);
        connection.release();
    } catch (err) {
        console.error(`❌ Gagal terkoneksi ke database: ${err.message}`);
    }
})();

module.exports = pool;