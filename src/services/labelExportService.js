'use strict';
const { PDFDocument, degrees } = require('pdf-lib');
const safeName = value => String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const compare = (a, b) => String(a || '').localeCompare(String(b || ''), 'en', { numeric: true });
const csvCell = value => {
    let text = String(value ?? '');
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
};
function options(input = {}) {
    const result = { sortBy: 'sku', format: 'by_sku', output: 'merged', direction: 'asc', onFailure: 'abort', pageSize: 'original', ...input };
    if (!['sku', 'awb', 'order_id', 'product', 'size', 'date'].includes(result.sortBy) ||
        !['flat', 'by_sku', 'by_product', 'by_carrier', 'by_size'].includes(result.format) ||
        !['merged', 'individual', 'pdf'].includes(result.output) || !['asc', 'desc'].includes(result.direction) ||
        !['abort', 'skip'].includes(result.onFailure) || !['original', 'thermal_4x6'].includes(result.pageSize)) throw error('Invalid label download options');
    if (result.output === 'pdf' && result.onFailure === 'skip') throw error('Partial downloads require a ZIP so missing labels can be reported');
    return result;
}
async function loadLabelPdf(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw error('Carrier returned an empty or non-PDF label', 502);
    try {
        const pdf = await PDFDocument.load(buffer, { throwOnInvalidObject: true });
        if (!pdf.getPageCount() || !pdf.getPages().some(page => page.node.Contents())) throw new Error('No printable pages');
        return pdf;
    } catch (_) { throw error('Carrier returned an unreadable or empty PDF', 502); }
}

