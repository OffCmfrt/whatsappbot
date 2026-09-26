// Run: node --test test/testExchangeDispatches.js
// All database and carrier operations are in-memory stubs. No .env is loaded.
'use strict';
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { inflateRawSync } = require('node:zlib');
const { PDFDocument, PDFName, degrees, decodePDFRawStream } = require('pdf-lib');
const mapping = require('../../exchange-return-tracking-main/config/exchange-dispatches');
const labels = require('../src/services/labelExportService');
const stub = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
let records, batches, sqlLog, backup, nextBatch, fetchSource, failSql, releaseCount;
const clone = value => structuredClone(value);
async function query(sql, args = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    sqlLog.push({ sql: s, args: clone(args) });
    assert.doesNotMatch(s, /\b(shipments|shipment_batches|store_shoppers)\b/);
    if (failSql?.(s, args)) throw new Error('Injected transaction failure');
    if (s === 'BEGIN') { backup = clone({ records, batches, nextBatch }); return { rows: [] }; }
    if (s === 'ROLLBACK') { ({ records, batches, nextBatch } = backup); return { rows: [] }; }
    if (s === 'COMMIT' || s.includes('pg_advisory_xact_lock')) return { rows: [] };
    let result = [];
    if (s.startsWith('SELECT * FROM exchange_dispatch_batches')) result = batches.filter(b => b.id === String(args[0]));
    else if (s.startsWith('SELECT') && s.includes('FROM exchange_dispatches')) {
        if (s.includes('booking_key=$1')) result = records.filter(r => r.booking_key === args[0]);
        else if (s.includes('batch_id=$1')) result = records.filter(r => r.batch_id === String(args[0]) && (!s.includes('active=TRUE') || r.active));
        else if (s.includes('id=ANY')) result = records.filter(r => args[0].map(String).includes(r.id));
        else throw new Error(`Unhandled SELECT: ${s}`);
    } else if (s.startsWith('INSERT INTO exchange_dispatch_batches')) {
        let batch = s.includes('ON CONFLICT') && batches.find(b => b.auto_key === args[2]);
        if (!batch) {
            batch = { id: String(nextBatch++), batch_code: args[0], custom_name: args[1], kind: s.includes("'automatic'") ? 'automatic' : 'custom', auto_key: s.includes('ON CONFLICT') ? args[2] : null, revision: 1 };
            batches.push(batch);
        }
        result = [batch];
    } else if (s.startsWith('INSERT INTO exchange_dispatches')) {
        const [request_id, booking_key, identity, snapshot, batch_id, seen_scan] = args;
        let row = records.find(r => r.booking_key === booking_key);
        if (row) {
            // Assert production SQL preserves custom membership, not just this test double.
            const update = s.split('DO UPDATE SET')[1];
            assert.doesNotMatch(update, /\bbatch_id\s*=/);
            if (row.identity !== identity) { row.label_state = 'unchecked'; row.label_error = null; }
            Object.assign(row, { identity, snapshot: JSON.parse(snapshot), active: true, seen_scan, revision: row.revision + 1 });
        } else records.push({ id: String(records.length + 1), request_id, booking_key, identity, snapshot: JSON.parse(snapshot), batch_id: String(batch_id), seen_scan, active: true, revision: 1, label_state: 'unchecked', label_error: null });
    } else if (s.startsWith('UPDATE exchange_dispatches SET active=FALSE')) {
        for (const r of records) if (r.active && r.seen_scan !== args[0]) { r.active = false; r.revision++; }
    } else if (s.startsWith('UPDATE exchange_dispatches SET batch_id')) {
        const field = s.includes('WHERE batch_id=ANY') ? 'batch_id' : 'id';
        for (const r of records) if (args[1].map(String).includes(r[field])) Object.assign(r, { batch_id: String(args[0]), manual_group: true, revision: r.revision + 1 });
    } else if (s.startsWith('UPDATE exchange_dispatches SET label_state')) {
        for (const r of records) if (r.id === String(args[2]) && r.identity === args[3]) { r.label_state = args[0]; r.label_error = args[1]; }
    } else if (s.startsWith('UPDATE exchange_dispatch_batches')) {
        const rename = s.includes('custom_name=$1');
        const ids = rename ? [String(args[1])] : s.includes('ANY') ? args[0].map(String) : s.includes('WHERE id=$1') ? [String(args[0])] : batches.map(b => b.id);
        for (const b of batches) if (ids.includes(b.id)) { b.revision++; if (rename) b.custom_name = args[0]; }
    } else throw new Error(`Unhandled query: ${s}`);
    return { rows: clone(result) };
}
stub('../src/database/db', { pool: { query, connect: async () => ({ query, release: () => releaseCount++ }) } });
stub('axios', async config => fetchSource(config));
const servicePath = require.resolve('../src/services/exchangeDispatchService');
let service;
let onePage;
function sourceRow(n, extra = {}) {
    return mapping.normalizeRequest({ request_id: `EX-${n}`, order_number: `#${n}`, type: 'exchange', status: 'received', forward_carrier: 'delhivery', forward_shipment_id: `shipment-${n}`, forward_awb_number: `forward-${n}`, forward_status: 'scheduled', customer_name: 'Test Recipient', shipping_city: 'Delhi', items: [{ name: 'Original Tee', sku: 'OLD-M', variantId: 1, variant: 'M', replacementVariantId: 2, replacementProductTitle: 'Replacement Tee', replacementVariant: 'Blue / XL', replacementSku: 'NEW-XL', quantity: 2 }], ...extra });
}
async function seed(rows) { await service.applySync(rows); }
const selection = () => records.filter(r => r.active).map(r => ({ id: r.id, revision: r.revision }));
function sourceMock(rows, pdf = onePage) {
    return async config => {
        assert.equal(config.maxRedirects, 0);
        assert.equal(config.headers['x-internal-token'], 'test-internal-token');
        if (config.url.endsWith('/lookup')) return { data: { success: true, dispatches: rows.filter(r => config.data.requestIds.includes(r.request_id)) } };
        if (config.responseType === 'arraybuffer') {
            const row = rows.find(r => config.url.includes(`/${r.request_id}/label`));
            assert.equal(config.params.identity, row.identity);
            return { data: pdf };
        }
        return { data: { success: true, dispatches: rows, next_cursor: null } };
    };
}
function unzip(buffer) {
    const entries = new Map();
    const end = buffer.lastIndexOf(Buffer.from('504b0506', 'hex'));
    let offset = buffer.readUInt32LE(end + 16);
    for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
        const size = buffer.readUInt32LE(offset + 20), n = buffer.readUInt16LE(offset + 28);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + n);
        const local = buffer.readUInt32LE(offset + 42);
        const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const bytes = buffer.subarray(start, start + size);
        assert.ok(!entries.has(name));
        entries.set(name, buffer.readUInt16LE(offset + 10) === 8 ? inflateRawSync(bytes) : bytes);
        offset += 46 + n + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    }
    return entries;
}
async function assertThermal(bytes, pages) {
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), pages);
    for (const p of pdf.getPages()) {
        assert.deepEqual(p.getSize(), { width: 288, height: 432 });
        assert.deepEqual(p.getCropBox(), { x: 0, y: 0, width: 288, height: 432 });
        assert.equal(p.getRotation().angle, 0);
    }
    return pdf;
}
before(async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([288, 432]).drawText('TEST OUTBOUND LABEL', { x: 10, y: 390 });
    onePage = Buffer.from(await pdf.save());
});
beforeEach(() => {
    records = []; batches = []; sqlLog = []; nextBatch = 1; releaseCount = 0; failSql = null;
    process.env.RETURNS_SERVER_URL = 'https://returns.example';
    process.env.WHATSAPP_INTERNAL_TOKEN = 'test-internal-token';
    fetchSource = async () => { throw new Error('Unexpected source request'); };
    delete require.cache[servicePath]; service = require(servicePath);
});

