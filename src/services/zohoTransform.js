const { dbAdapter } = require('../database/db');
const { normName } = require('./zohoItemResolver');

// ============================================================
// ZOHO TRANSFORMATION ENGINE
// Handles: bundle breaking, tax correction, invoice mapping
// ============================================================

// Indian states for CGST/SGST vs IGST determination
const INDIAN_STATES = new Set([
    'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
    'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
    'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
    'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
    'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
    'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Puducherry', 'Chandigarh',
    'Andaman and Nicobar Islands', 'Dadra and Nagar Haveli and Daman and Diu',
    'Lakshadweep'
]);

// State name normalization (common Shopify variations → canonical)
const STATE_ALIASES = {
    'delhi': 'Delhi',
    'new delhi': 'Delhi',
    'dilli': 'Delhi',
    'haryana': 'Haryana',
    'maharashtra': 'Maharashtra',
    'mumbai': 'Maharashtra',
    'karnataka': 'Karnataka',
    'bangalore': 'Karnataka',
    'bengaluru': 'Karnataka',
    'tamil nadu': 'Tamil Nadu',
    'chennai': 'Tamil Nadu',
    'telangana': 'Telangana',
    'hyderabad': 'Telangana',
    'gujarat': 'Gujarat',
    'rajasthan': 'Rajasthan',
    'uttar pradesh': 'Uttar Pradesh',
    'up': 'Uttar Pradesh',
    'west bengal': 'West Bengal',
    'kolkata': 'West Bengal',
    'punjab': 'Punjab',
    'kerala': 'Kerala',
    'madhya pradesh': 'Madhya Pradesh',
    'mp': 'Madhya Pradesh',
    'bihar': 'Bihar',
    'odisha': 'Odisha',
    'orissa': 'Odisha',
    'assam': 'Assam',
    'jharkhand': 'Jharkhand',
    'chhattisgarh': 'Chhattisgarh',
    'uttarakhand': 'Uttarakhand',
    'goa': 'Goa',
    'himachal pradesh': 'Himachal Pradesh',
    'jammu and kashmir': 'Jammu and Kashmir',
    'j&k': 'Jammu and Kashmir'
};

function normalizeState(stateStr) {
    if (!stateStr) return '';
    const lower = stateStr.trim().toLowerCase();
    if (STATE_ALIASES[lower]) return STATE_ALIASES[lower];
    // Title case match against known states
    for (const s of INDIAN_STATES) {
        if (s.toLowerCase() === lower) return s;
    }
    return stateStr.trim();
}

// GST state codes — Zoho Books needs the code (not just the name) on the
// contact's billing address to derive the invoice place of supply correctly
const STATE_CODES = {
    'andhra pradesh': 'AP', 'arunachal pradesh': 'AR', 'assam': 'AS', 'bihar': 'BR',
    'chhattisgarh': 'CG', 'goa': 'GA', 'gujarat': 'GJ', 'haryana': 'HR',
    'himachal pradesh': 'HP', 'jarkhand': 'JH', 'jharkhand': 'JH', 'karnataka': 'KA',
    'kerala': 'KL', 'madhya pradesh': 'MP', 'maharashtra': 'MH', 'manipur': 'MN',
    'meghalaya': 'ML', 'mizoram': 'MZ', 'nagaland': 'NL', 'odisha': 'OR',
    'punjab': 'PB', 'rajasthan': 'RJ', 'sikkim': 'SK', 'tamil nadu': 'TN',
    'telangana': 'TS', 'tripura': 'TR', 'uttar pradesh': 'UP', 'uttarakhand': 'UK',
    'west bengal': 'WB', 'delhi': 'DL', 'jammu and kashmir': 'JK', 'ladakh': 'LA',
    'puducherry': 'PY', 'chandigarh': 'CH', 'andaman and nicobar islands': 'AN',
    'dadra and nagar haveli and daman and diu': 'DH', 'lakshadweep': 'LD'
};

function stateCodeOf(stateStr) {
    if (!stateStr) return '';
    return STATE_CODES[stateStr.trim().toLowerCase()] || '';
}

