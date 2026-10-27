// One-shot (re-runnable) maintenance sweep for the RTO recheck window.
//
// Polls the LIVE carrier for every shipment currently sitting in 'rto' /
// 'rto_initiated' whose immutable created_at is inside the self-heal window,
// prints a histogram of the raw carrier status strings (so mis-classifications
// are visible), and self-heals the ones the carrier shows moving FORWARD.
//
// Writes the DB directly (both shipments and orders) instead of going through
// the sync pipeline, so no Zoho credit note re-fires and no out-for-delivery
// WhatsApp template goes out during a correction.
//
// Usage: node recheck-rto-window.js [--dry-run]
require('dotenv').config();
const { dbAdapter } = require('./src/database/db');
const { mapCarrierStatus, resolveTransition } = require('./src/services/shipmentSyncService');
const { getAdapter } = require('./src/services/carriers');

const DRY_RUN = process.argv.includes('--dry-run');
const WINDOW_DAYS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function trackWithRetry(adapter, awb) {
    let result = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            result = await adapter.track(awb);
            // Shiprocket answers "No tracking data found" as a throttling
            // artifact under load — retry those instead of believing them.
            if (result && result.success) return result;
        } catch (e) {
            result = { success: false, error: e.message };
        }
        await sleep(900 * attempt);
    }
    return result;
}

(async () => {
    const rows = await dbAdapter.query(
        `SELECT id, order_id, awb, carrier, status, created_at, updated_at
         FROM shipments
         WHERE status IN ('rto', 'rto_initiated')
           AND awb IS NOT NULL AND awb <> ''
           AND created_at > NOW() - (? || ' days')::interval
         ORDER BY created_at DESC`,
        [String(WINDOW_DAYS)]
    );
    console.log(`scanning ${rows.length} in-window RTO rows${DRY_RUN ? ' (DRY RUN)' : ''}...`);

    const histogram = {};
    let healed = 0, genuine = 0, unknown = 0, failed = 0, ordersMirrored = 0;

    for (const row of rows) {
        const adapter = getAdapter(row.carrier);
        if (!adapter) { unknown++; continue; }

        const res = await trackWithRetry(adapter, row.awb);
        if (!res || !res.success) {
            failed++;
            await sleep(200);
            continue;
        }

        const live = res.data.currentStatus || '';
        const key = `${live} | type=${res.data.statusType || '-'}`;
        histogram[key] = (histogram[key] || 0) + 1;

        const mapped = mapCarrierStatus(live, res.data.statusType);
        const target = resolveTransition(row.status, mapped);

        if (!target || target === row.status) {
            genuine++;
            await sleep(200);
            continue;
        }

        console.log(`HEAL #${row.id} (${row.order_id}) "${row.status}" → "${target}" live="${live}"`);
        if (!DRY_RUN) {
            await dbAdapter.query(
                `UPDATE shipments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [target, row.id]
            );
            const oRes = await dbAdapter.query(
                `UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE order_id = ? AND awb = ? AND status LIKE 'rto%' RETURNING order_id`,
                [target, row.order_id, row.awb]
            );
            if (oRes && oRes.length) ordersMirrored++;
        }
        healed++;
        await sleep(250);
    }

    console.log('\n== live carrier status histogram ==');
    Object.entries(histogram)
        .sort((a, b) => b[1] - a[1])
        .forEach(([k, n]) => console.log(`${String(n).padStart(4)}  ${k}`));

    console.log(`\ndone. healed=${healed} genuine=${genuine} unknownAdapter=${unknown} trackFailed=${failed} ordersMirrored=${ordersMirrored}`);
    process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