test('mapping never uses pickup fields or original SKU for a different replacement', () => {
    const row = sourceRow(1, { type: 'return', resolution: 'exchange', carrier: 'ekart', awb_number: 'reverse-only' });
    assert.equal(row.carrier, 'delhivery'); assert.equal(row.awb, 'forward-1');
    assert.equal(row.items[0].sku, 'NEW-XL'); assert.equal(row.original_items[0].sku, 'OLD-M');
    const [missing] = mapping.outgoingItems([{ sku: 'OLD', variantId: 1, replacementVariantId: 2, replacementProductTitle: 'New product' }]);
    assert.equal(missing.sku, '');
    const cleared = sourceRow(1, { forward_shipment_id: null, forward_awb_number: null, awb_number: 'reverse-only' });
    assert.equal(cleared.booked, false); assert.equal(cleared.awb, '');
});

test('booking events preserve immutable outgoing items and pending AWB identity', () => {
    const pending = sourceRow(1, { forward_awb_number: '' });
    const assigned = sourceRow(1);
    assert.equal(pending.booking_key, assigned.booking_key); assert.notEqual(pending.identity, assigned.identity);
    assert.notEqual(assigned.booking_key, sourceRow(1, { forward_shipment_id: 'replacement-booking' }).booking_key);
    const event = mapping.dispatchEvent({ requestId: 'EX-1' }, 'delhivery', 'shipment-1', '', [{ replacementProductTitle: 'Booked product', replacementVariant: 'S', quantity: 1 }]);
    const snapshot = sourceRow(1, { request_history: [event] });
    assert.equal(snapshot.date_source, 'booking_event'); assert.equal(snapshot.items[0].title, 'Booked product');
});

