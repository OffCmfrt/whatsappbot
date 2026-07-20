/**
 * Timezone utility functions for IST (Indian Standard Time)
 * IST = UTC + 5:30
 */

/**
 * Convert a UTC date string/Date object to IST formatted string
 * @param {string|Date} date - UTC date string or Date object
 * @param {string} format - Output format: 'ISO' (default), 'display', 'date', 'time'
 * @returns {string} Formatted date string in IST
 */
function toIST(date, format = 'ISO') {
    if (!date) return null;
    
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    
    // IST offset: UTC + 5:30
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(d.getTime() + istOffsetMs);
    
    switch (format) {
        case 'ISO':
            // Return ISO string representation in IST
            return istDate.toISOString();
            
        case 'display':
            // Format: "15 APR, 2026 09:31 PM"
            const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
            const month = months[istDate.getUTCMonth()];
            const day = istDate.getUTCDate();
            const year = istDate.getUTCFullYear();
            let hours = istDate.getUTCHours();
            const minutes = istDate.getUTCMinutes().toString().padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12;
            hours = hours ? hours : 12;
            return `${day} ${month}, ${year} ${hours}:${minutes} ${ampm}`;
            
        case 'date':
            // Format: "2026-04-15" (IST date)
            const y = istDate.getUTCFullYear();
            const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
            const d2 = String(istDate.getUTCDate()).padStart(2, '0');
            return `${y}-${m}-${d2}`;
            
        case 'time':
            // Format: "09:31 PM" (IST time)
            let h = istDate.getUTCHours();
            const min = istDate.getUTCMinutes().toString().padStart(2, '0');
            const ap = h >= 12 ? 'PM' : 'AM';
            h = h % 12;
            h = h ? h : 12;
            return `${h}:${min} ${ap}`;
            
        case 'datetime':
            // Format: "2026-04-15 21:31:00" (IST datetime for database queries)
            const yr = istDate.getUTCFullYear();
            const mo = String(istDate.getUTCMonth() + 1).padStart(2, '0');
            const dy = String(istDate.getUTCDate()).padStart(2, '0');
            const hr = String(istDate.getUTCHours()).padStart(2, '0');
            const mi = String(istDate.getUTCMinutes()).padStart(2, '0');
            const sc = String(istDate.getUTCSeconds()).padStart(2, '0');
            return `${yr}-${mo}-${dy} ${hr}:${mi}:${sc}`;
            
        default:
            return istDate.toISOString();
    }
}

/**
 * Convert IST date string back to UTC for database queries
 * @param {string} istDateStr - IST date string (YYYY-MM-DD or YYYY-MM-DD HH:mm:ss)
 * @returns {string} UTC date string for database queries
 */
function fromISTtoUTC(istDateStr) {
    if (!istDateStr) return null;
    
    // Parse the IST date string by treating it as UTC first
    // This gives us the "wall clock" time in IST
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    
    // Replace space with T for ISO format parsing
    const isoFormat = istDateStr.replace(' ', 'T') + 'Z';
    const wallClockTime = new Date(isoFormat);
    
    if (isNaN(wallClockTime.getTime())) return null;
    
    // The wall clock time is what we want in IST
    // To get the actual UTC time, we need to SUBTRACT the IST offset
    // (because IST = UTC + 5:30, so UTC = IST - 5:30)
    const utcTime = new Date(wallClockTime.getTime() - istOffsetMs);
    return utcTime.toISOString();
}

/**
 * Format date for Excel/CSV export in IST
 * @param {string|Date} date - UTC date
 * @returns {string} Formatted date string for export
 */
function formatDateForExport(date) {
    return toIST(date, 'display');
}

/**
 * Get current IST time
 * @returns {Date} Current time in IST (as Date object)
 */
function getCurrentIST() {
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    return new Date(Date.now() + istOffsetMs);
}

module.exports = {
    toIST,
    fromISTtoUTC,
    formatDateForExport,
    getCurrentIST
};
