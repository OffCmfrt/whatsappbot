/**
 * Shiprocket adapter — ships via the Shiprocket aggregator (Delhivery, BlueDart,
 * Xpressbees, Ekart etc. selectable per-shipment via courier serviceability).
 *
 * Env vars:
 *   SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD — existing bot credentials (token reuse)
 *   SHIPROCKET_PICKUP_LOCATION             — registered pickup location nickname
 *   SHIPROCKET_PICKUP_PINCODE              — OPTIONAL. Auto-resolved from the pickup
 *                                            location via the API; only needed as an override.
 *   SHIPROCKET_CHANNEL_ID                  — OPTIONAL. Channel to file orders under (e.g. Shopify).
 *                                            Auto-resolved to the Shopify channel via GET /channels;
 *                                            only needed as an override.
 *
 * Endpoints used:
 *   Channels       : GET  /channels
 *   Serviceability : GET  /courier/serviceability/
 *   Reuse synced   : GET  /orders?search=<id> (Shopify-integrated orders are
 *                    already synced under the Shopify channel — we only assign
 *                    an AWB to them, never create a duplicate)
 *   Update order   : POST /orders/update/{order_id} (pins the fixed package
 *                    weight/dimensions onto synced orders — Shopify sync sizes
 *                    them from line items, so they'd drift with item count)
 *   Create order   : POST /orders/create (channel-specific, only for orders
 *                    not yet synced) — orders are NEVER filed under "Custom"
 *   Assign AWB     : POST /courier/assign/awb
 *   Label          : POST /courier/generate/label
 *   Pickup         : POST /courier/generate/pickup
 *   Manifest       : POST /manifests/generate
 *   Invoice        : POST /orders/print/invoice
 *   Cancel         : POST /orders/cancel
 *   Tracking       : GET  /courier/track/awb/{awb} (via shiprocketService)
 */

const axios = require('axios');
const BaseCarrier = require('./baseCarrier');
const shiprocketService = require('../shiprocketService');

class ShiprocketAdapter extends BaseCarrier {
    constructor() {
        super('shiprocket', 'Shiprocket');
        this.baseURL = shiprocketService.baseURL;
        this._pickupPincode = null; // cached after first lookup
        this._channelId = null;     // cached after first lookup
        this._channels = [];        // full channel list, cached by resolveChannelId
    }

    get capabilities() {
        return {
            ...super.capabilities,
            needsCourierSelection: true,
            supportsManifest: true,
            supportsInvoice: true
        };
    }

    isConfigured() {
        return Boolean(
            (process.env.SHIPROCKET_EMAIL && process.env.SHIPROCKET_PASSWORD) &&
            process.env.SHIPROCKET_PICKUP_LOCATION
        );
    }

    async authHeaders() {
        await shiprocketService.ensureAuthenticated();
        return {
            'Authorization': `Bearer ${shiprocketService.token}`,
            'Content-Type': 'application/json'
        };
    }

    // Resolve the pickup warehouse pincode from its registered nickname.
    // Uses SHIPROCKET_PICKUP_PINCODE as an override when explicitly set; otherwise
    // looks it up once from /settings/company/pickup and caches the result.
    async resolvePickupPincode() {
        if (process.env.SHIPROCKET_PICKUP_PINCODE) return process.env.SHIPROCKET_PICKUP_PINCODE;
        if (this._pickupPincode) return this._pickupPincode;

        const headers = await this.authHeaders();
        const response = await axios.get(`${this.baseURL}/settings/company/pickup`, {
            headers,
            timeout: 20000
        });

        const addresses = response.data?.data?.shipping_address || [];
        const wanted = (process.env.SHIPROCKET_PICKUP_LOCATION || '').trim().toLowerCase();
        const match = addresses.find(a => (a.pickup_location || '').trim().toLowerCase() === wanted);
        const pin = match?.pin_code;
        if (!pin) {
            const names = addresses.map(a => a.pickup_location).join(', ') || 'none';
            throw new Error(`Pickup location "${process.env.SHIPROCKET_PICKUP_LOCATION}" not found in Shiprocket (available: ${names})`);
        }
        this._pickupPincode = String(pin);
        return this._pickupPincode;
    }

    // Resolve the channel to file orders under so they don't land in "Custom".
    // Uses SHIPROCKET_CHANNEL_ID as an override when explicitly set; otherwise
    // looks up the Shopify channel once from /channels and caches the result.
    async resolveChannelId() {
        if (process.env.SHIPROCKET_CHANNEL_ID) return process.env.SHIPROCKET_CHANNEL_ID;
        if (this._channelId) return this._channelId;

        try {
            const headers = await this.authHeaders();
            const response = await axios.get(`${this.baseURL}/channels`, {
                headers,
                timeout: 20000
            });

            const channels = response.data?.data || [];
            this._channels = channels; // cached for custom-channel detection later
            const isCustom = c => (c.base_channel_code || '').toUpperCase() === 'CS' || /custom/i.test(c.name || '');
            // Prefer an explicit Shopify match; otherwise fall back to the first
            // non-custom channel (Shopify channels are often named after the store)
            const shopify = channels.find(c =>
                (c.base_channel_code || '').toUpperCase() === 'SH' ||
                /shopify/i.test(c.name || '') ||
                /shopify/i.test(c.base_channel_code || '')
            ) || channels.find(c => !isCustom(c));
            if (shopify?.id) {
                this._channelId = String(shopify.id);
                console.log(`📦 Shiprocket: filing orders under channel "${shopify.name}" (id ${this._channelId})`);
                return this._channelId;
            }
            const names = channels.map(c => `${c.name} (${c.id})`).join(', ') || 'none';
            console.warn(`⚠️ Shiprocket: no Shopify channel found (available: ${names}); orders will use the default (Custom) channel`);
        } catch (error) {
            console.warn(`⚠️ Shiprocket: channel lookup failed (${this.describeAxiosError(error)}); orders will use the default (Custom) channel`);
        }
        return null;
    }