test('legacy dates require reliable history; unknown dates remain unknown; grouping is IST', () => {
    assert.equal(sourceRow(1, { updated_at: '2026-09-26T10:00:00Z' }).dispatched_at, null);
    const event = { action: 'resolution_selected', resolution: 'exchange', timestamp: '2026-09-25T20:00:00Z' };
    const row = sourceRow(1, { request_history: [event] });
    assert.equal(row.date_source, 'resolution_history'); assert.equal(service.automaticGroup(row).key, '2026-09-26:delhivery');
    assert.equal(sourceRow(1, { request_history: [event], admin_notes: 'Duplicate forward order created' }).dispatched_at, null);
    assert.match(service.automaticGroup(sourceRow(1)).name, /unknown/);
});

test('replacement grouping retains full combinations and uses replacement size', () => {
    const enriched = service.enrich(sourceRow(1));
    assert.equal(enriched.size_group, 'XL'); assert.equal(enriched.sku_group, 'NEW-XL');
    assert.match(enriched.product_summary, /Replacement Tee \(XL\) x2/);
    const explicit = service.enrich({ items: [{ title: 'Tee', size: 'S', variant: 'Red / M', quantity: 1 }] });
    assert.equal(explicit.size_group, 'S');
    const multiple = service.enrich({ items: [{ title: 'B', sku: 'B', size: 'L' }, { title: 'A', sku: 'A', size: 'S' }] });
    assert.equal(multiple.sku_group, 'A + B'); assert.equal(multiple.size_group, 'S + L');
});

test('source pagination reads beyond 1,000 rows and rejects incomplete/repeated scans', async () => {
    const all = Array.from({ length: 1205 }, (_, i) => sourceRow(i + 1));
    let calls = 0;
    const collected = await service.collectSource(async (_path, { params }) => {
        calls++; const offset = Number(params?.cursor || 0);
        return { dispatches: all.slice(offset, offset + 100), next_cursor: offset + 100 < all.length ? String(offset + 100) : null };
    });
    assert.equal(collected.length, 1205); assert.equal(calls, 13);
    await assert.rejects(service.collectSource(async () => ({ dispatches: [all[0]], next_cursor: 'same' })), /did not advance/);
});

