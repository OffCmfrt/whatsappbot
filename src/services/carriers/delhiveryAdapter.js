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
 *   Create (CMU)   : POST /api/cmu/create.json  (body: format=json&data={...})
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

    // Create shipment via CMU API — returns waybill (AWB) directly
    async createShipment(ctx) {
        try {
            const pin = this.normalizePincode(ctx.consignee.pincode);
            if (!pin) return this.fail('Invalid delivery pincode (must be 6 digits)');

            const isCod = ctx.payment.mode === 'COD';
            const productsDesc = ctx.items.map(i => `${i.name} x${i.quantity}`).join(', ').substring(0, 200) || 'Apparel';
            const totalQty = ctx.items.reduce((sum, i) => sum + (i.quantity || 1), 0) || 1;

            const cmuPayload = {
                shipments: [{
                    name: ctx.consignee.name,
                    add: ctx.consignee.address,
                    city: ctx.consignee.city || '',
                    state: ctx.consignee.state || '',
                    country: ctx.consignee.country || 'India',
                    pin: pin,
                    phone: this.normalizePhone(ctx.consignee.phone),
                    order: ctx.orderId,
                    payment_mode: isCod ? 'COD' : 'Prepaid',
                    cod_amount: isCod ? String(ctx.payment.codAmount || 0) : '0',
                    total_amount: String(ctx.payment.declaredValue || 0),
                    products_desc: productsDesc,
                    quantity: String(totalQty),
                    weight: String(ctx.package.weightGrams || 500),
                    shipment_length: String(ctx.package.lengthCm || 30),
                    shipment_width: String(ctx.package.breadthCm || 40),
                    shipment_height: String(ctx.package.heightCm || 2)
                }],
                pickup_location: {
                    name: process.env.DELHIVERY_PICKUP_LOCATION
                }
            };

            // Delhivery CMU expects a form-encoded body: format=json&data=<json>
            // (URLSearchParams also escapes &/+/# inside addresses & product names)
            const body = new URLSearchParams({
                format: 'json',
                data: JSON.stringify(cmuPayload)
            });

            const response = await axios.post(`${this.baseURL}/api/cmu/create.json`, body.toString(), {
                headers: {
                    ...this.authHeaders(),
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 30000
            });

            const pkg = response.data?.packages?.[0];
            if (!pkg || (pkg.status && pkg.status.toLowerCase() !== 'success') || !pkg.waybill) {
                const remarks = pkg?.remarks
                    ? (Array.isArray(pkg.remarks) ? pkg.remarks.join('; ') : pkg.remarks)
                    : (response.data?.rmk || 'Unknown Delhivery error');
                return this.fail(`Delhivery shipment creation failed: ${remarks}`, response.data);
            }

            return this.ok({
                awb: pkg.waybill,
                courierName: 'Delhivery',
                carrierShipmentId: pkg.waybill,
                carrierOrderId: pkg.refnum || ctx.orderId,
                freightCharge: null,
                trackingUrl: `https://www.delhivery.com/track/package/${pkg.waybill}`,
                requestPayload: cmuPayload
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

    async cancelShipment(shipment) {
        try {
            const response = await axios.post(`${this.baseURL}/api/p/edit`, {
                waybill: shipment.awb,
                cancellation: 'true'
            }, {
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                timeout: 20000
            });

            if (response.data?.status === false) {
                return this.fail(`Delhivery cancellation rejected: ${response.data?.remark || 'unknown reason'}`, response.data);
            }
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