    // Find the order that Shiprocket already synced from the Shopify channel.
    // When the Shopify integration is active, orders land in Shiprocket under
    // the Shopify channel automatically — creating another one via the API is
    // rejected (or worse, duplicates it under Custom), so we reuse this row
    // and only assign an AWB to it.
    async findSyncedOrder(headers, orderId, channelId) {
        // Shopify order names carry a "#" prefix; our rows usually don't.
        // Search every plausible spelling of the same order number.
        const bare = String(orderId).replace(/^#/, '').trim();
        const candidates = [...new Set([bare, `#${bare}`])];

        const normalize = v => String(v ?? '').replace(/^#/, '').trim().toLowerCase();

        for (const candidate of candidates) {
            try {
                const response = await axios.get(`${this.baseURL}/orders`, {
                    headers,
                    params: { search: candidate, per_page: 20 },
                    timeout: 20000
                });

                const orders = response.data?.data || [];
                const matches = orders.filter(o =>
                    normalize(o.channel_order_id) === normalize(bare) ||
                    normalize(o.order_id) === normalize(bare)
                );
                if (matches.length === 0) continue;

                // Prefer the copy living on the Shopify channel; skip stale
                // duplicates that earlier adhoc runs filed under "Custom"
                const onShopify = matches.find(o => String(o.channel_id) === String(channelId));
                if (onShopify) return onShopify;

                const nonCustom = matches.find(o => !this.isCustomChannelId(o.channel_id));
                if (nonCustom) {
                    console.warn(`⚠️ Shiprocket: order ${bare} matched on channel ${nonCustom.channel_id} (expected ${channelId}) — reusing it anyway`);
                    return nonCustom;
                }
                console.warn(`⚠️ Shiprocket: order ${bare} only exists on the Custom channel — ignoring it so shipping stays on Shopify`);
            } catch (error) {
                console.warn(`⚠️ Shiprocket: synced-order lookup for "${candidate}" failed (${this.describeAxiosError(error)})`);
            }
        }
        return null;
    }

    // True when the cached channel list says this channel id is a "Custom" one
    isCustomChannelId(channelId) {
        const channel = (this._channels || []).find(c => String(c.id) === String(channelId));
        if (!channel) return false; // unknown channel — don't exclude on guesswork
        return (channel.base_channel_code || '').toUpperCase() === 'CS' || /custom/i.test(channel.name || '');
    }

    // Extract the package weight (kg) from an order payload. Shiprocket's API
    // shape changed: the AWB check reads the SHIPMENT-level weight, which the
    // Shopify sync pre-populates — while `others.weight` can stay 0 forever.
    // So shipment weights are checked first. Returns null when no weight
    // field is present at all.
    extractWeightKg(order) {
        const candidates = [
            ...(Array.isArray(order?.shipments) ? order.shipments.map(s => s?.weight) : []),
            order?.shipments?.weight,
            order?.weight,
            order?.others?.weight
        ];
        for (const raw of candidates) {
            const value = Number(raw);
            if (Number.isFinite(value) && value > 0) return value;
        }
        // All zero/blank — return the first finite value (0) so callers can
        // distinguish "zero" from "unknown"
        for (const raw of candidates) {
            const value = Number(raw);
            if (Number.isFinite(value)) return value;
        }
        return null;
    }

    // Shopify-synced orders carry weight/dimensions computed from the line
    // items, so they drift with item count. The hub ships everything in one
    // fixed package (the shipment draft's), so push it onto the synced order
    // to keep the Shiprocket panel, rates and labels consistent.
    // Best-effort: Shiprocket refuses edits once a shipment is far along —
    // that must never block shipping. NOTE: Shiprocket retired the
    // /orders/update endpoint (now 404); the Shopify sync pre-populates the
    // shipment-level weight that AWB assignment actually checks, so this is
    // cosmetic and must not block when it can't run.
    async enforceFixedPackage(headers, synced, ctx) {
        const desired = {
            length: ctx.package.lengthCm || 30,
            breadth: ctx.package.breadthCm || 40,
            height: ctx.package.heightCm || 2,
            weight: (ctx.package.weightGrams || 500) / 1000 // kg
        };
        const currentWeight = this.extractWeightKg(synced);
        // Dims may live only in a "LxBxH" string (e.g. others.dimensions "30x40x2")
        const dimsStr = String(synced.others?.dimensions || '');
        const [dimL, dimB, dimH] = dimsStr.split(/[x×*]/i).map(v => Number(v));
        const dimsFromStr = dimsStr && [dimL, dimB, dimH].every(Number.isFinite);
        const differs = Object.entries(desired).some(([key, value]) => {
            let current;
            if (key === 'weight') current = currentWeight;
            else if (dimsFromStr) current = { length: dimL, breadth: dimB, height: dimH }[key];
            else current = Number(synced[key] ?? synced.others?.[key]);
            return !Number.isFinite(current) || Math.abs(current - Number(value)) > 0.01;
        });
        if (!differs) return true;

        try {
            await axios.post(`${this.baseURL}/orders/update/${synced.id}`, desired, { headers, timeout: 20000 });
            console.log(`📦 Shiprocket: normalized order ${synced.channel_order_id} package to ${desired.weight} kg / ${desired.length}×${desired.breadth}×${desired.height} cm`);
            return true;
        } catch (error) {
            // 404 = endpoint retired — expected now; weight comes from the
            // Shopify sync. Only warn for anything else.
            if (error.response?.status !== 404) {
                const body = error.response?.data ? ` — ${JSON.stringify(error.response.data).substring(0, 300)}` : '';
                console.warn(`⚠️ Shiprocket: could not normalize order ${synced.channel_order_id} package (${this.describeAxiosError(error)}${body}) — shipping with the synced values`);
            }
            return false;
        }
    }

    // Shiprocket rejects AWB assignment on zero-weight orders ("Zero weight or
    // no weight entered."), and Shopify products without a weight sync across
    // as 0. Returns the order's current weight in kg, or null when it can't
    // be determined.
    async verifyOrderWeight(headers, srOrderId) {
        try {
            const detail = await axios.get(`${this.baseURL}/orders/show/${srOrderId}`, { headers, timeout: 20000 });
            const order = detail.data?.data || detail.data || {};
            // null = no weight field anywhere → can't determine, don't block on it
            return this.extractWeightKg(order);
        } catch (error) {
            console.warn(`⚠️ Shiprocket: could not verify weight for order ${srOrderId} (${this.describeAxiosError(error)})`);
            return null;
        }
    }

    // Extract the Shiprocket shipment id from an order row (shape varies by endpoint)
    extractShipmentId(order) {
        const sid = order?.shipment_id || order?.shipments?.[0]?.shipment_id || order?.shipments?.[0]?.id;
        return sid ? String(sid) : null;
    }

    // Extract an AWB + courier from any order/detail payload (top-level
    // awb_code from listings, or the newest non-cancelled shipment's awb)
    extractAwbFromOrder(order) {
        if (order?.awb_code) {
            return { awb: String(order.awb_code), courierName: order.courier_name || null };
        }
        const shipments = Array.isArray(order?.shipments) ? order.shipments : (order?.shipments ? [order.shipments] : []);
        const usable = shipments
            .filter(sh => sh && (sh.awb || sh.awb_code) && !/CANCEL/i.test(String(sh.status || '')))
            .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
        const hit = usable[0];
        if (hit) return { awb: String(hit.awb || hit.awb_code), courierName: hit.courier_name || hit.courier_company_name || null };
        return null;
    }

    // awb_assign_status: 0 means either "queued (async)" or "courier rejected
    // the waybill". The rejection hides in response.data.packages[].status —
    // e.g. Delhivery's "Shipment restricted based on historical delivery
    // outcomes" RTO-risk block. Surface it so the hub sees the real reason.
    describeAwbFailure(raw) {
        const packages = raw?.response?.data?.packages || [];
        const failed = packages.filter(p => p && /fail/i.test(String(p.status || '')));
        if (failed.length > 0) {
            const remarks = failed.flatMap(p => (Array.isArray(p.remarks) ? p.remarks : [])).join(' | ');
            return `courier rejected the shipment — ${remarks || 'no remarks given'}. Retrying won't help; ship prepaid or contact the courier.`;
        }
        return 'assignment may still be pending at Shiprocket';
    }

    // /courier/assign/awb often answers HTTP 200 with awb_assign_status: 0 —
    // the request was queued and the AWB lands asynchronously a few seconds
    // later. Parse the immediate response first; when it carries no AWB,
    // poll the order detail until one appears (or the budget runs out).
    async assignAwbAndAwait(headers, awbBody, srOrderId, channelOrderId) {
        const awbRes = await axios.post(`${this.baseURL}/courier/assign/awb`, awbBody, { headers, timeout: 30000 });

        const awbData = awbRes.data?.response?.data || awbRes.data?.data || {};
        const immediate = awbData.awb_code || awbRes.data?.awb_code;
        if (immediate) {
            return { awb: String(immediate), courierName: awbData.courier_name || null, raw: awbRes.data };
        }

        // A failed package means the courier already rejected the waybill —
        // the AWB will never land, so skip polling and fail fast.
        const rejected = (awbData.packages || []).some(p => p && /fail/i.test(String(p.status || '')));
        if (rejected) {
            console.warn(`❌ Shiprocket: courier rejected AWB for order ${channelOrderId}: ${this.describeAwbFailure(awbRes.data)}`);
            return { awb: null, raw: awbRes.data };
        }

        const assignStatus = awbRes.data?.response?.awb_assign_status ?? awbRes.data?.awb_assign_status;
        console.log(`⏳ Shiprocket: AWB for order ${channelOrderId} not in assign response (awb_assign_status=${assignStatus}) — polling order detail`);
        for (let attempt = 0; attempt < 3; attempt++) {
            await new Promise(r => setTimeout(r, 3000));
            try {
                const detail = await axios.get(`${this.baseURL}/orders/show/${srOrderId}`, { headers, timeout: 20000 });
                const order = detail.data?.data || detail.data || {};
                const found = this.extractAwbFromOrder(order);
                if (found) {
                    console.log(`📦 Shiprocket: AWB ${found.awb} appeared on order ${channelOrderId} after async assignment`);
                    return { ...found, raw: awbRes.data };
                }
            } catch (error) {
                console.warn(`⚠️ Shiprocket: AWB poll for order ${channelOrderId} failed (${this.describeAxiosError(error)})`);
            }
        }
        return { awb: null, raw: awbRes.data };
    }

    // Live courier list with rates/ETA/rating for admin to choose from
    async checkServiceability(ctx) {
        try {
            const deliveryPin = this.normalizePincode(ctx.consignee.pincode);
            if (!deliveryPin) return this.fail('Invalid delivery pincode (must be 6 digits)');

            const headers = await this.authHeaders();
            const isCod = ctx.payment.mode === 'COD';
            const pickupPincode = await this.resolvePickupPincode();

            const response = await axios.get(`${this.baseURL}/courier/serviceability/`, {
                headers,
                params: {
                    pickup_postcode: pickupPincode,
                    delivery_postcode: deliveryPin,
                    weight: (ctx.package.weightGrams || 500) / 1000, // kg
                    cod: isCod ? 1 : 0,
                    declared_value: ctx.payment.declaredValue || 0
                },
                timeout: 20000
            });

            const couriers = response.data?.data?.available_courier_companies || [];
            if (couriers.length === 0) {
                return this.ok({ serviceable: false, reason: `No couriers available for pincode ${deliveryPin}`, couriers: [] }, response.data);
            }

            const recommendedId = response.data?.data?.recommended_courier_company_id;
            const normalized = couriers.map(c => ({
                courierId: c.courier_company_id,
                courierName: c.courier_name,
                rate: c.rate,
                codCharges: c.cod_charges || 0,
                etd: c.etd || c.estimated_delivery_days || null,
                rating: c.rating || null,
                recommended: c.courier_company_id === recommendedId
            })).sort((a, b) => (a.rate || 0) - (b.rate || 0));

            return this.ok({
                serviceable: true,
                couriers: normalized,
                recommendedCourierId: recommendedId || null
            }, response.data);
        } catch (error) {
            return this.fail(`Shiprocket serviceability failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    // Ship orders ONLY under the Shopify channel. Two routes, never "Custom":
    //   1. The order was already synced from Shopify → reuse it, assign AWB only.
    //   2. Not synced yet → create it via the channel-specific endpoint.
    async createShipment(ctx) {
        try {
            const deliveryPin = this.normalizePincode(ctx.consignee.pincode);
            if (!deliveryPin) return this.fail('Invalid delivery pincode (must be 6 digits)');

            const headers = await this.authHeaders();

            // Without a Shopify channel we refuse to ship — the old adhoc
            // fallback silently filed everything under "Custom", which is
            // exactly what this flow must never do.
            const channelId = await this.resolveChannelId();
            if (!channelId) {
                return this.fail(
                    'Shiprocket has no usable Shopify channel — orders would land under "Custom", which is disabled. ' +
                    'Connect the Shopify channel in Shiprocket (Setup & Manage → Channels) or set SHIPROCKET_CHANNEL_ID.'
                );
            }

            // --- Route 1: reuse the order Shiprocket synced from Shopify ---
            const synced = await this.findSyncedOrder(headers, ctx.orderId, channelId);
            if (synced) {
                // Pin the fixed package before AWB assignment so the synced
                // order keeps the same weight/dimensions whatever it contains
                await this.enforceFixedPackage(headers, synced, ctx);

                // Warn (not block) if the hub edited the address away from the Shopify one
                const syncedPin = this.normalizePincode(synced.billing_pincode || synced.shipping_pincode);
                if (syncedPin && syncedPin !== deliveryPin) {
                    console.warn(`⚠️ Shiprocket: hub pincode ${deliveryPin} differs from synced order ${synced.channel_order_id} (${syncedPin}) — shipment will use the synced address`);
                }

                const srOrderId = String(synced.id);
                let shipmentId = this.extractShipmentId(synced);

                // Shiprocket rejects AWB assignment on zero-weight orders. If
                // the synced row carries no weight, confirm the fixed package
                // really landed before asking for an AWB — otherwise fail with
                // an actionable message instead of the cryptic API rejection.
                if (!(this.extractWeightKg(synced) > 0)) {
                    const weightNow = await this.verifyOrderWeight(headers, srOrderId);
                    if (weightNow !== null && weightNow <= 0) {
                        return this.fail(
                            `Synced Shopify-channel order ${synced.channel_order_id} has zero weight at Shiprocket and the package update did not take. ` +
                            `Add a weight to the order in the Shiprocket panel (or to the Shopify product), then retry shipping.`
                        );
                    }
                }

                // Listing rows often omit the shipment id, but the AWB endpoint
                // works most reliably with it (and rejects the old `order_ids`
                // array shape) — fetch it from the detail endpoint when missing.
                if (!shipmentId) {
                    try {
                        const detail = await axios.get(`${this.baseURL}/orders/show/${srOrderId}`, { headers, timeout: 20000 });
                        const d = detail.data?.data || detail.data || {};
                        shipmentId = this.extractShipmentId(d);
                    } catch (error) {
                        console.warn(`⚠️ Shiprocket: shipment-id lookup for order ${synced.channel_order_id} failed (${this.describeAxiosError(error)})`);
                    }
                }

                // Already carries an AWB (Shiprocket auto-allocation) — nothing to create
                if (synced.awb_code) {
                    console.log(`📦 Shiprocket: reusing synced Shopify-channel order ${synced.channel_order_id} (existing AWB ${synced.awb_code})`);
                    return this.ok({
                        awb: String(synced.awb_code),
                        courierName: synced.courier_name || 'Shiprocket Courier',
                        carrierShipmentId: shipmentId,
                        carrierOrderId: srOrderId,
                        trackingUrl: `https://shiprocket.co/tracking/${synced.awb_code}`,
                        reusedSyncedOrder: true,
                        requestPayload: { channel_order_id: synced.channel_order_id, channel_id: synced.channel_id }
                    }, { order: synced });
                }

                const awbBody = {};
                if (shipmentId) awbBody.shipment_id = Number(shipmentId);
                else awbBody.order_id = Number(srOrderId);
                if (ctx.courierId && ctx.courierId !== 'auto') awbBody.courier_id = ctx.courierId;

                let awbAssigned = null;
                let awbError = null;
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        awbAssigned = await this.assignAwbAndAwait(headers, awbBody, srOrderId, synced.channel_order_id);
                        awbError = null;
                        break;
                    } catch (error) {
                        awbError = error;
                        // "Zero weight or no weight entered." — the weight update
                        // didn't land. Force the fixed package once more, confirm
                        // Shiprocket now sees a weight, then retry the AWB once.
                        const detail = JSON.stringify(error.response?.data || error.message || '').toLowerCase();
                        if (attempt === 1 && /weight/.test(detail)) {
                            await this.enforceFixedPackage(headers, { ...synced, weight: 0 }, ctx);
                            const weightNow = await this.verifyOrderWeight(headers, srOrderId);
                            if (weightNow && weightNow > 0) continue;
                        }
                        break;
                    }
                }
                if (awbError) {
                    const detail = JSON.stringify(awbError.response?.data || awbError.message || '').toLowerCase();
                    const message = /weight/.test(detail)
                        ? `Synced Shopify-channel order ${synced.channel_order_id} has zero weight at Shiprocket and it could not be updated via the API. ` +
                          `Add a weight to the order in the Shiprocket panel (or to the Shopify product), then retry shipping.`
                        : `Synced Shopify-channel order ${synced.channel_order_id} found, but AWB assignment failed: ${this.describeAxiosError(awbError)}`;
                    return this.fail(message, { order: synced, awbError: awbError.response?.data });
                }

