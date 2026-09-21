/**
 * Restore missing store_shoppers records from Shopify orders.
 *
 * This script only inserts shoppers that are absent from Supabase. It does not
 * replay the order webhook, so it never sends WhatsApp confirmation messages
 * or changes existing shopper status/conversation data.
 *
 * Usage:
 *   node scripts/backfill_shopify_shoppers.js --hours=3
 *   node scripts/backfill_shopify_shoppers.js --since=2026-09-18T06:00:00Z --until=2026-09-18T09:00:00Z
 *   node scripts/backfill_shopify_shoppers.js --hours=3 --apply
 *   node scripts/backfill_shopify_shoppers.js --hours=3 --refresh --apply
 */

require('dotenv').config();
const axios = require('axios');
const { dbAdapter, initializeDatabase } = require('../src/database/db');

const APPLY = process.argv.includes('--apply');
const REFRESH = process.argv.includes('--refresh');
const SHOPIFY_API_VERSION = '2025-01';
const MAX_PAGES = 20;

function argumentValue(name) {
    const prefix = `--${name}=`;
    return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseDate(value, label) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`${label} must be a valid ISO timestamp`);
    }
    return date;
}

function parseWindow() {
    const sinceValue = argumentValue('since');
    const untilValue = argumentValue('until');
    const hoursValue = argumentValue('hours');

    if (sinceValue && hoursValue) {
        throw new Error('Use either --since or --hours, not both');
    }

    const until = untilValue ? parseDate(untilValue, '--until') : new Date();
    let since;
    if (sinceValue) {
        since = parseDate(sinceValue, '--since');
    } else {
        const hours = hoursValue === undefined ? 3 : Number(hoursValue);
        if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
            throw new Error('--hours must be greater than 0 and no more than 168');
        }
        since = new Date(until.getTime() - hours * 60 * 60 * 1000);
    }

    if (since >= until) throw new Error('--since must be earlier than --until');
    return { since, until };
}

function shopifyConfig() {
    const store = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP_URL;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!store || !token) {
        throw new Error('SHOPIFY_STORE (or SHOPIFY_SHOP_URL) and SHOPIFY_ACCESS_TOKEN are required');
    }

    const hostname = String(store)
        .replace(/^https?:\/\//, '')
        .replace(/\.myshopify\.com.*$/, '');
    return {
        baseUrl: `https://${hostname}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}`,
        headers: { 'X-Shopify-Access-Token': token }
    };
}

function nextPageUrl(linkHeader) {
    if (!linkHeader) return null;
    const nextLink = linkHeader.split(',').find(link => /rel="next"/.test(link));
    return nextLink?.match(/<([^>]+)>/)?.[1] || null;
}

async function fetchOrders(config, since, until) {
    const params = new URLSearchParams({
        status: 'any',
        limit: '250',
        created_at_min: since.toISOString(),
        created_at_max: until.toISOString(),
        order: 'created_at asc'
    });
    let url = `${config.baseUrl}/orders.json?${params.toString()}`;
    const orders = [];

    for (let page = 1; url && page <= MAX_PAGES; page++) {
        const response = await axios.get(url, {
            headers: config.headers,
            timeout: 30000
        });
        orders.push(...(response.data?.orders || []));
        url = nextPageUrl(response.headers.link);
    }

    if (url) {
        throw new Error(`Shopify returned more than ${MAX_PAGES * 250} orders; use a smaller time window`);
    }
    return orders;
}

function normalizePhone(order) {
    const phone = order.phone || order.customer?.phone || order.customer?.default_address?.phone ||
        order.billing_address?.phone || order.shipping_address?.phone;
    if (!phone) return null;

    const digits = String(phone).replace(/\D/g, '');
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    return digits || null;
}

function refundedAmount(order) {
    const amounts = (order.refunds || []).flatMap(refund => refund.transactions || [])
        .filter(transaction => transaction.kind === 'refund' && transaction.status === 'success')
        .map(transaction => Number(transaction.amount))
        .filter(Number.isFinite);
    return amounts.length ? amounts.reduce((total, amount) => total + amount, 0) : null;
}

