/**
 * Carrier registry — single place that knows every available carrier adapter.
 *
 * To add a new carrier (BlueDart, DTDC, Xpressbees...):
 *   1. Create src/services/carriers/<carrier>Adapter.js extending BaseCarrier
 *   2. Require + register it below
 *   3. Add its env credentials — it appears in the Shopper Hub automatically
 */

const delhiveryAdapter = require('./delhiveryAdapter');
const shiprocketAdapter = require('./shiprocketAdapter');
const ekartAdapter = require('./ekartAdapter');

const ADAPTERS = {
    [delhiveryAdapter.key]: delhiveryAdapter,
    [shiprocketAdapter.key]: shiprocketAdapter,
    [ekartAdapter.key]: ekartAdapter
};

// Only carriers whose env credentials are present (drives the UI carrier list)
function getConfiguredCarriers() {
    return Object.values(ADAPTERS)
        .filter(adapter => adapter.isConfigured())
        .map(adapter => ({
            key: adapter.key,
            name: adapter.name,
            capabilities: adapter.capabilities
        }));
}

// Returns the adapter or null (caller decides how to error)
function getAdapter(key) {
    const adapter = ADAPTERS[key];
    if (!adapter || !adapter.isConfigured()) return null;
    return adapter;
}

module.exports = { getConfiguredCarriers, getAdapter };
