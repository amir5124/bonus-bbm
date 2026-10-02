const mysql = require('mysql2/promise');

// Semua nilai DATETIME disimpan & dibaca sebagai UTC.
// Konversi ke WIB dilakukan di aplikasi (lihat utils/wibDay.js dan frontend).
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,   // WAJIB lewat env, jangan ditulis di kode
    database: process.env.DB_NAME || 'bonus',
    timezone: 'Z',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// Pastikan session MySQL juga UTC (supaya UTC_TIMESTAMP()/NOW() konsisten)
pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
});

(async () => {
    try {
        const connection = await pool.getConnection();
        console.log(`✅ Terkoneksi ke database "${dbConfig.database}" di ${dbConfig.host}`);
        connection.release();
    } catch (err) {
        console.error(`❌ Gagal terkoneksi ke database: ${err.message}`);
    }
})();

// Yang diexport adalah POOL (bukan config)
module.exports = pool;