function toShopper(order) {
    const phone = normalizePhone(order);
    if (!phone) return null;

    const shipping = order.shipping_address || order.billing_address || {};
    const customerName = order.customer?.first_name
        ? `${order.customer.first_name} ${order.customer.last_name || ''}`.trim()
        : (shipping.name || `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim() || 'Customer');
    const gateway = order.gateway || order.payment_gateway_names?.[0] || 'Unknown';
    const gatewayLower = String(gateway).toLowerCase();
    const paymentMethod = gatewayLower.includes('cod') || gatewayLower.includes('cash on delivery') ||
        gatewayLower.includes('cash_on_delivery') || gatewayLower === 'manual' ? 'COD' : 'Prepaid';
    const shippingTitle = String(order.shipping_lines?.[0]?.title || order.shipping_lines?.[0]?.code || '').toLowerCase();
    const deliveryType = /express|priority|fast|overnight/.test(shippingTitle) ? 'Express' : 'Standard';
    const items = (order.line_items || []).map(item => {
        const sizeMatch = String(item.variant_title || '').match(/Size:\s*(\w+)/i) ||
            String(item.variant_title || '').match(/\b(S|M|L|XL|XXS|XS|XXL|XXXL|Free Size|One Size)\b/i);
        return { ...item, size: sizeMatch?.[1]?.toUpperCase() || item.size || undefined };
    });
    const orderId = String(order.name || order.order_number || order.id);
    const createdAt = order.created_at ? new Date(order.created_at).toISOString() : new Date().toISOString();
    const updatedAt = order.updated_at ? new Date(order.updated_at).toISOString() : createdAt;
    const cancelledAt = order.cancelled_at ? new Date(order.cancelled_at).toISOString() : null;

    return {
        id: `shop_backfill_${order.id}`,
        phone,
        name: customerName,
        email: order.email || order.customer?.email || '',
        order_id: orderId,
        address: `${shipping.address1 || ''} ${shipping.address2 || ''}`.trim(),
        city: shipping.city || '',
        province: shipping.province || '',
        zip: shipping.zip || '',
        country: shipping.country || '',
        payment_method: paymentMethod,
        items_json: JSON.stringify(items),
        order_total: order.total_price || order.total_amount || order.grand_total || null,
        delivery_type: deliveryType,
        source: 'shopify',
        status: cancelledAt ? 'cancelled' : 'pending',
        cancel_reason: cancelledAt ? (order.cancel_reason || 'Cancelled in Shopify') : null,
        shopify_cancelled_at: cancelledAt,
        shopify_refund_amount: refundedAmount(order),
        created_at: createdAt,
        updated_at: updatedAt
    };
}

async function existingShoppers(orderIds) {
    if (orderIds.length === 0) return new Map();
    const placeholders = orderIds.map(() => '?').join(',');
    const rows = await dbAdapter.query(
        `SELECT id, order_id FROM store_shoppers WHERE order_id IN (${placeholders})`,
        orderIds
    );
    return new Map(rows.map(row => [String(row.order_id), row]));
}

async function insertShopper(shopper) {
    const columns = Object.keys(shopper);
    const placeholders = columns.map(() => '?').join(', ');
    await dbAdapter.query(
        `INSERT INTO store_shoppers (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (phone, order_id) DO NOTHING`,
        columns.map(column => shopper[column])
    );
}

async function refreshShopper(shopper) {
    const { id, ...data } = shopper;
    await dbAdapter.update('store_shoppers', data, { id });
}

async function main() {
    const { since, until } = parseWindow();
    const config = shopifyConfig();
    await initializeDatabase();

    console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — Shopify shopper recovery`);
    console.log(`Window: ${since.toISOString()} to ${until.toISOString()}`);
    const orders = await fetchOrders(config, since, until);
    const shoppers = orders.map(toShopper);
    const skippedNoPhone = shoppers.filter(shopper => !shopper).length;
    const validShoppers = shoppers.filter(Boolean);
    const existingShoppersByOrder = await existingShoppers(validShoppers.map(shopper => shopper.order_id));
    const missingShoppers = validShoppers.filter(shopper => !existingShoppersByOrder.has(shopper.order_id));
    const refreshableShoppers = REFRESH ? validShoppers.filter(shopper =>
        existingShoppersByOrder.get(shopper.order_id)?.id === shopper.id
    ) : [];

    console.log(`Shopify orders found: ${orders.length}`);
    console.log(`Skipped without phone: ${skippedNoPhone}`);
    console.log(`Already present: ${validShoppers.length - missingShoppers.length}`);
    console.log(`Missing shoppers: ${missingShoppers.length}`);
    console.log(`Backfilled rows to refresh: ${refreshableShoppers.length}`);
    for (const shopper of missingShoppers) {
        console.log(`  ${shopper.order_id} | ${shopper.phone} | ${shopper.name}`);
    }

    if (!APPLY) {
        console.log('Dry run complete — add --apply to insert missing shoppers; add --refresh to enrich prior backfilled rows. No WhatsApp messages will be sent.');
        return;
    }

    for (const shopper of missingShoppers) {
        await insertShopper(shopper);
    }
    for (const shopper of refreshableShoppers) {
        await refreshShopper(shopper);
    }
    console.log(`Inserted ${missingShoppers.length} missing shopper record(s).`);
    if (REFRESH) console.log(`Refreshed ${refreshableShoppers.length} backfilled shopper record(s) with current Shopify details.`);
}

main()
    .catch(error => {
        console.error(`Backfill failed: ${error.message}`);
        process.exitCode = 1;
    });
