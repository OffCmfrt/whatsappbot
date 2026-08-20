const { dbAdapter } = require('../database/db');

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

    for (const item of lineItems) {
        const sku = item.sku || '';
        if (bundleMap[sku]) {
            // This is a bundle — expand into components
            const components = bundleMap[sku];
            const bundlePrice = parseFloat(item.price || 0);
            const bundleQty = parseInt(item.quantity || 1);
            const pricePerUnit = bundlePrice / components.reduce((sum, c) => sum + c.component_qty, 0);

            for (const comp of components) {
                const qty = comp.component_qty * bundleQty;
                const lineTotal = pricePerUnit * qty;
                result.push({
                    name: comp.component_sku,
                    sku: comp.component_sku,
                    quantity: qty,
                    rate: pricePerUnit,
                    amount: lineTotal,
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
                gst_rate: parseFloat(item.tax_rate || 5),
                is_bundle_component: false
            });
        }
    }

    return { lineItems: result, transformations };
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

        const taxAmount = item.amount * (rate / 100);

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
        tax_rate: li.tax_lines?.[0]?.rate ? li.tax_lines[0].rate * 100 : null,
        gst_rate: li.tax_lines?.[0]?.rate ? li.tax_lines[0].rate * 100 : 5
    }));

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
        discount: 0
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
        place_of_supply: normalizeStateCode(shopifyOrder.shipping_address?.province_code) || stateCodeOf(customerState)
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

function buildCreditNotePayload(shopifyOrder, returnItems, returnType = 'return') {
    const lineItems = returnItems.map(item => ({
        name: item.title || item.sku || 'Returned Item',
        description: returnType === 'rto' ? 'RTO Return' : 'Customer Return',
        quantity: item.quantity || 1,
        rate: parseFloat(item.price || 0),
        // GST 5% split on the credited amount (intra-state default)
        cgst_rate: 2.5,
        sgst_rate: 2.5,
        tax_percentage: 5
    }));

    return {
        customer_id: null, // Resolved at sync time
        customer_name: `${shopifyOrder.customer?.first_name || ''} ${shopifyOrder.customer?.last_name || ''}`.trim(),
        date: new Date().toISOString().split('T')[0],
        line_items: lineItems,
        notes: `${returnType.toUpperCase()} — Shopify Order #${shopifyOrder.order_number || shopifyOrder.id}`,
        reference_number: shopifyOrder.order_number?.toString() || '',
        is_inclusive_tax: false,
        return_type: returnType
    };
}

// ============================================================
// Build COD Payment Payload
// ============================================================

function buildCodPaymentPayload(zohoInvoiceId, amount, paymentDate, customerId) {
    const payload = {
        // Without the invoices array Zoho books the payment as an unused
        // advance and the invoice is never marked paid
        invoices: [{ invoice_id: zohoInvoiceId, amount_applied: amount }],
        amount: amount,
        date: paymentDate || new Date().toISOString().split('T')[0],
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
    buildCodPaymentPayload,

    // Constants
    INDIAN_STATES,
    STATE_ALIASES
};
