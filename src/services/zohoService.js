const axios = require('axios');
const { dbAdapter } = require('../database/db');

// ============================================================
// ZOHO API CLIENT — OAuth2 + Books + Inventory
// Handles token refresh, rate limiting, and retry logic.
// ============================================================

// Books AND Inventory transactional APIs only accept the www.zohoapis.* domain
// (books.zoho.in / inventory.zoho.in return 400 "Use the zohoapis domain")
const tldOf = (d) => (d || '').split('.').slice(1).join('.') || 'in';
const BOOKS_BASE = () => `https://www.zohoapis.${tldOf(process.env.ZOHO_BOOKS_DOMAIN || 'zoho.in')}/books/v3`;
const INVENTORY_BASE = () => `https://www.zohoapis.${tldOf(process.env.ZOHO_INVENTORY_DOMAIN || 'zoho.in')}/inventory/v1`;
const ACCOUNTS_BASE = () => `https://accounts.${process.env.ZOHO_BOOKS_DOMAIN || 'zoho.in'}/oauth/v2/token`;

const ORG_ID = () => process.env.ZOHO_ORGANIZATION_ID || '';

// Token cache — refreshed automatically before expiry
let tokenCache = {
    access_token: null,
    expires_at: 0
};

// Rate limiter — Zoho allows ~100 req/min per API
const rateBucket = { tokens: 100, max: 100, refillRate: 2, lastRefill: Date.now() };

function refillTokens() {
    const now = Date.now();
    const elapsed = (now - rateBucket.lastRefill) / 1000;
    rateBucket.tokens = Math.min(rateBucket.max, rateBucket.tokens + elapsed * rateBucket.refillRate);
    rateBucket.lastRefill = now;
}

async function waitForSlot() {
    refillTokens();
    if (rateBucket.tokens >= 1) {
        rateBucket.tokens -= 1;
        return;
    }
    const waitMs = Math.ceil((1 - rateBucket.tokens) / rateBucket.refillRate * 1000);
    await new Promise(r => setTimeout(r, waitMs));
    refillTokens();
    rateBucket.tokens -= 1;
}

// ============================================================
// OAuth2 Token Management
// ============================================================

async function getAccessToken(force = false) {
    // Return cached token if still valid (with 60s buffer)
    if (!force && tokenCache.access_token && Date.now() < tokenCache.expires_at - 60000) {
        return tokenCache.access_token;
    }

    const clientId = process.env.ZOHO_CLIENT_ID;
    const clientSecret = process.env.ZOHO_CLIENT_SECRET;
    const refreshToken = process.env.ZOHO_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('Zoho OAuth credentials not configured (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN)');
    }

    const res = await axios.post(ACCOUNTS_BASE(), new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
    }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (!res.data.access_token) {
        throw new Error('Zoho token refresh failed: no access_token in response');
    }

    tokenCache.access_token = res.data.access_token;
    tokenCache.expires_at = Date.now() + (res.data.expires_in || 3600) * 1000;

    console.log('🔑 Zoho access token refreshed');
    return tokenCache.access_token;
}

// ============================================================
// Generic Request Helper
// ============================================================