// Zoho Books still uses the PRE-MERGER GST state codes for the merged UT
// "Dadra and Nagar Haveli and Daman and Diu": it accepts 'DN'/'DD' (and '26')
// but rejects 'DH' with "Please provide a valid state code" (verified live).
// Map both legacy Shopify codes to 'DN' so the merged UT always resolves.
const LEGACY_STATE_CODES = {
    'DN': 'DN', // Dadra and Nagar Haveli → keep as-is (valid in Zoho)
    'DD': 'DN', // Daman and Diu → same merged UT
    'DH': 'DN'  // merged-UT code not accepted by Zoho Books
};

function normalizeStateCode(code) {
    const c = String(code || '').trim().toUpperCase();
    return LEGACY_STATE_CODES[c] || c;
}

// ============================================================
// Bundle Breaking
// ============================================================

/**
 * Load bundle mappings from DB.
 * Returns { bundleSku: [{ component_sku, component_qty, gst_rate }] }
 */
async function loadBundleMap() {
    const rows = await dbAdapter.query('SELECT * FROM zoho_bundle_map ORDER BY id');
    const map = {};
    for (const row of rows) {
        if (!map[row.bundle_sku]) map[row.bundle_sku] = [];
        map[row.bundle_sku].push({
            component_sku: row.component_sku,
            component_qty: row.component_qty,
            gst_rate: parseFloat(row.gst_rate)
        });
    }
    return map;
}

/**
 * Break bundle line items into individual components.
 * Returns { lineItems: [...], transformations: [...] }
 */
function breakBundleLineItems(lineItems, bundleMap) {
    const result = [];
    const transformations = [];

    // Shopify bundle variants carry no SKU — the mapping key is usually the
    // product TITLE ("HENLEY - 001 ( TRIPLE )"). Try sku, exact title, then a
    // whitespace-normalised title.
    const normTitle = (s) => String(s || '').toUpperCase()
        .replace(/\s*([()])\s*/g, '$1')
        .replace(/\s*-\s*/g, '-')
        .replace(/\s+/g, ' ').trim();
    const byTitle = {};
    for (const [k, v] of Object.entries(bundleMap)) byTitle[normTitle(k)] = v;

    for (const item of lineItems) {
        const sku = item.sku || '';
        const components = bundleMap[sku] || bundleMap[item.title || ''] || byTitle[normTitle(item.title)];
        if (components) {
            // Zoho stock lives per size ("... ( ACID WASH ) - M") — append the
            // bundle's size variant unless the component already ends with it.
            const size = String(item.variant || '').trim();

            // This is a bundle — expand into components
            const bundlePrice = parseFloat(item.price || 0);
            const bundleQty = parseInt(item.quantity || 1);
            const bundleGross = bundlePrice * bundleQty;
            const bundleDiscount = parseFloat(item.discount || 0);
            const pricePerUnit = bundlePrice / components.reduce((sum, c) => sum + c.component_qty, 0);

            for (const comp of components) {
                const qty = comp.component_qty * bundleQty;
                const lineTotal = pricePerUnit * qty;
                let compName = comp.component_sku;
                if (size && !compName.endsWith(size)) compName += ' - ' + size;
                result.push({
                    name: compName,
                    sku: compName,
                    quantity: qty,
                    rate: pricePerUnit,
                    amount: lineTotal,
                    // Parent bundle discount prorated onto each component so
                    // invoices AND credit notes carry the same net amounts
                    discount: bundleGross > 0 ? round2(bundleDiscount * lineTotal / bundleGross) : 0,
                    gst_rate: comp.gst_rate,
                    is_bundle_component: true,
                    parent_bundle_sku: sku,
                    parent_bundle_name: item.title || sku
                });
            }

            transformations.push({
                type: 'bundle_break',
                original: { sku, title: item.title, quantity: bundleQty, price: bundlePrice },
                expanded: components.map(c => ({
                    sku: c.component_sku,
                    qty: c.component_qty * bundleQty,
                    gst_rate: c.gst_rate
                }))
            });
        } else {
            // Not a bundle — pass through
            result.push({
                name: item.title || item.sku || 'Item',
                sku: item.sku || '',
                quantity: parseInt(item.quantity || 1),
                rate: parseFloat(item.price || 0),
                amount: parseFloat(item.price || 0) * parseInt(item.quantity || 1),
                discount: round2(parseFloat(item.discount || 0)),
                gst_rate: parseFloat(item.tax_rate || 5),
                is_bundle_component: false
            });
        }
    }

    return { lineItems: result, transformations };
}

