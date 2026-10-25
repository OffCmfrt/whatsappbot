#!/usr/bin/env node
/**
 * Retry failed RTO balance fix invoices from the bulk run
 * Reads the failed invoice numbers from the JSON report and re-processes them
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zohoService = require('../src/services/zohoService');

const REPORT_PATH = path.join(__dirname, '../tmp/rto_balance_fix_bulk_2026-10-22.json');

async function main() {
  console.log('[RETRY] Reading failed invoices from report...');
  
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  const failedInvoices = report.errors.map(err => {
    const match = err.match(/^(OFF\/[^\s:]+)/);
    return match ? match[1] : null;
  }).filter(Boolean);

  console.log(`[RETRY] Found ${failedInvoices.length} failed invoices to retry`);
  
  if (failedInvoices.length === 0) {
    console.log('[RETRY] No failed invoices to retry');
    return;
  }

  console.log('[RETRY] Fetching all RTO credit notes to build lookup map...');
  
  // Fetch all RTO credit notes (same as bulk script)
  let allCreditNotes = [];
  let page = 1;
  const perPage = 200;
  
  while (true) {
    const result = await zohoService.zohoRequest('get', `${zohoService.BOOKS_BASE()}/creditnotes`, null, {
      date_start: '2026-09-01',
      per_page: perPage,
      page: page
    });
    
    const creditNotes = result.creditnotes || [];
    if (creditNotes.length === 0) break;
    
    allCreditNotes = allCreditNotes.concat(creditNotes);
    
    if (creditNotes.length < perPage) break;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }

  const rtoCreditNotes = allCreditNotes.filter(cn => 
    (cn.reference_number || '').startsWith('RTO-')
  );

  console.log(`[RETRY] Found ${rtoCreditNotes.length} RTO credit notes`);

  // Build map: order number → credit note info
  const rtoMap = new Map();
  for (const cn of rtoCreditNotes) {
    const ref = cn.reference_number || '';
    const match = ref.match(/RTO-(\d+)/);
    if (match) {
      const orderNum = match[1];
      rtoMap.set(orderNum, {
        credit_note_id: cn.creditnote_id,
        customer_id: cn.customer_id,
        customer_name: cn.customer_name,
        reference_number: cn.reference_number
      });
    }
  }

  console.log(`[RETRY] Built RTO map: ${rtoMap.size} entries`);

  // Fetch overdue invoices to get details for failed ones
  console.log('[RETRY] Fetching overdue invoices...');
  
  let allInvoices = [];
  page = 1;
  
  while (true) {
    const result = await zohoService.zohoRequest('get', `${zohoService.BOOKS_BASE()}/invoices`, null, {
      status: 'overdue',
      date_start: '2026-09-01',
      per_page: perPage,
      page: page
    });
    
    const invoices = result.invoices || [];
    if (invoices.length === 0) break;
    
    allInvoices = allInvoices.concat(invoices);
    
    if (invoices.length < perPage) break;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[RETRY] Found ${allInvoices.length} overdue invoices`);

  // Filter to only the failed invoices
  const invoicesToRetry = allInvoices.filter(inv => 
    failedInvoices.includes(inv.invoice_number)
  );

  console.log(`[RETRY] Matched ${invoicesToRetry.length} failed invoices for retry`);

  // Process each failed invoice
  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < invoicesToRetry.length; i++) {
    const inv = invoicesToRetry[i];
    const invNum = inv.invoice_number;
    
    try {
      // Extract order number from reference
      const invRef = inv.reference_number || '';
      const orderNum = invRef.replace(/^#/, '').replace(/.*\//, '').trim();
      
      const rtoInfo = rtoMap.get(orderNum);
      if (!rtoInfo) {
        console.log(`[RETRY]   [${i+1}/${invoicesToRetry.length}] ⚠️  ${invNum}: No RTO credit note found`);
        skipped++;
        continue;
      }

      // Check if invoice still has balance
      if (inv.balance <= 0.01) {
        console.log(`[RETRY]   [${i+1}/${invoicesToRetry.length}] ⏭️  ${invNum}: Already balanced (₹${inv.balance})`);
        skipped++;
        continue;
      }

      // Create credit note (same logic as bulk script)
      const preTaxRate = Math.round((inv.balance / 1.05) * 100) / 100;
      
      const creditNotePayload = {
        customer_id: rtoInfo.customer_id,
        customer_name: rtoInfo.customer_name,
        date: new Date().toISOString().split('T')[0],
        line_items: [{
          name: 'RTO Shipping/COD Charge Reversal',
          description: 'Reversal of unreversed shipping/COD charges for RTO order',
          quantity: 1,
          rate: preTaxRate,
          igst_rate: 5
        }],
        notes: `RTO balance reversal — Shopify Order ${orderNum}`,
        reference_number: `RTO-MISC-${inv.reference_number || inv.invoice_number}`,
        is_inclusive_tax: true
      };

      const cnResult = await zohoService.zohoRequest('post', `${zohoService.BOOKS_BASE()}/creditnotes`, creditNotePayload, { invoice_id: inv.invoice_id });
      const creditNoteNumber = cnResult.creditnote.creditnote_number;

      console.log(`[RETRY]   [${i+1}/${invoicesToRetry.length}] ✅ ${invNum} (Order ${orderNum}): ₹${inv.balance.toFixed(2)} → ${creditNoteNumber}`);
      created++;

      // Delay between calls
      await new Promise(r => setTimeout(r, 600));

    } catch (err) {
      console.log(`[RETRY]   [${i+1}/${invoicesToRetry.length}] ❌ ${invNum}: ${err.message}`);
      failed++;
      errors.push(`${invNum}: ${err.message}`);
      
      // Backoff on rate limit or network errors
      if (err.message.includes('400') || err.message.includes('network') || err.message.includes('timeout')) {
        console.log('[RETRY]   ⏳ Waiting 30s before retry...');
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }

  console.log('\n[RETRY] ========================================');
  console.log(`[RETRY] Retry complete!`);
  console.log(`[RETRY]   Created: ${created}`);
  console.log(`[RETRY]   Skipped: ${skipped}`);
  console.log(`[RETRY]   Failed:  ${failed}`);
  console.log('[RETRY] ========================================\n');

  if (errors.length > 0) {
    console.log('[RETRY] Failed invoices:');
    errors.forEach(e => console.log(`[RETRY]   - ${e}`));
  }

  // Write retry report
  const retryReport = {
    timestamp: new Date().toISOString(),
    retried: invoicesToRetry.length,
    created,
    skipped,
    failed,
    errors
  };

  const reportPath = path.join(__dirname, `../tmp/rto_balance_retry_${new Date().toISOString().split('T')[0]}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(retryReport, null, 2));
  console.log(`[RETRY] Report written to ${reportPath}`);
}

main().catch(err => {
  console.error('[RETRY] Fatal error:', err);
  process.exit(1);
});
