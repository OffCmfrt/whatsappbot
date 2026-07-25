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
 *   Create order   : POST /orders/create/adhoc
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
            const shopify = channels.find(c =>
                (c.base_channel_code || '').toUpperCase() === 'SH' ||
                /shopify/i.test(c.name || '')
            );
            if (shopify?.id) {
                this._channelId = String(shopify.id);
                console.log(`📦 Shiprocket: filing orders under Shopify channel (id ${this._channelId})`);
                return this._channelId;
            }
            console.warn('⚠️ Shiprocket: no Shopify channel found; orders will use the default (Custom) channel');
        } catch (error) {
            console.warn(`⚠️ Shiprocket: channel lookup failed (${this.describeAxiosError(error)}); orders will use the default (Custom) channel`);
        }
        return null;
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

    // Two-step flow: create adhoc order → assign AWB for the chosen courier
    async createShipment(ctx) {
        try {
            const deliveryPin = this.normalizePincode(ctx.consignee.pincode);
            if (!deliveryPin) return this.fail('Invalid delivery pincode (must be 6 digits)');

            const headers = await this.authHeaders();
            const isCod = ctx.payment.mode === 'COD';
            const nameParts = (ctx.consignee.name || 'Customer').trim().split(/\s+/);
            const firstName = nameParts[0];
            const lastName = nameParts.slice(1).join(' ') || '';

            const orderItems = (ctx.items.length > 0 ? ctx.items : [{ name: 'Product', quantity: 1, price: ctx.payment.declaredValue || 0 }])
                .map((item, idx) => ({
                    name: item.name,
                    sku: item.sku || `SKU-${ctx.orderId}-${idx + 1}`,
                    units: item.quantity || 1,
                    selling_price: Number(item.price) || 0
                }));

            const subTotal = orderItems.reduce((sum, i) => sum + (i.selling_price * i.units), 0) || Number(ctx.payment.declaredValue) || 0;
            const channelId = await this.resolveChannelId();

            const orderPayload = {
                order_id: ctx.orderId,
                ...(channelId ? { channel_id: channelId } : {}),
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
                length: ctx.package.lengthCm || 20,
                breadth: ctx.package.breadthCm || 15,
                height: ctx.package.heightCm || 5,
                weight: (ctx.package.weightGrams || 500) / 1000 // kg
            };

            const createRes = await axios.post(`${this.baseURL}/orders/create/adhoc`, orderPayload, {
                headers,
                timeout: 30000
            });

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
        try {
            const headers = await this.authHeaders();
            const response = await axios.post(`${this.baseURL}/orders/cancel`, {
                ids: [Number(shipment.carrier_order_id)]
            }, { headers, timeout: 30000 });

            return this.ok({ cancelled: true }, response.data);
        } catch (error) {
            return this.fail(`Shiprocket cancellation failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
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

            return this.ok({
                currentStatus: td.shipment_track?.[0]?.current_status || timeline[0]?.status || 'Unknown',
                expectedDelivery: td.etd || null,
                timeline
            }, trackingData);
        } catch (error) {
            return this.fail(`Shiprocket tracking failed: ${error.message}`);
        }
    }
}

module.exports = new ShiprocketAdapter();
