/**
 * Sample check: fetch 20 recent invoices from Zoho and compare line item names
 * to what's in our local database.
 * 
 * Usage: node scripts/sample_check_zoho_invoices.js
 */

require('dotenv').config();
const { dbAdapter } = require('../src/database/db');
const zohoService = require('../src/services/zohoService');

async function main() {
    console.log('\n🔍 Sampling 20 recent invoices from Zoho to compare with local DB...\n');

    // Get 20 recent synced invoices
    const syncLogs = await dbAdapter.query(`
        SELECT 
            shopify_order_id,
            zoho_invoice_id,
            original_payload
        FROM zoho_sync_log
        WHERE created_at >= '2026-09-01'
            AND status = 'synced'
            AND zoho_invoice_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 20
    `) || [];

    console.log(`Found ${syncLogs.length} invoices to check\n`);

    let mismatches = 0;

    for (const log of syncLogs) {
        try {
            console.log(`\nChecking Order #${log.shopify_order_id} (Invoice ${log.zoho_invoice_id})...`);
            
            // Fetch from Zoho
            const zohoInvoice = await zohoService.getInvoice(log.zoho_invoice_id);
            
            if (!zohoInvoice || !zohoInvoice.line_items) {
                console.log('  ⚠️  No line items in Zoho invoice');
                continue;
            }

            const localPayload = log.original_payload;
            const localItems = localPayload?.line_items || [];

            console.log(`  Zoho has ${zohoInvoice.line_items.length} line items, local has ${localItems.length}`);

            // Compare each line item
            for (let i = 0; i < zohoInvoice.line_items.length; i++) {
                const zohoItem = zohoInvoice.line_items[i];
                const localItem = localItems[i];

                if (!localItem) {
                    console.log(`  ⚠️  Line ${i + 1}: Missing in local payload`);
                    continue;
                }

                const zohoName = zohoItem.name || '(EMPTY)';
                const localName = localItem.name || '(EMPTY)';
                const zohoItemId = zohoItem.item_id || '(NONE)';
                const localItemId = localItem.item_id || '(NONE)';

                if (zohoName !== localName || zohoItemId !== localItemId) {
                    console.log(`  ❌ MISMATCH on line ${i + 1}:`);
                    console.log(`     Local name: "${localName}" → Zoho name: "${zohoName}"`);
                    console.log(`     Local item_id: ${localItemId} → Zoho item_id: ${zohoItemId}`);
                    mismatches++;
                } else {
                    console.log(`  ✓ Line ${i + 1}: "${zohoName}" (item_id: ${zohoItemId})`);
                }
            }

            // Rate limiting
            await new Promise(r => setTimeout(r, 200));
        } catch (err) {
            console.error(`  ❌ Error: ${err.message}`);
        }
    }

    console.log(`\n\n✅ Check complete. Found ${mismatches} mismatches.\n`);
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
