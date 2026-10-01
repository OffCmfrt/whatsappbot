/**
 * Remove duplicate overdue invoices from Zoho
 * -------------------------------------------
 * Paginates through all invoices, groups by customer_id,
 * and deletes overdue invoices when a paid invoice exists for the same customer.
 *
 * Usage:
 *   node scripts/remove_duplicate_invoices.js              # dry-run
 *   node scripts/remove_duplicate_invoices.js --apply      # actually delete
 */
require('dotenv').config();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CONCURRENCY = parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1] || '5', 10);

function log(msg) { console.log(`${APPLY ? '[APPLY]' : '[DRY-RUN]'} ${msg}`); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  Remove Duplicate Overdue Invoices');
    console.log(`  Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}  |  Workers: ${CONCURRENCY}`);
    console.log('═══════════════════════════════════════════════════\n');

    const zohoService = require('../src/services/zohoService');
    const axios = require('axios');
    const token = await zohoService.getAccessToken();
    const orgId = process.env.ZOHO_ORGANIZATION_ID;
    const BOOKS = 'https://www.zohoapis.in/books/v3';
    const h = { 'Authorization': 'Zoho-oauthtoken ' + token, 'X-composer-orgid': orgId };

    // 1. Paginate through ALL invoices
    log('Fetching all invoices...');
    let page = 1, allInvoices = [];
    while (true) {
        const res = await axios.get(BOOKS + '/invoices?per_page=200&page=' + page, { headers: h });
        const batch = res.data?.invoices || [];
        allInvoices.push(...batch);
        if (batch.length < 200) break;
        page++;
        if (page % 10 === 0) log(`  Fetched ${allInvoices.length} invoices...`);
    }
    log(`Total invoices: ${allInvoices.length}`);

    // 2. Group by customer_id
    const byCustomer = {};
    for (const inv of allInvoices) {
        const cid = inv.customer_id;
        if (!cid) continue;
        if (!byCustomer[cid]) byCustomer[cid] = [];
        byCustomer[cid].push(inv);
    }

    // 3. Find customers with multiple invoices where at least one is overdue
    const toDelete = [];
    for (const [cid, invs] of Object.entries(byCustomer)) {
        if (invs.length < 2) continue;
        const paid = invs.filter(i => i.status === 'paid');
        const overdue = invs.filter(i => i.status === 'overdue');
        
        // If there's a paid invoice and overdue invoices, delete the overdue ones
        if (paid.length > 0 && overdue.length > 0) {
            for (const inv of overdue) {
                toDelete.push({
                    id: inv.invoice_id,
                    number: inv.invoice_number,
                    customer: inv.customer_name,
                    total: inv.total,
                    reason: 'overdue duplicate (paid exists)'
                });
            }
        }
        // If ALL are overdue, keep the newest (highest invoice number), delete the rest
        else if (overdue.length >= 2 && paid.length === 0) {
            const sorted = overdue.sort((a, b) => b.invoice_number.localeCompare(a.invoice_number));
            for (let i = 1; i < sorted.length; i++) {
                toDelete.push({
                    id: sorted[i].invoice_id,
                    number: sorted[i].invoice_number,
                    customer: sorted[i].customer_name,
                    total: sorted[i].total,
                    reason: 'older overdue duplicate'
                });
            }
        }
    }

    log(`\nFound ${toDelete.length} duplicate invoices to delete`);
    if (toDelete.length === 0) { log('Nothing to delete.'); return; }

    // Show first 20
    log('\nSample (first 20):');
    for (const d of toDelete.slice(0, 20)) {
        log(`  ${d.number} (${d.customer}) ₹${d.total} — ${d.reason}`);
    }
    if (toDelete.length > 20) log(`  ... and ${toDelete.length - 20} more`);

    if (!APPLY) { log('\nDry-run complete. Re-run with --apply.'); return; }

    // 4. Delete in bulk with concurrency
    const stats = { deleted: 0, failed: 0, errors: [] };
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < toDelete.length) {
            const idx = nextIndex++;
            const d = toDelete[idx];
            try {
                await axios.delete(BOOKS + '/invoices/' + d.id, { headers: h });
                stats.deleted++;
                if ((idx + 1) % 25 === 0) log(`Progress: ${idx + 1}/${toDelete.length} (✅${stats.deleted} ❌${stats.failed})`);
            } catch (e) {
                stats.failed++;
                stats.errors.push({ number: d.number, error: e.response?.data?.message || e.message });
            }
            await sleep(100);
        }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toDelete.length) }, () => worker()));

    console.log('\n═══════════════════════════════════════════════════');
    console.log('  DONE');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  Deleted: ${stats.deleted}`);
    console.log(`  Failed:  ${stats.failed}`);
    if (stats.errors.length > 0) {
        console.log('\n  FAILURES:');
        stats.errors.slice(0, 10).forEach(e => console.log(`    ${e.number}: ${e.error}`));
    }
    console.log('═══════════════════════════════════════════════════');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

