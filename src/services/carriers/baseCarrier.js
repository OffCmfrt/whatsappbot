/**
 * BaseCarrier — common interface for all carrier adapters.
 *
 * Every adapter implements the same contract so the shipping service and the
 * Shopper Hub UI never need carrier-specific logic. Adding a new carrier
 * (BlueDart, DTDC, Xpressbees...) = one new adapter file + env vars.
 *
 * All adapter methods return a normalized result object:
 *   { success: true,  data: {...}, raw: <carrier response> }
 *   { success: false, error: 'human readable message', raw: <carrier response> }
 */

class BaseCarrier {
    constructor(key, name) {
        this.key = key;   // machine key, e.g. 'delhivery'
        this.name = name; // display name, e.g. 'Delhivery'
    }

    // Capabilities drive the UI (courier picker, manifest button, etc.)
    get capabilities() {
        return {
            needsCourierSelection: false, // aggregators expose a courier list to pick from
            supportsManifest: false,
            supportsInvoice: false,
            supportsPickup: true,
            supportsLabel: true,
            supportsCancel: true,
            supportsTracking: true
        };
    }

    // True only when all required env credentials are present
    isConfigured() {
        return false;
    }

    /* eslint-disable no-unused-vars */
    // ctx = shipment context built by shippingService.buildShipmentContext()
    async checkServiceability(ctx) {
        return this.fail(`${this.name}: serviceability check not implemented`);
    }

    async createShipment(ctx) {
        return this.fail(`${this.name}: createShipment not implemented`);
    }

    async generateLabel(shipment) {
        return this.fail(`${this.name}: generateLabel not implemented`);
    }

    async schedulePickup(shipment, pickupDate) {
        return this.fail(`${this.name}: schedulePickup not implemented`);
    }

    async cancelShipment(shipment) {
        return this.fail(`${this.name}: cancelShipment not implemented`);
    }

    async track(awb) {
        return this.fail(`${this.name}: tracking not implemented`);
    }
    /* eslint-enable no-unused-vars */

    // ==========================================
    // Shared helpers
    // ==========================================

    ok(data, raw = null) {
        return { success: true, data, raw };
    }

    fail(error, raw = null) {
        return { success: false, error, raw };
    }

    // Normalize to a 10-digit Indian mobile number (carriers reject 91-prefixed)
    normalizePhone(phone) {
        if (!phone) return '';
        const digits = phone.toString().replace(/\D/g, '');
        if (digits.length === 10) return digits;
        if (digits.length > 10) return digits.slice(-10);
        return digits;
    }

    // Validate/normalize a 6-digit Indian pincode
    normalizePincode(pin) {
        if (!pin) return '';
        const digits = pin.toString().replace(/\D/g, '');
        return digits.length === 6 ? digits : '';
    }

    // Extract a readable error message from an axios error
    describeAxiosError(error) {
        const data = error.response?.data;
        if (data) {
            if (typeof data === 'string') return data.substring(0, 300);
            const msg = data.message || data.error || data.errors;
            if (msg) return typeof msg === 'string' ? msg : JSON.stringify(msg).substring(0, 300);
            return JSON.stringify(data).substring(0, 300);
        }
        return error.message;
    }
}

module.exports = BaseCarrier;
