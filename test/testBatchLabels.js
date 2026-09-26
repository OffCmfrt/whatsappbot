// Run: node --test test/testBatchLabels.js
// Exercise real PDF merging and ZIP generation without a database or carrier network calls.
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { inflateRawSync } = require('node:zlib');
const { PDFDocument, degrees } = require('pdf-lib');
const axios = require('axios');

let shipments, batchExists, updates, generationCalls, generate;
function stubModule(path, exports) {
    require.cache[require.resolve(path)] = { id: require.resolve(path), filename: require.resolve(path), loaded: true, exports };
}
stubModule('../src/database/db', { dbAdapter: {
    query: async sql => {
        if (sql.includes('FROM shipment_batches')) return batchExists ? [{ batch_number: 'BATCH-TEST', carrier: 'delhivery' }] : [];
        assert.match(sql, /s.status NOT IN \('failed', 'cancelled'\)/);
        return shipments.filter(s => !['failed', 'cancelled'].includes(s.status)).map(s => ({ ...s }));
    },
    select: async (table, { id }) => shipments.filter(s => s.id === id),
    update: async (table, data, where) => { updates.push({ table, data, where }); }
} });
stubModule('../src/utils/cache', { caches: {} });
stubModule('../src/services/carriers', {
    getConfiguredCarriers: () => [],
    getAdapter: () => ({ generateLabel: async shipment => { generationCalls.push(shipment.id); return generate(shipment); } })
});
const shipping = require('../src/services/shippingService');
const delhivery = require('../src/services/carriers/delhiveryAdapter');
let onePage, twoPages, blankPdf;

async function makePdf(widths) {
    const pdf = await PDFDocument.create();
    for (const width of widths) {
        const page = pdf.addPage([width, 432]);
        page.drawText(`Carrier label ${width}`, { x: 15, y: 380, size: 10 });
        page.drawRectangle({ x: 20, y: 40, width: 150, height: 50 });
        if (width === 212) page.setRotation(degrees(90));
    }
    return Buffer.from(await pdf.save());
}
function shipment(id, extra = {}) {
    return {
        id, order_id: `#${id}`, awb: String(10000 + id), carrier: 'delhivery', courier_name: 'Delhivery',
        label_url: `https://labels.example/${id}.pdf`, status: 'awb_assigned',
        items_json: JSON.stringify([{ title: 'Tee', sku: 'TEE-M', size: 'M', quantity: 1 }]), ...extra
    };
}
function unpackZip(buffer) {
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.readUInt32LE(0), 0x04034b50);
    const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(end > 0);
    const count = buffer.readUInt16LE(end + 10);
    let offset = buffer.readUInt32LE(end + 16);
    const entries = new Map();
    for (let i = 0; i < count; i++) {
        assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
        const method = buffer.readUInt16LE(offset + 10);
        const compressedLength = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
        const data = buffer.subarray(start, start + compressedLength);
        const decoded = method === 8 ? inflateRawSync(data) : data;
        assert.ok(decoded.length > 0, `${name} must not be empty`);
        assert.ok(!entries.has(name), `Duplicate ZIP entry: ${name}`);
        entries.set(name, decoded);
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}
const pdfEntries = entries => [...entries].filter(([name]) => name.endsWith('.pdf'));

before(async () => {
    onePage = await makePdf([202]);
    twoPages = await makePdf([210, 212]);
    const blank = await PDFDocument.create();
    blank.addPage();
    blankPdf = Buffer.from(await blank.save());
});
beforeEach(() => {
    shipments = [shipment(2), shipment(10)];
    batchExists = true;
    updates = [];
    generationCalls = [];
    generate = async () => ({ success: false, error: 'Label unavailable' });
});

test('default ZIP has one multipage PDF per SKU folder, with preserved pages and index positions', async t => {
    t.mock.method(axios, 'get', async url => ({ data: url.endsWith('/2.pdf') ? onePage : twoPages }));
    const result = await shipping.buildBatchLabelsZip(1, { sortBy: 'order_id' });
    assert.equal(result.labelCount, 2);
    assert.equal(result.pageCount, 3);
    assert.equal(result.missingCount, 0);
    const entries = unpackZip(result.zipBuffer);
    const [[name, bytes]] = pdfEntries(entries);
    assert.equal(pdfEntries(entries).length, 1);
    assert.match(name, /TEE-M\/labels_2_shipments.pdf$/);
    const pdf = await PDFDocument.load(bytes);
    assert.deepEqual(pdf.getPages().map(page => page.getWidth()), [202, 210, 212]);
    assert.equal(pdf.getPage(2).getRotation().angle, 90);
    const index = entries.get('_label_index.csv').toString();
    assert.match(index, /"#2".*"OK".*"1","1"/);
    assert.match(index, /"#10".*"OK".*"2","3"/);
    assert.equal(generationCalls.length, 0);
});

