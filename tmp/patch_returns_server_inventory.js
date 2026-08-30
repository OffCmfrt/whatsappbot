/**
 * One-time patch: add /api/internal/inventory-open-requests to the returns
 * server so the WhatsApp bot's Inventory Intelligence module can include
 * Shopify-portal returns/exchanges in its sellable-stock math.
 * Applies one exact-string replacement to
 * exchange-return-tracking-main/server.js (anchor: end of the ai-data endpoint).
 */
const fs = require('fs');
const PATH = '/Users/sunny/Downloads/OFFCOMFRT/exchange-return-tracking-main/server.js';

let src = fs.readFileSync(PATH, 'utf8');

if (src.includes('/api/internal/inventory-open-requests')) {
    console.log('✅ Already patched — nothing to do');
    process.exit(0);
}

// The returns server file uses CRLF line endings — normalize anchors/insertion
const crlf = (s) => s.replace(/\n/g, '\r\n');

function replaceOnce(src, oldStr, newStr, label) {
    const count = src.split(oldStr).length - 1;
    if (count !== 1) {
        console.error(`❌ ${label}: expected 1 occurrence, found ${count}`);
        process.exit(1);
    }
    console.log(`✅ ${label}: anchor unique, replacing`);
    return src.replace(oldStr, newStr);
}

const OLD = `    } catch (error) {
        console.error('AI data endpoint error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== PHONE OTP LOGIN (STOREFRONT) ====================`;

const NEW = `    } catch (error) {
        console.error('AI data endpoint error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Inventory pipeline endpoint for the WhatsApp bot's Inventory Intelligence
// module: returns OPEN return/exchange requests within a time window — i.e.
// units still physically out with customers and expected back (returns) or
// reserved as replacements (exchanges). Auth: x-internal-token.
app.get('/api/internal/inventory-open-requests', async (req, res) => {
    try {
        const expectedToken = process.env.WHATSAPP_INTERNAL_TOKEN;
        if (expectedToken && req.headers['x-internal-token'] !== expectedToken) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const windowDays = Math.max(0, Math.min(parseInt(req.query.window, 10) || 90, 730));
        // Statuses where the items are still out with the customer (not yet
        // received back at the warehouse). delivered/inspected = received,
        // rejected/cancelled = never coming back.
        const OPEN_STATUSES = ['pending', 'approved', 'scheduled', 'waiting_payment', 'pickup_pending', 'pickup_booked', 'picked_up', 'in_transit'];

        let query = supabase.from('requests')
            .select('request_id, order_number, type, status, items, created_at')
            .in('status', OPEN_STATUSES)
            .order('created_at', { ascending: false })
            .range(0, 999);
        if (windowDays > 0) {
            const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
            query = query.gte('created_at', since);
        }
        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, window_days: windowDays, count: (data || []).length, requests: data || [] });
    } catch (error) {
        console.error('Inventory open-requests endpoint error:', error.message);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ==================== PHONE OTP LOGIN (STOREFRONT) ====================`;

src = replaceOnce(src, crlf(OLD), crlf(NEW), 'inventory-open-requests endpoint');
fs.writeFileSync(PATH, src);
console.log('✅ Patched', PATH);
