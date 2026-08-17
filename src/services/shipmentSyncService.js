/**
 * Shipment status auto-sync — keeps the Shopper Hub "Shipped Orders" section
 * in step with live carrier tracking (Shiprocket / Delhivery / future adapters).
 *
 * How it works:
 *   - Picks active shipments (AWB assigned, not in a terminal state), oldest
 *     synced first, and polls each carrier's track API.
 *   - Maps the carrier's free-text status to our internal pipeline smartly:
 *       awb_assigned → pickup_scheduled → in_transit → delivered
 *     with special handling for RTO and carrier-side cancellations.
 *   - Forward-only transitions: a stray/older scan can never regress a
 *     shipment (e.g. delivered back to in_transit).
 *   - Mirrors terminal states onto the orders row so the whole hub sees them.
 *
 * Invoked from the cron (shipmentSyncCron) and on-demand from the admin API
 * when the Shipped Orders view is opened/refreshed.
 */

const { dbAdapter } = require('../database/db');
const { caches } = require('../utils/cache');
const { getAdapter } = require('./carriers');

// Statuses still worth polling the carrier for
const ACTIVE_STATUSES = ['created', 'awb_assigned', 'pickup_scheduled', 'shipped', 'in_transit', 'out_for_delivery'];

// Forward-only pipeline ranks (higher = further along, never move backwards)
const STATUS_RANK = { created: 0, awb_assigned: 1, pickup_scheduled: 2, shipped: 3, in_transit: 3, out_for_delivery: 4, delivered: 5 };

// Delay between carrier calls so a big batch never hammers their API
const PER_CALL_DELAY_MS = 300;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let isRunning = false;
let lastRunAt = null;

/**
 * Map a carrier's live status string to our internal shipment status.
 * Handles Shiprocket labels ("Out For Delivery", "RTO Initiated"...) and
 * Delhivery statuses ("Manifested", "Dispatched", "Returned"...).
 * Returns null when the status carries no useful transition.
 */
function mapCarrierStatus(rawStatus) {
    const s = (rawStatus || '').toLowerCase().trim();
    if (!s) return null;

    // Order matters: RTO/return and cancellation before the generic checks,
    // and "out for delivery" before "delivered" (both contain 'deliver')
    if (s.includes('rto') || s.includes('return')) return 'rto';
    if (s.includes('cancellation requested')) return null; // not cancelled yet
    if (s.includes('cancel')) return 'cancelled';
    if (s.includes('undeliver') || s.includes('not deliver') || s.includes('failed deliver')) return 'in_transit'; // NDR — still with courier
    if (s.includes('out for delivery')) return 'out_for_delivery';
    if (s.includes('deliver')) return 'delivered';
    if (s.includes('transit') || s.includes('shipped') || s.includes('picked') ||
        s.includes('dispatch') || s.includes('reached') || s.includes('arrived') ||
        s.includes('bagged') || s.includes('received at') || s.includes('pending')) return 'in_transit';
    if (s.includes('pickup') || s.includes('manifest') || s.includes('scheduled')) return 'pickup_scheduled';
    return null;
}

/**
 * Decide the status to persist for a shipment given the mapped live status.
 * Terminal overrides (rto/cancelled) always win unless already delivered;
 * pipeline statuses only ever move forward.
 */
function resolveTransition(currentStatus, mappedStatus) {
    if (!mappedStatus || mappedStatus === currentStatus) return null;
    if (currentStatus === 'delivered') return null; // delivered is final
    if (mappedStatus === 'rto' || mappedStatus === 'cancelled') return mappedStatus;
    if (currentStatus === 'rto') return null; // only cancelled/failed can follow RTO (manual)
    const from = STATUS_RANK[currentStatus] ?? 0;
    const to = STATUS_RANK[mappedStatus] ?? 0;
    return to > from ? mappedStatus : null;
}

/**
 * Pull the actual delivery timestamp out of a carrier tracking result.
 * Prefers the scan that says "Delivered"; falls back to the newest scan
 * (the carrier only reports delivered after the POD scan exists).
 */
function extractDeliveredAt(result) {
    const timeline = result?.data?.timeline || [];
    const isDeliverScan = e => {
        const text = `${e.activity || ''} ${e.status || ''}`.toLowerCase();
        return text.includes('deliver') && !text.includes('out for delivery') && !text.includes('undeliver');
    };
    const scan = timeline.find(isDeliverScan) || timeline[0];
    const date = scan?.date ? new Date(scan.date) : null;
    if (date && !isNaN(date.getTime())) return date.toISOString();
    return new Date().toISOString();
}

// Mirror meaningful transitions onto the orders row (hub-wide visibility)
async function syncOrderRowStatus(shipment, newStatus, expectedDelivery, deliveredAt) {
    try {
        if (newStatus === 'delivered') {
            await dbAdapter.query(
                `UPDATE orders SET status = 'delivered', delivered_at = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                [deliveredAt || new Date().toISOString(), shipment.order_id, shipment.awb]
            );
        } else if (newStatus === 'rto') {
            await dbAdapter.query(
                `UPDATE orders SET status = 'rto', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                [shipment.order_id, shipment.awb]
            );
        } else if (newStatus === 'cancelled') {
            // Cancelled at the carrier: free the order so it's re-shippable from the hub
            await dbAdapter.query(
                `UPDATE orders SET awb = NULL, courier_name = NULL, tracking_url = NULL, status = 'cancelled_shipment', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                [shipment.order_id, shipment.awb]
            );
        } else if (expectedDelivery) {
            await dbAdapter.query(
                `UPDATE orders SET expected_delivery = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                [String(expectedDelivery).substring(0, 100), shipment.order_id, shipment.awb]
            );
        }
    } catch (error) {
        console.error(`⚠️ Order row sync failed for ${shipment.order_id}:`, error.message);
    }
}