async function normalizeThermal(source) {
    const pdf = await PDFDocument.create();
    const warnings = [];
    for (const [index, page] of source.getPages().entries()) {
        const crop = page.getCropBox();
        const w = crop.width, h = crop.height;
        let angle = ((page.getRotation().angle % 360) + 360) % 360;
        if (![0, 90, 180, 270].includes(angle) || w <= 0 || h <= 0) throw error('Invalid carrier page geometry', 502);
        const effective = angle % 180 ? [h, w] : [w, h];
        if (effective[0] > effective[1]) angle = (angle + 90) % 360;
        if (angle === 0 && Math.abs(w - 288) < 0.001 && Math.abs(h - 432) < 0.001 && crop.x === 0 && crop.y === 0 && page.getWidth() === 288 && page.getHeight() === 432) {
            const [copy] = await pdf.copyPages(source, [index]);
            pdf.addPage(copy);
            continue;
        }
        const [rw, rh] = angle % 180 ? [h, w] : [w, h];
        const scale = Math.min(288 / rw, 432 / rh);
        const embedded = await pdf.embedPage(page, { left: crop.x, bottom: crop.y, right: crop.x + w, top: crop.y + h });
        const x = (288 - rw * scale) / 2;
        const y = (432 - rh * scale) / 2;
        const offsets = { 0: [0, 0], 90: [0, w * scale], 180: [w * scale, h * scale], 270: [h * scale, 0] };
        pdf.addPage([288, 432]).drawPage(embedded, {
            x: x + offsets[angle][0], y: y + offsets[angle][1], width: w * scale, height: h * scale, rotate: degrees(-angle)
        });
        if (scale < 0.75) warnings.push(`Page ${index + 1} scaled to ${Math.round(scale * 100)}%; verify barcode on thermal printer`);
    }
    return { pdf, warnings };
}
const SIZE_ORDER = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL', '6XL'];
function compareSize(a, b) {
    const rank = value => { const i = SIZE_ORDER.indexOf(String(value).toUpperCase()); return i < 0 ? (value && value !== 'Unspecified' ? 100 : 1000) : i; };
    return rank(a) - rank(b) || compare(a, b);
}
function sortLabels(labels, opts) {
    const key = { sku: 'sku_group', awb: 'awb', order_id: 'order_id', product: 'product_summary', size: 'size_group', date: 'dispatched_at' }[opts.sortBy];
    labels.sort((a, b) => (opts.direction === 'desc' ? -1 : 1) *
        ((opts.sortBy === 'size' ? compareSize(a[key], b[key]) : compare(a[key], b[key])) || compare(a.order_id, b.order_id) || compare(a.id, b.id)));
}
async function mergeLabels(group, signal) {
    const pdf = await PDFDocument.create();
    for (const label of group) {
        signal?.throwIfAborted();
        label.page_start = pdf.getPageCount() + 1;
        const pages = await pdf.copyPages(label.pdf, label.pdf.getPageIndices());
        pages.forEach(page => pdf.addPage(page));
        label.page_end = pdf.getPageCount();
    }
    return Buffer.from(await pdf.save());
}
async function zipEntries(entries, signal) {
    signal?.throwIfAborted();
    const { ZipArchive } = require('archiver');
    const { PassThrough } = require('node:stream');
    return new Promise((resolve, reject) => {
        const stream = new PassThrough();
        const archive = new ZipArchive({ zlib: { level: 6 } });
        const chunks = [];
        const stop = () => fail(error('Download canceled', 499));
        const cleanup = () => signal?.removeEventListener('abort', stop);
        const fail = err => { cleanup(); archive.abort(); stream.destroy(); reject(err); };
        signal?.addEventListener('abort', stop, { once: true });
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => { cleanup(); resolve(Buffer.concat(chunks)); });
        stream.on('error', fail);
        archive.on('error', fail);
        archive.on('warning', fail);
        archive.pipe(stream);
        for (const entry of entries) archive.append(entry.buffer, { name: entry.name });
        archive.finalize().catch(fail);
    });
}
async function packageLabels(labels, batchNumber, input = {}, signal) {
    const opts = options(input);
    const { output, format, sortBy, direction, onFailure, pageSize } = opts;
    const valid = labels.filter(l => l.pdf && !l.duplicate_of);
    const failed = labels.filter(l => !l.pdf && !l.duplicate_of);
    const failures = failed.map(l => ({ requestId: l.request_id, orderId: l.order_id, awb: l.awb, error: l.label_error }));
    if (!valid.length || (failed.length && onFailure === 'abort')) return {
        error: `${failed.length} of ${labels.length} labels could not be retrieved. No file was downloaded. Retry or choose a partial ZIP with a failure report.`,
        status: 502, failures, labelCount: valid.length, missingCount: failed.length
    };
    const name = safeName(batchNumber);
    const result = {
        labelCount: valid.length, missingCount: failed.length, totalCount: labels.length,
        pageCount: valid.reduce((n, l) => n + l.pdf.getPageCount(), 0), batchNumber,
        warnings: valid.flatMap(l => (l.warnings || []).map(w => `${l.order_id}: ${w}`))
    };
    if (output === 'pdf') return { ...result, pdfBuffer: await mergeLabels(valid, signal), contentType: 'application/pdf', fileName: `${name}_labels_${sortBy}.pdf` };
    const groups = new Map();
    const groupKey = { by_sku: 'sku_group', by_product: 'product_group', by_carrier: 'carrier', by_size: 'size_group' }[format];
    for (const label of valid) {
        const key = groupKey ? label[groupKey] || 'unknown' : 'all';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(label);
    }
    const entries = [];
    let i = 0;
    for (const [key, group] of groups) {
        signal?.throwIfAborted();
        const folder = format === 'flat' ? '' : `${String(++i).padStart(3, '0')}_${safeName(key)}/`;
        if (output === 'merged') {
            const file = `${folder}labels_${group.length}_shipments.pdf`;
            entries.push({ name: file, buffer: await mergeLabels(group, signal) });
            group.forEach(l => { l.pdf_file = file; });
        } else for (const label of group) {
            const file = `${folder}${String(labels.indexOf(label) + 1).padStart(4, '0')}_${safeName(label.order_id)}_${safeName(label.awb)}.pdf`;
            entries.push({ name: file, buffer: Buffer.from(await label.pdf.save()) });
            label.pdf_file = file; label.page_start = 1; label.page_end = label.pdf.getPageCount();
        }
    }
    const lines = ['Order ID,AWB,Courier,SKU,Products,Label Status,PDF File,First Page,Last Page,Error,Request ID,Size,Warnings'];
    for (const l of labels) {
        const target = l.duplicate_of || l;
        lines.push([l.order_id, l.awb, l.courier_name, l.sku_group, l.product_summary,
            l.duplicate_of ? 'DUPLICATE REFERENCE' : l.pdf ? 'OK' : 'FAILED', target.pdf_file, target.page_start, target.page_end,
            target.label_error, l.request_id, l.size_group, (target.warnings || []).join('; ')].map(csvCell).join(','));
    }
    entries.push({ name: '_label_index.csv', buffer: Buffer.from(lines.join('\r\n')) });
    if (failed.length) entries.push({ name: '_failed_labels.csv', buffer: Buffer.from(['Order ID,AWB,Error,Request ID', ...failures.map(f => [f.orderId, f.awb, f.error, f.requestId].map(csvCell).join(','))].join('\r\n')) });
    entries.push({ name: '_download_summary.txt', buffer: Buffer.from([
        `Batch: ${batchNumber}`, `Labels downloaded: ${valid.length}`, `Missing labels: ${failed.length}`, `Total shipments: ${labels.length}`, `PDF pages: ${result.pageCount}`,
        `Output: ${output}; grouping: ${format}; sort: ${sortBy} ${direction}`,
        pageSize === 'thermal_4x6' ? 'Every label page is 4 x 6 inches (288 x 432 points). Print at actual size (100%).' : 'Original carrier page sizes and barcodes are preserved. Print at actual size (100%).',
        'Multi-item shipments appear once, grouped by their complete SKU/product combination.',
        failed.length ? 'PARTIAL DOWNLOAD: see _failed_labels.csv. Missing labels are NOT included as printable pages.' : 'All active shipment labels included.',
        ...result.warnings
    ].join('\n')) });
    return { ...result, zipBuffer: await zipEntries(entries, signal), contentType: 'application/zip', fileName: `${name}_labels_${sortBy}${failed.length ? '_PARTIAL' : ''}.zip` };
}
module.exports = { options, loadLabelPdf, normalizeThermal, sortLabels, compareSize, packageLabels, csvCell, safeName };
