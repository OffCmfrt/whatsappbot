/**
 * Ekart Elite API adapter (direct integration) — built from the official
 * OpenAPI spec (app.elite.ekartlogistics.in, v3.8.9).
 *
 * Env vars:
 *   EKART_CLIENT_ID        — client id provided by Ekart during onboarding (auth URL path)
 *   EKART_USERNAME         — API username (auth request body)
 *   EKART_PASSWORD         — API password (auth request body)
 *   EKART_SELLER_NAME      — seller name printed on the label/invoice (required by create API)
 *   EKART_SELLER_ADDRESS   — seller billing address (required by create API)
 *   EKART_SELLER_GST_TIN   — seller GST TIN (required by create API)
 *   EKART_PICKUP_ALIAS     — Alias of the registered pickup address (required by Ekart)
 *   EKART_RETURN_ALIAS     — OPTIONAL. RTO address alias (defaults to pickup)
 *   EKART_PICKUP_PINCODE   — OPTIONAL. Enables rate estimates in the serviceability step
 *   EKART_CATEGORY_OF_GOODS— OPTIONAL. Category on the shipment (default: Apparel)
 *   EKART_BASE_URL         — OPTIONAL. Default: https://app.elite.ekartlogistics.in
 *
 * Endpoints used:
 *   Auth token     : POST   /integrations/v2/auth/token/{client_id}  ({username, password})
 *   Serviceability : GET    /api/v2/serviceability/{pincode}
 *   Rate estimate  : POST   /data/pricing/estimate  (best-effort, optional)
 *   Create shipment: PUT    /api/v1/package/create
 *   Label (PDF)    : POST   /api/v1/package/label   (binary PDF → uploaded to Cloudinary)
 *   Manifest       : POST   /data/v2/generate/manifest
 *   Cancel         : DELETE /api/v1/package/cancel?tracking_id={awb}
 *   Tracking       : GET    /api/v1/track/{awb}
 *
 * Notes:
 * - Ekart assigns the tracking id (AWB) itself on creation — no client-side series.
 * - First-mile pickup is auto-scheduled from preferred_dispatch_date at creation,
 *   so there is no separate pickup-request API (supportsPickup=false).
 * - Public tracking link: {base}/track/{tracking_id}
 */

const axios = require('axios');
const BaseCarrier = require('./baseCarrier');

class EkartAdapter extends BaseCarrier {
    constructor() {
        super('ekart', 'Ekart');
        this._token = null;
        this._tokenExpiry = 0; // epoch ms
    }

    get baseURL() {
        return (process.env.EKART_BASE_URL || 'https://app.elite.ekartlogistics.in').replace(/\/$/, '');
    }

    get capabilities() {
        return {
            ...super.capabilities,
            needsCourierSelection: false, // Ekart ships on its own network
            supportsManifest: true,
            supportsPickup: false         // pickup auto-scheduled from dispatch date
        };
    }

    isConfigured() {
        return Boolean(
            process.env.EKART_CLIENT_ID &&
            process.env.EKART_USERNAME &&
            process.env.EKART_PASSWORD &&
            process.env.EKART_SELLER_NAME &&
            process.env.EKART_SELLER_ADDRESS &&
            process.env.EKART_SELLER_GST_TIN &&
            process.env.EKART_PICKUP_ALIAS
        );
    }

    // ==========================================
    // Auth — token cached in-process; Ekart caches server-side for 24h too
    // ==========================================

    async ensureToken() {
        if (this._token && Date.now() < this._tokenExpiry) return this._token;

        const response = await axios.post(
            `${this.baseURL}/integrations/v2/auth/token/${encodeURIComponent(process.env.EKART_CLIENT_ID)}`,
            {
                username: process.env.EKART_USERNAME,
                password: process.env.EKART_PASSWORD
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
        );

        const { access_token: token, expires_in: expiresIn } = response.data || {};
        if (!token) throw new Error(`Ekart auth: no access_token in response (${JSON.stringify(response.data).substring(0, 200)})`);

        this._token = token;
        // Refresh 5 minutes before expiry (expires_in is in seconds)
        this._tokenExpiry = Date.now() + (Math.max(Number(expiresIn) || 3600, 600) - 300) * 1000;
        return this._token;
    }

    // Swift (Ekart's platform) often returns a bare exception code (e.g.
    // SWIFT_VALIDATION_EXCEPTION) in `message`/`error` with the field-level
    // details elsewhere in the body — surface the whole body in that case.
    describeAxiosError(error) {
        const msg = super.describeAxiosError(error);
        const data = error.response?.data;
        if (data && typeof data === 'object' && /^[A-Z0-9_]{6,}$/.test(msg)) {
            return `${msg} — ${JSON.stringify(data).substring(0, 400)}`;
        }
        return msg;
    }

    // Authenticated request with a single retry on 401 (expired/rotated token)
    async request(config, retried = false) {
        const token = await this.ensureToken();
        try {
            return await axios({
                timeout: 30000,
                ...config,
                url: `${this.baseURL}${config.url}`,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    ...(config.headers || {})
                }
            });
        } catch (error) {
            if (error.response?.status === 401 && !retried) {
                this._token = null; // force re-auth and retry once
                return this.request(config, true);
            }
            throw error;
        }
    }

