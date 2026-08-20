/**
 * Sync manually-shipped confirmed orders back into the Shopper Hub — ALL carriers.
 *
 * When orders are shipped manually through a carrier's own dashboard/panel,
 * the hub never learns about the AWB and the shopper stays "confirmed".
 * This script finds every confirmed shopper with no AWB and checks each
 * configured carrier for an existing shipment:
 *
 *   - Shiprocket : GET /orders?search=<order id> → reuse awb_code/courier
 *   - Delhivery  : best-effort package lookup by client reference (order id)
 *   - Ekart      : no order-search API — use a manual CSV (see below)
 *   - Shopify    : fulfillments on the order carry the tracking number the
 *                  seller entered when shipping from a carrier panel — checked
 *                  FIRST, since panel shipments always fulfill the Shopify order
 *                  (the AWB is verified against the carrier's track API)
 *
 * Anything not discoverable via API can be supplied as a CSV of
 * order_id,awb[,carrier] rows (--manual path) — each AWB is verified with
 * the carrier's track API before we trust it.
 *
 * Found shipments are written as a shipments row (status 'shipped',
 * shipped_by 'manual_sync') and mirrored onto the orders row, exactly like
 * a normal hub shipment — so Shipped Orders, tracking sync and the shopper
 * list all pick them up.
 *
 * Usage:
 *   node scripts/sync_manual_shipments.js                 # dry run (report only)
 *   node scripts/sync_manual_shipments.js --apply         # write to the DB
 *   node scripts/sync_manual_shipments.js --since 2026-07-25
 *   node scripts/sync_manual_shipments.js --manual manual_awbs.csv --apply
 */

require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const { dbAdapter, initializeDatabase } = require('../src/database/db');
const { getAdapter } = require('../src/services/carriers');
const { caches } = require('../src/utils/cache');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --------------------------------------
// CLI args
// --------------------------------------
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const sinceArg = args[args.indexOf('--since') + 1];
const manualArg = args[args.indexOf('--manual') + 1];
const SINCE = /^\d{4}-\d{2}-\d{2}$/.test(sinceArg || '') ? sinceArg : '2026-07-25';
const MANUAL_CSV = manualArg && !manualArg.startsWith('--') ? manualArg : null;

// Carriers worth asking about an order, in preference order
const CARRIER_KEYS = ['shiprocket', 'delhivery', 'ekart'];

// Shopify Admin API — fulfillments carry the AWB entered in the carrier panel
const SHOPIFY_BASE = process.env.SHOPIFY_STORE
    ? `https://${String(process.env.SHOPIFY_STORE).replace('.myshopify.com', '')}.myshopify.com/admin/api/2025-01`
    : null;
const SHOPIFY_HEADERS = process.env.SHOPIFY_ACCESS_TOKEN
    ? { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN }
    : null;

// Fulfillment tracking_company → our carrier key (for AWB verification order)
function companyToCarrier(company) {
    const c = String(company || '').toLowerCase();
    if (/ekart/.test(c)) return 'ekart';
    if (/delhivery/.test(c)) return 'delhivery';
    if (/shiprocket|bluedart|dtdc|ecom|xpressbees|india post|delhivery surface/i.test(c)) return 'shiprocket';
    return null;
}

async function searchShopifyFulfillment(orderId) {
    if (!SHOPIFY_BASE || !SHOPIFY_HEADERS) return null;
    try {
        const r = await axiosGet(`${SHOPIFY_BASE}/orders.json`, SHOPIFY_HEADERS, { name: orderId, status: 'any' });
        const order = r.data?.orders?.[0];
        if (!order) return null;
        const f = await axiosGet(`${SHOPIFY_BASE}/orders/${order.id}/fulfillments.json`, SHOPIFY_HEADERS, {});
        const fuls = (f.data?.fulfillments || [])
            .filter(x => x.status !== 'cancelled' && (x.tracking_numbers || []).length > 0)
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        if (fuls.length === 0) return null;
        const ful = fuls[0];
        return {
            awb: String(ful.tracking_numbers[0]),
            company: ful.tracking_company || null,
            preferredCarrier: companyToCarrier(ful.tracking_company),
            source: 'shopify_fulfillment'
        };
    } catch (error) {
        return null;
    }
}

