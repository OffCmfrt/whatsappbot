/**
 * Import Daily Inventory Report (Excel) into manual_inventory table.
 *
 * Usage:
 *   node scripts/import-inventory-report.js [path-to-xlsx]
 *
 * Defaults to "NEW Daily Inventory Report September (1).xlsx" in the project root.
 *
 * What it does:
 *   1. Reads the "Report Selling Pcs & Closing" sheet (sheet2).
 *   2. Picks the LATEST date's rows (closing stock snapshot).
 *   3. Upserts each product+size row into manual_inventory with:
 *        - quantity  = closing stock (column I)
 *        - reorder_level = reorder value (column J)
 *        - category  = category column (C)
 *   4. Logs every change as a 'sync' adjustment in inventory_adjustments.
 *   5. Reports summary (new / updated / skipped / reorder alerts).
 *
 * Run with --dry-run to preview without writing.
 */

require('dotenv').config();
const XLSX = require('xlsx');
const path = require('path');
const { pool } = require('../src/database/db');

// ── Config ──
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const XLSX_FILE = args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'NEW Daily Inventory Report September (1).xlsx');
const SHEET_NAME = 'Daily Stock Add';

// ── Helpers ──
function generateSkuKey(productName, size) {
  const base = String(productName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const sz = String(size).trim().toLowerCase();
  return `${base}-${sz}`;
}

function excelSerialToDate(serial) {
  // Excel serial date: days since 1900-01-01 (with the Lotus 1-2-3 leap year bug)
  const utcDays = Math.floor(serial - 25569);
  const d = new Date(utcDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function safeNum(val) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// ── Main ──
async function main() {
  console.log(`\n📦 Inventory Import Script`);
  console.log(`   File: ${XLSX_FILE}`);
  console.log(`   Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '🔴 LIVE (will write to DB)'}\n`);

  // 1. Read Excel
  const wb = XLSX.readFile(XLSX_FILE, { cellDates: false, raw: true });
  // Find sheet by trimmed name match
  const targetName = SHEET_NAME.trim();
  const matchedName = wb.SheetNames.find(n => n.trim() === targetName);
  const ws = matchedName ? wb.Sheets[matchedName] : null;
  if (!ws) {
    console.error(`❌ Sheet "${targetName}" not found. Available: ${wb.SheetNames.join(', ')}`);
    process.exit(1);
  }

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

  // 2. Find header row (contains "Date" and "Product Name")
  let headerIdx = -1;
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const r = rows[i];
    if (r && r.some(c => String(c).trim() === 'Date') && r.some(c => String(c).includes('Product Name'))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    console.error('❌ Could not find header row with "Date" and "Product Name"');
    process.exit(1);
  }

  const headers = rows[headerIdx].map(h => String(h).trim());
  const col = {
    date: headers.indexOf('Date'),
    product: headers.findIndex(h => h.includes('Product Name')),
    category: headers.indexOf('Category'),
    size: headers.indexOf('Size'),
    opening: headers.findIndex(h => h.includes('OPENING')),
    rto: headers.findIndex(h => h.includes('RTO')),
    bulkIn: headers.findIndex(h => h.includes('BULK IN')),
    stockOut: headers.findIndex(h => h.includes('STOCK OUT')),
    closing: headers.findIndex(h => h.includes('CLOSING')),
    reorder: headers.indexOf('REORDER'),
    status: headers.findIndex(h => h.includes('REORDER STATUS')),
  };

  console.log(`   Header row: ${headerIdx + 1}`);
  console.log(`   Columns mapped:`, Object.fromEntries(Object.entries(col).filter(([, v]) => v >= 0).map(([k, v]) => [k, headers[v]])));

  // 3. Parse all data rows and find the latest date
  const dataRows = rows.slice(headerIdx + 1).filter(r => r[col.date] !== '' && r[col.product] !== '');
  
  let maxDateSerial = 0;
  for (const r of dataRows) {
    const d = safeNum(r[col.date]);
    if (d > 0 && d > maxDateSerial) maxDateSerial = d;
  }

  const latestDateStr = maxDateSerial > 0 ? excelSerialToDate(maxDateSerial) : 'unknown';
  console.log(`\n   Latest date in sheet: ${latestDateStr} (serial ${maxDateSerial})`);

  // 4. Filter rows for latest date
  const latestRows = dataRows.filter(r => safeNum(r[col.date]) === maxDateSerial);
  console.log(`   Rows for latest date: ${latestRows.length}\n`);

  // 5. Build items array
  const items = [];
  for (const r of latestRows) {
    const productName = String(r[col.product]).trim();
    const size = String(r[col.size]).trim();
    const category = col.category >= 0 ? String(r[col.category]).trim() : 'T-SHIRT';
    const closingStock = safeNum(r[col.closing]);
    const reorderLevel = safeNum(r[col.reorder]);
    const skuKey = generateSkuKey(productName, size);

    if (!productName || !size) continue;

    items.push({
      sku_key: skuKey,
      product_name: productName,
      size: size.toUpperCase() === 'XS' ? 'xs' : size,
      category,
      quantity: closingStock,
      reorder_level: reorderLevel,
    });
  }

  // Print summary table
  console.log('─'.repeat(90));
  console.log('  SKU'.padEnd(45) + 'Product'.padEnd(32) + 'Size'.padEnd(6) + 'Qty'.padEnd(6) + 'Reorder');
  console.log('─'.repeat(90));
  const reorderItems = [];
  for (const item of items) {
    const flag = item.quantity <= item.reorder_level ? ' ⚠️' : '';
    if (flag) reorderItems.push(item);
    console.log(
      `  ${item.sku_key.slice(0, 43).padEnd(45)}` +
      `${item.product_name.slice(0, 30).padEnd(32)}` +
      `${item.size.padEnd(6)}` +
      `${String(item.quantity).padEnd(6)}` +
      `${item.reorder_level}${flag}`
    );
  }
  console.log('─'.repeat(90));
  console.log(`\n   Total SKUs: ${items.length}`);
  console.log(`   Reorder alerts: ${reorderItems.length}`);

  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN — no database changes. Run without --dry-run to import.\n');
    await pool.end();
    return;
  }

  // 6. Upsert into manual_inventory
  const timestamp = new Date().toISOString();
  let created = 0, updated = 0, unchanged = 0;

  // Deduplicate items by sku_key (keep last occurrence)
  const skuMap = new Map();
  for (const item of items) {
    skuMap.set(item.sku_key, item);
  }
  const dedupedItems = [...skuMap.values()];
  console.log(`   Deduplicated: ${items.length} → ${dedupedItems.length} SKUs\n`);

  for (const item of dedupedItems) {
    const existing = await pool.query('SELECT * FROM manual_inventory WHERE sku_key = $1', [item.sku_key]);
    const qtyBefore = existing.length > 0 ? (existing[0].quantity || 0) : null;

    if (qtyBefore === null) {
      // INSERT (use ON CONFLICT to handle any edge-case duplicates)
      try {
        await pool.query(
          `INSERT INTO manual_inventory (product_name, category, size, sku_key, quantity, reorder_level, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (sku_key) DO UPDATE SET quantity = $5, category = COALESCE($2, manual_inventory.category), reorder_level = $6, updated_at = $7`,
          [item.product_name, item.category, item.size, item.sku_key, item.quantity, item.reorder_level, timestamp]
        );
        created++;
      } catch (e) {
        console.error('  ⚠️  Upsert failed for', item.sku_key, ':', e.message);
        updated++;
      }
    } else if (qtyBefore !== item.quantity) {
      // UPDATE
      await pool.query(
        'UPDATE manual_inventory SET quantity = $1, category = COALESCE($2, category), reorder_level = $3, updated_at = $4 WHERE sku_key = $5',
        [item.quantity, item.category, item.reorder_level, timestamp, item.sku_key]
      );
      updated++;
    } else {
      unchanged++;
    }

    // Log adjustment
    const qtyBeforeVal = qtyBefore ?? 0;
    const change = item.quantity - qtyBeforeVal;
    await pool.query(
      `INSERT INTO inventory_adjustments
       (sku_key, product_name, size, adjustment_type, quantity_change, quantity_before, quantity_after, reference, notes, performed_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [item.sku_key, item.product_name, item.size, 'sync', change, qtyBeforeVal, item.quantity,
       'sept_inventory_report', `Imported from Daily Inventory Report (${latestDateStr})`, 'excel_import', timestamp]
    );
  }

  console.log(`\n✅ Import complete!`);
  console.log(`   Created: ${created}`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Unchanged: ${unchanged}`);
  console.log(`   Total: ${items.length}`);

  if (reorderItems.length > 0) {
    console.log(`\n⚠️  Reorder Alerts (${reorderItems.length}):`);
    for (const r of reorderItems) {
      console.log(`   • ${r.product_name} [${r.size}] — Stock: ${r.quantity}, Reorder at: ${r.reorder_level}`);
    }
  }

  await pool.end();
  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('❌ Import failed:', err.message);
  pool.end().then(() => process.exit(1));
});
