/**
 * Diagnose Zoho invoices from Sep 1 onwards using LOCAL DATABASE only
 * (no Zoho API calls). Checks the original_payload line_items for
 * missing or suspicious product names.
 * 
 * Usage: node scripts/diagnose_zoho_invoice_names.js
 */

require('dotenv').config();
const { dbAdapter } = require('../src/database/db');

const START_DATE = '2026-09-01';

async function main() {
    console.log(`\n🔍 Diagnosing Zoho invoices from ${START_DATE} onwards (DB-only, no API calls)...\n`);

    // Query all synced invoices from Sep 1 onwards with their payloads
    const syncLogs = await dbAdapter.query(`
        SELECT 
            shopify_order_id,
            zoho_invoice_id,
            status,
            created_at,
            original_payload
        FROM zoho_sync_log
        WHERE created_at >= $1
            AND status = 'synced'
            AND zoho_invoice_id IS NOT NULL
            AND original_payload IS NOT NULL
        ORDER BY created_at DESC
    `, [START_DATE]) || [];

    console.log(`Found ${syncLogs.length} synced invoices from ${START_DATE}\n`);

    const issues = [];
    const stats = { total: 0, withIssues: 0, totalLineItems: 0 };

    for (const log of syncLogs) {
        stats.total++;
        const payload = log.original_payload;
        
        if (!payload || !payload.line_items || !Array.isArray(payload.line_items)) {
            continue;
        }

        for (const li of payload.line_items) {
            stats.totalLineItems++;
            const hasName = li.name && String(li.name).trim() !== '';
            const isShipping = li.name === 'Shipping';
            const hasItemId = li.item_id && li.item_id !== '';

            // Check for missing name
            if (!hasName && !isShipping) {
                issues.push({
                    order_id: log.shopify_order_id,
                    invoice_id: log.zoho_invoice_id,
                    name: li.name || '(EMPTY)',
                    description: li.description || '(EMPTY)',
                    item_id: li.item_id || '(NONE)',
                    issue: 'MISSING_NAME'
                });
                continue;
            }

            // Check if name looks like just a SKU (all caps, no spaces, short)
            if (hasName && !isShipping) {
                const nameStr = String(li.name);
                // Bundle components often look like "SKU - SIZE" or just "SKU"
                // If it's all uppercase with no lowercase letters and no item_id, it's suspicious
                const looksLikeSkuOnly = /^[A-Z0-9\s-]+$/.test(nameStr) 
                    && nameStr.length < 40 
                    && !/[a-z]/.test(nameStr)
                    && !hasItemId;
                
                if (looksLikeSkuOnly) {
                    issues.push({
                        order_id: log.shopify_order_id,
                        invoice_id: log.zoho_invoice_id,
                        name: nameStr,
                        description: li.description || '(EMPTY)',
                        item_id: li.item_id || '(NONE)',
                        issue: 'NAME_LOOKS_LIKE_SKU'
                    });
                }
            }
        }

        if (issues.length > 0 && issues[issues.length - 1]?.order_id === log.shopify_order_id) {
            stats.withIssues++;
        }
    }

    console.log(`✅ Analyzed ${stats.total} invoices (${stats.totalLineItems} line items)\n`);
    console.log(`❌ Found ${issues.length} problematic line items in ${stats.withIssues} invoices\n`);

    if (issues.length > 0) {
        // Group by issue type
        const byIssue = {};
        for (const issue of issues) {
            if (!byIssue[issue.issue]) byIssue[issue.issue] = [];
            byIssue[issue.issue].push(issue);
        }

        for (const [issueType, items] of Object.entries(byIssue)) {
            console.log(`\n${issueType} (${items.length} occurrences):`);
            console.log('─'.repeat(100));
            for (const item of items.slice(0, 30)) {
                console.log(`  Order: ${item.order_id} | Invoice: ${item.invoice_id}`);
                console.log(`    Name: "${item.name}"`);
                console.log(`    Desc: "${item.description}"`);
                console.log(`    Item ID: ${item.item_id}`);
                console.log('');
            }
            if (items.length > 30) {
                console.log(`  ... and ${items.length - 30} more\n`);
            }
        }

        // Save full results
        const fs = require('fs');
        const outputFile = `tmp/diagnose_zoho_names_${new Date().toISOString().split('T')[0]}.json`;
        fs.writeFileSync(outputFile, JSON.stringify({ 
            summary: { 
                total_invoices: stats.total, 
                total_line_items: stats.totalLineItems,
                issues_found: issues.length,
                invoices_with_issues: stats.withIssues,
                by_type: Object.fromEntries(Object.entries(byIssue).map(([k, v]) => [k, v.length]))
            },
            issues 
        }, null, 2));
        console.log(`\n📄 Full results saved to: ${outputFile}`);
    }

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
