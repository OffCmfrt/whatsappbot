/**
 * Advanced In-Memory Caching System with LRU Eviction
 * Reduces database reads by caching frequently accessed data
 */

class LRUCache {
  constructor(maxSize = 100, defaultTTL = 5 * 60 * 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL; // 5 minutes default
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  get(key) {
    if (!this.cache.has(key)) {
      this.stats.misses++;
      return null;
    }

    const item = this.cache.get(key);
    
    // Check if expired
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, item);
    
    this.stats.hits++;
    return item.value;
  }

  set(key, value, ttl = this.defaultTTL) {
    // If key exists, delete it first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } 
    // Check if we need to evict
    else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first item in Map)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
      this.stats.evictions++;
    }

    this.cache.set(key, {
      value,
      expiry: Date.now() + ttl,
      createdAt: Date.now()
    });
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRate: total > 0 ? (this.stats.hits / total * 100).toFixed(2) + '%' : '0%',
      size: this.cache.size,
      maxSize: this.maxSize
    };
  }

  // Get all keys
  keys() {
    return Array.from(this.cache.keys());
  }

  // Get cache size
  size() {
    return this.cache.size;
  }
}

// Create specialized caches for different use cases
const caches = {
  // Customer lookups by phone (high frequency, small data)
  customers: new LRUCache(500, 10 * 60 * 1000), // 500 items, 10 min TTL
  
  // Order lookups (medium frequency)
  orders: new LRUCache(300, 5 * 60 * 1000), // 300 items, 5 min TTL
  
  // Stats and analytics (low frequency, expensive queries)
  stats: new LRUCache(50, 3 * 60 * 1000), // 50 items, 3 min TTL
  
  // Settings (very low frequency, should persist long)
  settings: new LRUCache(20, 30 * 60 * 1000), // 20 items, 30 min TTL
  
  // Query results (generic cache for arbitrary queries)
  queries: new LRUCache(200, 5 * 60 * 1000), // 200 items, 5 min TTL
  
  // Shopper data
  shoppers: new LRUCache(300, 2 * 60 * 1000), // 300 items, 2 min TTL
};

// Cache key generator for queries
function generateQueryKey(sql, params = []) {
  return `query:${sql}:${JSON.stringify(params)}`;
}

// Cache wrapper for database queries
async function cachedQuery(cacheName, key, queryFn, ttl = null) {
  const cache = caches[cacheName];
  if (!cache) {
    console.warn(`⚠️ Cache "${cacheName}" not found`);
    return await queryFn();
  }

  // Try to get from cache
  const cached = cache.get(key);
  if (cached !== null) {
    return cached;
  }

  // Execute query
  const result = await queryFn();
  
  // Store in cache
  if (ttl) {
    cache.set(key, result, ttl);
  } else {
    cache.set(key, result);
  }

  return result;
}

// Invalidate specific cache or all caches
function invalidateCache(cacheName = null, key = null) {
  if (cacheName && caches[cacheName]) {
    if (key) {
      caches[cacheName].delete(key);
    } else {
      caches[cacheName].clear();
    }
  } else if (!cacheName) {
    // Clear all caches
    Object.values(caches).forEach(cache => cache.clear());
  }
}

// Get cache statistics
function getCacheStats() {
  const stats = {};
  for (const [name, cache] of Object.entries(caches)) {
    stats[name] = cache.getStats();
  }
  return stats;
}

// Helper function to get cached value
function getCached(key) {
  // Try to find the key in all caches
  for (const [cacheName, cache] of Object.entries(caches)) {
    const value = cache.get(key);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

// Helper function to set cached value
function setCache(key, value, cacheName = 'stats', ttl = null) {
  const cache = caches[cacheName];
  if (!cache) {
    console.warn(`⚠️ Cache "${cacheName}" not found, using default cache`);
    cache = caches.stats;
  }
  
  if (ttl) {
    cache.set(key, value, ttl);
  } else {
    cache.set(key, value);
  }
}

// Log cache stats periodically
function startCacheStatsLogging(intervalMs = 5 * 60 * 1000) {
  setInterval(() => {
    const stats = getCacheStats();
    console.log('📊 Cache Statistics:', JSON.stringify(stats, null, 2));
  }, intervalMs);
}

module.exports = {
  caches,
  LRUCache,
  cachedQuery,
  generateQueryKey,
  invalidateCache,
  getCacheStats,
  getCached,
  setCache,
  startCacheStatsLogging
};