test('an expired URL is refreshed and a raw carrier PDF is used without cloud storage', async t => {
    shipments = [shipment(1)];
    t.mock.method(axios, 'get', async () => { throw new Error('Request failed with status code 403'); });
    generate = async () => ({ success: true, data: { labelBuffer: onePage } });
    const result = await shipping.buildBatchLabelsZip(1);
    assert.equal(result.labelCount, 1);
    assert.deepEqual(generationCalls, [1]);
    assert.equal(updates.length, 0);
    assert.equal(pdfEntries(unpackZip(result.zipBuffer)).length, 1);
});

test('empty and HTML downloads regenerate a fresh URL instead of writing fake PDF files', async t => {
    t.mock.method(axios, 'get', async (url, config) => {
        assert.equal(config.responseType, 'arraybuffer');
        assert.ok(config.timeout > 0);
        if (url.includes('fresh')) return { data: onePage };
        return { data: url.endsWith('/2.pdf') ? Buffer.alloc(0) : Buffer.from('<html>Access denied</html>') };
    });
    generate = async s => ({ success: true, data: { labelUrl: `https://labels.example/fresh-${s.id}.pdf` } });
    const result = await shipping.buildBatchLabelsZip(1);
    assert.equal(result.labelCount, 2);
    assert.equal(updates.length, 2);
    assert.deepEqual(generationCalls.sort((a, b) => a - b), [2, 10]);
    const pdf = await PDFDocument.load(pdfEntries(unpackZip(result.zipBuffer))[0][1]);
    assert.equal(pdf.getPageCount(), 2);
});

test('strict mode reports every missing shipment and downloads nothing', async t => {
    shipments[1].label_url = null;
    t.mock.method(axios, 'get', async () => ({ data: onePage }));
    const result = await shipping.buildBatchLabelsZip(1);
    assert.equal(result.status, 502);
    assert.equal(result.zipBuffer, undefined);
    assert.equal(result.labelCount, 1);
    assert.equal(result.missingCount, 1);
    assert.equal(result.failures[0].orderId, '#10');
});

test('partial ZIP contains only valid PDFs and an explicit missing-label report', async t => {
    shipments[1].label_url = null;
    t.mock.method(axios, 'get', async () => ({ data: onePage }));
    const result = await shipping.buildBatchLabelsZip(1, { onFailure: 'skip' });
    assert.match(result.fileName, /_PARTIAL.zip$/);
    assert.equal(result.labelCount, 1);
    assert.equal(result.missingCount, 1);
    const entries = unpackZip(result.zipBuffer);
    assert.equal(pdfEntries(entries).length, 1);
    assert.match(entries.get('_failed_labels.csv').toString(), /"#10"/);
    assert.match(entries.get('_label_index.csv').toString(), /"#10".*"FAILED"/);
    assert.match(entries.get('_download_summary.txt').toString(), /PARTIAL DOWNLOAD/);
});

test('all labels failing never yields an empty ZIP, even in partial mode', async t => {
    t.mock.method(axios, 'get', async () => ({ data: Buffer.alloc(0) }));
    const result = await shipping.buildBatchLabelsZip(1, { onFailure: 'skip' });
    assert.equal(result.status, 502);
    assert.equal(result.failures.length, 2);
    assert.equal(result.zipBuffer, undefined);
});

test('blank or malformed PDFs are rejected after refreshing, without placeholder pages', async t => {
    t.mock.method(axios, 'get', async () => ({ data: blankPdf }));
    generate = async () => ({ success: true, data: { labelBuffer: Buffer.from('%PDF-1.7\ninvalid') } });
    const result = await shipping.buildBatchLabelsZip(1);
    assert.equal(result.status, 502);
    assert.ok(result.failures.every(f => /unreadable or empty PDF/.test(f.error)));
});

test('single batch PDF supports descending natural order and retains every source page', async t => {
    t.mock.method(axios, 'get', async url => ({ data: url.endsWith('/2.pdf') ? onePage : twoPages }));
    const result = await shipping.buildBatchLabelsZip(1, { output: 'pdf', sortBy: 'order_id', direction: 'desc' });
    assert.equal(result.contentType, 'application/pdf');
    assert.equal(result.zipBuffer, undefined);
    const pdf = await PDFDocument.load(result.pdfBuffer);
    assert.deepEqual(pdf.getPages().map(page => page.getWidth()), [210, 212, 202]);
});

test('individual PDFs and carrier folders work with mixed carriers', async t => {
    shipments[1].carrier = 'ekart';
    shipments[1].label_url = null;
    generate = async () => ({ success: true, data: { labelBuffer: twoPages } });
    t.mock.method(axios, 'get', async () => ({ data: onePage }));
    const result = await shipping.buildBatchLabelsZip(1, { output: 'individual', format: 'by_carrier' });
    const entries = unpackZip(result.zipBuffer);
    const pdfs = pdfEntries(entries);
    assert.equal(pdfs.length, 2);
    assert.ok(pdfs.some(([name]) => name.includes('_delhivery/')));
    assert.ok(pdfs.some(([name]) => name.includes('_ekart/')));
    assert.equal((entries.get('_label_index.csv').toString().match(/"OK"/g) || []).length, 2);
});

