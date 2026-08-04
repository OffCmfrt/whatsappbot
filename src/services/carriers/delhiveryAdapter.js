/**
 * Delhivery Express API adapter (direct integration).
 *
 * Env vars:
 *   DELHIVERY_API_TOKEN      — API token from Delhivery One dashboard
 *                              (DELHIVERY_API_KEY is also accepted as an alias)
 *   DELHIVERY_PICKUP_LOCATION — registered warehouse/pickup location name (exact match)
 *   DELHIVERY_ENV            — 'staging' or 'production' (default: production)
 *
 * Endpoints used:
 *   Serviceability : GET  /c/api/pin-codes/json/?filter_codes={pin}
 *   Reuse synced   : GET  /api/v1/packages/json/?ref_ids={order id}
 *                    (Shopify-integrated orders are already synced to the
 *                    Delhivery panel under the Shopify channel — we only
 *                    reuse their waybill, never create a duplicate via CMU)
 *   Packing slip   : GET  /api/p/packing_slip?wbns={awb}&pdf=true
 *   Pickup request : POST /fm/request/new/
 *   Cancel         : POST /api/p/edit  ({ waybill, cancellation: 'true' })
 *   Tracking       : GET  /api/v1/packages/json/?waybill={awb}
 */

const axios = require('axios');
const BaseCarrier = require('./baseCarrier');

class DelhiveryAdapter extends BaseCarrier {
    constructor() {
        super('delhivery', 'Delhivery');
    }

    get baseURL() {
        return (process.env.DELHIVERY_ENV || 'production') === 'staging'
            ? 'https://staging-express.delhivery.com'
            : 'https://track.delhivery.com';
    }

    get capabilities() {
        return {
            ...super.capabilities,
            needsCourierSelection: false // Delhivery ships on its own network
        };
    }

    get apiToken() {
        return process.env.DELHIVERY_API_TOKEN || process.env.DELHIVERY_API_KEY;
    }

    isConfigured() {
        return Boolean(this.apiToken && process.env.DELHIVERY_PICKUP_LOCATION);
    }

    authHeaders() {
        return {
            'Authorization': `Token ${this.apiToken}`,
            'Accept': 'application/json'
        };
    }

