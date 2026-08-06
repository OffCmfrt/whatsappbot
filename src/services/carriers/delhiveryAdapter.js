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
 *                    (orders that already have a Delhivery waybill are
 *                    reused — their AWB is adopted, never duplicated)
 *   Direct create  : POST /api/cmu/create.json
 *                    (fallback when no waybill exists yet — e.g. Shopify
 *                    channel orders sitting at "Pending AWB" in the panel)
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

    // Find an existing Delhivery package for this order.
    // Returns:
    //   { awb }           — a live (non-closed) waybill was found
    //   null              — lookup succeeded, no adoptable package exists
    //   { lookupError }   — the lookup itself failed; callers MUST fail closed
    //                       (creating on an errored lookup risks a duplicate
    //                       consignment for an order that already has an AWB)
    async findSyncedOrder(orderId) {
        const bare = String(orderId).replace(/^#/, '').trim();
        const normalize = v => String(v ?? '').replace(/^#/, '').trim().toLowerCase();
        let lastError = null;

        for (const candidate of [...new Set([bare, `#${bare}`])]) {
            try {
                lastError = null; // a successful request clears prior failures
                const response = await axios.get(`${this.baseURL}/api/v1/packages/json/`, {
                    headers: this.authHeaders(),
                    params: { ref_ids: candidate, size: 10 },
                    timeout: 20000
                });

                const pkgs = response.data?.ShipmentData || response.data?.shipments || [];
                const list = (Array.isArray(pkgs) ? pkgs : [pkgs]).filter(Boolean);

                // Only live packages are adoptable — a cancelled / delivered /
                // RTO waybill must never be resurrected (re-ships need a fresh
                // AWB, so those orders fall through to direct creation)
                const isClosed = p => /cancel|deliver|rto|return/i.test(String(p?.status || p?.Shipment?.Status?.Status || ''));
                const open = list.filter(p => !isClosed(p));
                if (!open.length) continue;

                // Prefer an exact reference match; when the tier's payload
                // carries no ref field, accept the hit (the search was
                // already scoped to this reference)
                const match = open.find(p => {
                    const ref = p?.refnum || p?.RefNum || p?.client_reference_number ||
                        p?.Shipment?.refnum || p?.Shipment?.RefNum || p?.Shipment?.ReferenceNo;
                    return !ref || normalize(ref) === normalize(bare);
                });
                if (!match) continue;

                const awb = match.waybill || match.Waybill ||
                    match.Shipment?.AWB || match.Shipment?.Waybill || match.Shipment?.waybill;
                return { awb: awb ? String(awb) : null, raw: match };
            } catch (error) {
                lastError = this.describeAxiosError(error);
                console.warn(`⚠️ Delhivery: synced-order lookup for "${candidate}" failed (${lastError})`);
            }
        }
        // All candidates errored → we cannot rule out an existing waybill;
        // signal the failure instead of pretending the slot is empty
        if (lastError) return { lookupError: lastError };
        return null;
    }

    // Ship the order at Delhivery:
    //   Route 1 — adopt the waybill when the order already has one (panel or
    //             any other channel); never create a duplicate in that case.
    //   Route 2 — create the consignment directly via CMU. Shopify-channel
    //             imports land at "Pending AWB" in the panel without a
    //             waybill, so this is the path that actually gets AWBs for
    //             them (equivalent of the panel's "Get AWB Number" button).
    async createShipment(ctx) {
        // --- Route 1: reuse an existing Delhivery waybill for this order ---
        const synced = await this.findSyncedOrder(ctx.orderId);

        // Fail closed: if we couldn't verify whether a waybill already exists,
        // creating risks a duplicate consignment (double freight / double COD)
        if (synced?.lookupError) {
            return this.fail(
                `Could not verify existing Delhivery waybills for order ${ctx.orderId} (${synced.lookupError}). ` +
                'Refusing to create to avoid a duplicate — please retry.'
            );
        }

        if (synced?.awb) {
            // Never adopt an AWB we already closed locally — Delhivery's
            // tracking feed can still report it as live (stale status)
            const closedAwbs = ctx.meta?.closedAwbs || [];
            if (closedAwbs.includes(String(synced.awb))) {
                console.log(`📦 Delhivery: skipping locally-closed AWB ${synced.awb} for order ${ctx.orderId} — creating a fresh consignment`);
                return this.createDirectShipment(ctx, synced);
            }

            console.log(`📦 Delhivery: reusing existing waybill ${synced.awb} for order ${ctx.orderId}`);
            return this.ok({
                awb: synced.awb,
                courierName: 'Delhivery',
                carrierShipmentId: synced.awb,
                carrierOrderId: ctx.orderId,
                freightCharge: null,
                trackingUrl: `https://www.delhivery.com/track/package/${synced.awb}`,
                reusedSyncedOrder: true,
                requestPayload: { orderId: ctx.orderId, source: 'existing_waybill' }
            }, synced.raw);
        }

        // --- Route 2: no waybill anywhere — create the consignment directly ---
        return this.createDirectShipment(ctx, synced);
    }

    // CMU consignment creation (form-encoded: format=json&data={...}).
    // Delhivery assigns the AWB synchronously in the response.
    async createDirectShipment(ctx, existingPanelOrder = null) {
        const isCod = ctx.payment.mode === 'COD';
        const codAmount = Number(ctx.payment.codAmount) || 0;
        const declared = Number(ctx.payment.declaredValue) || codAmount || 0;

        if (isCod && !(codAmount > 0)) {
            return this.fail('COD amount must be greater than 0 for COD shipments');
        }

        const pin = this.normalizePincode(ctx.consignee.pincode);
        const phone = this.normalizePhone(ctx.consignee.phone);
        const weightKg = Math.max(0.1, Math.round((Number(ctx.package.weightGrams) || 500) / 100) / 10);
        const totalQty = (ctx.items || []).reduce((n, i) => n + (i.quantity || 1), 0) || 1;
        const orderId = String(ctx.orderId).replace(/^#/, '');

        const consignment = {
            name: ctx.consignee.name,
            add: ctx.consignee.address,
            pin,
            city: ctx.consignee.city,
            state: ctx.consignee.state,
            country: ctx.consignee.country || 'India',
            phone,
            order: orderId,
            payment_mode: isCod ? 'COD' : 'Prepaid',
            shipping_mode: 'Pickup',
            // What the label + panel show — names with sizes ("WAFFLE - 001 (M) x1")
            products_desc: this.formatProductsDesc(ctx.items),
            // Return leg = registered warehouse (same as the panel default)
            return_name: process.env.DELHIVERY_RETURN_NAME || process.env.EKART_SELLER_NAME || 'Offcomfrt',
            return_add: process.env.DELHIVERY_RETURN_ADDRESS || process.env.EKART_SELLER_ADDRESS || '',
            return_pin: process.env.DELHIVERY_RETURN_PIN || '123001',
            return_city: process.env.DELHIVERY_RETURN_CITY || 'Narnaul',
            return_state: process.env.DELHIVERY_RETURN_STATE || 'Haryana',
            return_country: 'India',
            return_phone: process.env.DELHIVERY_RETURN_PHONE || phone,
            // GSTIN is mandatory on the label per GST compliance
            seller_tin_gst: process.env.DELHIVERY_SELLER_GSTIN || process.env.EKART_SELLER_GST_TIN,
            seller_gst_cst_tin: process.env.DELHIVERY_SELLER_GSTIN || process.env.EKART_SELLER_GST_TIN,
            total_amount: String(isCod ? codAmount : declared),
            collectable_amount: String(isCod ? codAmount : 0),
            cod_amount: String(isCod ? codAmount : 0),
            // CMU wants strings; weight in kg, dimensions in cm under the
            // shipment_* keys (plain height/breadth/length are ignored)
            weight: String(weightKg),
            quantity: String(totalQty),
            shipment_length: String(ctx.package.lengthCm || 30),
            shipment_width: String(ctx.package.breadthCm || 40),
            shipment_height: String(ctx.package.heightCm || 2),
            products: (ctx.items && ctx.items.length ? ctx.items : [{ name: 'Apparel', sku: 'SKU', price: declared, quantity: 1 }]).map(item => ({
                sku: item.sku || 'SKU',
                name: `${item.name}${item.size ? ` (${item.size})` : ''}`.substring(0, 100),
                order: orderId,
                price: Number(item.price) || 0,
                quantity: item.quantity || 1,
                hsn: '6109' // apparel default
            }))
        };

        const cmuPayload = {
            shipments: [consignment],
            // Registers the pickup against the warehouse — without it the
            // panel shows "Pickup address: null"
            pickup_location: { name: process.env.DELHIVERY_PICKUP_LOCATION }
        };

        const requestPayload = new URLSearchParams({
            format: 'json',
            data: JSON.stringify(cmuPayload)
        });

        try {
            const response = await axios.post(`${this.baseURL}/api/cmu/create.json`, requestPayload.toString(), {
                headers: { ...this.authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 30000
            });

            // HTTP 200 can still be a per-package failure — inspect the package
            const pkg = response.data?.packages?.[0];
            const awb = pkg?.waybill ? String(pkg.waybill) : '';

            if (!response.data?.success || !awb || /fail/i.test(String(pkg?.status || ''))) {
                const reason = this.extractReason(response.data);
                console.error(`❌ Delhivery CMU create rejected for order ${orderId}:`, JSON.stringify(response.data || {}).substring(0, 600));
                return this.fail(`Delhivery rejected the shipment: ${reason}`, response.data);
            }

            console.log(`📦 Delhivery: created consignment for order ${orderId} (AWB ${awb}${existingPanelOrder ? ', panel order without waybill existed' : ''})`);
            return this.ok({
                awb,
                courierName: 'Delhivery',
                carrierShipmentId: awb,
                carrierOrderId: orderId,
                freightCharge: null,
                trackingUrl: `https://www.delhivery.com/track/package/${awb}`,
                reusedSyncedOrder: false,
                requestPayload: { orderId, source: 'direct_cmu_create', consignment }
            }, response.data);
        } catch (error) {
            return this.fail(`Delhivery shipment creation failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
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
