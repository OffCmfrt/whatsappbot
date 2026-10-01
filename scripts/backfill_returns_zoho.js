/**
 * Backfill: Add exchange/return notes + replacement items to existing Zoho invoices
 * --------------------------------------------------------------------------
 * NO credit notes. Just:
 *   - Comment on the invoice documenting the exchange/return
 *   - For exchanges: add replacement item as a line item (rate=0)
 *
 * Usage:
 *   node scripts/backfill_returns_zoho.js                    # dry-run
 *   node scripts/backfill_returns_zoho.js --apply            # actually sync
 *   node scripts/backfill_returns_zoho.js --apply --concurrency=10 --pace=300
 */
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xfirtmnciahexpnlnhdc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PACE_MS = parseInt((args.find(a => a.startsWith('--pace=')) || '').split('=')[1] || '300', 10);
const CONCURRENCY = parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1] || '10', 10);

function log(msg) { console.log(`${APPLY ? '[APPLY]' : '[DRY-RUN]'} ${msg}`); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchFinalizedRequests(sinceDate) {
    const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/requests?select=request_id,order_number,type,status,items,created_at,customer_name,customer_email,customer_phone&or=(status.eq.approved)&created_at=gte.${sinceDate}&order=created_at.asc`;
    const res = await fetch(url, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (!res.ok) throw new Error(`Supabase REST query failed: HTTP ${res.status}`);
    return await res.json();
}

async function processOrder(request, zohoService, axios, BOOKS, h) {
    const orderId = String(request.order_number || '').replace(/^#/, '');
    const isExchange = request.type === 'exchange';

    // Parse items
    let items = request.items;
    if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch (e) { items = []; }
    }
    const parsedItems = Array.isArray(items) ? items : [];
    if (parsedItems.length === 0) return { success: false, error: 'No items' };

    // Find the invoice in Zoho
    const invRes = await axios.get(BOOKS + '/invoices?search_text=' + orderId, { headers: h });
    const invs = invRes.data?.invoices || [];
    if (invs.length === 0) return { success: false, error: 'Invoice not found in Zoho' };

    // Get full invoice details
    const fullInv = await axios.get(BOOKS + '/invoices/' + invs[0].invoice_id, { headers: h });
    const invoice = fullInv.data?.invoice;
    if (!invoice) return { success: false, error: 'Could not fetch invoice details' };

    const results = [];

    // Build the comment text
    const origSummary = parsedItems.map(i =>
        `${i.quantity || 1}x ${i.name || i.title || 'item'}${i.variant ? ' (' + i.variant + ')' : ''}`
    ).join(', ');

    let noteText = '';
    if (isExchange) {
        const exchSummary = parsedItems.map(i =>
            `${i.quantity || 1}x ${i.replacementProductTitle || i.name || 'item'}${i.replacementVariant ? ' (' + i.replacementVariant + ')' : ''}`
        ).join(', ');
        noteText = `EXCHANGE — ${new Date().toISOString().split('T')[0]}\nOriginal: ${origSummary}\nExchanged for: ${exchSummary}\nRequest: ${request.request_id || 'N/A'}`;
    } else {
        noteText = `RETURN — ${new Date().toISOString().split('T')[0]}\nItems: ${origSummary}\nRequest: ${request.request_id || 'N/A'}`;
    }

    // 1. Add comment to invoice
    try {
        await zohoService.addInvoiceComment(invoice.invoice_id, noteText);
        results.push('comment added');
    } catch (e) {
        results.push('comment failed: ' + e.message);
    }

    // 2. For exchanges: add replacement item as line item (rate=0)
    if (isExchange) {
        try {
            const currentLines = invoice.line_items || [];
            const replacementLines = parsedItems.map(i => ({
                name: i.replacementProductTitle || i.name || i.title || 'Replacement Item',
                description: `Exchange replacement${i.replacementVariant ? ' - ' + i.replacementVariant : ''}`,
                quantity: parseFloat(i.quantity || 1),
                rate: 0,
                discount: 0
            }));

            const updatedPayload = {
                line_items: [...currentLines.map(li => ({
                    item_id: li.item_id,
                    name: li.name,
                    description: li.description,
                    quantity: parseFloat(li.quantity),
                    rate: parseFloat(li.rate),
                    discount: parseFloat(li.discount || 0),
                    tax_id: li.tax_id
                })), ...replacementLines]
            };

            await zohoService.updateInvoice(invoice.invoice_id, updatedPayload, 'Adding exchange replacement item for backfill');
            results.push('replacement item added');
        } catch (e) {
            results.push('replacement item failed: ' + e.message);
        }
    }

    return { success: true, invoiceId: invoice.invoice_id, invoiceNumber: invoice.invoice_number, results };
}

async function main() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  Returns/Exchange → Zoho Invoice Notes (SIMPLE)');
    console.log(`  Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}  |  Workers: ${CONCURRENCY}  |  Pace: ${PACE_MS}ms`);
    console.log('═══════════════════════════════════════════════════\n');

    if (!SUPABASE_KEY) { console.error('❌ SUPABASE keys not set'); process.exit(1); }

    log('Fetching approved requests since 2026-09-01...');
    const requests = await fetchFinalizedRequests('2026-09-01');
    const returns = requests.filter(r => r.type === 'return');
    const exchanges = requests.filter(r => r.type === 'exchange');
    log(`Found ${requests.length}: ${returns.length} returns, ${exchanges.length} exchanges\n`);

    if (requests.length === 0) { log('Nothing to process.'); return; }
    if (!APPLY) { log('Dry-run complete. Re-run with --apply.'); return; }

    // Init Zoho
    const zohoService = require('../src/services/zohoService');
    const axios = require('axios');
    const token = await zohoService.getAccessToken();
    const orgId = process.env.ZOHO_ORGANIZATION_ID;
    const BOOKS = 'https://www.zohoapis.in/books/v3';
    const h = { 'Authorization': 'Zoho-oauthtoken ' + token, 'X-composer-orgid': orgId };

    const stats = { done: 0, failed: 0, errors: [], processed: 0 };
    const total = requests.length;
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < total) {
            const idx = nextIndex++;
            const r = requests[idx];
            const label = `[${idx + 1}/${total}]`;

            try {
                const result = await processOrder(r, zohoService, axios, BOOKS, h);
                if (result.success) {
                    stats.done++;
                    log(`${label} ✅ #${r.order_number} (${r.type}) → ${result.results.join(', ')}`);
                } else {
                    stats.failed++;
                    stats.errors.push({ order: r.order_number, error: result.error });
                    log(`${label} ❌ #${r.order_number} → ${result.error}`);
                }
            } catch (err) {
                stats.failed++;
                stats.errors.push({ order: r.order_number, error: err.message });
                log(`${label} ❌ #${r.order_number} → ${err.message}`);
            }

            stats.processed++;
            if (stats.processed % 50 === 0) {
                log(`Progress: ${stats.processed}/${total} (✅${stats.done} ❌${stats.failed})`);
            }
            await sleep(PACE_MS);
        }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));

    console.log('\n═══════════════════════════════════════════════════');
    console.log('  DONE');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  Processed: ${stats.done}`);
    console.log(`  Failed:    ${stats.failed}`);
    if (stats.errors.length > 0) {
        console.log('\n  FAILURES:');
        stats.errors.slice(0, 20).forEach(e => console.log(`    #${e.order}: ${e.error}`));
    }
    console.log('═══════════════════════════════════════════════════');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