test('refresh retains manual grouping; new bookings supersede old records and cleared bookings disappear', async () => {
    const row = sourceRow(1, { forward_awb_number: '' }); await seed([row]);
    const created = await service.mutate('create', { name: 'Packing Desk A', selection: selection() }, 'tester');
    const assigned = sourceRow(1); await seed([assigned]);
    assert.equal(records.length, 1); assert.equal(records[0].batch_id, created.batchId); assert.equal(records[0].manual_group, true);
    assert.equal(records[0].snapshot.awb, 'forward-1');
    const replacement = sourceRow(1, { forward_shipment_id: 'new-booking', forward_awb_number: 'new-awb' }); await seed([replacement]);
    assert.equal(records.length, 2); assert.equal(records[0].active, false); assert.equal(records[1].active, true);
    await seed([sourceRow(1, { forward_shipment_id: null, forward_awb_number: null })]);
    assert.ok(records.every(r => !r.active));
    assert.ok(sqlLog.some(q => q.sql.includes('pg_advisory_xact_lock'))); assert.ok(releaseCount > 0);
});

test('failed or partial source scans preserve saved records and report stale data', async () => {
    const row = sourceRow(1); fetchSource = sourceMock([row]);
    assert.equal((await service.sync({ force: true })).connected, true);
    const saved = clone(records);
    let calls = 0;
    fetchSource = async () => { if (calls++) throw new Error('Offline'); return { data: { success: true, dispatches: [], next_cursor: 'EX-100' } }; };
    const result = await service.sync({ force: true });
    assert.equal(result.connected, false); assert.ok(result.lastSync); assert.match(result.error, /unavailable/);
    assert.deepEqual(records, saved);
});

test('overlapping syncs coalesce, and automatic sync is throttled', async () => {
    let calls = 0;
    fetchSource = async () => { calls++; await new Promise(r => setTimeout(r, 5)); return { data: { success: true, dispatches: [], next_cursor: null } }; };
    await Promise.all([service.sync(), service.sync()]); await service.sync();
    assert.equal(calls, 1);
});

test('merge and split retain one membership, preserve codes on rename, and roll back on failure', async () => {
    await seed([sourceRow(1), sourceRow(2), sourceRow(3)]);
    const { batchId } = await service.mutate('create', { name: 'Custom', selection: selection().slice(0, 1) }, 'tester');
    const custom = batches.find(b => b.id === batchId), code = custom.batch_code;
    await service.mutate('rename', { name: 'Renamed', batchId, revision: custom.revision }, 'tester');
    assert.equal(custom.batch_code, code); assert.equal(custom.custom_name, 'Renamed');
    const refs = batches.map(b => ({ id: b.id, revision: b.revision }));
    const merged = await service.mutate('merge', { name: 'Merged', batches: refs }, 'tester');
    assert.ok(records.every(r => r.batch_id === merged.batchId));
    const before = clone({ records, batches }); let inserts = 0;
    failSql = sql => sql.startsWith('INSERT INTO exchange_dispatch_batches') && ++inserts === 2;
    await assert.rejects(service.mutate('split', { batchId: merged.batchId, revision: batches.at(-1).revision, size: 1 }, 'tester'), /Injected/);
    assert.deepEqual({ records, batches }, before); assert.equal(sqlLog.at(-1).sql, 'ROLLBACK');
    failSql = null;
    await service.mutate('split', { batchId: merged.batchId, revision: batches.at(-1).revision, size: 1 }, 'tester');
    assert.equal(new Set(records.map(r => r.batch_id)).size, 3);
});

test('move rejects stale batch/dispatch revisions and successful moves survive sync', async () => {
    const rows = [sourceRow(1), sourceRow(2)]; await seed(rows);
    const created = await service.mutate('create', { name: 'Target', selection: selection().slice(0, 1) }, 'tester');
    const target = batches.find(b => b.id === created.batchId);
    await assert.rejects(service.mutate('move', { batchId: target.id, revision: 0, selection: selection().slice(1) }, 'tester'), e => e.status === 409);
    await assert.rejects(service.mutate('move', { batchId: target.id, revision: target.revision, selection: [{ id: '2', revision: 99 }] }, 'tester'), e => e.status === 409);
    await service.mutate('move', { batchId: target.id, revision: target.revision, selection: selection().slice(1) }, 'tester');
    await seed(rows); assert.ok(records.every(r => r.batch_id === target.id));
});