                if (!awbAssigned?.awb) {
                    return this.fail(
                        `Synced Shopify-channel order ${synced.channel_order_id} found, but no AWB returned (${this.describeAwbFailure(awbAssigned?.raw)}): ${awbAssigned?.raw?.message || JSON.stringify(awbAssigned?.raw).substring(0, 200)}`,
                        { order: synced, awb: awbAssigned?.raw }
                    );
                }

                console.log(`📦 Shiprocket: shipped synced Shopify-channel order ${synced.channel_order_id} (AWB ${awbAssigned.awb})`);
                return this.ok({
                    awb: awbAssigned.awb,
                    courierName: awbAssigned.courierName || 'Shiprocket Courier',
                    carrierShipmentId: shipmentId || String(awbAssigned.raw?.shipment_id || ''),
                    carrierOrderId: srOrderId,
                    freightCharge: awbAssigned.raw?.response?.data?.freight_charges || awbAssigned.raw?.response?.data?.applied_weight_amount || null,
                    trackingUrl: `https://shiprocket.co/tracking/${awbAssigned.awb}`,
                    reusedSyncedOrder: true,
                    requestPayload: { channel_order_id: synced.channel_order_id, channel_id: synced.channel_id, awb: awbBody }
                }, { order: synced, awb: awbAssigned.raw });
            }

            // --- Route 2: not synced yet — create under the Shopify channel ---
            const isCod = ctx.payment.mode === 'COD';
            // Shiprocket only allows alphabets and spaces in name fields —
            // strip digits, punctuation, emojis etc. before sending.
            const stripNonAlpha = s => (s || '').replace(/[^a-zA-Z ]/g, '').trim();
            const nameParts = (ctx.consignee.name || 'Customer').trim().split(/\s+/);
            const firstName = stripNonAlpha(nameParts[0]) || 'Customer';
            const lastName = stripNonAlpha(nameParts.slice(1).join(' '));

            const orderItems = (ctx.items.length > 0 ? ctx.items : [{ name: 'Product', quantity: 1, price: ctx.payment.declaredValue || 0 }])
                .map((item, idx) => ({
                    // Size goes in the name — Shiprocket labels/invoices print it from here
                    name: `${item.name}${item.size ? ` (${item.size})` : ''}`,
                    sku: item.sku || `SKU-${ctx.orderId}-${idx + 1}`,
                    units: item.quantity || 1,
                    selling_price: Number(item.price) || 0
                }));

            const subTotal = orderItems.reduce((sum, i) => sum + (i.selling_price * i.units), 0) || Number(ctx.payment.declaredValue) || 0;

            const orderPayload = {
                order_id: ctx.orderId,
                order_date: new Date().toISOString().slice(0, 16).replace('T', ' '),
                pickup_location: process.env.SHIPROCKET_PICKUP_LOCATION,
                billing_customer_name: firstName,
                billing_last_name: lastName,
                billing_address: ctx.consignee.address,
                billing_city: ctx.consignee.city || '',
                billing_pincode: deliveryPin,
                billing_state: ctx.consignee.state || '',
                billing_country: ctx.consignee.country || 'India',
                billing_email: ctx.consignee.email || 'noreply@offcomfrt.com',
                billing_phone: this.normalizePhone(ctx.consignee.phone),
                shipping_is_billing: true,
                order_items: orderItems,
                payment_method: isCod ? 'COD' : 'Prepaid',
                sub_total: subTotal,
                length: ctx.package.lengthCm || 30,
                breadth: ctx.package.breadthCm || 40,
                height: ctx.package.heightCm || 2,
                weight: (ctx.package.weightGrams || 500) / 1000 // kg
            };

            let createRes;
            try {
                createRes = await axios.post(`${this.baseURL}/orders/create`, { ...orderPayload, channel_id: channelId }, {
                    headers,
                    timeout: 30000
                });
            } catch (channelError) {
                const httpStatus = channelError.response?.status;
                // Extract field-level validation errors from the Shiprocket response
                // (422 body typically has { message: "Oops! Invalid Data.", data: { ...field errors... } })
                const srBody = channelError.response?.data;
                const fieldErrors = srBody?.data || srBody?.errors;
                const fieldDetail = fieldErrors
                    ? (typeof fieldErrors === 'string' ? fieldErrors : JSON.stringify(fieldErrors).substring(0, 500))
                    : '';
                const suffix = fieldDetail && fieldDetail !== this.describeAxiosError(channelError)
                    ? ` Details: ${fieldDetail}`
                    : '';

                // "order_id already taken" — the order exists at Shiprocket but
                // findSyncedOrder missed it on the first pass (search API lag,
                // different channel, etc.). Re-search and proceed with AWB
                // assignment instead of failing — the order is already there.
                const orderIdTaken = httpStatus === 422 && /already been taken/i.test(fieldDetail || srBody?.message || '');
                if (orderIdTaken) {
                    console.log(`📦 Shiprocket: order ${ctx.orderId} already exists — re-searching to reuse it`);
                    // Brief pause for search-index propagation (Shopify sync may have just created it)
                    await new Promise(r => setTimeout(r, 2000));
                    let existing = await this.findSyncedOrder(headers, ctx.orderId, channelId);

                    // Fallback: search by customer phone — different search index,
                    // catches orders the order-id search misses (search API lag/format mismatch).
                    // The Shopify sync files orders under the Shopify order number as
                    // channel_order_id (e.g. "7379"), NOT our internal order ID (e.g.
                    // "48969"). So we must also match by customer name + amount within
                    // the phone search results.
                    if (!existing && ctx.consignee?.phone) {
                        const rawPhone = String(ctx.consignee.phone).replace(/\D/g, '');
                        const searchPhones = rawPhone.length === 10 ? [`91${rawPhone}`, rawPhone] : [rawPhone];
                        const bare = String(ctx.orderId).replace(/^#/, '').trim().toLowerCase();
                        const subTotal = orderPayload.sub_total;
                        const custFirst = (orderPayload.billing_customer_name || '').toLowerCase().trim();
                        const custLast = (orderPayload.billing_last_name || '').toLowerCase().trim();
                        const custEmail = (orderPayload.billing_email || '').toLowerCase().trim();

                        for (const phone of searchPhones) {
                            if (existing) break;
                            for (let page = 1; page <= 3; page++) {
                                try {
                                    const resp = await axios.get(`${this.baseURL}/orders`, {
                                        headers,
                                        params: { search: phone, per_page: 50, page },
                                        timeout: 20000
                                    });
                                    const orders = resp.data?.data || [];
                                    if (orders.length === 0) break;

                                    // 1. Exact match on order_id (our internal ID or Shopify #)
                                    const exact = orders.find(o =>
                                        String(o.channel_order_id || '').replace(/^#/, '').trim().toLowerCase() === bare ||
                                        String(o.order_id || '').replace(/^#/, '').trim().toLowerCase() === bare
                                    );
                                    if (exact) {
                                        console.log(`📦 Shiprocket: found existing order ${ctx.orderId} via phone search (${phone})`);
                                        existing = exact;
                                        break;
                                    }
                                    // 2. Fuzzy match: digits of our order_id appear in channel_order_id
                                    const fuzzy = orders.find(o => {
                                        const coi = String(o.channel_order_id || '').replace(/\D/g, '');
                                        return coi && coi.length >= 4 && (coi.includes(bare.replace(/\D/g, '')) || bare.replace(/\D/g, '').includes(coi));
                                    });
                                    if (fuzzy) {
                                        console.log(`📦 Shiprocket: fuzzy-matched order ${ctx.orderId} → SR channel_order_id "${fuzzy.channel_order_id}" via phone (${phone})`);
                                        existing = fuzzy;
                                        break;
                                    }
                                    // 3. Match by customer name + amount (catches Shopify-synced orders
                                    //    where channel_order_id is the Shopify #, not our internal ID).
                                    //    Lenient: first-name match only, wide amount tolerance, skip shipped.
                                    const unshipped = orders.filter(o => !o.awb_code);
                                    const byNameAndAmount = unshipped.find(o => {
                                        const srFirst = String(o.billing_customer_name || '').toLowerCase().trim();
                                        // First name must match (lenient: allows empty last name on either side)
                                        if (srFirst !== custFirst) return false;
                                        // Amount: compare against multiple Shiprocket fields (total may be
                                        // the grand total, sub_total may exclude tax, etc.) — wide tolerance
                                        const srTotal = Number(o.total || o.sub_total || o.total_amount || 0);
                                        const amountMatch = Math.abs(srTotal - subTotal) < 50;
                                        return amountMatch;
                                    });
                                    if (byNameAndAmount) {
                                        console.log(`📦 Shiprocket: matched order ${ctx.orderId} → SR id ${byNameAndAmount.id}, channel_order_id "${byNameAndAmount.channel_order_id}" by name+amount via phone (${phone}, page ${page})`);
                                        existing = byNameAndAmount;
                                        break;
                                    }
                                    // 4. Name-only match (last resort within phone results — if exactly one
                                    //    unshipped order has the same first name, it's almost certainly ours)
                                    const nameOnly = unshipped.filter(o =>
                                        String(o.billing_customer_name || '').toLowerCase().trim() === custFirst
                                    );
                                    if (nameOnly.length === 1) {
                                        console.log(`📦 Shiprocket: name-only match for order ${ctx.orderId} → SR id ${nameOnly[0].id}, channel_order_id "${nameOnly[0].channel_order_id}" (sole unshipped order with name "${custFirst}" on page ${page})`);
                                        existing = nameOnly[0];
                                        break;
                                    }
                                    // Diagnostic: show what we're comparing
                                    if (page === 1 && unshipped.length > 0) {
                                        const sample = unshipped.slice(0, 5).map(o => ({
                                            id: o.id,
                                            coi: o.channel_order_id,
                                            name: `${o.billing_customer_name} ${o.billing_last_name || ''}`.trim(),
                                            total: o.total,
                                            sub: o.sub_total
                                        }));
                                        console.log(`📦 Shiprocket: phone search (${phone}, page ${page}) — ${orders.length} orders (${unshipped.length} unshipped). Looking for name="${custFirst} ${custLast}" amount=${subTotal}. Sample unshipped: ${JSON.stringify(sample)}`);
                                    }
                                    if (orders.length < 50) break; // no more pages
                                } catch (e) {
                                    console.warn(`⚠️ Shiprocket: phone-search fallback for ${phone} page ${page} failed`);
                                    break;
                                }
                            }
                        }
                        // Also try email search if phone didn't find it
                        if (!existing && custEmail && custEmail !== 'noreply@offcomfrt.com') {
                            try {
                                const resp = await axios.get(`${this.baseURL}/orders`, {
                                    headers,
                                    params: { search: custEmail, per_page: 50 },
                                    timeout: 20000
                                });
                                const orders = (resp.data?.data || []).filter(o => !o.awb_code);
                                const match = orders.find(o =>
                                    String(o.billing_customer_name || '').toLowerCase().trim() === custFirst
                                );
                                if (match) {
                                    console.log(`📦 Shiprocket: matched order ${ctx.orderId} → SR id ${match.id}, channel_order_id "${match.channel_order_id}" by email+name`);
                                    existing = match;
                                }
                            } catch (e) {
                                console.warn(`⚠️ Shiprocket: email-search fallback failed`);
                            }
                        }
                        // Diagnostic if still not found
                        if (!existing) {
                            console.log(`📦 Shiprocket: all phone/email searches exhausted without matching order ${ctx.orderId} (looking for name="${custFirst} ${custLast}", email="${custEmail}", amount=${subTotal})`);
                        }
                    }

                    // Last resort: scan recent orders (no search filter) and look for
                    // one matching our payload (same amount, same customer, no AWB yet).
                    // Checks up to 5 pages of 50 to cast a wider net.
                    if (!existing) {
                        const bare = String(ctx.orderId).replace(/^#/, '').trim().toLowerCase();
                        const subTotal = orderPayload.sub_total;
                        const custName = (orderPayload.billing_customer_name || '').toLowerCase();
                        const custLastName = (orderPayload.billing_last_name || '').toLowerCase();
                        for (let page = 1; page <= 5; page++) {
                            try {
                                const resp = await axios.get(`${this.baseURL}/orders`, {
                                    headers,
                                    params: { per_page: 50, page },
                                    timeout: 20000
                                });
                                const recent = resp.data?.data || [];
                                if (recent.length === 0) break;
                                const match = recent.find(o => {
                                    const coi = String(o.channel_order_id || '').replace(/^#/, '').trim().toLowerCase();
                                    const oid = String(o.order_id || '').replace(/^#/, '').trim().toLowerCase();
                                    if (coi === bare || oid === bare) return true;
                                    if (o.awb_code) return false;
                                    const firstName = String(o.billing_customer_name || '').toLowerCase().trim();
                                    const lastName = String(o.billing_last_name || '').toLowerCase().trim();
                                    const nameMatch = firstName === custName && (!custLastName || lastName === custLastName || !lastName);
                                    const amountMatch = Math.abs(Number(o.total || 0) - subTotal) < 2;
                                    return nameMatch && amountMatch;
                                });
                                if (match) {
                                    console.log(`📦 Shiprocket: found orphaned order via recent-orders scan (page ${page}) — SR id ${match.id}, channel_order_id "${match.channel_order_id}"`);
                                    existing = match;
                                    break;
                                }
                                if (recent.length < 50) break;
                            } catch (e) {
                                console.warn(`⚠️ Shiprocket: recent-orders scan page ${page} failed`);
                                break;
                            }
                        }
                    }

                    if (existing) {
                        const srOrderId = String(existing.id);
                        let shipmentId = this.extractShipmentId(existing);
                        if (!shipmentId) {
                            try {
                                const detail = await axios.get(`${this.baseURL}/orders/show/${srOrderId}`, { headers, timeout: 20000 });
                                const d = detail.data?.data || detail.data || {};
                                shipmentId = this.extractShipmentId(d);
                            } catch (e) {
                                console.warn(`⚠️ Shiprocket: shipment-id lookup for existing order ${existing.channel_order_id} failed`);
                            }
                        }
                        // If it already has an AWB, just return it
                        if (existing.awb_code) {
                            console.log(`📦 Shiprocket: existing order ${existing.channel_order_id} already has AWB ${existing.awb_code}`);
                            return this.ok({
                                awb: String(existing.awb_code),
                                courierName: existing.courier_name || 'Shiprocket Courier',
                                carrierShipmentId: shipmentId,
                                carrierOrderId: srOrderId,
                                trackingUrl: `https://shiprocket.co/tracking/${existing.awb_code}`,
                                reusedSyncedOrder: true,
                                requestPayload: { channel_order_id: existing.channel_order_id, channel_id: existing.channel_id }
                            }, { order: existing });
                        }
                        // Assign AWB to the existing order
                        const awbBody = {};
                        if (shipmentId) awbBody.shipment_id = Number(shipmentId);
                        else awbBody.order_id = Number(srOrderId);
                        if (ctx.courierId && ctx.courierId !== 'auto') awbBody.courier_id = ctx.courierId;
                        try {
                            const awbAssigned = await this.assignAwbAndAwait(headers, awbBody, srOrderId, existing.channel_order_id);
                            if (awbAssigned?.awb) {
                                console.log(`📦 Shiprocket: assigned AWB ${awbAssigned.awb} to existing order ${existing.channel_order_id}`);
                                return this.ok({
                                    awb: awbAssigned.awb,
                                    courierName: awbAssigned.courierName || 'Shiprocket Courier',
                                    carrierShipmentId: shipmentId || String(awbAssigned.raw?.shipment_id || ''),
                                    carrierOrderId: srOrderId,
                                    freightCharge: awbAssigned.raw?.response?.data?.freight_charges || awbAssigned.raw?.response?.data?.applied_weight_amount || null,
                                    trackingUrl: `https://shiprocket.co/tracking/${awbAssigned.awb}`,
                                    reusedSyncedOrder: true,
                                    requestPayload: { channel_order_id: existing.channel_order_id, channel_id: existing.channel_id, awb: awbBody }
                                }, { order: existing, awb: awbAssigned.raw });
                            }
                            // AWB assignment failed — fall through to the error below
                            return this.fail(
                                `Shiprocket order ${existing.channel_order_id} exists but AWB assignment failed: ${this.describeAwbFailure(awbAssigned?.raw)}`,
                                { order: existing, awb: awbAssigned?.raw }
                            );
                        } catch (awbError) {
                            return this.fail(
                                `Shiprocket order ${existing.channel_order_id} exists but AWB assignment failed: ${this.describeAxiosError(awbError)}`,
                                { order: existing, awbError: awbError.response?.data }
                            );
                        }
                    }
                    // Re-search also missed it — fail with context
                    console.warn(`⚠️ Shiprocket: order ${ctx.orderId} rejected as duplicate but re-search found nothing — cannot recover`);
                }

                console.error(`❌ Shiprocket: order ${ctx.orderId} creation payload rejected — payload keys: ${Object.keys(orderPayload).join(', ')}; response: ${JSON.stringify(srBody).substring(0, 600)}`);
                // Never fall back to /orders/create/adhoc — that endpoint ALWAYS files
                // under the "Custom" channel. Fail loudly with the raw response so the
                // rejection reason is diagnosable (if the order already exists at
                // Shiprocket it will be found by the synced-order lookup next attempt).
                return this.fail(
                    `Shiprocket rejected channel ${channelId} order creation (HTTP ${httpStatus || 'n/a'}: ${this.describeAxiosError(channelError)}${suffix}). ` +
                    `Not retrying under another channel — check the Shiprocket panel before shipping again.`,
                    srBody
                );
            }

            const shipmentId = createRes.data?.shipment_id;
            const srOrderId = createRes.data?.order_id;
            if (!shipmentId) {
                return this.fail(`Shiprocket order creation failed: ${createRes.data?.message || JSON.stringify(createRes.data).substring(0, 200)}`, createRes.data);
            }

            // Assign AWB with the courier the admin picked (or auto-assign cheapest)
            const awbBody = { shipment_id: shipmentId };
            if (ctx.courierId && ctx.courierId !== 'auto') {
                awbBody.courier_id = ctx.courierId;
            }

            let awbAssigned;
            try {
                awbAssigned = await this.assignAwbAndAwait(headers, awbBody, String(srOrderId), ctx.orderId);
            } catch (awbError) {
                // Order exists but AWB failed — surface both facts so admin can retry from Shiprocket panel
                return this.fail(
                    `Shiprocket order #${srOrderId} created, but AWB assignment failed: ${this.describeAxiosError(awbError)}`,
                    { order: createRes.data, awbError: awbError.response?.data }
                );
            }

            if (!awbAssigned.awb) {
                return this.fail(
                    `Shiprocket order #${srOrderId} created, but no AWB returned (${this.describeAwbFailure(awbAssigned.raw)}): ${awbAssigned.raw?.message || JSON.stringify(awbAssigned.raw).substring(0, 200)}`,
                    { order: createRes.data, awb: awbAssigned.raw }
                );
            }

            return this.ok({
                awb: awbAssigned.awb,
                courierName: awbAssigned.courierName || 'Shiprocket Courier',
                carrierShipmentId: String(shipmentId),
                carrierOrderId: String(srOrderId),
                freightCharge: awbAssigned.raw?.response?.data?.freight_charges || awbAssigned.raw?.response?.data?.applied_weight_amount || null,
                trackingUrl: `https://shiprocket.co/tracking/${awbAssigned.awb}`,
                requestPayload: orderPayload
            }, { order: createRes.data, awb: awbAssigned.raw });
        } catch (error) {
            return this.fail(`Shiprocket shipment creation failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    async generateLabel(shipment) {
        try {
            const headers = await this.authHeaders();
            const response = await axios.post(`${this.baseURL}/courier/generate/label`, {
                shipment_id: [Number(shipment.carrier_shipment_id)]
            }, { headers, timeout: 30000 });

            if (!response.data?.label_url) {
                return this.fail(`Shiprocket label not ready: ${response.data?.response || response.data?.message || 'unknown'}`, response.data);
            }
            return this.ok({ labelUrl: response.data.label_url }, response.data);
        } catch (error) {
            return this.fail(`Shiprocket label generation failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    async schedulePickup(shipment, pickupDate) {
        try {
            const headers = await this.authHeaders();
            const body = { shipment_id: [Number(shipment.carrier_shipment_id)] };
            if (pickupDate) body.pickup_date = [pickupDate];

            const response = await axios.post(`${this.baseURL}/courier/generate/pickup`, body, {
                headers,
                timeout: 30000
            });

            const data = response.data?.response || response.data;
            if (response.data?.pickup_status !== 1 && !data?.pickup_scheduled_date) {
                return this.fail(`Shiprocket pickup scheduling failed: ${data?.data || response.data?.message || 'unknown'}`, response.data);
            }
            return this.ok({
                pickupDate: data?.pickup_scheduled_date || pickupDate,
                pickupToken: data?.pickup_token_number ? String(data.pickup_token_number) : null
            }, response.data);
        } catch (error) {
            return this.fail(`Shiprocket pickup scheduling failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    async generateManifest(shipment) {
        try {
            const headers = await this.authHeaders();
            const response = await axios.post(`${this.baseURL}/manifests/generate`, {
                shipment_id: [Number(shipment.carrier_shipment_id)]
            }, { headers, timeout: 30000 });

            const manifestUrl = response.data?.manifest_url;
            if (!manifestUrl) {
                return this.fail(`Shiprocket manifest not generated: ${response.data?.message || 'unknown'}`, response.data);
            }
            return this.ok({ manifestUrl }, response.data);
        } catch (error) {
            return this.fail(`Shiprocket manifest generation failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    async generateInvoice(shipment) {
        try {
            const headers = await this.authHeaders();
            const response = await axios.post(`${this.baseURL}/orders/print/invoice`, {
                ids: [Number(shipment.carrier_order_id)]
            }, { headers, timeout: 30000 });

            const invoiceUrl = response.data?.invoice_url;
            if (!invoiceUrl) {
                return this.fail(`Shiprocket invoice not generated: ${response.data?.message || 'unknown'}`, response.data);
            }
            return this.ok({ invoiceUrl }, response.data);
        } catch (error) {
            return this.fail(`Shiprocket invoice generation failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    async cancelShipment(shipment) {
        // Two-step: once an AWB is assigned, cancelling the Shiprocket order alone does NOT
        // cancel the shipment with the courier — the AWB must be cancelled explicitly first.
        let headers;
        try {
            headers = await this.authHeaders();
        } catch (error) {
            return this.fail(`Shiprocket cancellation failed: could not authenticate (${error.message})`);
        }

        let awbCancel = null;
        let orderCancel = null;

        if (shipment.awb) {
            try {
                const response = await axios.post(`${this.baseURL}/orders/cancel/shipment/awbs`, {
                    awbs: [String(shipment.awb)]
                }, { headers, timeout: 30000 });
                awbCancel = { success: true, raw: response.data };
            } catch (error) {
                awbCancel = { success: false, error: this.describeAxiosError(error), raw: error.response?.data };
                console.warn(`⚠️ Shiprocket AWB cancel failed for ${shipment.awb}: ${awbCancel.error}`);
            }
        }

        const carrierOrderId = Number(shipment.carrier_order_id);
        if (carrierOrderId) {
            try {
                const response = await axios.post(`${this.baseURL}/orders/cancel`, {
                    ids: [carrierOrderId]
                }, { headers, timeout: 30000 });
                orderCancel = { success: true, raw: response.data };
            } catch (error) {
                orderCancel = { success: false, error: this.describeAxiosError(error), raw: error.response?.data };
                console.warn(`⚠️ Shiprocket order cancel failed for SR order ${carrierOrderId}: ${orderCancel.error}`);
            }
        }

        if (!awbCancel && !orderCancel) {
            return this.fail('Shiprocket cancellation failed: shipment has no AWB or Shiprocket order ID on record');
        }

        // Succeed if at least one leg went through (e.g. AWB already cancelled but order still open, or vice versa)
        if ((awbCancel && awbCancel.success) || (orderCancel && orderCancel.success)) {
            return this.ok({
                cancelled: true,
                awbCancelled: awbCancel ? awbCancel.success : null,
                orderCancelled: orderCancel ? orderCancel.success : null,
                warning: [
                    awbCancel && !awbCancel.success ? `AWB cancel: ${awbCancel.error}` : null,
                    orderCancel && !orderCancel.success ? `Order cancel: ${orderCancel.error}` : null
                ].filter(Boolean).join(' | ') || null
            }, { awbCancel: awbCancel?.raw, orderCancel: orderCancel?.raw });
        }

        return this.fail(
            `Shiprocket cancellation failed: ${[awbCancel?.error, orderCancel?.error].filter(Boolean).join(' | ')}`,
            { awbCancel: awbCancel?.raw, orderCancel: orderCancel?.raw }
        );
    }

    async track(awb) {
        try {
            const trackingData = await shiprocketService.getTrackingByAWB(awb);
            if (!trackingData?.tracking_data) {
                return this.fail('No tracking data found for this AWB', trackingData);
            }

            const td = trackingData.tracking_data;
            const timeline = (td.shipment_track_activities || []).map(a => ({
                date: a.date,
                location: a.location,
                activity: a.activity,
                status: a['sr-status-label'] || a.sr_status_label || ''
            }));

            // Fresh shipments often have zero scans — fall back to Shiprocket's
            // numeric shipment_status code so the status sync still works pre-pickup
            const codeStatus = SR_SHIPMENT_STATUS_CODES[Number(td.shipment_status)] || null;

            return this.ok({
                currentStatus: td.shipment_track?.[0]?.current_status || timeline[0]?.status || codeStatus || 'Unknown',
                expectedDelivery: td.etd || null,
                timeline
            }, trackingData);
        } catch (error) {
            return this.fail(`Shiprocket tracking failed: ${error.message}`);
        }
    }
}

// Shiprocket numeric shipment_status → human label (used when a shipment has
// no scan activity yet, e.g. right after AWB assignment / pickup scheduling)
const SR_SHIPMENT_STATUS_CODES = {
    1: 'AWB Assigned', 2: 'Label Generated', 3: 'Pickup Scheduled', 4: 'Pickup Queued',
    5: 'Manifest Generated', 6: 'Shipped', 7: 'Delivered', 8: 'Cancelled',
    9: 'RTO Initiated', 10: 'RTO Delivered', 12: 'Lost',
    13: 'Pickup Error', 14: 'RTO Acknowledged', 15: 'Pickup Rescheduled',
    16: 'Cancellation Requested', 17: 'Out For Delivery', 18: 'In Transit',
    19: 'Out For Pickup', 20: 'Pickup Exception', 21: 'Undelivered', 22: 'Delayed',
    23: 'Partial Delivered', 38: 'Reached Destination Hub', 39: 'Misrouted',
    40: 'RTO NDR', 41: 'RTO Out For Delivery', 42: 'Picked Up',
    45: 'Cancelled Before Dispatched', 46: 'RTO In Transit'
};

module.exports = new ShiprocketAdapter();