    // ==========================================
    // Serviceability — GET /api/v2/serviceability/{pincode}
    // ==========================================

    async checkServiceability(ctx) {
        try {
            const pin = this.normalizePincode(ctx.consignee.pincode);
            if (!pin) return this.fail('Invalid delivery pincode (must be 6 digits)');

            const response = await this.request({ method: 'get', url: `/api/v2/serviceability/${pin}` });
            const { status, remark, details } = response.data || {};

            const isCod = ctx.payment.mode === 'COD';
            const codAvailable = Boolean(details?.cod);
            const maxCod = Number(details?.max_cod_amount) || 0;
            const forwardDrop = details?.forward_drop !== false; // spec: drop at customer location

            let serviceable = Boolean(status) && forwardDrop;
            let reason = serviceable ? null : (remark || `Pincode ${pin} is not serviceable by Ekart`);
            if (serviceable && isCod) {
                if (!codAvailable) {
                    serviceable = false;
                    reason = `Pincode ${pin} does not support COD with Ekart`;
                } else if (maxCod && Number(ctx.payment.codAmount) > maxCod) {
                    serviceable = false;
                    reason = `COD amount ₹${ctx.payment.codAmount} exceeds Ekart's limit of ₹${maxCod} for pincode ${pin}`;
                }
            }

            // Best-effort rate estimate (needs the pickup pincode to quote)
            const rate = await this.fetchRateEstimate(ctx, pin);

            return this.ok({
                serviceable,
                reason,
                codAvailable,
                prepaidAvailable: Boolean(status) && forwardDrop,
                city: details?.city || null,
                state: details?.state || null,
                // Direct carrier — single "courier" option so the UI renders uniformly
                couriers: [{
                    courierId: 'ekart',
                    courierName: 'Ekart',
                    rate,
                    etd: null,
                    rating: null
                }]
            }, response.data);
        } catch (error) {
            return this.fail(`Ekart serviceability failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    // POST /data/pricing/estimate — optional, never blocks the flow
    async fetchRateEstimate(ctx, dropPin) {
        const pickupPin = this.normalizePincode(process.env.EKART_PICKUP_PINCODE);
        if (!pickupPin) return null;
        try {
            const isCod = ctx.payment.mode === 'COD';
            const response = await this.request({
                method: 'post',
                url: '/data/pricing/estimate',
                data: {
                    billingClientType: 'NON_LARGE',
                    shippingDirection: 'FORWARD',
                    serviceType: 'SURFACE',
                    pickupPincode: Number(pickupPin),
                    dropPincode: Number(dropPin),
                    invoiceAmount: Number(ctx.payment.declaredValue) || 0,
                    codAmount: isCod ? (Number(ctx.payment.codAmount) || 0) : 0,
                    weight: Number(ctx.package.weightGrams) || 500,
                    length: Number(ctx.package.lengthCm) || 30,
                    width: Number(ctx.package.breadthCm) || 40,
                    height: Number(ctx.package.heightCm) || 2
                },
                timeout: 15000
            });
            const total = Number(response.data?.total);
            return Number.isFinite(total) && total > 0 ? total : null;
        } catch (error) {
            console.warn(`⚠️ Ekart rate estimate unavailable (${this.describeAxiosError(error)})`);
            return null;
        }
    }

    // ==========================================
    // Create shipment — PUT /api/v1/package/create
    // ==========================================

    async createShipment(ctx) {
        try {
            const pin = this.normalizePincode(ctx.consignee.pincode);
            if (!pin) return this.fail('Invalid delivery pincode (must be 6 digits)');

            const phone = this.normalizePhone(ctx.consignee.phone);
            if (!/^\d{10}$/.test(phone)) return this.fail('Valid 10-digit consignee phone is required');

            const isCod = ctx.payment.mode === 'COD';
            const codAmount = isCod ? (Number(ctx.payment.codAmount) || 0) : 0;
            if (codAmount > 49999) return this.fail(`Ekart COD limit is ₹49,999 (order is ₹${codAmount})`);

            // total_amount/taxable_amount have a minimum of 1 in the API
            const totalAmount = Math.max(1, Number(ctx.payment.declaredValue) || 0);
            const productsDesc = this.formatProductsDesc(ctx.items);
            const totalQty = ctx.items.reduce((sum, i) => sum + (i.quantity || 1), 0) || 1;

            // Today in IST (invoice date) — dispatch date must be tomorrow or later
            const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
            const todayIst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(nowIst);
            const tomorrowIst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(nowIst.getFullYear(), nowIst.getMonth(), nowIst.getDate() + 1));

            // Swift validation rejects blank/null drop city & state — backfill
            // them from Ekart's own pincode master when the order lacks them
            let dropCity = (ctx.consignee.city || '').trim();
            let dropState = (ctx.consignee.state || '').trim();
            if (!dropCity || !dropState) {
                try {
                    const svc = await this.request({ method: 'get', url: `/api/v2/serviceability/${pin}`, timeout: 15000 });
                    dropCity = dropCity || svc.data?.details?.city || '';
                    dropState = dropState || svc.data?.details?.state || '';
                } catch (lookupError) {
                    console.warn(`⚠️ Ekart city/state backfill unavailable (${this.describeAxiosError(lookupError)})`);
                }
            }

            const payload = {
                seller_name: process.env.EKART_SELLER_NAME,
                seller_address: process.env.EKART_SELLER_ADDRESS,
                seller_gst_tin: process.env.EKART_SELLER_GST_TIN,
                seller_gst_amount: 0,
                consignee_gst_amount: 0,
                integrated_gst_amount: 0,
                order_number: String(ctx.orderId),
                invoice_number: String(ctx.orderId),
                invoice_date: todayIst,
                consignee_name: ctx.consignee.name,
                consignee_phone: phone,
                payment_mode: isCod ? 'COD' : 'Prepaid',
                category_of_goods: process.env.EKART_CATEGORY_OF_GOODS || 'Apparel',
                products_desc: productsDesc,
                total_amount: totalAmount,
                tax_value: 0,
                taxable_amount: totalAmount,
                commodity_value: String(totalAmount),
                cod_amount: codAmount,
                quantity: totalQty,
                weight: Math.max(1, Math.round(Number(ctx.package.weightGrams) || 500)),
                length: Math.max(1, Math.round(Number(ctx.package.lengthCm) || 30)),
                width: Math.max(1, Math.round(Number(ctx.package.breadthCm) || 40)),
                height: Math.max(1, Math.round(Number(ctx.package.heightCm) || 2)),
                return_reason: '', // forward shipment — not applicable
                preferred_dispatch_date: tomorrowIst,
                drop_location: {
                    name: ctx.consignee.name,
                    address: [ctx.consignee.address, dropCity, dropState]
                        .filter(Boolean).join(', ').substring(0, 500),
                    city: dropCity,
                    state: dropState,
                    country: 'India',
                    phone: Number(phone),
                    pin: Number(pin)
                }
            };

            // Only set alternate phone when we have a *different* second number —
            // Ekart SWIFT validation rejects identical primary & alternate phones.
            const altPhone = this.normalizePhone(ctx.consignee.alternatePhone);
            if (altPhone && altPhone !== phone && /^\d{10}$/.test(altPhone)) {
                payload.consignee_alternate_phone = altPhone;
            }

            // Pickup/RTO addresses are registered with Ekart beforehand.
            // Ekart now requires explicit pickup_location in the payload.
            payload.pickup_location = { name: process.env.EKART_PICKUP_ALIAS };
            payload.return_location = { name: process.env.EKART_RETURN_ALIAS || process.env.EKART_PICKUP_ALIAS };

            const response = await this.request({
                method: 'put',
                url: '/api/v1/package/create',
                data: payload
            });

            const result = response.data || {};
            if (result.status !== true || !result.tracking_id) {
                // A bare exception code as remark hides the real reason — dump the body
                const remark = result.remark && !/^[A-Z0-9_]{6,}$/.test(result.remark)
                    ? result.remark
                    : `${result.remark || 'rejected'} — ${JSON.stringify(result).substring(0, 300)}`;
                console.error(`❌ Ekart create rejected for order ${ctx.orderId}:`, JSON.stringify(result).substring(0, 600));
                return this.fail(`Ekart shipment creation failed: ${remark}`, result);
            }

            return this.ok({
                awb: result.tracking_id,
                courierName: result.vendor ? `Ekart (${result.vendor})` : 'Ekart',
                carrierShipmentId: result.tracking_id,
                carrierOrderId: result.barcodes?.order || String(ctx.orderId),
                freightCharge: null,
                trackingUrl: `${this.baseURL}/track/${result.tracking_id}`,
                requestPayload: payload
            }, result);
        } catch (error) {
            console.error(`❌ Ekart create failed for order ${ctx.orderId}:`, JSON.stringify(error.response?.data || error.message).substring(0, 600));
            return this.fail(`Ekart shipment creation failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    // ==========================================
    // Label — POST /api/v1/package/label returns a binary PDF; we upload it
    // to Cloudinary so the hub gets a stable, shareable label_url
    // ==========================================

    async generateLabel(shipment) {
        try {
            const response = await this.request({
                method: 'post',
                url: '/api/v1/package/label?json_only=false',
                data: { ids: [shipment.awb] },
                responseType: 'arraybuffer'
            });

            const buffer = Buffer.from(response.data);
            if (!buffer.length) return this.fail('Ekart returned an empty label file');

            // Ekart may return a JSON error body with a 200 on some failures
            if (buffer.slice(0, 5).toString().trim().startsWith('{')) {
                return this.fail(`Ekart label generation failed: ${buffer.toString().substring(0, 300)}`);
            }

            if (!process.env.CLOUDINARY_CLOUD_NAME) {
                return this.fail('Ekart returns the label as a PDF file — configure Cloudinary (CLOUDINARY_*) to store labels, or download it from the Ekart dashboard');
            }

            const cloudinaryService = require('../cloudinaryService');
            const labelUrl = await cloudinaryService.uploadBuffer(buffer, 'shipping_labels');
            return this.ok({ labelUrl });
        } catch (error) {
            return this.fail(`Ekart label generation failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    // ==========================================
    // Manifest — POST /data/v2/generate/manifest returns a download URL
    // ==========================================

    async generateManifest(shipment) {
        try {
            const response = await this.request({
                method: 'post',
                url: '/data/v2/generate/manifest',
                data: { ids: [shipment.awb] }
            });

            const manifestUrl = response.data?.manifestDownloadUrl;
            if (!manifestUrl) return this.fail('Ekart did not return a manifest link', response.data);
            return this.ok({ manifestUrl, manifestNumber: response.data.manifestNumber || null }, response.data);
        } catch (error) {
            return this.fail(`Ekart manifest generation failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    // ==========================================
    // Cancel — DELETE /api/v1/package/cancel?tracking_id={awb}
    // ==========================================

    async cancelShipment(shipment) {
        try {
            const response = await this.request({
                method: 'delete',
                url: `/api/v1/package/cancel?tracking_id=${encodeURIComponent(shipment.awb)}`
            });

            // Response: { data: [ { status, remark, tracking_id } ] } (or a bare ack)
            const ack = response.data?.data?.[0] || response.data;
            if (ack?.status !== true) {
                const reason = this.extractReason(ack);
                console.error(`❌ Ekart cancel rejected for AWB ${shipment.awb}:`, JSON.stringify(response.data || {}).substring(0, 500));

                // Already cancelled at Ekart → treat as done (keeps re-ship moving)
                if (/already\s+(been\s+)?cancell?ed|cancell?ed\s+already/i.test(reason)) {
                    return this.ok({ cancelled: true, warning: `Already cancelled at Ekart: ${reason}` }, response.data);
                }
                return this.fail(`Ekart cancellation rejected: ${reason}`, response.data);
            }
            return this.ok({ cancelled: true }, response.data);
        } catch (error) {
            return this.fail(`Ekart cancellation failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }

    // ==========================================
    // Tracking — GET /api/v1/track/{awb}, normalized timeline (newest first)
    // ==========================================

    async track(awb) {
        try {
            const response = await this.request({
                method: 'get',
                url: `/api/v1/track/${encodeURIComponent(awb)}`,
                timeout: 20000
            });

            const data = response.data || {};
            const trackInfo = data.track;
            if (!trackInfo) return this.fail('No tracking data found for this AWB', data);

            const toIso = ms => {
                const n = Number(ms);
                return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : '';
            };

            const timeline = (trackInfo.details || []).map(d => ({
                date: toIso(d.ctime),
                location: d.location || '',
                activity: d.desc || d.status || '',
                status: d.status || ''
            })).reverse();

            return this.ok({
                currentStatus: trackInfo.status || 'Unknown',
                expectedDelivery: toIso(data.edd) || null,
                timeline
            }, data);
        } catch (error) {
            return this.fail(`Ekart tracking failed: ${this.describeAxiosError(error)}`, error.response?.data);
        }
    }
}

module.exports = new EkartAdapter();