test('invalid filters and selection shapes fail with safe validation errors', () => {
    for (const f of [{ from: '2026-02-30' }, { carrier: ['ekart'] }, { status: 'bogus' }, { page: -1 }, { batchId: '1;DROP' }, { view: 'invalid' }, { history: 'invalid' }]) assert.throws(() => service.filters(f), e => e.status === 400);
    for (const s of [[], [null], [{ id: '0', revision: 1 }], [{ id: 1, revision: '1' }]]) assert.throws(() => service.selection(s), e => e.status === 400);
    assert.equal(service.selection([{ id: 1, revision: 1 }, { id: 1, revision: 1 }]).length, 1);
    const filtered = service.filters({ q: "' OR 1=1", from: '2026-09-01' });
    assert.doesNotMatch(filtered.where, /OR 1=1/); assert.match(filtered.where, /Asia\/Kolkata/);
});

test('Axios status errors are sanitized and mapped without signed URL leakage', async () => {
    for (const status of [401, 403, 404, 409, 413, 500]) {
        fetchSource = async () => { throw Object.assign(new Error('https://private.example/?signed=secret'), { isAxiosError: true, status, response: { status } }); };
        await assert.rejects(service.source(), err => !err.message.includes('secret') && err.status === ({ 401: 503, 403: 503, 404: 503, 409: 409, 413: 413 }[status] || 502));
    }
});

test('failed labels can be retried after source revalidation', async () => {
    const row = sourceRow(1); await seed([row]); records[0].label_state = 'failed'; records[0].label_error = 'Earlier transient failure';
    fetchSource = sourceMock([row]);
    const result = await service.download({ selection: selection(), options: { output: 'pdf' } });
    assert.equal(result.labelCount, 1); assert.equal(result.error, undefined); await assertThermal(result.pdfBuffer, 1);
    assert.equal(records[0].label_state, 'ready'); assert.equal(records[0].label_error, null);
});

test('changed, cleared, canceled, and superseded references cannot print', async () => {
    const row = sourceRow(1); await seed([row]);
    for (const current of [sourceRow(1, { forward_awb_number: 'new' }), sourceRow(1, { forward_shipment_id: null, forward_awb_number: null }), sourceRow(1, { forward_status: 'cancelled' })]) {
        fetchSource = sourceMock([current]); const result = await service.download({ selection: selection() });
        assert.equal(result.status, 502); assert.equal(result.zipBuffer, undefined);
    }
    records[0].active = false; fetchSource = sourceMock([row]);
    assert.equal((await service.download({ selection: [{ id: '1', revision: records[0].revision }] })).status, 502);
});

test('duplicates print once; missing AWBs cause strict failure or explicit partial ZIP reports', async () => {
    const rows = [sourceRow(1), sourceRow(2, { forward_awb_number: 'forward-1' }), sourceRow(3, { forward_awb_number: '' })];
    await seed(rows); fetchSource = sourceMock(rows);
    const strict = await service.download({ selection: [...selection(), selection()[0]] });
    assert.equal(strict.status, 502); assert.equal(strict.missingCount, 1); assert.equal(strict.labelCount, 1);
    const result = await service.download({ selection: selection(), options: { onFailure: 'skip' } });
    const entries = unzip(result.zipBuffer); const pdfs = [...entries].filter(([n]) => n.endsWith('.pdf'));
    assert.equal(pdfs.length, 1); await assertThermal(pdfs[0][1], 1);
    assert.match(entries.get('_label_index.csv').toString(), /DUPLICATE REFERENCE/);
    assert.match(entries.get('_failed_labels.csv').toString(), /EX-3/);
    assert.match(entries.get('_download_summary.txt').toString(), /4 x 6 inches/);
});

