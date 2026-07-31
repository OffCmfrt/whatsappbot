/**
 * Helpers for reading line items stored in store_shoppers.items_json.
 *
 * The size lives in a different field depending on the order source:
 *   Shopify webhooks → variant_title ("M", "Size: M / Blue", "Black / XL")
 *   GoKwik / manual  → size / variant_size / product_size
 * so anything that prints a product (shipping labels, exports, follow-ups)
 * needs the same fallback chain.
 */

// Standalone apparel size inside a variant title ("Black / XL" → XL)
const SIZE_TOKEN = /\b(XXXS|XXS|XS|S|M|L|XL|2XL|XXL|3XL|XXXL|4XL|5XL|FREE SIZE|ONE SIZE)\b/i;

// Variant titles Shopify auto-assigns to products that have no real options
const PLACEHOLDER_VARIANTS = ['default title', 'default', 'title'];

function extractItemSize(item) {
    if (!item) return null;

    const explicit = item.size || item.variant_size || item.product_size;
    if (explicit) return String(explicit).trim();

    const variant = String(item.variant_title || item.variant || '').trim();
    if (!variant || PLACEHOLDER_VARIANTS.includes(variant.toLowerCase())) return null;

    // "Size: M / Colour: Blue" → M
    const labelled = variant.match(/size\s*[:\-]\s*([^/|,]+)/i);
    if (labelled) return labelled[1].trim();

    const token = variant.match(SIZE_TOKEN);
    if (token) return token[1].toUpperCase();

    // Numeric or unrecognised option sets ("32", "38 / Blue") — keep the first option
    return variant.split(/\s*[/|]\s*/)[0].trim() || null;
}

module.exports = { extractItemSize };
