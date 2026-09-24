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
    if (explicit) return String(explicit).trim().toUpperCase();

    const variant = String(item.variant_title || item.variant || '').trim();
    if (!variant || PLACEHOLDER_VARIANTS.includes(variant.toLowerCase())) return null;

    // "Size: M / Colour: Blue" → M
    const labelled = variant.match(/size\s*[:\-]\s*([^/|,]+)/i);
    if (labelled) return labelled[1].trim().toUpperCase();

    const token = variant.match(SIZE_TOKEN);
    if (token) return token[1].toUpperCase();

    // Numeric or unrecognised option sets ("32", "38 / Blue") — keep the first option
    return variant.split(/\s*[/|]\s*/)[0].trim().toUpperCase() || null;
}

function extractItemColour(item) {
    if (!item) return null;

    const explicit = item.colour || item.color || item.variant_colour || item.variant_color || item.product_colour || item.product_color;
    if (explicit) return String(explicit).trim();

    const variant = String(item.variant_title || item.variant || '').trim();
    if (!variant || PLACEHOLDER_VARIANTS.includes(variant.toLowerCase())) return null;

    // "Size: M / Colour: Blue" or "Colour: Blue / Size: M" → Blue
    const labelled = variant.match(/colou?r\s*[:\-]\s*([^/|,]+)/i);
    if (labelled) return labelled[1].trim();

    // "Black / M" or "Navy / XL" — the non-size token is the colour
    const parts = variant.split(/\s*[/|]\s*/).map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
        // Return the part that is NOT a size token
        for (const part of parts) {
            if (!SIZE_TOKEN.test(part) && !/^\d+$/.test(part)) {
                return part;
            }
        }
    }

    return null;
}

module.exports = { extractItemSize, extractItemColour };
