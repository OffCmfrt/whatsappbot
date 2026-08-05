/**
 * Backfill zero-weight Shiprocket orders with a fixed weight.
 *
 * Shopify products without a weight sync across to Shiprocket as 0, and
 * Shiprocket then refuses AWB assignment ("Zero weight or no weight
 * entered."). This script scans Shiprocket orders and stamps a fixed
 * weight on every zero-weight one that isn't already shipped.
 *
 * Usage:
 *   node scripts/fix_zero_weight_shiprocket.js                  # dry run (report only)
 *   node scripts/fix_zero_weight_shiprocket.js --apply          # update the orders
 *   node scripts/fix_zero_weight_shiprocket.js --apply --weight 0.5
 *   node scripts/fix_zero_weight_shiprocket.js --apply --days 7 # only orders from the last 7 days
 */

require('dotenv').config();
const axios = require('axios');
const shiprocketService = require('../src/services/shiprocketService');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const weightArg = Number(args[args.indexOf('--weight') + 1]);
const daysArg = Number(args[args.indexOf('--days') + 1]);
const WEIGHT_KG = Number.isFinite(weightArg) && weightArg > 0 ? weightArg : 0.5;
const DAYS = Number.isFinite(daysArg) && daysArg > 0 ? daysArg : 30;

// Shiprocket won't let us edit orders that are already far along — only fix
// the statuses where shipping is still ahead of us.
const EDITABLE_STATUSES = new Set(['NEW', 'PENDING', 'ACCEPTED', 'PICKUP_QUEUED', 'READY_TO_SHIP', 'MANIFESTED']);

// Dimensions matching the hub's fixed package (see shiprocketAdapter.enforceFixedPackage)
const PACKAGE = { length: 30, breadth: 40, height: 2 };

async function authHeaders() {
    await shiprocketService.ensureAuthenticated();
    return { 'Authorization': `Bearer ${shiprocketService.token}`, 'Content-Type': 'application/json' };
}

function isZeroWeight(order) {
    // Shiprocket listing rows no longer carry a top-level `weight` — it lives
    // under `others.weight` now. Treat a missing field as unknown, not zero,
    // only when some weight field exists with a zero/blank value.
    const candidates = [order.weight, order.others?.weight];
    const present = candidates.map(Number).find(Number.isFinite);
    if (present === undefined) return false; // no weight field at all — can't tell
    return present <= 0;
}

function formatDate(date) {
    return date.toISOString().slice(0, 10);
}

async function main() {
    const headers = await authHeaders();
    const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

    console.log(`\n🔎 Mode: ${APPLY ? 'APPLY (updates Shiprocket)' : 'DRY RUN (report only)'}`);
    console.log(`📦 Target weight: ${WEIGHT_KG} kg | window: last ${DAYS} days (since ${formatDate(since)})\n`);

    const zeroWeight = [];
    let page = 1;
    let scanned = 0;

    // Page through recent orders and collect the zero-weight, still-editable ones
    while (page <= 50) {
        let response;
        try {
            response = await axios.get(`${shiprocketService.baseURL}/orders`, {
                headers,
                params: { page, per_page: 100 },
                timeout: 30000
            });
        } catch (error) {
            const body = error.response?.data ? JSON.stringify(error.response.data).substring(0, 200) : error.message;
            console.error(`❌ Order listing failed on page ${page}: ${body}`);
            break;
        }

        const orders = response.data?.data || [];
        if (orders.length === 0) break;
        scanned += orders.length;

        for (const order of orders) {
            const created = new Date(order.created_at);
            if (!Number.isNaN(created.getTime()) && created < since) continue; // out of window

            const status = String(order.status || order.current_status || '').toUpperCase();
            if (!isZeroWeight(order)) continue;
            if (order.awb_code) continue;                       // already shipped — nothing to fix
            if (!EDITABLE_STATUSES.has(status)) {
                console.log(`  ⏭️  Skipping ${order.channel_order_id} — status ${status} is past editing`);
                continue;
            }
            zeroWeight.push(order);
        }

        // The listing is newest-first — stop once the page is older than the window
        const oldest = orders.map(o => new Date(o.created_at)).filter(d => !Number.isNaN(d.getTime())).sort((a, b) => a - b)[0];
        if (oldest && oldest < since) break;
        if (orders.length < 100) break;
        page++;
    }

    console.log(`📋 Scanned ${scanned} order(s) — zero-weight candidates: ${zeroWeight.length}\n`);
    if (zeroWeight.length === 0) {
        console.log('✅ Nothing to fix — every recent order has a weight.');
        process.exit(0);
    }

    let fixed = 0;
    let failed = 0;

    for (const order of zeroWeight) {
        const label = `${order.channel_order_id} (#${order.id})`;
        if (!APPLY) {
            console.log(`• ${label} — weight ${order.weight ?? order.others?.weight ?? 0} kg → would set ${WEIGHT_KG} kg`);
            continue;
        }

        try {
            await axios.post(`${shiprocketService.baseURL}/orders/update/${order.id}`, {
                ...PACKAGE,
                weight: WEIGHT_KG
            }, { headers, timeout: 20000 });
            fixed++;
            console.log(`✅ ${label} — set to ${WEIGHT_KG} kg`);
        } catch (error) {
            failed++;
            const body = error.response?.data ? JSON.stringify(error.response.data).substring(0, 200) : error.message;
            console.warn(`❌ ${label} — update rejected: ${body}`);
        }
        await new Promise(r => setTimeout(r, 250)); // stay gentle on rate limits
    }

    console.log(`\n${APPLY ? `Done — fixed ${fixed}, failed ${failed}.` : `Dry run complete — re-run with --apply to update ${zeroWeight.length} order(s).`}`);
    process.exit(0);
}

main().catch(error => {
    console.error('❌ Script failed:', error.response?.data || error.message);
    process.exit(1);
});