// ============================================================
// Discount Allocation
// ============================================================

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

/**
 * Allocate the Shopify order-level discount onto raw line items.
 * Prefers Shopify's per-line discount_allocations; falls back to
 * prorating total_discounts / discount_codes by gross line value.
 * Returns an array aligned with rawLineItems.
 */
function allocateOrderDiscounts(shopifyOrder, rawLineItems) {
    // 1) Per-line allocations delivered by Shopify itself
    const fromLines = rawLineItems.map(li =>
        round2((li.discount_allocations || []).reduce((s, a) => s + (parseFloat(a.amount) || 0), 0))
    );
    if (fromLines.reduce((a, b) => a + b, 0) > 0) return fromLines;

    // 2) Order-level discount prorated by gross line amount
    let total = round2(shopifyOrder.total_discounts);
    if (!total) {
        total = round2((shopifyOrder.discount_codes || [])
            .reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
    }
    if (!total) return rawLineItems.map(() => 0);

    const grossOf = (li) => (parseFloat(li.price) || 0) * (parseInt(li.quantity) || 1);
    const grossTotal = rawLineItems.reduce((s, li) => s + grossOf(li), 0);
    if (!grossTotal) return rawLineItems.map(() => 0);

    const allocated = rawLineItems.map(li => round2(total * grossOf(li) / grossTotal));
    // Absorb rounding drift on the largest line so the shares sum to `total`
    const drift = round2(total - allocated.reduce((a, b) => a + b, 0));
    if (drift !== 0 && allocated.length > 0) {
        let idx = 0;
        allocated.forEach((v, i) => { if (v > allocated[idx]) idx = i; });
        allocated[idx] = round2(allocated[idx] + drift);
    }
    return allocated;
}

// ============================================================
// Tax Correction
// ============================================================

/**
 * Determine correct tax type based on seller state vs customer state.
 * Returns { taxType: 'cgst_sgst' | 'igst', isInterState: bool }
 */
function determineTaxType(sellerState, customerState) {
    const seller = normalizeState(sellerState);
    const customer = normalizeState(customerState);

    if (!seller || !customer) {
        // Default to IGST if state info is missing (safe default for inter-state)
        return { taxType: 'igst', isInterState: true, reason: 'missing_state_info' };
    }

    const isSameState = seller.toLowerCase() === customer.toLowerCase();
    return {
        taxType: isSameState ? 'cgst_sgst' : 'igst',
        isInterState: !isSameState,
        sellerState: seller,
        customerState: customer,
        reason: isSameState ? 'intra_state' : 'inter_state'
    };
}

/**
 * Apply correct GST rate and tax split to line items.
 * Returns { lineItems: [...], corrections: [...] }
 */
function correctTax(lineItems, sellerState, customerState) {
    const taxDecision = determineTaxType(sellerState, customerState);
    const corrections = [];

    const correctedItems = lineItems.map(item => {
        const rate = item.gst_rate || 5;
        let taxBreakdown = {};

        if (taxDecision.taxType === 'cgst_sgst') {
            taxBreakdown = {
                cgst_rate: rate / 2,
                sgst_rate: rate / 2,
                igst_rate: 0,
                tax_type: 'CGST+SGST'
            };
        } else {
            taxBreakdown = {
                cgst_rate: 0,
                sgst_rate: 0,
                igst_rate: rate,
                tax_type: 'IGST'
            };
        }

        const taxAmount = round2((item.amount - (item.discount || 0)) * (rate / 100));

        corrections.push({
            sku: item.sku,
            original_rate: item.gst_rate,
            corrected_rate: rate,
            tax_type: taxDecision.taxType,
            tax_amount: taxAmount,
            ...taxBreakdown
        });

        return { ...item, ...taxBreakdown, tax_amount: taxAmount };
    });
    return { lineItems: correctedItems, corrections, taxDecision };
}

// ============================================================
// Build Zoho Invoice Payload
// ============================================================

/**
 * Transform a Shopify order into a Zoho Books invoice payload.
 * Applies bundle breaking and tax correction.
 */
async function buildZohoInvoicePayload(shopifyOrder, sellerState) {
    const customerState = normalizeState(
        shopifyOrder.shipping_address?.province ||
        shopifyOrder.billing_address?.province ||
        ''
    );

    // Extract line items from Shopify order
    const rawLineItems = (shopifyOrder.line_items || []).map(li => ({
        title: li.title,
        sku: li.sku || '',
        quantity: li.quantity,
        price: parseFloat(li.price || 0),
        variant: li.variant_title || '',
        discount_allocations: li.discount_allocations || [],
        tax_rate: li.tax_lines?.[0]?.rate ? li.tax_lines[0].rate * 100 : null,
        gst_rate: li.tax_lines?.[0]?.rate ? li.tax_lines[0].rate * 100 : 5
    }));

    // Order-level discounts prorated onto each line so Zoho invoices
    // (and later credit notes) reflect the real discounted amounts
    const discounts = allocateOrderDiscounts(shopifyOrder, rawLineItems);
    rawLineItems.forEach((li, i) => { li.discount = discounts[i] || 0; });

    // Step 1: Load bundle map and break bundles
    const bundleMap = await loadBundleMap();
    const { lineItems: brokenItems, transformations: bundleTransforms } = breakBundleLineItems(rawLineItems, bundleMap);

    // Step 2: Apply tax correction
    const { lineItems: correctedItems, corrections, taxDecision } = correctTax(brokenItems, sellerState, customerState);

    // Step 3: Build Zoho invoice line items
    const zohoLineItems = correctedItems.map(item => ({
        name: item.name,
        description: item.is_bundle_component ? `(from ${item.parent_bundle_name})` : (item.name || 'Item'),
        item_id: item.sku, // Will be resolved to Zoho item_id at sync time
        quantity: item.quantity,
        rate: item.rate,
        discount: item.discount || 0
    }));

    // Customer details
    const customer = {
        name: `${shopifyOrder.customer?.first_name || ''} ${shopifyOrder.customer?.last_name || ''}`.trim() || shopifyOrder.shipping_address?.name || 'Customer',
        email: shopifyOrder.email || shopifyOrder.customer?.email || '',
        phone: shopifyOrder.phone || shopifyOrder.customer?.phone || '',
        shipping_address: shopifyOrder.shipping_address ? (() => {
            // Zoho Books GST recipe (verified live, mirrors the native
            // integration): the customer contact must carry
            // gst_treatment='consumer' + billing address state, and the
            // invoice passes a shipping_address incl. state + country_code
            // 'IN'. Empty fields are dropped — Zoho rejects empty strings
            // with a misleading "address has less than 100 characters" error.
            const addr = {};
            const addr1 = String(shopifyOrder.shipping_address.address1 || '').trim();
            if (addr1) addr.address = addr1.slice(0, 100);
            if (shopifyOrder.shipping_address.address2) addr.street2 = String(shopifyOrder.shipping_address.address2).trim().slice(0, 100);
            if (shopifyOrder.shipping_address.city) addr.city = String(shopifyOrder.shipping_address.city).trim().slice(0, 100);
            if (customerState) addr.state = customerState;
            // Zoho needs the GST state CODE to pick the right place of
            // supply — prefer Shopify's province_code, fall back to the map
            const code = normalizeStateCode(shopifyOrder.shipping_address.province_code);
            addr.state_code = code || stateCodeOf(customerState);
            if (shopifyOrder.shipping_address.zip) addr.zip = String(shopifyOrder.shipping_address.zip).trim().slice(0, 20);
            addr.country = 'India';
            addr.country_code = 'IN';
            if (shopifyOrder.shipping_address.name) addr.attention = String(shopifyOrder.shipping_address.name).trim().slice(0, 100);
            return addr;
        })() : null
    };

    const invoice = {
        customer_id: null, // Will be resolved at sync time via getOrCreateCustomer
        customer_name: customer.name,
        customer_email: customer.email,
        customer_phone: customer.phone,
        contact_persons: [],
        date: shopifyOrder.created_at?.split('T')[0] || new Date().toISOString().split('T')[0],
        payment_terms: 0,
        payment_terms_label: 'Due on receipt',
        line_items: zohoLineItems,
        notes: `Shopify Order #${shopifyOrder.order_number || shopifyOrder.id}`,
        reference_number: shopifyOrder.order_number?.toString() || shopifyOrder.id?.toString() || '',
        terms: '',
        is_inclusive_tax: false,
        taxDecision,
        shipping_address: customer.shipping_address,
        // GST state code of the customer state — sent as place_of_supply on
        // the invoice. Books derives POS from the contact's billing address
        // ONLY if it was set at contact creation; backfilled addresses are
        // ignored, so we override explicitly (verified live, order #45923).
        // Legacy Shopify codes for the merged DN+DD UT are normalised to the
        // pre-merger code 'DN' — the only form Zoho Books accepts.
        // Intra-state guard: for same-state supplies (e.g. Haryana↔Haryana)
        // the POS is forced to the seller's state code so Books can only
        // apply CGST+SGST — an empty/foreign POS here is what produced the
        // erroneous CGST+IGST mix on Haryana orders.
        place_of_supply: taxDecision.taxType === 'cgst_sgst'
            ? (stateCodeOf(taxDecision.sellerState) || stateCodeOf(taxDecision.customerState))
            : (normalizeStateCode(shopifyOrder.shipping_address?.province_code) || stateCodeOf(customerState))
    };

    return {
        invoice,
        customer,
        transformations: {
            bundle_breaks: bundleTransforms,
            tax_corrections: corrections,
            tax_decision: taxDecision
        }
    };
}

// ============================================================
// Build Credit Note Payload (for returns/RTO)
// ============================================================

/**
 * Reference convention used for Zoho-side duplicate prevention:
 * one order → one credit note per type. Backfill and live flows
 * both check this before creating.
 */
function creditNoteReference(orderId, returnType, refundId = '') {
    const o = String(orderId || '').replace(/^#/, '');
    if (returnType === 'rto') return `RTO-${o}`;
    if (returnType === 'exchange') return `EXCH-${o}`;
    return refundId ? `RET-${o}-${refundId}` : `RET-${o}`;
}

function creditNoteDescription(returnType) {
    if (returnType === 'rto') return 'RTO Return';
    if (returnType === 'exchange') return 'Exchange Return';
    return 'Customer Return';
}

/**
 * Map the GST actually applied on an original invoice line to the credit
 * note line — same basis (CGST+SGST vs IGST), no hardcoded split.
 */
function taxFromInvoiceLine(line) {
    const out = {};
    for (const t of line.taxes || []) {
        const name = String(t.tax_name || '').toUpperCase();
        const rate = parseFloat(t.rate || t.tax_percentage || 0);
        if (!rate) continue;
        if (name.includes('IGST')) out.igst_rate = round2((out.igst_rate || 0) + rate);
        else if (name.includes('CGST')) out.cgst_rate = round2((out.cgst_rate || 0) + rate);
        else if (name.includes('SGST')) out.sgst_rate = round2((out.sgst_rate || 0) + rate);
    }
    if (!out.igst_rate && !out.cgst_rate && !out.sgst_rate) {
        // Flat percentage without named components — split intra-state style
        const flat = parseFloat(line.tax_percentage || 0);
        if (flat > 0) {
            out.cgst_rate = round2(flat / 2);
            out.sgst_rate = round2(flat / 2);
        }
    }
    out.tax_percentage = round2((out.cgst_rate || 0) + (out.sgst_rate || 0) + (out.igst_rate || 0));
    return out;
}

function creditLineFromInvoiceLine(line, qty, returnType) {
    const invoiceQty = parseFloat(line.quantity || 1) || 1;

    // Per-unit discount the original invoice gave on this line, so the
    // credit reverses the exact same proportion (req: original discount)
    const lineDiscountTotal = (line.discounts || [])
        .reduce((s, d) => s + (parseFloat(d.discount_amount ?? d.amount) || 0), 0)
        + (parseFloat(line.discount_amount || 0) || 0);

    let rate = parseFloat(line.rate || 0);
    let discount = round2((lineDiscountTotal / invoiceQty) * qty);

    // No explicit discount fields but item_total shows a lower net — fall
    // back to the net unit price so credited amount still matches invoice
    const itemTotal = parseFloat(line.item_total);
    if (!lineDiscountTotal && !isNaN(itemTotal) && itemTotal < rate * invoiceQty - 0.01 && invoiceQty > 0) {
        rate = round2(itemTotal / invoiceQty);
        discount = 0;
    }

    const creditLine = {
        name: line.name,
        description: creditNoteDescription(returnType),
        quantity: qty,
        rate,
        discount,
        ...taxFromInvoiceLine(line)
    };
    // item_id linkage is what makes Books put the stock back on hand
    if (line.item_id) creditLine.item_id = line.item_id;
    return creditLine;
}

/**
 * Build a credit note payload that MIRRORS the original Zoho invoice:
 * same rate, same discount proportion, same tax treatment (CGST+SGST vs
 * IGST, tax-inclusive/exclusive), and item-linked lines so stock returns.
 * Returned bundles are expanded into size-wise singles first.
 */
async function buildCreditNoteFromInvoice({
    shopifyOrder, returnItems, returnType, originalInvoice,
    extraNotes = '', referenceNumber = '', fallbackTaxDecision = null
}) {
    const orderId = String(shopifyOrder?.order_number || shopifyOrder?.id || '');

    // 1) Expand returned bundles into their individual components
    const bundleMap = await loadBundleMap();
    const rawReturned = (returnItems || []).map(it => ({
        title: it.title || '',
        sku: it.sku || '',
        quantity: parseInt(it.quantity || 1) || 1,
        price: parseFloat(it.price || 0),
        variant: it.variant || ''
    }));
    const { lineItems: expanded } = breakBundleLineItems(rawReturned, bundleMap);

    // 2) Match each returned piece to an original invoice line
    const invoiceLines = (originalInvoice?.line_items || []).map(l => ({ ...l, _credited: 0 }));
    const findLine = (ret) => {
        const keys = [normName(ret.sku), normName(ret.name)].filter(Boolean);
        const available = invoiceLines.filter(l => l._credited < (l.quantity || 0));
        for (const key of keys) {
            const hit = available.find(l => normName(l.sku || '') === key || normName(l.name || '') === key);
            if (hit) return hit;
        }
        // Loose containment fallback ("HENLEY 001 (G) - M" vs catalogue spacing)
        for (const key of keys) {
            const hit = available.find(l => key && (normName(l.name || '').includes(key) || key.includes(normName(l.name || ''))));
            if (hit) return hit;
        }
        return null;
    };

    const lineItems = [];
    for (const ret of expanded) {
        const line = findLine(ret);
        if (!line) {
            // No matching invoice line — credit at the returned price with a
            // tax split derived from the order's states (never hardcoded)
            const gst = parseFloat(ret.gst_rate || 5);
            const fallback = {
                name: ret.name || ret.sku || 'Returned Item',
                description: creditNoteDescription(returnType),
                quantity: parseInt(ret.quantity || 1) || 1,
                rate: round2(ret.rate ?? ret.price ?? 0),
                discount: round2(ret.discount || 0)
            };
            if (fallbackTaxDecision?.taxType === 'igst') {
                fallback.igst_rate = gst;
            } else {
                fallback.cgst_rate = round2(gst / 2);
                fallback.sgst_rate = round2(gst / 2);
            }
            fallback.tax_percentage = gst;
            lineItems.push(fallback);
            continue;
        }
        const qty = Math.min(parseInt(ret.quantity || 1) || 1, (line.quantity || 0) - line._credited);
        if (qty <= 0) continue;
        line._credited += qty;
        lineItems.push(creditLineFromInvoiceLine(line, qty, returnType));
    }

    return {
        customer_id: null, // Resolved at sync time
        customer_name: `${shopifyOrder?.customer?.first_name || ''} ${shopifyOrder?.customer?.last_name || ''}`.trim(),
        date: new Date().toISOString().split('T')[0],
        line_items: lineItems,
        notes: `${returnType.toUpperCase()} — Shopify Order #${orderId}${extraNotes ? ' | ' + extraNotes : ''}`,
        // Credit note must use the SAME tax basis as the invoice it reverses
        reference_number: referenceNumber || creditNoteReference(orderId, returnType),
        is_inclusive_tax: !!originalInvoice?.is_inclusive_tax,
        return_type: returnType
    };
}

/**
 * Legacy fallback payload (no original invoice available). Tax split is
 * derived from the caller's tax decision instead of hardcoded intra-state.
 */
function buildCreditNotePayload(shopifyOrder, returnItems, returnType = 'return', extraNotes = '', taxDecision = null) {
    const lineItems = returnItems.map(item => {
        const gst = parseFloat(item.tax_rate || item.gst_rate || 5);
        const line = {
            name: item.title || item.sku || 'Returned Item',
            description: creditNoteDescription(returnType),
            quantity: item.quantity || 1,
            rate: parseFloat(item.price || 0),
            discount: round2(parseFloat(item.discount || 0))
        };
        if (taxDecision?.taxType === 'igst') {
            line.igst_rate = gst;
        } else {
            line.cgst_rate = round2(gst / 2);
            line.sgst_rate = round2(gst / 2);
        }
        line.tax_percentage = gst;
        return line;
    });

    const orderId = String(shopifyOrder.order_number || shopifyOrder.id || '');
    return {
        customer_id: null, // Resolved at sync time
        customer_name: `${shopifyOrder.customer?.first_name || ''} ${shopifyOrder.customer?.last_name || ''}`.trim(),
        date: new Date().toISOString().split('T')[0],
        line_items: lineItems,
        notes: `${returnType.toUpperCase()} — Shopify Order #${orderId}${extraNotes ? ' | ' + extraNotes : ''}`,
        reference_number: creditNoteReference(orderId, returnType),
        is_inclusive_tax: false,
        return_type: returnType
    };
}

// ============================================================
// Build COD Payment Payload
// ============================================================

/**
 * Normalise any incoming date (full ISO timestamp, carrier string, Date)
 * to the yyyy-mm-dd format Zoho Books requires — a full ISO string makes
 * the API reject the request with "Invalid value passed for Invoice Date".
 */
function toZohoDate(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = value instanceof Date ? value : new Date(value || undefined);
    return isNaN(d.getTime())
        ? new Date().toISOString().split('T')[0]
        : d.toISOString().split('T')[0];
}

function buildCodPaymentPayload(zohoInvoiceId, amount, paymentDate, customerId) {
    const payload = {
        // Without the invoices array Zoho books the payment as an unused
        // advance and the invoice is never marked paid
        invoices: [{ invoice_id: zohoInvoiceId, amount_applied: amount }],
        amount: amount,
        date: toZohoDate(paymentDate),
        payment_mode: 'cash',
        description: 'COD Payment received via carrier'
    };
    // Zoho rejects payments without a customer ("Customer field can neither
    // be blank") — taken from the invoice being paid
    if (customerId) payload.customer_id = customerId;
    return payload;
}

module.exports = {
    // Bundle
    loadBundleMap,
    breakBundleLineItems,

    // Tax
    determineTaxType,
    correctTax,
    normalizeState,

    // Payloads
    buildZohoInvoicePayload,
    buildCreditNotePayload,
    buildCreditNoteFromInvoice,
    creditNoteReference,
    buildCodPaymentPayload,
    allocateOrderDiscounts,

    // Constants
    INDIAN_STATES,
    STATE_ALIASES,
    stateCodeOf
};