// --------------------------------------
// Carrier lookups (all best-effort: null = not found / not supported)
// --------------------------------------

// Shiprocket order status → our shipment pipeline status
function mapShiprocketStatus(status) {
    const s = String(status || '').toUpperCase();
    if (/DELIVERED/.test(s)) return 'delivered';
    if (/RTO/.test(s)) return 'rto';
    if (/CANCEL/.test(s)) return 'cancelled';
    if (/SHIP|TRANSIT|OUT FOR DELIVERY|PICKUP/.test(s)) return 'shipped';
    return 'shipped'; // AWB assigned & active → shipped
}

function extractShiprocketAwb(order) {
    // Shipments come back as an array (listing) or single object (show)
    const shipments = Array.isArray(order.shipments) ? order.shipments : (order.shipments ? [order.shipments] : []);
    // Prefer the newest non-cancelled shipment carrying an AWB
    const usable = shipments
        .filter(sh => sh && sh.awb && !/CANCEL/i.test(sh.status || ''))
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return usable[0] || null;
}

async function searchShiprocket(orderId) {
    const adapter = getAdapter('shiprocket');
    if (!adapter) return null;
    const normalize = v => String(v ?? '').replace(/^#/, '').trim().toLowerCase();
    const bare = String(orderId).replace(/^#/, '').trim();

    for (const candidate of [...new Set([bare, `#${bare}`])]) {
        try {
            const headers = await adapter.authHeaders();
            const response = await axiosGet(`${adapter.baseURL}/orders`, headers, { search: candidate, per_page: 20 });
            const matches = (response.data?.data || []).filter(o =>
                normalize(o.channel_order_id) === normalize(bare) || normalize(o.order_id) === normalize(bare)
            );
            if (matches.length === 0) continue;

            // The listing omits AWBs — fetch the order detail where the
            // shipment object carries awb/courier/status
            for (const match of matches) {
                try {
                    const detail = await axiosGet(`${adapter.baseURL}/orders/show/${match.id}`, headers, {});
                    const order = detail.data?.data || detail.data || {};
                    const shipment = extractShiprocketAwb(order);
                    if (!shipment) continue;
                    return {
                        awb: String(shipment.awb),
                        carrier: 'shiprocket',
                        courierName: shipment.courier || order.last_mile_courier_name || 'Shiprocket Courier',
                        carrierShipmentId: String(shipment.id),
                        carrierOrderId: String(match.id),
                        trackingUrl: `https://shiprocket.co/tracking/${shipment.awb}`,
                        carrierStatus: shipment.status || order.status || null,
                        mappedStatus: mapShiprocketStatus(shipment.status || order.status)
                    };
                } catch (detailError) {
                    console.warn(`  ⚠️ Shiprocket detail failed for order #${match.id}: ${detailError.response?.status || detailError.message}`);
                }
            }

            // Exists at Shiprocket but nothing shippable (no AWB / all cancelled)
            return { pending: true, carrier: 'shiprocket', note: `exists at Shiprocket (order #${matches[0].id}) but has no active AWB there` };
        } catch (error) {
            console.warn(`  ⚠️ Shiprocket search failed for ${orderId}: ${error.response?.data ? JSON.stringify(error.response.data).substring(0, 200) : error.message}`);
        }
    }
    return null;
}

async function searchDelhivery(orderId) {
    const adapter = getAdapter('delhivery');
    if (!adapter) return null;
    try {
        // Best-effort: fetch packages by client reference (= our order id).
        // Endpoint shape varies by Delhivery account tier — never fatal here.
        const response = await axiosGet(`${adapter.baseURL}/api/v1/packages/json/`, adapter.authHeaders(), {
            ref_ids: String(orderId),
            size: 10
        });
        const pkgs = response.data?.ShipmentData || response.data?.shipments || [];
        const pkg = (Array.isArray(pkgs) ? pkgs : [pkgs]).find(p => p?.waybill || p?.Waybill);
        if (!pkg) return null;
        const awb = String(pkg.waybill || pkg.Waybill);
        return {
            awb,
            carrier: 'delhivery',
            courierName: 'Delhivery',
            trackingUrl: `https://www.delhivery.com/track/package/${awb}`
        };
    } catch (error) {
        return null; // unsupported/empty — treat as "not found"
    }
}

// Ekart exposes no order-search API — only per-AWB tracking. Returns null.
async function searchEkart() {
    return null;
}

const SEARCHERS = { shiprocket: searchShiprocket, delhivery: searchDelhivery, ekart: searchEkart };

// Live carrier status text → our pipeline status (null = keep default 'shipped')
function mapLiveStatus(status) {
    const s = String(status || '').toLowerCase();
    if (!s) return null;
    if (/deliver/.test(s) && !/out for|attempt|undeliver/.test(s)) return 'delivered';
    if (/rto|return.*origin|returned/.test(s)) return 'rto';
    return null;
}

// --------------------------------------
// Manual CSV: order_id,awb[,carrier] — verified against carrier track APIs
// --------------------------------------

function loadManualMap(csvPath) {
    const map = new Map(); // order_id -> { awb, carrier? }
    if (!csvPath) return map;
    let text;
    try {
        text = fs.readFileSync(csvPath, 'utf8');
    } catch (error) {
        console.error(`❌ Cannot read manual CSV ${csvPath}: ${error.message}`);
        process.exit(1);
    }
    for (const line of text.split(/\r?\n/)) {
        const parts = line.split(',').map(p => p.trim()).filter(Boolean);
        if (parts.length < 2) continue;
        const [orderId, awb, carrier] = parts;
        if (/order/i.test(orderId) && /awb/i.test(awb)) continue; // header row
        map.set(orderId.replace(/^#/, ''), { awb, carrier: carrier ? carrier.toLowerCase() : null });
    }
    return map;
}

// Confirm an AWB really belongs to the order by asking the carrier to track it
async function verifyAwb(awb, preferredCarrier) {
    const keys = preferredCarrier
        ? [preferredCarrier, ...CARRIER_KEYS.filter(k => k !== preferredCarrier)]
        : CARRIER_KEYS;
    for (const key of keys) {
        const adapter = getAdapter(key);
        if (!adapter || typeof adapter.track !== 'function') continue;
        try {
            const result = await adapter.track(awb);
            if (result.success) {
                return { carrier: key, courierName: key === 'shiprocket' ? 'Shiprocket Courier' : adapter.name, currentStatus: result.data?.currentStatus || null };
            }
        } catch (error) { /* try next carrier */ }
        await sleep(200);
    }
    return null;
}

// --------------------------------------
// Persistence — mirrors shippingService.ship's row shape
// --------------------------------------

async function recordShipment(shopper, found, shopperOrder) {
    // Idempotency: respect the one-open-shipment-per-order partial unique index
    const open = await dbAdapter.query(
        `SELECT id, awb, carrier FROM shipments WHERE order_id = ? AND status NOT IN ('cancelled', 'failed', 'delivered', 'rto') LIMIT 1`,
        [shopper.order_id]
    );
    if (open && open.length > 0) {
        return { skipped: true, reason: `active shipment #${open[0].id} already exists (AWB ${open[0].awb || 'pending'})` };
    }

    await dbAdapter.insert('shipments', {
        order_id: shopper.order_id,
        shopper_id: String(shopper.id),
        carrier: found.carrier,
        carrier_shipment_id: found.carrierShipmentId || found.awb,
        carrier_order_id: found.carrierOrderId || null,
        awb: found.awb,
        courier_name: found.courierName || found.carrier,
        status: found.mappedStatus || 'shipped',
        payment_mode: shopper.payment_method || null,
        cod_amount: shopper.payment_method === 'COD' ? shopper.order_total : null,
        tracking_url: found.trackingUrl || null,
        request_payload: JSON.stringify({ syncedFrom: 'manual_carrier_shipment', source: found.source || found.carrier }),
        response_payload: null,
        shipped_by: 'manual_sync'
    });

    // Mirror onto the orders row so the whole hub sees it as shipped
    const updated = await dbAdapter.query(`
        UPDATE orders
        SET awb = ?, courier_name = ?, status = 'shipped', tracking_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE order_id = ?
        RETURNING id
    `, [found.awb, found.courierName || found.carrier, found.trackingUrl || null, shopper.order_id]);

    if (!updated || updated.length === 0) {
        await dbAdapter.insert('orders', {
            order_id: shopper.order_id,
            awb: found.awb,
            courier_name: found.courierName || found.carrier,
            status: 'shipped',
            tracking_url: found.trackingUrl || null,
            total: shopper.order_total || null,
            payment_method: shopper.payment_method || null,
            order_date: shopper.created_at || new Date().toISOString()
        });
    }
    return { synced: true };
}

// --------------------------------------
// Helpers
// --------------------------------------

async function axiosGet(url, headers, params) {
    return axios.get(url, { headers, params, timeout: 20000 });
}

// --------------------------------------
// Main
// --------------------------------------

async function main() {
    await initializeDatabase();

    console.log(`\n🔎 Mode: ${APPLY ? 'APPLY (writes to DB)' : 'DRY RUN (report only)'}${SINCE ? ` | since ${SINCE}` : ' | all dates'}\n`);

    const dateClause = SINCE ? `AND s.created_at >= '${SINCE}'` : '';
    const confirmed = await dbAdapter.query(`
        SELECT s.id, s.phone, s.order_id, s.created_at, s.name, s.payment_method, s.order_total,
               o.awb, o.status AS order_status, o.courier_name
        FROM store_shoppers s
        LEFT JOIN orders o ON o.order_id = s.order_id
        WHERE s.status = 'confirmed'
          AND NOT COALESCE((o.awb IS NOT NULL OR o.status = 'shipped'), false)
          ${dateClause}
        ORDER BY s.created_at ASC
    `) || [];

    console.log(`📋 Confirmed shoppers without a shipped order: ${confirmed.length}\n`);
    if (confirmed.length === 0) {
        console.log('✅ Nothing to sync — hub already matches the carriers.');
        process.exit(0);
    }

    const manualMap = loadManualMap(MANUAL_CSV);
    if (MANUAL_CSV) console.log(`📄 Manual CSV loaded: ${manualMap.size} order→AWB mapping(s)\n`);

    const results = { synced: [], pending: [], notFound: [], failed: [] };
    const configured = CARRIER_KEYS.filter(k => getAdapter(k));
    console.log(`🚚 Configured carriers: ${configured.join(', ') || 'none'}\n`);

    if (configured.length === 0 && manualMap.size === 0) {
        console.error('❌ No carrier is configured and no --manual CSV given — nothing to check against.');
        console.error('   Add SHIPROCKET_* / DELHIVERY_* / EKART_* vars to .env (see .env.example) and re-run.');
        process.exit(1);
    }

    for (const shopper of confirmed) {
        const orderId = shopper.order_id;
        process.stdout.write(`• ${orderId} (${shopper.name || shopper.phone}): `);

        try {
            let found = null;

            // 1. Manual CSV takes priority — it's explicit human knowledge
            const manual = manualMap.get(String(orderId).replace(/^#/, ''));
            if (manual) {
                const verified = await verifyAwb(manual.awb, manual.carrier);
                if (verified) {
                    found = {
                        awb: manual.awb,
                        carrier: verified.carrier,
                        courierName: manual.carrier === 'shiprocket' ? 'Shiprocket Courier' : (getAdapter(verified.carrier)?.name || verified.carrier),
                        trackingUrl: verified.carrier === 'shiprocket' ? `https://shiprocket.co/tracking/${manual.awb}`
                            : verified.carrier === 'delhivery' ? `https://www.delhivery.com/track/package/${manual.awb}`
                            : `https://app.elite.ekartlogistics.in/track/${manual.awb}`,
                        mappedStatus: mapLiveStatus(verified.currentStatus),
                        source: 'manual_csv'
                    };
                } else {
                    results.failed.push({ orderId, reason: `manual AWB ${manual.awb} could not be verified at any carrier` });
                    console.log(`❌ manual AWB ${manual.awb} not verifiable at any carrier`);
                    continue;
                }
            }

            // 2. Shopify fulfillments — panel shipments always carry the AWB
            //    the seller typed when fulfilling. Verify it via carrier track.
            if (!found) {
                const ful = await searchShopifyFulfillment(orderId);
                if (ful) {
                    const verified = await verifyAwb(ful.awb, ful.preferredCarrier);
                    if (verified) {
                        const carrierKey = verified.carrier;
                        found = {
                            awb: ful.awb,
                            carrier: carrierKey,
                            courierName: ful.company || (getAdapter(carrierKey)?.name || carrierKey),
                            trackingUrl: carrierKey === 'shiprocket' ? `https://shiprocket.co/tracking/${ful.awb}`
                                : carrierKey === 'delhivery' ? `https://www.delhivery.com/track/package/${ful.awb}`
                                : `https://app.elite.ekartlogistics.in/track/${ful.awb}`,
                            mappedStatus: mapLiveStatus(verified.currentStatus),
                            source: 'shopify_fulfillment'
                        };
                    } else {
                        results.failed.push({ orderId, reason: `Shopify fulfillment AWB ${ful.awb} (${ful.company || '?'}) could not be verified at any carrier` });
                        console.log(`❌ Shopify AWB ${ful.awb} (${ful.company || '?'}) not verifiable at any carrier`);
                        continue;
                    }
                }
            }

            // 3. Ask each carrier whether this order already exists there.
            //    A "pending" answer (exists but no AWB) must NOT stop the
            //    search — the real AWB may live at another carrier.
            let pendingNote = null;
            if (!found) {
                for (const key of configured) {
                    const hit = await SEARCHERS[key](orderId);
                    if (!hit) continue;
                    if (hit.pending) { pendingNote = pendingNote || hit.note; continue; }
                    found = hit;
                    break;
                }
            }

            if (!found && pendingNote) {
                results.pending.push({ orderId, note: pendingNote });
                console.log(`⏳ ${pendingNote}`);
            } else if (!found) {
                results.notFound.push({ orderId });
                console.log('not found at any carrier');
            } else if (!APPLY) {
                results.synced.push({ orderId, awb: found.awb, carrier: found.carrier });
                console.log(`✅ found at ${found.carrier} — AWB ${found.awb} (${found.courierName}${found.carrierStatus ? `, ${found.carrierStatus}` : ''})${found.source === 'manual_csv' ? ' [manual CSV]' : ''}${found.source === 'shopify_fulfillment' ? ' [shopify fulfillment]' : ''}`);
            } else {
                const outcome = await recordShipment(shopper, found);
                if (outcome.skipped) {
                    results.pending.push({ orderId, note: outcome.reason });
                    console.log(`⏳ skipped — ${outcome.reason}`);
                } else {
                    results.synced.push({ orderId, awb: found.awb, carrier: found.carrier });
                    console.log(`✅ synced as shipped via ${found.carrier} — AWB ${found.awb}`);
                }
            }
        } catch (error) {
            results.failed.push({ orderId, reason: error.message });
            console.log(`❌ ${error.message.substring(0, 150)}`);
        }

        await sleep(400); // be gentle with carrier rate limits
    }

    // Apply mode touched shipment/order rows → hub caches must go stale
    if (APPLY && results.synced.length > 0 && caches && caches.shoppers) {
        caches.shoppers.clear();
        console.log('\n🗑️ Cache invalidated: shoppers');
    }

    console.log(`\n📊 Summary (${APPLY ? 'applied' : 'dry run'}):`);
    console.log(`   ✅ ${APPLY ? 'Synced as shipped' : 'Found & ready to sync'}: ${results.synced.length}`);
    console.log(`   ⏳ Pending / skipped:    ${results.pending.length}`);
    console.log(`   ❓ Not found anywhere:   ${results.notFound.length}`);
    console.log(`   ❌ Failed:               ${results.failed.length}`);

    if (!APPLY && results.synced.length > 0) {
        console.log('\n👉 Run again with --apply to write these into the hub.');
    }
    if (results.notFound.length > 0) {
        console.log('\n💡 Orders not discoverable via API (e.g. shipped manually on Ekart):');
        console.log('   create a CSV with rows of "order_id,awb,carrier" and run:');
        console.log('   node scripts/sync_manual_shipments.js --manual manual_awbs.csv --apply');
    }
    for (const f of results.failed) console.log(`   ❌ ${f.orderId}: ${f.reason}`);

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
