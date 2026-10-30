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

// Only the columns the sync pipeline actually reads.
//
// This is deliberately NOT `SELECT *`: shipments.request_payload /
// response_payload are multi-KB jsonb blobs (measured on the live table: the
// average row is ~6.2 KB, of which ~5.6 KB is response_payload; without the
// two blobs it is ~382 B). pg has to parse those into JS object graphs for
// every row, so a 300-row sweep used to materialise ~1.9 MB of heap it never
// read. Projecting the needed columns keeps the same sweep at ~115 KB — the
// process runs under a 512 MB RSS ceiling with a watchdog, so per-cycle row
// size is a real constraint, not a micro-optimisation.
const SYNC_COLUMNS = `id, order_id, awb, carrier, carrier_shipment_id, carrier_order_id,
                      courier_name, status, payment_mode, cod_amount`;

// Carriers emit transient RTO scans (an NDR that is later re-attempted, a
// stale "RTO Initiated" that reverses when the parcel resumes moving). Once
// an RTO variant is written the row leaves ACTIVE_STATUSES and would freeze
// forever. So for a bounded window we keep re-polling recently-created RTO
// rows: if the carrier shows the parcel still moving FORWARD, the row
// self-heals back to in_transit. Bounded by created_at (immutable) so settled
// RTOs permanently age out of the sweep and stop costing carrier calls.
//
// OPTIMIZATION: only 'rto' and 'rto_initiated' are re-polled. 'rto_delivered'
// means the return parcel was already delivered back to origin — that state
// is absolutely terminal and can never resume forward movement, so re-polling
// it is pure waste. It is also the largest bucket (currently 725 of the 1018
// RTO rows inside the window) and was starving genuine in-transit parcels of
// LIMIT slots, roughly doubling rotation time for the whole pipeline.
const RTO_RECHECK_DAYS = 30;
const RTO_RECHECK_STATUSES = ['rto', 'rto_initiated'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

let isRunning = false;
let lastRunAt = null;

/**
 * Map a carrier's live status string to our internal shipment status.
 * Handles Shiprocket labels ("Out For Delivery", "RTO Initiated"...) and
 * Delhivery statuses ("Manifested", "Dispatched", "Returned"...).
 *
 * @param {string} rawStatus  – human-readable carrier status string
 * @param {string} [statusType] – carrier status code (Delhivery: "RT" = RTO,
 *   "DL" = delivered, "PU" = picked up, "UD" = undelivered, etc.)
 * Returns null when the status carries no useful transition.
 */
function mapCarrierStatus(rawStatus, statusType = null) {
    const s = (rawStatus || '').toLowerCase().trim();
    const st = (statusType || '').toString().toUpperCase().trim();
    if (!s && !st) return null;

    // Handle Shiprocket numeric status codes (from API docs)
    // These are returned as strings but can be parsed as numbers
    const codeNum = parseInt(s, 10);
    if (!isNaN(codeNum)) {
        // Shiprocket status code mapping
        switch (codeNum) {
            case 6: return 'in_transit'; // Shipped
            case 7: return 'delivered'; // Delivered
            case 8: return 'cancelled'; // Canceled
            case 9: return 'rto_initiated'; // RTO Initiated
            case 10: return 'rto_delivered'; // RTO Delivered
            case 12: return 'untrackable'; // Lost — carrier wrote the parcel off
            case 13: return 'in_transit'; // Pickup Error
            case 14: return 'rto_initiated'; // RTO Acknowledged
            case 15: return 'pickup_scheduled'; // Pickup Rescheduled
            case 16: return null; // Cancellation Requested (not yet cancelled)
            case 17: return 'out_for_delivery'; // Out For Delivery
            case 18: return 'in_transit'; // In Transit
            case 19: return 'pickup_scheduled'; // Out For Pickup
            case 20: return 'in_transit'; // Pickup Exception
            case 21: return 'in_transit'; // Undelivered (NDR)
            case 22: return 'in_transit'; // Delayed
            case 23: return 'delivered'; // Partial_Delivered
            case 24: return 'failed'; // DESTROYED
            case 25: return 'failed'; // DAMAGED
            case 26: return 'delivered'; // FULFILLED
            case 27: return 'pickup_scheduled'; // Pickup Booked
            case 38: return 'in_transit'; // REACHED AT DESTINATION HUB
            case 39: return 'in_transit'; // MISROUTED
            case 40: return 'rto_initiated'; // RTO_NDR
            case 41: return 'rto_initiated'; // RTO_OFD
            case 42: return 'in_transit'; // PICKED UP
            case 43: return 'delivered'; // SELF FULFILLED
            case 44: return 'failed'; // DISPOSED OFF
            case 45: return 'cancelled'; // CANCELLED_BEFORE_DISPATCHED
            case 46: return 'rto'; // RTO IN INTRANSIT
            case 47: return 'failed'; // QC FAILED
            case 48: return 'in_transit'; // Reached Warehouse
            case 49: return 'in_transit'; // Custom Cleared
            case 50: return 'in_transit'; // In Flight
            case 51: return 'in_transit'; // Handover to Courier
            case 52: return 'in_transit'; // Shipment Booked
            case 54: return 'in_transit'; // In Transit Overseas
            case 55: return 'in_transit'; // Connection Aligned
            case 56: return 'in_transit'; // Reached Overseas Warehouse
            case 57: return 'in_transit'; // Custom Cleared Overseas
            case 59: return 'in_transit'; // Box Packing
            case 68: return 'in_transit'; // PROCESSED AT WAREHOUSE
            case 60: return 'in_transit'; // FC Allocated
            case 61: return 'in_transit'; // Picklist Generated
            case 62: return 'in_transit'; // Ready To Pack
            case 63: return 'in_transit'; // Packed
            case 67: return 'in_transit'; // FC MANIFEST GENERATED
            case 71: return 'in_transit'; // HANDOVER EXCEPTION
            case 72: return 'in_transit'; // PACKED EXCEPTION
            case 75: return 'rto_initiated'; // RTO_LOCK
            case 76: return 'untrackable'; // UNTRACEABLE
            case 77: return 'in_transit'; // ISSUE_RELATED_TO_THE_RECIPIENT
            case 78: return 'rto'; // REACHED_BACK_AT_SELLER_CITY
            default: break; // Not a numeric code, continue with string matching
        }
    }

    // Handle Delhivery B2B API statuses (from API docs)
    const upper = s.toUpperCase();
    const delhiveryB2BStatuses = {
        'MANIFESTED': 'in_transit',
        'PICKED_UP': 'in_transit',
        'LEFT_ORIGIN': 'in_transit',
        'REACH_DESTINATION': 'in_transit',
        'UNDEL_REATTEMPT': 'in_transit', // NDR
        'PART_DEL': 'delivered',
        'OFD': 'out_for_delivery',
        'DELIVERED': 'delivered',
        'RETURNED_INTRANSIT': 'rto', // Return in transit to return center
        'RECEIVED_AT_RETURN_CENTER': 'rto_delivered', // Received at return center
        'RETURN_OFD': 'rto_initiated', // Return out for delivery
        'RETURN_DELIVERED': 'rto_delivered', // Return delivered
        'NOT_PICKED': 'failed',
        'LOST': 'untrackable',        // parcel lost in the network
        'UNTRACEABLE': 'untrackable'  // carrier has no further trace of it
    };
    if (delhiveryB2BStatuses[upper]) {
        return delhiveryB2BStatuses[upper];
    }

    // Order matters: RTO/return and cancellation before the generic checks,
    // and "out for delivery" before "delivered" (both contain 'deliver')

    // RTO detection — comprehensive but safe.
    //
    // Carriers report RTO in many forms:
    //   • Delhivery: StatusType 'RT'/'RTO' + status 'RTO'/'Returned',
    //     BUT StatusType 'RT' + status 'Delivered' = DTO (return parcel
    //     delivered back to warehouse) — that's a failure case, NOT success.
    //   • Shiprocket: 'RTO Initiated', 'RTO Delivered', 'RTO In-Transit',
    //     'RTO Acknowledged', 'RTO NDR', 'RTO Out For Delivery'
    //   • Ekart: 'Marked RTO', 'RTO Delivered', 'RTO'
    //   • Compound: 'Delivered - Return to Origin', 'Returned to Sender'
    //
    // The ONLY 'return'-containing statuses that are NOT RTO are active
    // return-pickup-in-transit (the parcel is moving but as a return
    // pickup, not a forward RTO). We detect those by the combination of
    // 'return' + a transit/pickup keyword and exclude them.
    //
    // Delhivery StatusType 'RT'/'RTO' means RTO always (DTO is also a failure case)

    const inTransitReturn = s.includes('return') &&
        (s.includes('in transit') || s.includes('in-transit') ||
         s.includes('pickup') || s.includes('dto'));

    // StatusType RT/RTO = RTO always (DTO is also a failure case, not success)
    const stIsRto = (st === 'RT' || st === 'RTO');

    // More specific RTO detection: check for 'rto' as a word or in specific phrases,
    // not as a substring (to avoid false positives)
    // Exact matches for Ekart "RTO" status
    const isExactRto = s === 'rto';
    // Shiprocket returns underscored forms like RTO_OFD / RTO_NDR / RTO_LOCK
    // (codes 41, 40, 75). JS regex \b treats '_' as a word character, so
    // /\brto\b/ does NOT match "rto_ofd" — the underscored RTO prefix used to
    // slip past this check and fall through to the generic 'ofd' → out_for_delivery
    // branch, falsely healing genuine returns. Match rto followed by a word
    // boundary OR an underscore/non-word char.
    const hasRtoWord = isExactRto || /\brto\b|\brto_/i.test(s) || s.includes('rto initiated') || 
                       s.includes('rto delivered') || s.includes('rto in-transit') ||
                       s.includes('rto in intransit') || s.includes('rto acknowledged') || 
                       s.includes('rto ndr') || s.includes('rto ofd') || s.includes('rto lock') ||
                       s.includes('marked rto') || s.includes('reached_back_at_seller_city');

    const isRto =
        stIsRto ||
        (s.includes('return') && !inTransitReturn) ||
        hasRtoWord;
    
    if (isRto) {
        // Sub-classify RTO into more specific statuses
        if (s.includes('delivered') || s.includes('dto') || s.includes('received_at_return_center')) {
            return 'rto_delivered'; // RTO parcel delivered back to origin
        } else if (s.includes('initiated') || s.includes('marked') || s.includes('acknowledged') || 
                   s.includes('lock') || s.includes('ofd') || s.includes('ndr')) {
            return 'rto_initiated'; // RTO just initiated/acknowledged
        }
        return 'rto'; // Generic RTO
    }

    // Lost / untraceable in transit — the carrier has written the parcel off.
    // MUST run before the undelivered/transit/delivered branches below:
    // free-text forms such as "Lost in Transit", "Shipment Untraceable" or
    // "UNDELIVERED - LOST" contain 'transit'/'undeliver', so they used to fall
    // through to in_transit and were re-polled forever, never reaching the
    // hub's Untrackable filter.
    if (/\blost\b/i.test(s) ||
        s.includes('untraceable') || s.includes('untrackable') ||
        s.includes('not traceable') || s.includes('no tracking') ||
        s.includes('trace failed')) {
        return 'untrackable';
    }

    // Cancellation detection
    if (s.includes('cancellation requested') || s.includes('cancel requested')) return null; // not cancelled yet
    if (s.includes('cancel') || s.includes('cancelled')) return 'cancelled';
    
    // NDR / Undelivered - still with courier
    if (s.includes('undeliver') || s.includes('not deliver') || s.includes('failed deliver') || 
        s.includes('unsuccessful') || s.includes('reattempt')) return 'in_transit';
    
    // Out for delivery (must come before delivered check)
    if (s.includes('out for delivery') || s.includes('out_for_delivery') || s.includes('ofd')) return 'out_for_delivery';
    
    // Delivered
    if (s.includes('deliver') || s.includes('fulfilled')) return 'delivered';
    
    // In transit - comprehensive list
    if (s.includes('transit') || s.includes('shipped') || s.includes('picked') ||
        s.includes('dispatch') || s.includes('reached') || s.includes('arrived') ||
        s.includes('bagged') || s.includes('received at') || s.includes('pending') ||
        s.includes('manifest') || s.includes('booked') || s.includes('picked up') ||
        s.includes('warehouse') || s.includes('custom cleared') || s.includes('in flight') ||
        s.includes('handover') || s.includes('processed') || s.includes('allocated') ||
        s.includes('picklist') || s.includes('packed') || s.includes('misrouted') ||
        s.includes('delayed') || s.includes('exception') || s.includes('overseas')) return 'in_transit';
    
    // Pickup scheduled
    if (s.includes('pickup') || s.includes('scheduled') || s.includes('out for pickup')) return 'pickup_scheduled';
    
    // Failed (not lost — loss/untraceable is handled above as 'untrackable')
    if (s.includes('destroyed') || s.includes('damaged') ||
        s.includes('disposed') || s.includes('qc failed') || s.includes('not picked')) return 'failed';

    return null;
}

/**
 * Decide the status to persist for a shipment given the mapped live status.
 * Terminal overrides (rto/cancelled/untrackable) always win unless already
 * delivered; pipeline statuses only ever move forward.
 * RTO is final — DTO (Delivered to Origin) is also a failure case and cannot
 * override RTO back to delivered.
 */
function resolveTransition(currentStatus, mappedStatus) {
    if (!mappedStatus || mappedStatus === currentStatus) return null;
    if (currentStatus === 'delivered') return null; // delivered is final
    
    // All RTO variants (rto, rto_initiated, rto_delivered) are terminal.
    const isRtoVariant = (status) => status === 'rto' || (status && status.startsWith('rto_'));

    if (isRtoVariant(mappedStatus) || mappedStatus === 'cancelled' || mappedStatus === 'untrackable') return mappedStatus;
    // rto_delivered = return already delivered back to origin. Absolutely
    // final; cannot resume forward movement to the customer. Skipping the
    // recovery branch here matches the sweep (RTO_RECHECK_STATUSES excludes
    // rto_delivered) so genuine settled returns never get re-evaluated.
    if (currentStatus === 'rto_delivered') return null;
    if (isRtoVariant(currentStatus)) {
        // A transient RTO scan (rto / rto_initiated) must not permanently
        // freeze a parcel that the carrier now shows moving FORWARD again.
        // Recover only to in_transit / out_for_delivery. 'delivered' is still
        // NOT allowed out of RTO, so a genuine DTO (Delhivery StatusType
        // RT/RTO reported as Delivered) correctly stays a terminal failure.
        if (mappedStatus === 'in_transit' || mappedStatus === 'out_for_delivery') return mappedStatus;
        return null; // RTO is otherwise final — DTO is also a failure case
    }

    // untrackable (lost in transit) has no pipeline rank, so without this
    // explicit branch the rank guard below silently dropped every recovery
    // scan and a found-again parcel stayed lost forever. Only the revival
    // direction is special-cased; writing untrackable is handled above.
    if (currentStatus === 'untrackable') return mappedStatus;
    
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
        } else if (newStatus === 'rto' || (newStatus && newStatus.startsWith('rto_'))) {
            // All RTO variants (rto, rto_initiated, rto_delivered) mirror to orders
            await dbAdapter.query(
                `UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                [newStatus, shipment.order_id, shipment.awb]
            );
        } else if (newStatus === 'untrackable') {
            // Lost / untraceable at the carrier — mirror it so the hub shows
            // the order under the Untrackable filter instead of leaving it
            // looking in transit forever.
            await dbAdapter.query(
                `UPDATE orders SET status = 'untrackable', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                [shipment.order_id, shipment.awb]
            );
        } else if (newStatus === 'cancelled') {
            // Cancelled at the carrier: free the order so it's re-shippable from the hub
            await dbAdapter.query(
                `UPDATE orders SET awb = NULL, courier_name = NULL, tracking_url = NULL, status = 'cancelled_shipment', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                [shipment.order_id, shipment.awb]
            );
        } else if (
            (shipment.status === 'rto' || (shipment.status && shipment.status.startsWith('rto_')) || shipment.status === 'untrackable') &&
            ['shipped', 'in_transit', 'out_for_delivery'].includes(newStatus)
        ) {
            // Self-healing a false/transient RTO (or a lost parcel that was
            // found again): the shipment resumed forward movement, so mirror
            // that back onto the orders row too — otherwise the hub would
            // still show the order under the RTO / Untrackable pill.
            await dbAdapter.query(
                `UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                [newStatus, shipment.order_id, shipment.awb]
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

// Post-transition side effects, shared by the cron sync (syncShipment) and
// the on-demand admin "Refresh tracking" path (shippingService.trackShipment).
// Without this, a manual refresh on a healed false RTO would update the
// shipments row but leave orders stuck at rto_* (e.g. #64600, #64697, #64729)
// and skip the Zoho COD/credit-note reconciliation + OFD WhatsApp template.
async function applyTransitionSideEffects(shipment, newStatus, opts = {}) {
    const { expectedDelivery = null, deliveredAt = null, carrierStatusText = '' } = opts;
    await syncOrderRowStatus(shipment, newStatus, expectedDelivery, deliveredAt);
    if (carrierStatusText) {
        console.log(`📦 Shipment #${shipment.id} (${shipment.order_id}, AWB ${shipment.awb}): ${shipment.status} → ${newStatus} [carrier: "${carrierStatusText}"]`);
    }

    // Zoho middleware hook — auto COD reconciliation + RTO credit notes
    const isRtoVariantInner = (status) => status === 'rto' || (status && status.startsWith('rto_'));
    if (newStatus === 'delivered' || isRtoVariantInner(newStatus)) {
        try {
            require('./zohoShipmentHook').onShipmentTerminal(shipment, newStatus, deliveredAt)
                .catch(e => console.warn(`⚠️ Zoho shipment hook failed for ${shipment.order_id}:`, e.message));
        } catch (hookErr) {
            console.warn(`⚠️ Zoho shipment hook unavailable:`, hookErr.message);
        }
    }

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
}

// Sync one shipment against its carrier. Returns true if the status changed.
//
// `touchQueue`: when the caller passes an array, unchanged rows are NOT written
// one-by-one — their ids are collected so the batch loop can flush a single
// UPDATE for the whole pass (previously that was one round trip per row).
async function syncShipment(shipment, touchQueue = null) {
    const adapter = getAdapter(shipment.carrier);
    if (!adapter || !shipment.awb) return false;

    const result = await adapter.track(shipment.awb);
    let carrierStatus = result.success ? result.data.currentStatus : null;
    let carrierStatusType = result.success ? result.data.statusType : null;
    let expectedDelivery = result.success ? result.data.expectedDelivery : null;
    let mapped = mapCarrierStatus(carrierStatus, carrierStatusType);

    // Shiprocket fallback: fresh AWBs often have zero scans, so AWB tracking
    // says nothing while the order-level status already shows "PICKUP
    // SCHEDULED" / "PICKED UP". Use that so Ready to Ship drains properly.
    // IMPORTANT: this fallback uses the ORDER-level status which can be stale
    // (e.g. "RTO Initiated" from a temporary NDR that has since resolved).
    // Only accept non-terminal statuses from the fallback — never let it
    // mark a shipment as RTO or cancelled.
    if (!mapped && shipment.carrier === 'shiprocket') {
        try {
            const shiprocketService = require('./shiprocketService');
            const srOrder = await shiprocketService.getOrderStatus(shipment.carrier_order_id || shipment.order_id);
            if (srOrder && srOrder.status) {
                carrierStatus = String(srOrder.status);
                const fallbackMapped = mapCarrierStatus(carrierStatus, null);
                // Only accept the fallback if it's a non-terminal status;
                // terminal statuses (any RTO variant, cancelled) must come
                // from the tracking API, not the stale order-level status.
                // NOTE: check the 'rto' prefix, not just 'rto' exactly —
                // 'RTO Initiated'/'RTO Acknowledged'/'RTO NDR' map to
                // rto_initiated and 'RTO Delivered' maps to rto_delivered,
                // and those froze in-transit parcels (e.g. order #64247).
                if (fallbackMapped && !String(fallbackMapped).startsWith('rto') && fallbackMapped !== 'cancelled') {
                    mapped = fallbackMapped;
                    if (!expectedDelivery) expectedDelivery = srOrder.expectedDelivery || null;
                }
            }
        } catch (error) {
            console.warn(`⚠️ Shiprocket order-status fallback failed for ${shipment.order_id}:`, error.message);
        }
    }

    const newStatus = resolveTransition(shipment.status, mapped);

    // Always bump updated_at so unchanged shipments rotate to the back of the queue
    if (!newStatus) {
        if (touchQueue) touchQueue.push(shipment.id);
        else await dbAdapter.update('shipments', { updated_at: new Date().toISOString() }, { id: shipment.id });
        return false;
    }

    const deliveredAt = newStatus === 'delivered' ? extractDeliveredAt(result) : null;

    await dbAdapter.update('shipments', {
        status: newStatus,
        updated_at: new Date().toISOString(),
        ...(deliveredAt ? { delivered_at: deliveredAt } : {})
    }, { id: shipment.id });

    await applyTransitionSideEffects(shipment, newStatus, {
        expectedDelivery,
        deliveredAt,
        carrierStatusText: carrierStatus
    });

    return true;
}

/**
 * Rotate a pass's unchanged rows to the back of the queue in ONE statement.
 *
 * Every poll must bump updated_at or the oldest-first rotation stops moving,
 * which used to cost one round trip per unchanged row (the vast majority of a
 * sweep). Chunked at 500 so a future larger cap can't hit PostgreSQL's 65535
 * bind-parameter limit.
 */
async function touchShipments(ids) {
    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        await dbAdapter.query(
            `UPDATE shipments SET updated_at = CURRENT_TIMESTAMP WHERE id IN (${chunk.map(() => '?').join(', ')})`,
            chunk
        );
    }
}

/**
 * Poll the carrier for a batch of shipments and apply status updates.
 *
 * Two INDEPENDENT budgets, deliberately:
 *  • the active pipeline rotates oldest-synced-first, exactly as before;
 *  • recoverable RTO rows (inside the self-heal window, bounded by immutable
 *    created_at) get their OWN LIMIT, so a large active backlog can never
 *    starve them.
 *
 * Why the split: when both shared one 100-row queue, the ~1,870 active rows
 * dominated it and the ~270 in-window RTO rows were only rechecked once per
 * full rotation (~10.7 h). A transient RTO scan therefore kept a still-moving
 * parcel in the hub's RTO section for most of a day — #64693 sat there 9h16m
 * before healing, and ops kept seeing in-transit parcels under RTO. With its
 * own budget the RTO set is drained roughly every 2-3 cycles (~80 min), so a
 * false RTO clears while ops are still looking at it.
 *
 * Both passes are pure updated_at ASC: every poll bumps updated_at, so rows
 * that did not change rotate to the back and a larger set than the budget
 * still gets full coverage over consecutive cycles (no starvation either way).
 */
async function syncActiveShipments({ limit = 60, rtoLimit = null } = {}) {
    if (isRunning) return { skipped: true, reason: 'sync already in progress', checked: 0, updated: 0 };
    isRunning = true;

    try {
        const activeCap = Math.min(parseInt(limit) || 60, 200);
        // 0 disables the self-heal pass (useful for a pure pipeline refresh).
        const rtoCap = rtoLimit === 0
            ? 0
            : Math.min(parseInt(rtoLimit) || activeCap, 400);

        const activePlaceholders = ACTIVE_STATUSES.map(() => '?').join(', ');
        const rtoPlaceholders = RTO_RECHECK_STATUSES.map(() => '?').join(', ');

        // One pass = fetch, poll, flush. Results are released between passes so
        // peak heap holds a single result set rather than both at once.
        const runPass = async (sql, params) => {
            const rows = await dbAdapter.query(sql, params);
            const touches = [];
            let changed = 0;
            try {
                for (let i = 0; i < rows.length; i++) {
                    const shipment = rows[i];
                    try {
                        if (await syncShipment(shipment, touches)) changed++;
                    } catch (error) {
                        console.error(`⚠️ Status sync failed for shipment #${shipment.id} (AWB ${shipment.awb}):`, error.message);
                    }
                    if (i < rows.length - 1) await sleep(PER_CALL_DELAY_MS);
                }
            } finally {
                // Flush even if the loop above throws, otherwise those rows
                // keep the oldest updated_at and would be picked forever.
                await touchShipments(touches);
            }
            return { checked: rows.length, updated: changed };
        };

        const active = await runPass(`
            SELECT ${SYNC_COLUMNS} FROM shipments
            WHERE awb IS NOT NULL AND awb <> ''
              AND status IN (${activePlaceholders})
            ORDER BY updated_at ASC NULLS FIRST
            LIMIT ?
        `, [...ACTIVE_STATUSES, activeCap]);

        // Self-heal pass. rto_delivered is deliberately excluded from
        // RTO_RECHECK_STATUSES — a settled return can never move forward again.
        const rto = rtoCap > 0
            ? await runPass(`
                SELECT ${SYNC_COLUMNS} FROM shipments
                WHERE awb IS NOT NULL AND awb <> ''
                  AND status IN (${rtoPlaceholders})
                  AND created_at > NOW() - (? || ' days')::interval
                ORDER BY updated_at ASC NULLS FIRST
                LIMIT ?
            `, [...RTO_RECHECK_STATUSES, String(RTO_RECHECK_DAYS), rtoCap])
            : { checked: 0, updated: 0 };

        const checked = active.checked + rto.checked;
        const updated = active.updated + rto.updated;

        if (updated > 0 && caches && caches.shoppers) {
            caches.shoppers.clear();
            console.log('🗑️ Cache invalidated: shoppers (shipment status sync)');
        }

        lastRunAt = new Date();
        if (checked > 0) {
            console.log(`🔄 Shipment status sync: checked ${checked} (${active.checked} active + ${rto.checked} RTO recheck), updated ${updated}`);
        }
        return { checked, activeChecked: active.checked, rtoChecked: rto.checked, updated };
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
    syncOrderRowStatus,
    applyTransitionSideEffects,
    getLastRunAt
};
