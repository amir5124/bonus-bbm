const WIB_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// "YYYY-MM-DD" menurut tanggal WIB
function getWibDateString(date = new Date()) {
    return new Date(date.getTime() + WIB_MS).toISOString().slice(0, 10);
}

// Awal (inklusif) dan akhir (eksklusif) hari WIB, dalam objek Date UTC
function getWibDayRangeUtc(date = new Date()) {
    const wib = new Date(date.getTime() + WIB_MS);
    const startMs = Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate()) - WIB_MS;
    return { start: new Date(startMs), end: new Date(startMs + DAY_MS) };
}

module.exports = { getWibDateString, getWibDayRangeUtc };