test('100-dispatch limit, four-worker bound, cancellation, and aggregate byte cap', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => sourceRow(i + 1)); await seed(rows);
    await assert.rejects(service.download({ batchId: batches[0].id, revision: batches[0].revision }), e => e.status === 413);
    let running = 0, peak = 0; const base = sourceMock(rows);
    fetchSource = async config => {
        if (config.responseType !== 'arraybuffer') return base(config);
        running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 3)); running--; return base(config);
    };
    const selected = selection().slice(0, 12);
    assert.equal((await service.download({ selection: selected })).labelCount, 12); assert.ok(peak > 1 && peak <= 4);
    const signal = AbortSignal.abort();
    await assert.rejects(service.download({ selection: selected }, signal));
    const big = Buffer.concat([onePage, Buffer.alloc(8 * 1024 * 1024)]);
    fetchSource = sourceMock(rows, big);
    await assert.rejects(service.download({ selection: selected, options: { onFailure: 'skip' } }), e => e.status === 413);
});

test('manifest is a separate A4 internal document and needs authoritative availability', async () => {
    const row = sourceRow(1); await seed([row]); fetchSource = sourceMock([row]);
    const result = await service.manifest({ selection: selection() });
    const pdf = await PDFDocument.load(result.pdfBuffer);
    assert.ok(Math.abs(pdf.getPage(0).getWidth() - 595.28) < 0.1); assert.match(result.fileName, /packing_manifest/);
    fetchSource = async () => { throw new Error('Offline'); };
    await assert.rejects(service.manifest({ selection: selection() }), /unavailable/);
});

test('normalization preserves multipage vector content, rotation, CropBox offsets, and exact thermal dimensions', async () => {
    const pdf = await PDFDocument.create();
    for (const [width, height, rotation, x, y] of [[288, 432, 0, 0, 0], [432, 288, 0, 0, 0], [500, 700, 90, 23, 31], [595, 842, 180, 10, 20], [700, 500, 270, 13, 37]]) {
        const page = pdf.addPage([width + x, height + y]); page.setCropBox(x, y, width, height); page.setRotation(degrees(rotation));
        page.drawRectangle({ x: x + 4, y: y + 4, width: width - 8, height: height - 8 });
        page.drawText('Vector test label', { x: x + 10, y: y + 80, size: 10 });
    }
    const normalized = await labels.normalizeThermal(await labels.loadLabelPdf(Buffer.from(await pdf.save())));
    const result = await assertThermal(await normalized.pdf.save(), 5);
    assert.ok(normalized.warnings.length >= 2);
    const page = result.getPage(2);
    const resources = page.node.Resources().lookup(PDFName.of('XObject'));
    const form = resources.lookup(resources.keys()[0]);
    assert.equal(form.dict.get(PDFName.of('Subtype')).toString(), '/Form');
    assert.deepEqual(form.dict.lookup(PDFName.of('BBox')).asArray().map(n => n.asNumber()), [23, 31, 523, 731]);
    assert.deepEqual(form.dict.lookup(PDFName.of('Matrix')).asArray().map(n => n.asNumber()), [1, 0, 0, 1, -23, -31]);
    assert.match(Buffer.from(decodePDFRawStream(form).decode()).toString(), /Tj/);
});

test('sorting, validation, and packaging preserve original sizes unless thermal normalization is requested', async () => {
    assert.deepEqual(['10', 'M', 'XS', '2', 'Unspecified', 'XL'].sort(labels.compareSize), ['XS', 'M', 'XL', '2', '10', 'Unspecified']);
    const list = [{ id: 2, order_id: '#10', size_group: 'M' }, { id: 1, order_id: '#2', size_group: 'S' }];
    labels.sortLabels(list, { sortBy: 'size', direction: 'asc' }); assert.equal(list[0].id, 1);
    assert.throws(() => labels.options({ output: 'pdf', onFailure: 'skip' }));
    await assert.rejects(labels.loadLabelPdf(Buffer.from('<html>Expired</html>')), /non-PDF/);
    await assert.rejects(labels.loadLabelPdf(Buffer.from('%PDF-1.7\ninvalid')), /unreadable/);
    const source = await PDFDocument.create(); source.addPage([210, 550]).drawText('original');
    const result = await labels.packageLabels([{ pdf: source, order_id: '#1' }], 'REGULAR', { output: 'pdf' });
    assert.equal((await PDFDocument.load(result.pdfBuffer)).getPage(0).getWidth(), 210);
    assert.match(labels.csvCell('=HYPERLINK("bad")'), /^"'/);
});