async function zohoRequest(method, url, data = null, params = {}) {
    await waitForSlot();

    const maxRetries = 2;
    let forceRefresh = false;
    let authRetried = false;

    // Retry with exponential backoff
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Fetched each iteration so an auth retry picks up the fresh token
        const token = await getAccessToken(forceRefresh);
        forceRefresh = false;
        const config = {
            method,
            url,
            headers: {
                'Authorization': `Zoho-oauthtoken ${token}`,
                'X-composer-orgid': ORG_ID(),
                'Content-Type': 'application/json'
            },
            params,
            timeout: 30000
        };

        if (data && (method === 'post' || method === 'put' || method === 'patch')) {
            config.data = data;
        }

        try {
            const res = await axios(config);
            return res.data;
        } catch (err) {
            const status = err.response?.status;
            // Cached token was revoked server-side (Zoho caps active access
            // tokens per app — another process refreshing can invalidate
            // ours). Force a refresh and retry once.
            if (status === 401 && !authRetried) {
                authRetried = true;
                forceRefresh = true;
                console.warn('⚠️ Zoho API 401 — forcing token refresh and retrying');
                continue;
            }
            // Zoho signals rate limiting with a 400 "Access Denied / too many
            // requests" body (not 429) — treat it as retryable too
            const rateLimited = err.response?.data && /too many requests/i.test(
                `${err.response.data.error_description || ''} ${err.response.data.message || ''}`
            );
            if (status === 429 || rateLimited || (status >= 500 && attempt < maxRetries)) {
                const delay = Math.pow(2, attempt) * 2000;
                console.warn(`⚠️ Zoho API ${status}${rateLimited ? ' (rate limited)' : ''}, retrying in ${delay}ms (attempt ${attempt + 1})`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            const msg = err.response?.data?.message || err.message;
            throw new Error(`Zoho API error (${status || 'network'}): ${msg}`);
        }
    }
}

// ============================================================
// Zoho Books — Invoices
// ============================================================

async function createInvoice(invoicePayload) {
    const url = `${BOOKS_BASE()}/invoices`;
    const result = await zohoRequest('post', url, invoicePayload);
    return result.invoice;
}

async function getInvoice(invoiceId) {
    const url = `${BOOKS_BASE()}/invoices/${invoiceId}`;
    const result = await zohoRequest('get', url);
    return result.invoice;
}

async function searchInvoice(filters = {}) {
    const url = `${BOOKS_BASE()}/invoices`;
    const result = await zohoRequest('get', url, null, filters);
    return result.invoices || [];
}

async function voidInvoice(invoiceId) {
    const url = `${BOOKS_BASE()}/invoices/${invoiceId}/status/void`;
    const result = await zohoRequest('post', url);
    return result;
}

async function deleteInvoice(invoiceId) {
    const url = `${BOOKS_BASE()}/invoices/${invoiceId}`;
    return zohoRequest('delete', url);
}

async function markInvoiceSent(invoiceId) {
    const url = `${BOOKS_BASE()}/invoices/${invoiceId}/status/sent`;
    return zohoRequest('post', url);
}

async function deleteCreditNote(creditNoteId) {
    const url = `${BOOKS_BASE()}/creditnotes/${creditNoteId}`;
    return zohoRequest('delete', url);
}

async function deletePayment(paymentId) {
    const url = `${BOOKS_BASE()}/customerpayments/${paymentId}`;
    return zohoRequest('delete', url);
}

// ============================================================
// Zoho Books — Credit Notes (for returns/RTO)
// ============================================================

async function createCreditNote(creditNotePayload) {
    const url = `${BOOKS_BASE()}/creditnotes`;
    const result = await zohoRequest('post', url, creditNotePayload);
    return result.creditnote;
}

async function getCreditNote(creditNoteId) {
    const url = `${BOOKS_BASE()}/creditnotes/${creditNoteId}`;
    const result = await zohoRequest('get', url);
    return result.creditnote;
}

// ============================================================
// Zoho Books — Payments (COD reconciliation)
// ============================================================

async function recordPayment(paymentPayload) {
    const url = `${BOOKS_BASE()}/customerpayments`;
    const result = await zohoRequest('post', url, paymentPayload);
    return result.payment;
}

async function getPayments(invoiceId, invoiceNumber = null) {
    const url = `${BOOKS_BASE()}/customerpayments`;
    // NOTE: Books silently ignores the invoice_id filter here, so filter by
    // invoice_number and re-check client-side to be safe
    const params = invoiceNumber ? { invoice_number: invoiceNumber } : {};
    const result = await zohoRequest('get', url, null, params);
    let payments = result.customerpayments || result.payments || [];
    if (invoiceNumber) {
        payments = payments.filter(p => (p.invoice_numbers || '').includes(invoiceNumber));
    }
    return payments;
}

// ============================================================
// Zoho Books — Customers
// ============================================================

async function createCustomer(customerPayload) {
    const url = `${BOOKS_BASE()}/contacts`;
    const result = await zohoRequest('post', url, customerPayload);
    return result.contact;
}

async function searchCustomer(filters = {}) {
    const url = `${BOOKS_BASE()}/contacts`;
    const result = await zohoRequest('get', url, null, filters);
    return result.contacts || [];
}

async function getOrCreateCustomer(contactName, email = '', phone = '', address = null) {
    // Search by email or phone first
    const searchFilters = {};
    if (email) searchFilters.email = email;
    else if (phone) searchFilters.contact_person_email = phone;

    if (Object.keys(searchFilters).length > 0) {
        const existing = await searchCustomer(searchFilters);
        if (existing.length > 0) {
            const customer = existing[0];
            // GST correctness: Books derives the invoice place of supply from
            // the CONTACT's billing address. Customers created without one
            // (old middleware runs, or skipped by the native integration)
            // force every invoice to intra-state CGST+SGST. Backfill it once.
            try {
                const full = await zohoRequest('get', `${BOOKS_BASE()}/contacts/${customer.contact_id}`);
                const billing = full?.contact?.billing_address || {};
                // Missing state OR missing state_code breaks place of supply
                const needsState = address && address.state && !billing.state && !billing.state_code;
                const needsCode = address && address.state_code && !billing.state_code;
                const needsTreatment = address && full?.contact?.gst_treatment === 'business_none';
                if (needsState || needsCode || needsTreatment) {
                    await zohoRequest('put', `${BOOKS_BASE()}/contacts/${customer.contact_id}`, {
                        contact_name: full?.contact?.contact_name || customer.contact_name,
                        gst_treatment: 'consumer',
                        billing_address: address,
                        shipping_address: address
                    });
                    console.log(`✅ Zoho customer ${customer.contact_id}: backfilled address state ${address.state} + gst_treatment consumer`);
                }
            } catch (e) {
                console.warn(`⚠️ Zoho customer address backfill failed: ${e.message}`);
            }
            return customer;
        }
    }

    // Create new customer. gst_treatment 'consumer' + billing address state
    // are required for Books to pick the correct place of supply (IGST for
    // inter-state, CGST+SGST for intra-state).
    const payload = {
        contact_name: contactName,
        contact_type: 'customer',
        gst_treatment: 'consumer',
        payment_terms: 0,
        contact_persons: []
    };
    if (email) payload.contact_persons.push({ email });
    if (phone) {
        if (payload.contact_persons.length === 0) {
            payload.contact_persons.push({});
        }
        payload.contact_persons[0].mobile = phone;
    }
    if (address && address.state) {
        payload.billing_address = address;
        payload.shipping_address = address;
    }

    return await createCustomer(payload);
}

// ============================================================
// Zoho Books — Items
// ============================================================

async function searchItem(filters = {}) {
    const url = `${BOOKS_BASE()}/items`;
    const result = await zohoRequest('get', url, null, filters);
    return result.items || [];
}

async function getItemByName(name) {
    const items = await searchItem({ name });
    return items.find(i => i.name === name) || null;
}

// ============================================================
// Zoho Inventory — Stock Adjustment
// ============================================================

async function adjustInventory(adjustmentPayload) {
    const url = `${INVENTORY_BASE()}/inventoryadjustments`;
    const result = await zohoRequest('post', url, adjustmentPayload);
    return result.inventory_adjustment;
}

async function getStockOnHand(itemId) {
    const url = `${INVENTORY_BASE()}/items/${itemId}`;
    const result = await zohoRequest('get', url);
    return result.item;
}

// ============================================================
// Zoho Inventory — Composite Items (Bundle management)
// ============================================================

async function getCompositeItems() {
    const url = `${INVENTORY_BASE()}/compositeitems`;
    const result = await zohoRequest('get', url);
    return result.composite_items || [];
}

// ============================================================
// Connection Test
// ============================================================

async function testConnection() {
    try {
        const token = await getAccessToken();
        if (!token) return { success: false, error: 'No access token received' };

        // Try a lightweight API call
        const url = `${BOOKS_BASE()}/organizations`;
        const result = await zohoRequest('get', url);
        const org = (result.organizations || [])[0] || {};
        return {
            success: true,
            organization: org.name || 'Connected',
            orgId: org.organization_id || ORG_ID()
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ============================================================
// Initialize Zoho Tables (called from db.js)
// ============================================================

async function initializeZohoTables() {
    try {
        const { pool } = require('../database/db');

        // Create tables if they don't exist (run the SQL migration inline)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS zoho_sync_log (
                id SERIAL PRIMARY KEY,
                shopify_order_id TEXT NOT NULL,
                zoho_invoice_id TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                transformation JSONB NOT NULL DEFAULT '{}',
                original_payload JSONB,
                error_message TEXT,
                retry_count INT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS zoho_tax_corrections (
                id SERIAL PRIMARY KEY,
                shopify_order_id TEXT NOT NULL,
                original_tax JSONB,
                corrected_tax JSONB,
                correction_type TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS zoho_returns (
                id SERIAL PRIMARY KEY,
                shopify_order_id TEXT NOT NULL,
                shopify_return_id TEXT,
                zoho_credit_note_id TEXT,
                return_type TEXT,
                original_items JSONB,
                corrected_items JSONB,
                status TEXT DEFAULT 'pending',
                error_message TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS zoho_cod_payments (
                id SERIAL PRIMARY KEY,
                shopify_order_id TEXT NOT NULL,
                zoho_invoice_id TEXT,
                zoho_payment_id TEXT,
                amount DECIMAL(12,2),
                payment_status TEXT DEFAULT 'pending',
                carrier TEXT,
                awb TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                reconciled_at TIMESTAMPTZ
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS zoho_bundle_map (
                id SERIAL PRIMARY KEY,
                bundle_sku TEXT NOT NULL UNIQUE,
                component_sku TEXT NOT NULL,
                component_qty INT NOT NULL DEFAULT 1,
                gst_rate DECIMAL(5,2) NOT NULL DEFAULT 5.0,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // Indexes
        await pool.query('CREATE INDEX IF NOT EXISTS idx_zoho_sync_order ON zoho_sync_log(shopify_order_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_zoho_sync_status ON zoho_sync_log(status)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_zoho_sync_created ON zoho_sync_log(created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_zoho_returns_order ON zoho_returns(shopify_order_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_zoho_returns_status ON zoho_returns(status)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_zoho_cod_order ON zoho_cod_payments(shopify_order_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_zoho_cod_status ON zoho_cod_payments(payment_status)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_zoho_bundle_sku ON zoho_bundle_map(bundle_sku)');

        console.log('✅ Zoho sync tables initialized');
    } catch (err) {
        console.error('❌ Failed to initialize Zoho tables:', err.message);
    }
}

module.exports = {
    // Auth
    getAccessToken,
    testConnection,

    // Invoices
    createInvoice,
    getInvoice,
    searchInvoice,
    voidInvoice,
    deleteInvoice,
    markInvoiceSent,
    deleteCreditNote,
    deletePayment,

    // Credit Notes
    createCreditNote,
    getCreditNote,

    // Payments
    recordPayment,
    getPayments,

    // Customers
    createCustomer,
    searchCustomer,
    getOrCreateCustomer,

    // Items
    searchItem,
    getItemByName,

    // Inventory
    adjustInventory,
    getStockOnHand,
    getCompositeItems,

    // Init
    initializeZohoTables,

    // Helpers
    zohoRequest,
    BOOKS_BASE,
    INVENTORY_BASE
};
