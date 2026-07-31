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

    // Product line printed on the label / packing slip:
    //   "Relaxed Tee (M) x2, Cargo Pants (32) x1"
    // Size matters for apparel returns & warehouse picking, so it is always
    // included when the item carries one. Drops whole items (never half a
    // product name) when the carrier's field length runs out.
    formatProductsDesc(items = [], maxLength = 200, fallback = 'Apparel') {
        const parts = [];
        let length = 0;
        for (const item of items) {
            const part = `${item.name}${item.size ? ` (${item.size})` : ''} x${item.quantity || 1}`;
            const added = parts.length ? part.length + 2 : part.length; // ', ' separator
            if (length + added > maxLength) break;
            parts.push(part);
            length += added;
        }
        // A single oversized product still needs *something* descriptive
        if (!parts.length && items.length) return items[0].name.substring(0, maxLength);
        return parts.join(', ') || fallback;
    }

    // Extract the rejection reason from a carrier's JSON body (HTTP 200 + a
    // failure flag). Carriers scatter it across remark/rmk/error/errors/message
    // and flip between string, array and nested shapes, so every known spot is
    // tried before falling back to the body itself — a rejection must never be
    // reported as "unknown reason" when the carrier did explain itself.
    extractReason(payload, fallback = 'no reason returned by the carrier') {
        const flatten = (value) => {
            if (value === null || value === undefined) return '';
            if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join('; ');
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value).trim();
        };

        if (!payload || typeof payload !== 'object') return flatten(payload) || fallback;

        const candidates = [
            payload.remark, payload.remarks, payload.rmk, payload.reason,
            payload.error, payload.errors, payload.error_message,
            payload.message, payload.msg,
            payload.packages?.[0]?.remarks, payload.packages?.[0]?.remark,
            payload.data?.[0]?.remark, payload.data?.[0]?.remarks, payload.data?.remark
        ];
        for (const candidate of candidates) {
            const text = flatten(candidate);
            if (text && text !== '{}' && text !== '[]') return text.substring(0, 300);
        }

        // Nothing recognizable — surface the raw body so the reason isn't lost
        const body = JSON.stringify(payload);
        return body && body !== '{}' ? `${fallback} (response: ${body.substring(0, 300)})` : fallback;
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
