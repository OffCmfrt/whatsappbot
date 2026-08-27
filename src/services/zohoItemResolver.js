const zohoService = require('./zohoService');

// ============================================================
// ZOHO ITEM RESOLVER
// Shared by invoice sync, credit notes and exchange replacements
// so every document links to real Zoho items — that linkage is
// what makes Books adjust stock (deduct on invoice sent, return
// on credit note / replacement flows).
// ============================================================

// Zoho catalog names are inconsistent ("( B ) - M" vs "(G)-M") —
// normalise whitespace so bundle components still link to stock.
const normName = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

/**
 * Create a resolver with a per-run cache.
 * resolve(key) → Zoho item object ({ item_id, name, ... }) or null.
 * Lookup order: SKU → exact name → fuzzy style-prefix + normalised match.
 */
function createItemResolver() {
    const itemCache = new Map();

    async function resolve(key) {
        if (!key) return null;
        if (itemCache.has(key)) return itemCache.get(key);
        let item = null;
        try {
            const bySku = await zohoService.searchItem({ sku: key });
            item = bySku[0] || null;
            if (!item) item = await zohoService.getItemByName(key);
            if (!item) {
                // Fuzzy fallback: style-prefix search + whitespace-insensitive
                // match (Zoho stores some variants without spaces, e.g.
                // "RAGLAN 001 (G)-M" vs "RAGLAN 001 ( G ) - M")
                const prefix = String(key)
                    .replace(/\s*[-]\s*\w+$/, '')  // drop trailing size
                    .replace(/\(.*$/, '')          // drop colourway paren
                    .trim();
                const cands = await zohoService.searchItem({ name_contains: prefix, per_page: 200 });
                item = cands.find(c => normName(c.name) === normName(key)) || null;
            }
        } catch (e) { /* leave unlinked */ }
        itemCache.set(key, item);
        return item;
    }

    return { resolve, normName };
}

module.exports = { createItemResolver, normName };
