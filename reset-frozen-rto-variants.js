// Verify shipments frozen as rto_initiated/rto_delivered against live carrier
// tracking; reset to in_transit only when the carrier shows the parcel is
// still moving (non-terminal). Fixes false RTOs created by the stale
// Shiprocket order-level fallback (e.g. order #64247).
require('dotenv').config();
const { dbAdapter } = require('./src/database/db');
const { mapCarrierStatus, resolveTransition } = require('./src/services/shipmentSyncService');
const { getAdapter } = require('./src/services/carriers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const rows = await dbAdapter.query(
        `SELECT id, order_id, awb, carrier, status FROM shipments
         WHERE status IN ('rto_initiated', 'rto_delivered')
           AND awb IS NOT NULL AND carrier IS NOT NULL
         ORDER BY updated_at DESC`
    );
    console.log(`Verifying ${rows.length} shipments against live carrier tracking...`);

    let reset = 0, kept = 0, unverifiable = 0;
    for (const s of rows) {
        const adapter = getAdapter(s.carrier);
        if (!adapter) { console.log(`SKIP #${s.id} (${s.order_id}) no adapter for ${s.carrier}`); unverifiable++; continue; }
        let mapped = null;
        let liveStatus = null;
        // Shiprocket throttles bulk lookups and returns "No tracking data".
        // Retry with backoff so a throttle hiccup is not mistaken for a real
        // missing-shipment (which would leave a false RTO frozen).
        let result = null;
        for (let attempt = 1; attempt <= 4; attempt++) {
            try {
                result = await adapter.track(s.awb);
                if (result.success) break;
            } catch (e) {
                result = { success: false, error: e.message };
            }
            await sleep(1200 * attempt);
        }
        if (!result || !result.success) {
            console.log(`SKIP #${s.id} (${s.order_id}) track failed after retries: ${result && result.error}`);
            unverifiable++;
            await sleep(300);
            continue;
        }
        liveStatus = result.data.currentStatus;
        mapped = mapCarrierStatus(result.data.currentStatus, result.data.statusType);

        // Trust the live tracking API: any RTO variant stays terminal.
        if (!mapped || String(mapped).startsWith('rto') || mapped === 'cancelled' || mapped === 'failed') {
            console.log(`KEEP #${s.id} (${s.order_id}) "${s.status}" live="${liveStatus}" mapped=${mapped}`);
            kept++;
            await sleep(300);
            continue;
        }

        console.log(`RESET #${s.id} (${s.order_id}) "${s.status}" → "${mapped}" live="${liveStatus}"`);
        await dbAdapter.query(
            `UPDATE shipments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [mapped, s.id]
        );
        await dbAdapter.query(
            `UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
            [mapped, s.order_id, s.awb]
        );
        reset++;
        await sleep(400); // be gentle on carrier rate limits
    }

    console.log(`\nDone. reset=${reset} kept=${kept} unverifiable=${unverifiable}`);
    process.exit(0);
})().catch((e) => { console.error('SCRIPT ERROR:', e.message); process.exit(1); });
