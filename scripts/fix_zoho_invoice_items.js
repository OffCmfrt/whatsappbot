/**
 * Bulk fix: Update Zoho invoices from Sep 1 onwards to add missing item_ids
 * so inventory syncs correctly.
 * 
 * Strategy:
 * 1. Load all Zoho items once into memory (with pagination)
 * 2. Query local DB for invoices from Sep 1 onwards
 * 3. For each invoice, fetch from Zoho and check which line items are missing item_id
 * 4. For missing items, search the local item map using normalized name matching
 * 5. Update the invoice in Zoho with the correct item_ids
 * 
 * Usage: node scripts/fix_zoho_invoice_items.js [--dry-run] [--limit=N]
 */

require('dotenv').config();
const { dbAdapter } = require('../src/database/db');
const zohoService = require('../src/services/zohoService');

const START_DATE = '2026-09-01';
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 0;

// Normalize name for matching (strip all whitespace and uppercase)
const normName = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

// Convert our name format to Zoho's format: "Product - XS" -> "Product (XS)"
function toZohoNameFormat(name) {
    if (!name) return name;
    // Match " - SIZE" at the end and convert to "(SIZE)"
    return name.replace(/\s*-\s*(XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|28|30|32|34|36|38|40|42|44|46|48|FREE|FREE SIZE|ONESIZE|ONE SIZE|DEFAULT)\s*$/i, 
        (match, size) => ` (${size.toUpperCase()})`);
}

async function loadAllZohoItems() {
    console.log('\n📦 Loading all Zoho items into memory...');
    const items = [];
    let page = 1;
    const perPage = 200;

    while (true) {
        const result = await zohoService.searchItem({ per_page: perPage, page });
        if (!result || result.length === 0) break;
        items.push(...result);
        console.log(`  Loaded ${items.length} items...`);
        if (result.length < perPage) break;
        page++;
        await new Promise(r => setTimeout(r, 100));
    }

    console.log(`✅ Loaded ${items.length} Zoho items\n`);
    
    // Build a map: normalized name -> item
    const itemMap = new Map();
    for (const item of items) {
        const norm = normName(item.name);
        itemMap.set(norm, item);
    }
    
    return { items, itemMap };
}

function findItemInMap(itemMap, name) {
    if (!name) return null;
    
    // Parse the name to extract base product and size
    const sizeMatch = name.match(/\s*[-(]\s*(XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|28|30|32|34|36|38|40|42|44|46|48|FREE|FREE SIZE|ONESIZE|ONE SIZE|DEFAULT)\s*[)]?\s*$/i);
    const size = sizeMatch ? sizeMatch[1].toUpperCase() : null;
    const baseName = sizeMatch ? name.replace(sizeMatch[0], '').trim() : name;
    
    // Try exact match first
    let item = itemMap.get(normName(name));
    if (item) return item;
    
    // Try converting to Zoho format: "Product (XS)" -> "Product - XS"
    if (size) {
        const zohoName = `${baseName} - ${size}`;
        item = itemMap.get(normName(zohoName));
        if (item) return item;
    }
    
    // Try matching with different size formats but same size
    if (size) {
        for (const [norm, item] of itemMap.entries()) {
            // Parse the item name to extract its base and size
            const itemSizeMatch = item.name.match(/\s*[-(]\s*(XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|28|30|32|34|36|38|40|42|44|46|48|FREE|FREE SIZE|ONESIZE|ONE SIZE|DEFAULT)\s*[)]?\s*$/i);
            const itemSize = itemSizeMatch ? itemSizeMatch[1].toUpperCase() : null;
            const itemBase = itemSizeMatch ? item.name.replace(itemSizeMatch[0], '').trim() : item.name;
            
            // Match if base names are the same AND sizes are the same
            if (normName(itemBase) === normName(baseName) && itemSize === size) {
                return item;
            }
        }
    }
    
    return null;
}

