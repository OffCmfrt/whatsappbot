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
    // shape changed: rows no longer carry a top-level `weight` — it now lives
    // under `others.weight` (listing & detail) and `shipments[].weight`
    // (detail). Returns null when no weight field is present at all.
    extractWeightKg(order) {
        const candidates = [
            order?.weight,
            order?.others?.weight,
            order?.shipments?.weight,
            ...(Array.isArray(order?.shipments) ? order.shipments.map(s => s?.weight) : [])
        ];
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
    // that must never block shipping.
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
            const body = error.response?.data ? ` — ${JSON.stringify(error.response.data).substring(0, 300)}` : '';
            console.warn(`⚠️ Shiprocket: could not normalize order ${synced.channel_order_id} package (${this.describeAxiosError(error)}${body}) — shipping with the synced values`);
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
                const shipmentId = this.extractShipmentId(synced);

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
                else awbBody.order_ids = [Number(srOrderId)];
                if (ctx.courierId && ctx.courierId !== 'auto') awbBody.courier_id = ctx.courierId;

                let awbRes;
                let awbError = null;
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        awbRes = await axios.post(`${this.baseURL}/courier/assign/awb`, awbBody, { headers, timeout: 30000 });
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

                const awbData = awbRes.data?.response?.data || awbRes.data?.data || {};
                const awb = awbData.awb_code || awbRes.data?.awb_code;
                if (!awb) {
                    return this.fail(
                        `Synced Shopify-channel order ${synced.channel_order_id} found, but no AWB returned: ${awbRes.data?.message || JSON.stringify(awbRes.data).substring(0, 200)}`,
                        { order: synced, awb: awbRes.data }
                    );
                }

                console.log(`📦 Shiprocket: shipped synced Shopify-channel order ${synced.channel_order_id} (AWB ${awb})`);
                return this.ok({
                    awb,
                    courierName: awbData.courier_name || 'Shiprocket Courier',
                    carrierShipmentId: shipmentId || String(awbRes.data?.shipment_id || ''),
                    carrierOrderId: srOrderId,
                    freightCharge: awbData.freight_charges || awbData.applied_weight_amount || null,
                    trackingUrl: `https://shiprocket.co/tracking/${awb}`,
                    reusedSyncedOrder: true,
                    requestPayload: { channel_order_id: synced.channel_order_id, channel_id: synced.channel_id, awb: awbBody }
                }, { order: synced, awb: awbRes.data });
            }

            // --- Route 2: not synced yet — create under the Shopify channel ---
            const isCod = ctx.payment.mode === 'COD';
            const nameParts = (ctx.consignee.name || 'Customer').trim().split(/\s+/);
            const firstName = nameParts[0];
            const lastName = nameParts.slice(1).join(' ') || '';

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
                // Never fall back to /orders/create/adhoc — that endpoint ALWAYS files
                // under the "Custom" channel. Fail loudly with the raw response so the
                // rejection reason is diagnosable (if the order already exists at
                // Shiprocket it will be found by the synced-order lookup next attempt).
                return this.fail(
                    `Shiprocket rejected channel ${channelId} order creation (HTTP ${httpStatus || 'n/a'}: ${this.describeAxiosError(channelError)}). ` +
                    `Not retrying under another channel — check the Shiprocket panel before shipping again.`,
                    channelError.response?.data
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

            let awbRes;
            try {
                awbRes = await axios.post(`${this.baseURL}/courier/assign/awb`, awbBody, {
                    headers,
                    timeout: 30000
                });
            } catch (awbError) {
                // Order exists but AWB failed — surface both facts so admin can retry from Shiprocket panel
                return this.fail(
                    `Shiprocket order #${srOrderId} created, but AWB assignment failed: ${this.describeAxiosError(awbError)}`,
                    { order: createRes.data, awbError: awbError.response?.data }
                );
            }

            const awbData = awbRes.data?.response?.data || awbRes.data?.data || {};
            const awb = awbData.awb_code || awbRes.data?.awb_code;
            if (!awb) {
                return this.fail(
                    `Shiprocket order #${srOrderId} created, but no AWB returned: ${awbRes.data?.message || JSON.stringify(awbRes.data).substring(0, 200)}`,
                    { order: createRes.data, awb: awbRes.data }
                );
            }

            return this.ok({
                awb,
                courierName: awbData.courier_name || 'Shiprocket Courier',
                carrierShipmentId: String(shipmentId),
                carrierOrderId: String(srOrderId),
                freightCharge: awbData.freight_charges || awbData.applied_weight_amount || null,
                trackingUrl: `https://shiprocket.co/tracking/${awb}`,
                requestPayload: orderPayload
            }, { order: createRes.data, awb: awbRes.data });
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