// Sync one shipment against its carrier. Returns true if the status changed.
async function syncShipment(shipment) {
    const adapter = getAdapter(shipment.carrier);
    if (!adapter || !shipment.awb) return false;

    const result = await adapter.track(shipment.awb);
    let carrierStatus = result.success ? result.data.currentStatus : null;
    let expectedDelivery = result.success ? result.data.expectedDelivery : null;
    let mapped = mapCarrierStatus(carrierStatus);

    // Shiprocket fallback: fresh AWBs often have zero scans, so AWB tracking
    // says nothing while the order-level status already shows "PICKUP
    // SCHEDULED" / "PICKED UP". Use that so Ready to Ship drains properly.
    if (!mapped && shipment.carrier === 'shiprocket') {
        try {
            const shiprocketService = require('./shiprocketService');
            const srOrder = await shiprocketService.getOrderStatus(shipment.carrier_order_id || shipment.order_id);
            if (srOrder && srOrder.status) {
                carrierStatus = String(srOrder.status);
                mapped = mapCarrierStatus(carrierStatus);
                if (!expectedDelivery) expectedDelivery = srOrder.expectedDelivery || null;
            }
        } catch (error) {
            console.warn(`⚠️ Shiprocket order-status fallback failed for ${shipment.order_id}:`, error.message);
        }
    }

    const newStatus = resolveTransition(shipment.status, mapped);

    // Always bump updated_at so unchanged shipments rotate to the back of the queue
    if (!newStatus) {
        await dbAdapter.update('shipments', { updated_at: new Date().toISOString() }, { id: shipment.id });
        return false;
    }

    const deliveredAt = newStatus === 'delivered' ? extractDeliveredAt(result) : null;

    await dbAdapter.update('shipments', {
        status: newStatus,
        updated_at: new Date().toISOString(),
        ...(deliveredAt ? { delivered_at: deliveredAt } : {})
    }, { id: shipment.id });

    await syncOrderRowStatus(shipment, newStatus, expectedDelivery, deliveredAt);
    console.log(`📦 Shipment #${shipment.id} (${shipment.order_id}, AWB ${shipment.awb}): ${shipment.status} → ${newStatus} [carrier: "${carrierStatus}"]`);

    // Send "Out for Delivery" WhatsApp template notification to the customer
    if (newStatus === 'out_for_delivery' && shipment.status !== 'out_for_delivery') {
        try {
            const shopperRows = await dbAdapter.query(
                `SELECT phone, name, order_id FROM store_shoppers WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
                [shipment.order_id]
            );
            const shopper = shopperRows[0];
            if (shopper && shopper.phone) {
                const whatsappService = require('./whatsappService');
                await whatsappService.sendOutOfDeliveryNotification(
                    shopper.phone,
                    shopper.name || 'Customer',
                    shipment.order_id,
                    shipment.awb
                );
                console.log(`🚚 Out-for-delivery notification sent to ${shopper.phone} for order ${shipment.order_id}`);
            }
        } catch (notifyErr) {
            console.warn(`⚠️ Failed to send OFD notification for ${shipment.order_id}:`, notifyErr.message);
        }
    }

    return true;
}

/**
 * Poll the carrier for a batch of active shipments and apply status updates.
 * Oldest-synced first so every active shipment gets refreshed over time.
 */
async function syncActiveShipments({ limit = 60 } = {}) {
    if (isRunning) return { skipped: true, reason: 'sync already in progress', checked: 0, updated: 0 };
    isRunning = true;

    try {
        const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
        const shipments = await dbAdapter.query(`
            SELECT * FROM shipments
            WHERE awb IS NOT NULL AND awb <> '' AND status IN (${placeholders})
            ORDER BY updated_at ASC NULLS FIRST
            LIMIT ?
        `, [...ACTIVE_STATUSES, Math.min(parseInt(limit) || 60, 200)]);

        let updated = 0;
        for (const shipment of shipments) {
            try {
                if (await syncShipment(shipment)) updated++;
            } catch (error) {
                console.error(`⚠️ Status sync failed for shipment #${shipment.id} (AWB ${shipment.awb}):`, error.message);
            }
            if (shipments.length > 1) await sleep(PER_CALL_DELAY_MS);
        }

        if (updated > 0 && caches && caches.shoppers) {
            caches.shoppers.clear();
            console.log('🗑️ Cache invalidated: shoppers (shipment status sync)');
        }

        lastRunAt = new Date();
        if (shipments.length > 0) {
            console.log(`🔄 Shipment status sync: checked ${shipments.length}, updated ${updated}`);
        }
        return { checked: shipments.length, updated };
    } finally {
        isRunning = false;
    }
}

function getLastRunAt() {
    return lastRunAt;
}

module.exports = {
    syncActiveShipments,
    mapCarrierStatus,
    resolveTransition,
    extractDeliveredAt,
    getLastRunAt
};