async function main() {
    console.log(`\n🔧 Fixing Zoho invoice item_ids from ${START_DATE} onwards${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

    // Load all Zoho items
    const { items: allItems, itemMap } = await loadAllZohoItems();

    // Query invoices from local DB
    const syncLogs = await dbAdapter.query(`
        SELECT 
            shopify_order_id,
            zoho_invoice_id,
            original_payload
        FROM zoho_sync_log
        WHERE created_at >= $1
            AND status = 'synced'
            AND zoho_invoice_id IS NOT NULL
        ORDER BY created_at DESC
    `, [START_DATE]) || [];

    console.log(`Found ${syncLogs.length} invoices to check\n`);

    const stats = {
        total: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        itemsFixed: 0
    };

    for (const log of syncLogs) {
        stats.total++;
        
        if (LIMIT > 0 && stats.total > LIMIT) {
            console.log(`\n⏸️  Reached limit of ${LIMIT} invoices`);
            break;
        }

        if (stats.total % 50 === 0) {
            console.log(`\nProgress: ${stats.total}/${syncLogs.length} (Updated: ${stats.updated}, Items fixed: ${stats.itemsFixed})\n`);
        }

        try {
            // Fetch invoice from Zoho
            const zohoInvoice = await zohoService.getInvoice(log.zoho_invoice_id);
            
            if (!zohoInvoice || !zohoInvoice.line_items) {
                stats.skipped++;
                continue;
            }

            // Check which line items are missing item_id
            const linesToUpdate = [];
            for (const li of zohoInvoice.line_items) {
                // Skip if already has item_id
                if (li.item_id && li.item_id !== '') continue;
                
                // Skip shipping lines
                if (li.name === 'Shipping') continue;

                // Try to find the item in our map
                const item = findItemInMap(itemMap, li.name);
                
                if (item) {
                    linesToUpdate.push({
                        line_item_id: li.line_item_id,
                        item_id: item.item_id,
                        name: li.name,
                        zoho_item_name: item.name
                    });
                } else {
                    console.log(`  ⚠️  Order #${log.shopify_order_id}: Could not find item for "${li.name}"`);
                }
            }

            if (linesToUpdate.length === 0) {
                stats.skipped++;
                continue;
            }

            console.log(`\nOrder #${log.shopify_order_id} (Invoice ${log.zoho_invoice_id}):`);
            console.log(`  Found ${linesToUpdate.length} line items missing item_id`);

            if (DRY_RUN) {
                for (const lu of linesToUpdate) {
                    console.log(`    [DRY RUN] Would set item_id=${lu.item_id} for "${lu.name}" -> "${lu.zoho_item_name}"`);
                }
                stats.itemsFixed += linesToUpdate.length;
                stats.updated++;
            } else {
                // Build the update payload with all line items
                const updatePayload = {
                    line_items: zohoInvoice.line_items.map(li => {
                        const update = linesToUpdate.find(lu => lu.line_item_id === li.line_item_id);
                        return {
                            line_item_id: li.line_item_id,
                            item_id: update ? update.item_id : li.item_id,
                            name: li.name,
                            description: li.description,
                            quantity: li.quantity,
                            rate: li.rate,
                            discount: li.discount || 0
                        };
                    }),
                    // Zoho requires a reason when updating sent invoices
                    reason: 'Fixing missing item_id linkage for inventory sync'
                };

                await zohoService.updateInvoice(log.zoho_invoice_id, updatePayload);
                console.log(`  ✅ Updated invoice with ${linesToUpdate.length} item_ids`);
                
                for (const lu of linesToUpdate) {
                    console.log(`    ✓ Set item_id=${lu.item_id} for "${lu.name}" -> "${lu.zoho_item_name}"`);
                }

                stats.itemsFixed += linesToUpdate.length;
                stats.updated++;
            }

            // Rate limiting
            await new Promise(r => setTimeout(r, 150));
        } catch (err) {
            console.error(`  ❌ Error processing invoice ${log.zoho_invoice_id}: ${err.message}`);
            stats.errors++;
        }
    }

    console.log(`\n\n${'═'.repeat(60)}`);
    console.log(`✅ Fix complete!`);
    console.log(`   Total invoices: ${stats.total}`);
    console.log(`   Updated: ${stats.updated}`);
    console.log(`   Skipped (no issues): ${stats.skipped}`);
    console.log(`   Errors: ${stats.errors}`);
    console.log(`   Line items fixed: ${stats.itemsFixed}`);
    console.log(`${'═'.repeat(60)}\n`);

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
