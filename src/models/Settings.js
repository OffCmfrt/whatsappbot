const { dbAdapter } = require('../database/db');

class Settings {
    constructor() {
        // In-memory cache with 60s TTL to avoid repeated slow DB hits on tiny settings table
        // Settings rarely change, so 60s is a safe trade-off
        this._cache = new Map();
        this._cacheTTL = 60_000; // 60 seconds
        this._cacheMaxSize = 100; // NEW: Limit cache size to prevent memory leak
    }

    /**
     * Get a setting by key. 
     * @param {string} key 
     * @param {any} defaultValue - Value to return if setting doesn't exist
     * @returns {Promise<any>}
     */
    async get(key, defaultValue = null) {
        try {
            // Check cache first
            const cached = this._cache.get(key);
            if (cached && (Date.now() - cached.ts) < this._cacheTTL) {
                return cached.value;
            }

            const rows = await dbAdapter.query('SELECT value FROM system_settings WHERE key = ?', [key]);

            if (rows && rows.length > 0) {
                // Try parsing JSON if applicable, otherwise string based
                let value;
                try {
                    value = JSON.parse(rows[0].value);
                } catch {
                    value = rows[0].value;
                }
                
                // NEW: Implement LRU eviction - remove oldest entry if cache is full
                if (this._cache.size >= this._cacheMaxSize) {
                    const firstKey = this._cache.keys().next().value;
                    this._cache.delete(firstKey);
                }
                
                // Update cache
                this._cache.set(key, { value, ts: Date.now() });
                return value;
            }

            return defaultValue;
        } catch (error) {
            console.error(`Error fetching setting ${key}:`, error);
            return defaultValue;
        }
    }

    /**
     * Get multiple settings by prefix matching
     * @param {string} prefix 
     * @returns {Promise<Object>} Dictionary of key-values
     */
    async getBulk(prefix) {
        try {
            const rows = await dbAdapter.query("SELECT key, value FROM system_settings WHERE key LIKE ?", [`${prefix}%`]);
            const result = {};

            for (const row of rows) {
                try {
                    result[row.key] = JSON.parse(row.value);
                } catch {
                    result[row.key] = row.value;
                }
            }

            return result;
        } catch (error) {
            console.error(`Error bulk fetching settings (prefix: ${prefix}):`, error);
            return {};
        }
    }

    /**
     * Create or update a setting
     * @param {string} key 
     * @param {string|number|object} value 
     * @returns {Promise<boolean>} Success status
     */
    async set(key, value) {
        try {
            const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

            await dbAdapter.query(`
                INSERT INTO system_settings (key, value, updated_at) 
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET 
                    value = excluded.value, 
                    updated_at = CURRENT_TIMESTAMP
            `, [key, stringValue]);

            // Invalidate cache for this key
            this._cache.delete(key);

            return true;
        } catch (error) {
            console.error(`Error setting ${key}:`, error);
            return false;
        }
    }

    /**
     * NEW: Clear expired cache entries to prevent memory buildup
     */
    clearOldCache() {
        const now = Date.now();
        let clearedCount = 0;
        for (const [key, entry] of this._cache.entries()) {
            if (now - entry.ts > this._cacheTTL) {
                this._cache.delete(key);
                clearedCount++;
            }
        }
        if (clearedCount > 0) {
            console.log(`[SETTINGS CACHE] Cleared ${clearedCount} expired entries`);
        }
    }
}

module.exports = new Settings();
