// Read-only smoke test for GET /api/admin/inventory
// Now also verifies the external returns-server pipeline by stubbing
// /api/internal/inventory-open-requests inside the same test app.
require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const adminRoutes = require('../src/routes/adminRoutes');

const app = express();
app.use('/api/admin', adminRoutes);

// ---- Stub of the returns server's inventory pipeline endpoint ----
app.get('/api/internal/inventory-open-requests', (req, res) => {
    if (req.headers['x-internal-token'] !== (process.env.WHATSAPP_INTERNAL_TOKEN || '')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({
        success: true,
        window_days: parseInt(req.query.window, 10) || 90,
        count: 2,
        requests: [
            {
                request_id: 'STUB-RET-1', order_number: '99901', type: 'return', status: 'approved',
                created_at: new Date().toISOString(),
                items: [{ name: 'HENLEY - 001 ( ACID WASH )', variant: 'M', quantity: 2 }]
            },
            {
                request_id: 'STUB-EXCH-1', order_number: '99902', type: 'exchange', status: 'pickup_booked',
                created_at: new Date().toISOString(),
                items: [{
                    name: 'HENLEY - 001 ( ACID WASH )', variant: 'S', quantity: 1,
                    replacementProductTitle: 'HENLEY - 001 ( ACID WASH )', replacementVariant: 'L', replacementSku: ''
                }]
            }
        ]
    });
});

const server = app.listen(0, async () => {
    try {
        const port = server.address().port;
        // Point the inventory endpoint at our stub (read at request time)
        process.env.RETURNS_SERVER_URL = `http://127.0.0.1:${port}`;

        const token = jwt.sign(
            { role: 'operator', username: 'inv-smoke-test', permissions: [] },
            process.env.JWT_SECRET,
            { expiresIn: '5m' }
        );
        const t0 = Date.now();
        const res = await fetch(`http://127.0.0.1:${port}/api/admin/inventory?window=90`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        console.log('HTTP', res.status, '| success:', data.success, '| took', Date.now() - t0, 'ms');
        console.log('returns_server block:', JSON.stringify(data.returns_server, null, 2));
        console.log('summary:', JSON.stringify(data.summary, null, 2));

        // Baseline (previous verified run, no returns server):
        // return_incoming 0, exchange_incoming 0, exchange_outgoing 0, final 13579
        const s = data.summary;
        const checks = [
            ['returns server connected', data.returns_server?.connected === true],
            ['return_incoming = 2 (stub)', s.return_incoming_units === 2],
            ['exchange_incoming = 1 (stub)', s.exchange_incoming_units === 1],
            ['exchange_outgoing = 1 (stub)', s.exchange_outgoing_units === 1],
            ['final = 13579 + 2 + 1 - 1 = 13581', s.final_available_units === 13581]
        ];
        let pass = true;
        for (const [label, ok] of checks) {
            console.log(`${ok ? '✅' : '❌'} ${label}`);
            if (!ok) pass = false;
        }

        const henley = data.products.find(p => p.title.includes('HENLEY - 001'));
        if (henley) {
            const m = henley.variants.find(v => v.title === 'M');
            const sVar = henley.variants.find(v => v.title === 'S');
            const l = henley.variants.find(v => v.title === 'L');
            console.log('HENLEY M return_incoming:', m?.return_incoming, '(expect 2)');
            console.log('HENLEY S exchange_incoming:', sVar?.exchange_incoming, '(expect 1)');
            console.log('HENLEY L exchange_outgoing:', l?.exchange_outgoing, '(expect 1)');
            if (m?.return_incoming !== 2 || sVar?.exchange_incoming !== 1 || l?.exchange_outgoing !== 1) pass = false;
        } else {
            console.log('❌ HENLEY product not found');
            pass = false;
        }
        console.log(pass ? '\n🎉 ALL CHECKS PASSED' : '\n💥 SOME CHECKS FAILED');
    } catch (err) {
        console.error('SMOKE TEST FAILED:', err);
    } finally {
        server.close();
        process.exit(0);
    }
});