test('different SKUs that sanitize identically cannot collide, and multi-item shipments print once', async t => {
    const item = sku => ({ title: 'Tee', sku, quantity: 1 });
    shipments = [
        shipment(1, { items_json: JSON.stringify([item('A/B')]) }),
        shipment(2, { items_json: JSON.stringify([item('A_B')]) }),
        shipment(3, { items_json: JSON.stringify([item('A/B'), item('A_B')]) })
    ];
    t.mock.method(axios, 'get', async () => ({ data: onePage }));
    const result = await shipping.buildBatchLabelsZip(1);
    assert.equal(result.labelCount, 3);
    assert.equal(result.pageCount, 3);
    assert.equal(pdfEntries(unpackZip(result.zipBuffer)).length, 3);
});

test('product grouping combines sizes and flat grouping creates one root PDF', async t => {
    shipments[1].items_json = JSON.stringify([{ title: 'Tee', sku: 'TEE-L', size: 'L' }]);
    t.mock.method(axios, 'get', async () => ({ data: onePage }));
    for (const format of ['by_product', 'flat']) {
        const result = await shipping.buildBatchLabelsZip(1, { format });
        const pdfs = pdfEntries(unpackZip(result.zipBuffer));
        assert.equal(pdfs.length, 1);
        assert.equal(pdfs[0][0].includes('/'), format !== 'flat');
    }
});

test('no-AWB shipments remain in failure reports; canceled/failed shipments are excluded', async t => {
    shipments = [shipment(1, { awb: null, label_url: null }), shipment(2, { status: 'cancelled' }), shipment(3, { status: 'failed' })];
    t.mock.method(axios, 'get', async () => { throw new Error('Unexpected network request'); });
    const result = await shipping.buildBatchLabelsZip(1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].error, /no AWB/);
    assert.equal(generationCalls.length, 0);
});

test('invalid options and unknown or empty batches return errors', async () => {
    assert.equal((await shipping.buildBatchLabelsZip(1, { sortBy: 'invalid' })).status, 400);
    assert.equal((await shipping.buildBatchLabelsZip(1, { format: ['flat'] })).status, 400);
    assert.equal((await shipping.buildBatchLabelsZip(1, { output: 'pdf', onFailure: 'skip' })).status, 400);
    batchExists = false;
    assert.equal((await shipping.buildBatchLabelsZip(1)).status, 404);
    batchExists = true;
    shipments = [];
    assert.equal((await shipping.buildBatchLabelsZip(1)).status, 404);
});

test('batch retrieval uses bounded concurrency and keeps shipments with missing labels', async t => {
    let inFlight = 0, peak = 0;
    shipments = Array.from({ length: 12 }, (_, i) => shipment(i + 1));
    t.mock.method(axios, 'get', async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight--;
        return { data: onePage };
    });
    assert.equal((await shipping.buildBatchLabelsZip(1)).labelCount, 12);
    assert.ok(peak <= 4 && peak > 1);
    shipments[0].label_url = null;
    const labels = (await shipping.getBatchLabels(1)).data.labels;
    assert.equal(labels.length, 12);
    assert.equal(labels[0].label_error, 'Label unavailable');
});

test('CSV cells are quoted and formulas escaped; failure reports do not leak signed URLs', async t => {
    shipments[0].order_id = '=HYPERLINK("bad")';
    shipments[1].label_url = null;
    generate = async () => ({ success: false, error: 'Download failed https://labels.example/?signed=secret' });
    t.mock.method(axios, 'get', async () => ({ data: onePage }));
    const entries = unpackZip((await shipping.buildBatchLabelsZip(1, { onFailure: 'skip' })).zipBuffer);
    assert.match(entries.get('_label_index.csv').toString(), /"'=HYPERLINK\(""bad""\)"/);
    assert.doesNotMatch(entries.get('_failed_labels.csv').toString(), /signed=secret/);
});

test('Delhivery accepts direct binary PDFs and JSON links, normalizing relative/HTTP URLs', async t => {
    let payload = onePage;
    t.mock.method(axios, 'get', async (url, options) => {
        assert.equal(options.responseType, 'arraybuffer');
        assert.equal(options.params.pdf_size, '4R');
        return { data: payload };
    });
    assert.deepEqual((await delhivery.generateLabel({ awb: '123' })).data.labelBuffer, onePage);
    payload = Buffer.from(JSON.stringify({ packages: [{ wbn: '123', pdf_download_link: '/labels/123.pdf' }] }));
    assert.equal((await delhivery.generateLabel({ awb: '123' })).data.labelUrl, `${delhivery.baseURL}/labels/123.pdf`);
    payload = Buffer.from(JSON.stringify({ pdf_link: 'http://labels.example/123.pdf' }));
    assert.equal((await delhivery.generateLabel({ awb: '123' })).data.labelUrl, 'https://labels.example/123.pdf');
});

test('Delhivery rejects missing links, invalid schemes, and empty/HTML API responses', async t => {
    let payload;
    t.mock.method(axios, 'get', async () => ({ data: payload }));
    for (const value of ['', '<html>Error</html>', '{}', JSON.stringify({ pdf_link: 'javascript:alert(1)' })]) {
        payload = Buffer.from(value);
        assert.equal((await delhivery.generateLabel({ awb: '123' })).success, false);
    }
});