    // Check destination pincode serviceability (prepaid / COD / pickup flags)
    async checkServiceability(ctx) {
        try {
            const pin = this.normalizePincode(ctx.consignee.pincode);
            if (!pin) return this.fail('Invalid delivery pincode (must be 6 digits)');

            const response = await axios.get(`${this.baseURL}/c/api/pin-codes/json/`, {
                headers: this.authHeaders(),
                params: { filter_codes: pin },
                timeout: 15000
            });

            const entry = response.data?.delivery_codes?.[0]?.postal_code;
            if (!entry) {
                return this.ok({ serviceable: false, reason: `Pincode ${pin} is not serviceable by Delhivery` }, response.data);
            }

            const codAvailable = entry.cod === 'Y' || entry.cash === 'Y';
            const prepaidAvailable = entry.pre_paid === 'Y';
            const isCod = ctx.payment.mode === 'COD';
            const serviceable = isCod ? codAvailable : prepaidAvailable;

            return this.ok({
                serviceable,
                reason: serviceable ? null : `Pincode ${pin} does not support ${ctx.payment.mode} with Delhivery`,
                codAvailable,
                prepaidAvailable,
                pickupAvailable: entry.pickup === 'Y',
                city: entry.city || null,
                state: entry.state_code || null,
                // Direct carrier — single "courier" option so the UI can render uniformly
                couriers: [{
                    courierId: 'delhivery',
                    courierName: 'Delhivery Surface',
                    rate: null,
                    etd: null,
                    rating: null
                }]
            }, response.data);
        } catch (error) {
            return this.fail(`Delhivery serviceability failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    // Find the order Delhivery already synced from the Shopify channel.
    // Best-effort lookup by client reference (= our order id); package list
    // shape varies by account tier, so several field spellings are tried.
    async findSyncedOrder(orderId) {
        const bare = String(orderId).replace(/^#/, '').trim();
        const normalize = v => String(v ?? '').replace(/^#/, '').trim().toLowerCase();

        for (const candidate of [...new Set([bare, `#${bare}`])]) {
            try {
                const response = await axios.get(`${this.baseURL}/api/v1/packages/json/`, {
                    headers: this.authHeaders(),
                    params: { ref_ids: candidate, size: 10 },
                    timeout: 20000
                });

                const pkgs = response.data?.ShipmentData || response.data?.shipments || [];
                const list = (Array.isArray(pkgs) ? pkgs : [pkgs]).filter(Boolean);

                // Skip closed packages (cancelled ones especially — a re-ship
                // must never resurrect the old waybill)
                const isClosed = p => /cancel/i.test(String(p?.status || p?.Shipment?.Status?.Status || ''));
                const open = list.filter(p => !isClosed(p));

                // Prefer an exact reference match; when the tier's payload
                // carries no ref field, accept the hit (the search was
                // already scoped to this reference)
                const match = (open.length ? open : list).find(p => {
                    const ref = p?.refnum || p?.RefNum || p?.client_reference_number ||
                        p?.Shipment?.refnum || p?.Shipment?.RefNum;
                    return !ref || normalize(ref) === normalize(bare);
                });
                if (!match) continue;

                const awb = match.waybill || match.Waybill ||
                    match.Shipment?.Waybill || match.Shipment?.waybill;
                return { awb: awb ? String(awb) : null, raw: match };
            } catch (error) {
                console.warn(`⚠️ Delhivery: synced-order lookup for "${candidate}" failed (${this.describeAxiosError(error)})`);
            }
        }
        return null;
    }

    // Ship orders ONLY via the Shopify channel — i.e. the order Delhivery
    // already synced from the Shopify integration. Direct CMU creation is
    // disabled: it files orders outside the Shopify channel and duplicates
    // anything the integration has already synced.
    async createShipment(ctx) {
        // --- Route 1: reuse the order Delhivery synced from Shopify ---
        const synced = await this.findSyncedOrder(ctx.orderId);

        if (synced?.awb) {
            console.log(`📦 Delhivery: reusing Shopify-synced order ${ctx.orderId} (existing waybill ${synced.awb})`);
            return this.ok({
                awb: synced.awb,
                courierName: 'Delhivery',
                carrierShipmentId: synced.awb,
                carrierOrderId: ctx.orderId,
                freightCharge: null,
                trackingUrl: `https://www.delhivery.com/track/package/${synced.awb}`,
                reusedSyncedOrder: true,
                requestPayload: { orderId: ctx.orderId, source: 'shopify_synced_order' }
            }, synced.raw);
        }

        if (synced) {
            return this.fail(
                `Order ${ctx.orderId} exists at Delhivery but has no waybill yet — generate the shipment in the Delhivery panel, then ship again.`
            );
        }

        // --- Not synced: refuse instead of creating directly (CMU disabled) ---
        return this.fail(
            `Order ${ctx.orderId} was not found at Delhivery. Delhivery ships only under the Shopify channel — ` +
            'the order must be synced via the Shopify–Delhivery integration first (direct CMU creation is disabled).'
        );
    }

    // Packing slip / label PDF link (4R = 4x6 inch thermal label format)
    async generateLabel(shipment) {
        try {
            const response = await axios.get(`${this.baseURL}/api/p/packing_slip`, {
                headers: this.authHeaders(),
                params: { wbns: shipment.awb, pdf: 'true', pdf_size: '4R' },
                timeout: 20000
            });

            const pkg = response.data?.packages?.[0];
            const labelUrl = pkg?.pdf_download_link || pkg?.pdf_link;
            if (!labelUrl) {
                return this.fail('Delhivery did not return a label link (shipment may not be manifested yet)', response.data);
            }
            return this.ok({ labelUrl }, response.data);
        } catch (error) {
            return this.fail(`Delhivery label generation failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    // First-mile pickup request for the registered warehouse
    async schedulePickup(shipment, pickupDate) {
        try {
            const payload = {
                pickup_location: process.env.DELHIVERY_PICKUP_LOCATION,
                pickup_date: pickupDate, // YYYY-MM-DD
                pickup_time: '11:00:00',
                expected_package_count: 1
            };

            const response = await axios.post(`${this.baseURL}/fm/request/new/`, payload, {
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                timeout: 20000
            });

            const pickupId = response.data?.pickup_id || response.data?.pr_exist_id || null;
            return this.ok({
                pickupDate,
                pickupToken: pickupId ? String(pickupId) : null
            }, response.data);
        } catch (error) {
            return this.fail(`Delhivery pickup request failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    // Cancel — POST /api/p/edit { waybill, cancellation: 'true' }
    //
    // Delhivery only allows cancellation while the package is Manifested /
    // In Transit / Pending / Open / Scheduled. Anything already closed at their
    // end (cancelled, delivered, RTO) comes back as HTTP 200 with status false
    // and the reason in one of several fields — always logged raw, because a
    // rejection here is what blocks a re-ship.
    async cancelShipment(shipment) {
        if (!shipment.awb) return this.fail('Delhivery cancellation failed: shipment has no AWB on record');

        try {
            const response = await axios.post(`${this.baseURL}/api/p/edit`, {
                waybill: String(shipment.awb),
                cancellation: 'true'
            }, {
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                timeout: 20000
            });

            // Delhivery is inconsistent here: boolean false, "false", "Failure"...
            const status = response.data?.status;
            const rejected = status === false || (typeof status === 'string' && /^(false|fail|failure|error)/i.test(status.trim()));

            if (rejected) {
                const reason = this.extractReason(response.data);
                console.error(`❌ Delhivery cancel rejected for AWB ${shipment.awb}:`, JSON.stringify(response.data || {}).substring(0, 500));

                // Already cancelled on their side → the goal is met, so don't
                // dead-end the caller (re-ship) over a duplicate request
                if (/already\s+(been\s+)?cancell?ed|cancell?ed\s+already/i.test(reason)) {
                    return this.ok({ cancelled: true, warning: `Already cancelled at Delhivery: ${reason}` }, response.data);
                }
                return this.fail(`Delhivery cancellation rejected: ${reason}`, response.data);
            }

            console.log(`📦 Delhivery cancel accepted for AWB ${shipment.awb}:`, JSON.stringify(response.data || {}).substring(0, 300));
            return this.ok({ cancelled: true }, response.data);
        } catch (error) {
            return this.fail(`Delhivery cancellation failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    // Normalized tracking timeline (newest first)
    async track(awb) {
        try {
            const response = await axios.get(`${this.baseURL}/api/v1/packages/json/`, {
                headers: this.authHeaders(),
                params: { waybill: awb },
                timeout: 20000
            });

            const shipmentData = response.data?.ShipmentData?.[0]?.Shipment;
            if (!shipmentData) return this.fail('No tracking data found for this AWB', response.data);

            const scans = (shipmentData.Scans || []).map(s => {
                const detail = s.ScanDetail || s;
                return {
                    date: detail.ScanDateTime || detail.StatusDateTime || '',
                    location: detail.ScannedLocation || detail.CityLocation || '',
                    activity: detail.Instructions || detail.Scan || '',
                    status: detail.Scan || detail.ScanType || ''
                };
            }).reverse();

            return this.ok({
                currentStatus: shipmentData.Status?.Status || 'Unknown',
                expectedDelivery: shipmentData.ExpectedDeliveryDate || null,
                timeline: scans
            }, response.data);
        } catch (error) {
            return this.fail(`Delhivery tracking failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }
}

module.exports = new DelhiveryAdapter();
