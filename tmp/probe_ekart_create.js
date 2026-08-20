// Probe: what does Ekart say when we create a shipment for an order that may
// already exist on its panel? Duplicate error body may carry the existing AWB.
// Uses buildShipmentContext for the payload, calls adapter.createShipment
// directly — NO DB writes happen here.
require('dotenv').config();
const { initializeDatabase, dbAdapter } = require('../src/database/db');
const { getAdapter } = require('../src/services/carriers');
const { buildShipmentContext } = require('../src/services/shippingService');

(async () => {
    await initializeDatabase();
    const rows = await dbAdapter.query(`
        SELECT id FROM store_shoppers WHERE order_id = '39628' AND status = 'confirmed' ORDER BY id DESC LIMIT 1
    `);
    const s = rows[0];
    if (!s) { console.log('shopper not found'); return; }

    const draft = await buildShipmentContext(s.id);
    if (draft.error) { console.log('draft error:', draft.error); return; }
    const ctx = draft.ctx;
    if (ctx.validationErrors.length > 0) { console.log('validation:', ctx.validationErrors); return; }

    const ekt = getAdapter('ekart');
    const result = await ekt.createShipment(ctx);
    console.log('success:', result.success);
    console.log('data:', JSON.stringify(result.data, null, 2).substring(0, 600));
    console.log('error:', result.error);
    console.log('raw:', JSON.stringify(result.raw, null, 2).substring(0, 800));
})();
