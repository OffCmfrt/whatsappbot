'use strict';
const { randomUUID, randomBytes } = require('node:crypto');
const axios = require('axios');
const { pool } = require('../database/db');
const labels = require('./labelExportService');
const { extractItemSize } = require('../utils/orderItems');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = value => { if (!/^[1-9]\d{0,14}$/.test(String(value))) throw fail('Invalid record ID'); return String(value); };
const batchCode = () => `EXB-${randomBytes(6).toString('hex').toUpperCase()}`;
let syncing = null;
let lastAttempt = 0;
let sourceState = { connected: null, lastSync: null, error: null };
const query = async (sql, params = [], client = pool) => (await client.query(sql, params)).rows;

async function source(path = '', { data, signal, binary = false, params } = {}) {
    const base = process.env.RETURNS_SERVER_URL;
    const token = process.env.WHATSAPP_INTERNAL_TOKEN;
    if (!base || !token) throw fail('Returns dispatch connection is not configured', 503);
    let url;
    try { url = new URL(base); } catch (_) { throw fail('Returns dispatch connection URL is invalid', 503); }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw fail('Returns server must use HTTPS without embedded credentials', 503);
    try {
        const response = await axios({
            url: `${base.replace(/\/+$/, '')}/api/internal/exchange-dispatches${path}`,
            method: data ? 'POST' : 'GET', data, params, signal,
            headers: { 'x-internal-token': token }, maxRedirects: 0,
            timeout: binary ? 35000 : 20000, maxContentLength: binary ? 10 * 1024 * 1024 : 5 * 1024 * 1024,
            responseType: binary ? 'arraybuffer' : 'json'
        });
        if (binary) return Buffer.from(response.data);
        if (!response.data?.success || !Array.isArray(response.data.dispatches)) throw fail('Invalid response from returns dispatch service', 502);
        return response.data;
    } catch (err) {
        if (signal?.aborted) throw fail('Download canceled', 499);
        if (err.status && !err.isAxiosError && !err.response) throw err;
        const status = err.response?.status;
        if (status === 413 || /maxContentLength.*exceeded/.test(err.message || '')) throw fail('Carrier PDF exceeds the download limit; split the batch or contact support', 413);
        if (status === 404) throw fail('Returns dispatch API is not deployed yet', 503);
        if (status === 409) throw fail('Forward booking changed or is not printable; refresh dispatches', 409);
        if ([401, 403].includes(status)) throw fail('Returns dispatch connection was not authorized', 503);
        throw fail('Returns dispatch service is unavailable; retry shortly', 502);
    }
}
function enrich(row) {
    const items = (Array.isArray(row.items) ? row.items : []).map(i => ({ ...i, size: extractItemSize({ ...i, size: undefined, variant_title: i.size || i.variant }) || i.size || 'Unspecified' }));
    const combination = key => [...new Set(items.map(key))].sort().join(' + ') || 'Unspecified';
    return {
        ...row, items, order_id: row.order_number, courier_name: row.carrier,
        sku_group: combination(i => i.sku || `${i.title}-${i.variant || i.size}`),
        product_group: combination(i => i.title), size_group: [...new Set(items.map(i => i.size))].sort(labels.compareSize).join(' + ') || 'Unspecified',
        product_summary: items.map(i => `${i.title} (${i.size}) x${i.quantity}`).join('; ')
    };
}
function printable(row) {
    return row.active !== false && !['cancelled', 'canceled', 'failed', 'rto', 'rto_delivered'].includes(String(row.status).toLowerCase()) &&
        !['cancelled', 'canceled', 'rejected', 'failed'].includes(String(row.request_status).toLowerCase());
}
function automaticGroup(row) {
    const day = row.dispatched_at ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(row.dispatched_at)) : 'unknown';
    return { key: `${day}:${row.carrier || 'unknown'}`, name: `${day === 'unknown' ? 'Dispatch date unknown' : day} · ${row.carrier || 'Unknown carrier'}` };
}
function unpack(row) { return { ...enrich(row.snapshot), ...row, snapshot: undefined }; }
async function transaction(work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Serialize membership and sync mutations across server instances.
        await client.query('SELECT pg_advisory_xact_lock(73142601)');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
}
async function collectSource(fetchPage = source) {
    const rows = new Map(), cursors = new Set();
    let cursor;
    do {
        const page = await fetchPage('', { params: cursor ? { cursor } : undefined });
        for (const row of page.dispatches) {
            if (!row.request_id || (row.booked && (!/^[a-f0-9]{64}$/.test(row.booking_key) || !/^[a-f0-9]{64}$/.test(row.identity)))) throw fail('Invalid source dispatch identity', 502);
            rows.set(row.request_id, row);
        }
        cursor = page.next_cursor;
        if (cursor && cursors.has(cursor)) throw fail('Returns dispatch pagination did not advance', 502);
        cursors.add(cursor);
        if (rows.size > 50000) throw fail('Dispatch source is too large; contact support', 413);
    } while (cursor);
    return [...rows.values()];
}
async function applySync(records) {
    const scan = randomUUID();
    return transaction(async client => {
        for (const raw of records) {
            if (!raw.booked) continue;
            const row = enrich(raw);
            const [existing] = await query('SELECT * FROM exchange_dispatches WHERE booking_key=$1 FOR UPDATE', [row.booking_key], client);
            let batchId = existing?.batch_id;
            if (!batchId) {
                const group = automaticGroup(row);
                const [batch] = await query(`INSERT INTO exchange_dispatch_batches(batch_code,custom_name,kind,auto_key,created_by)
                    VALUES($1,$2,'automatic',$3,'returns-sync') ON CONFLICT(auto_key) DO UPDATE SET auto_key=EXCLUDED.auto_key RETURNING id`, [batchCode(), group.name, group.key], client);
                batchId = batch.id;
            }
            await query(`INSERT INTO exchange_dispatches(request_id,booking_key,identity,snapshot,batch_id,seen_scan)
                VALUES($1,$2,$3,$4::jsonb,$5,$6)
                ON CONFLICT(booking_key) DO UPDATE SET identity=EXCLUDED.identity,snapshot=EXCLUDED.snapshot,
                active=TRUE,seen_scan=EXCLUDED.seen_scan,synced_at=NOW(),
                label_state=CASE WHEN exchange_dispatches.identity=EXCLUDED.identity THEN exchange_dispatches.label_state ELSE 'unchecked' END,
                label_error=CASE WHEN exchange_dispatches.identity=EXCLUDED.identity THEN exchange_dispatches.label_error ELSE NULL END,
                revision=exchange_dispatches.revision+1`, [row.request_id, row.booking_key, row.identity, JSON.stringify(row), batchId, scan], client);
        }
        // This runs only after a complete successful source scan and transaction.
        await query('UPDATE exchange_dispatches SET active=FALSE,revision=revision+1 WHERE active=TRUE AND seen_scan IS DISTINCT FROM $1', [scan], client);
        await query('UPDATE exchange_dispatch_batches SET revision=revision+1,updated_at=NOW()', [], client);
        return records.filter(r => r.booked).length;
    });
}
async function sync({ force = false } = {}) {
    if (syncing) return syncing;
    if (!force && Date.now() - lastAttempt < 60000) return { ...sourceState };
    lastAttempt = Date.now();
    syncing = (async () => {
        try {
            const count = await applySync(await collectSource());
            sourceState = { connected: true, lastSync: new Date().toISOString(), error: null, count };
        } catch (err) { sourceState = { ...sourceState, connected: false, error: err.status ? err.message : 'Exchange synchronization failed' }; }
        return { ...sourceState };
    })();
    try { return await syncing; } finally { syncing = null; }
}
function filters(input = {}) {
    if (input.view && !['dispatches', 'batches'].includes(input.view)) throw fail('Invalid exchange view');
    if (input.history && !['true', 'false'].includes(input.history)) throw fail('Invalid history filter');
    if (input.from && input.to && input.from > input.to) throw fail('Start date must not be after end date');
    const values = [], clauses = [];
    const add = (sql, value) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)); };
    if (input.history !== 'true') clauses.push('d.active=TRUE');
    if (input.q) add("(d.request_id || ' ' || d.snapshot::text || ' ' || COALESCE(b.custom_name,'') || ' ' || b.batch_code) ILIKE ?", `%${String(input.q).slice(0, 150)}%`);
    for (const key of ['from', 'to']) if (input[key]) {
        const value = String(input[key]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw fail('Invalid date filter');
        add(`((d.snapshot->>'dispatched_at')::timestamptz AT TIME ZONE 'Asia/Kolkata')::date ${key === 'from' ? '>=' : '<='} ?::date`, value);
    }
    if (input.carrier) {
        if (!['delhivery', 'ekart', 'shiprocket'].includes(input.carrier)) throw fail('Invalid carrier');
        add("d.snapshot->>'carrier' = ?", input.carrier);
    }
    if (input.status) {
        if (!['scheduled', 'pickup_pending', 'pickup_booked', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'cancelled'].includes(input.status)) throw fail('Invalid status');
        add("d.snapshot->>'status' = ?", input.status);
    }
    if (input.label) {
        if (!['unchecked', 'ready', 'failed'].includes(input.label)) throw fail('Invalid label state');
        add('d.label_state = ?', input.label);
    }
    if (input.kind) {
        if (!['automatic', 'custom'].includes(input.kind)) throw fail('Invalid batch type');
        add('b.kind = ?', input.kind);
    }
    if (input.batchId) add('d.batch_id = ?', id(input.batchId));
    const page = Number(input.page || 1);
    if (!Number.isInteger(page) || page < 1 || page > 100000) throw fail('Invalid page');
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values, offset: (page - 1) * 25, page };
}
async function list(input = {}) {
    const f = filters(input);
    const join = `FROM exchange_dispatches d JOIN exchange_dispatch_batches b ON b.id=d.batch_id ${f.where}`;
    const stats = (await query(`SELECT COUNT(*)::int total,
        COUNT(*) FILTER(WHERE COALESCE(d.snapshot->>'awb','')='')::int awaiting_awb,
        COUNT(*) FILTER(WHERE d.snapshot->>'status' IN ('scheduled','pickup_pending','pickup_booked'))::int scheduled,
        COUNT(*) FILTER(WHERE d.snapshot->>'status' IN ('in_transit','out_for_delivery','picked_up'))::int in_transit,
        COUNT(*) FILTER(WHERE d.snapshot->>'status'='delivered')::int delivered,
        COUNT(*) FILTER(WHERE NOT d.active OR d.label_state='failed' OR d.snapshot->>'status' IN ('failed','cancelled'))::int attention ${join}`, f.values))[0];
    const paging = [...f.values, f.offset];
    if (input.view === 'batches') {
        const [{ total }] = await query(`SELECT COUNT(DISTINCT b.id)::int total ${join}`, f.values);
        const rows = await query(`SELECT b.*,COUNT(d.id)::int dispatch_count ${join} GROUP BY b.id ORDER BY b.created_at DESC,b.id DESC LIMIT 25 OFFSET $${paging.length}`, paging);
        return { rows, total, stats, page: f.page, source: sourceState };
    }
    const rows = await query(`SELECT d.*,b.batch_code,b.custom_name,b.kind ${join} ORDER BY d.id DESC LIMIT 25 OFFSET $${paging.length}`, paging);
    return { rows: rows.map(unpack), total: stats.total, stats, page: f.page, source: sourceState };
}
async function detail(recordId) {
    const [row] = await query('SELECT d.*,b.batch_code,b.custom_name,b.kind FROM exchange_dispatches d JOIN exchange_dispatch_batches b ON b.id=d.batch_id WHERE d.id=$1', [id(recordId)]);
    if (!row) throw fail('Exchange dispatch not found', 404);
    return unpack(row);
}
function name(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw fail('Batch name must contain 1–200 characters');
    return value.trim();
}
function selection(input) {
    if (!Array.isArray(input) || !input.length || input.length > 100) throw fail('Select 1–100 dispatches');
    const unique = new Map();
    for (const item of input) {
        if (!item || typeof item !== 'object') throw fail('Invalid dispatch selection');
        const key = id(item.id);
        if (!Number.isInteger(item.revision) || item.revision < 1) throw fail('Refresh the selection before continuing');
        unique.set(key, { id: key, revision: item.revision });
    }
    return [...unique.values()];
}
async function lockBatch(client, batchId, revision) {
    const [batch] = await query('SELECT * FROM exchange_dispatch_batches WHERE id=$1 FOR UPDATE', [id(batchId)], client);
    if (!batch) throw fail('Batch not found', 404);
    if (batch.revision !== revision) throw fail('Batch changed; refresh and retry', 409);
    return batch;
}
async function mutate(action, body, actor) {
    return transaction(async client => {
        if (action === 'rename') {
            await lockBatch(client, body.batchId, body.revision);
            await query('UPDATE exchange_dispatch_batches SET custom_name=$1,revision=revision+1,updated_at=NOW() WHERE id=$2', [name(body.name), id(body.batchId)], client);
            return { batchId: body.batchId };
        }
        if (action === 'merge') {
            if (!Array.isArray(body.batches) || body.batches.length < 2 || body.batches.length > 100) throw fail('Select 2–100 batches');
            if (body.batches.some(b => !b || typeof b !== 'object')) throw fail('Invalid batch selection');
            const ids = [...new Set(body.batches.map(b => id(b.id)))];
            if (ids.length !== body.batches.length) throw fail('Duplicate batch selection');
            for (const b of body.batches) await lockBatch(client, b.id, b.revision);
            const [target] = await query("INSERT INTO exchange_dispatch_batches(batch_code,custom_name,kind,created_by) VALUES($1,$2,'custom',$3) RETURNING id", [batchCode(), name(body.name), actor], client);
            await query('UPDATE exchange_dispatches SET batch_id=$1,manual_group=TRUE,revision=revision+1 WHERE batch_id=ANY($2::bigint[])', [target.id, ids], client);
            await query('UPDATE exchange_dispatch_batches SET revision=revision+1,updated_at=NOW() WHERE id=ANY($1::bigint[])', [ids], client);
            return { batchId: target.id };
        }
        if (action === 'split') {
            const batch = await lockBatch(client, body.batchId, body.revision);
            if (!Number.isInteger(body.size) || body.size < 1 || body.size > 100) throw fail('Split size must be 1–100');
            const rows = await query('SELECT id FROM exchange_dispatches WHERE batch_id=$1 ORDER BY id FOR UPDATE', [batch.id], client);
            if (rows.length <= body.size) throw fail('Batch is already smaller than the split size');
            for (let i = 0; i < rows.length; i += body.size) {
                const [part] = await query("INSERT INTO exchange_dispatch_batches(batch_code,custom_name,kind,created_by) VALUES($1,$2,'custom',$3) RETURNING id", [batchCode(), `${(batch.custom_name || batch.batch_code).slice(0, 175)} · ${i / body.size + 1}`, actor], client);
                await query('UPDATE exchange_dispatches SET batch_id=$1,manual_group=TRUE,revision=revision+1 WHERE id=ANY($2::bigint[])', [part.id, rows.slice(i, i + body.size).map(r => r.id)], client);
            }
            await query('UPDATE exchange_dispatch_batches SET revision=revision+1,updated_at=NOW() WHERE id=$1', [batch.id], client);
            return { split: true };
        }
        if (!['create', 'move'].includes(action)) throw fail('Invalid batch operation');
        const selected = selection(body.selection);
        const rows = await query('SELECT * FROM exchange_dispatches WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [selected.map(r => r.id)], client);
        if (rows.length !== selected.length || rows.some(r => r.revision !== selected.find(s => s.id === String(r.id)).revision)) throw fail('Dispatch selection changed; refresh and retry', 409);
        let target;
        if (action === 'move') target = await lockBatch(client, body.batchId, body.revision);
        else [target] = await query("INSERT INTO exchange_dispatch_batches(batch_code,custom_name,kind,created_by) VALUES($1,$2,'custom',$3) RETURNING id", [batchCode(), name(body.name), actor], client);
        await query('UPDATE exchange_dispatches SET batch_id=$1,manual_group=TRUE,revision=revision+1 WHERE id=ANY($2::bigint[])', [target.id, rows.map(r => r.id)], client);
        await query('UPDATE exchange_dispatch_batches SET revision=revision+1,updated_at=NOW() WHERE id=ANY($1::bigint[])', [[...new Set([...rows.map(r => r.batch_id), target.id])]], client);
        return { batchId: target.id };
    });
}
async function exportSelection(body, signal) {
    signal?.throwIfAborted();
    let rows, batchNumber = 'EXCHANGE-SELECTION';
    if (body.batchId) {
        const [batch] = await query('SELECT * FROM exchange_dispatch_batches WHERE id=$1', [id(body.batchId)]);
        if (!batch) throw fail('Batch not found', 404);
        if (batch.revision !== body.revision) throw fail('Batch changed; refresh before downloading', 409);
        rows = (await query('SELECT * FROM exchange_dispatches WHERE batch_id=$1 AND active=TRUE ORDER BY id', [batch.id])).map(unpack).filter(printable);
        batchNumber = batch.batch_code;
    } else {
        const selected = selection(body.selection);
        rows = (await query('SELECT * FROM exchange_dispatches WHERE id=ANY($1::bigint[]) ORDER BY id', [selected.map(r => r.id)])).map(unpack);
        if (rows.length !== selected.length || rows.some(r => r.revision !== selected.find(s => s.id === String(r.id)).revision)) throw fail('Selection changed; refresh before downloading', 409);
    }
    if (!rows.length) throw fail('No active dispatches selected', 404);
    if (rows.length > 100) throw fail('Download limit is 100 dispatches; split the batch first', 413);
    const fresh = await source('/lookup', { data: { requestIds: [...new Set(rows.map(r => r.request_id))] }, signal });
    const current = new Map(fresh.dispatches.map(r => [r.request_id, r]));
    for (const row of rows) {
        const record = current.get(row.request_id);
        if (!record?.booked || record.identity !== row.identity || !printable(record) || !printable(row)) row.label_error = 'Booking changed, cleared, or is no longer printable; refresh dispatches';
        else Object.assign(row, enrich(record), { label_error: null });
    }
    return { rows, batchNumber };
}
async function download(body, signal) {
    const controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const opts = labels.options({ ...(body.options || {}), pageSize: 'thermal_4x6' });
    const { rows, batchNumber } = await exportSelection(body, signal);
    labels.sortLabels(rows, opts);
    const seen = new Map();
    for (const row of rows) {
        if (!row.awb || row.label_error) continue;
        const key = `${row.carrier}:${row.awb}`;
        if (seen.has(key)) row.duplicate_of = seen.get(key);
        else seen.set(key, row);
    }
    let next = 0, bytes = 0, fatal;
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
        while (next < rows.length && !fatal) {
            const row = rows[next++];
            if (row.duplicate_of) continue;
            try {
                signal?.throwIfAborted();
                if (row.label_error) throw fail(row.label_error, 409);
                if (!row.awb) throw fail('Forward shipment is awaiting AWB', 409);
                const buffer = await source(`/${encodeURIComponent(row.request_id)}/label`, { params: { identity: row.identity }, binary: true, signal });
                if (buffer.length > 10 * 1024 * 1024) throw fail('Carrier PDF exceeds 10 MB; contact support', 413);
                bytes += buffer.length;
                if (bytes > 30 * 1024 * 1024) throw fail('Labels exceed 30 MB; split the batch first', 413);
                const pdf = await labels.loadLabelPdf(buffer);
                Object.assign(row, await labels.normalizeThermal(pdf));
            } catch (err) {
                row.label_error = err.status ? err.message : 'Carrier label could not be processed';
                if (err.status === 413 || signal.aborted) { fatal ||= err; controller.abort(); }
            }
            await query('UPDATE exchange_dispatches SET label_state=$1,label_error=$2,label_checked_at=NOW() WHERE id=$3 AND identity=$4', [row.pdf ? 'ready' : 'failed', row.label_error || null, row.id, row.identity]);
        }
    }));
    if (fatal) throw fatal;
    return labels.packageLabels(rows, batchNumber, opts, signal);
}
async function manifest(body, signal) {
    const { rows, batchNumber } = await exportSelection(body, signal);
    if (rows.some(r => r.label_error)) throw fail('Some bookings changed; refresh before exporting a manifest', 409);
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks = [];
    const complete = new Promise((resolve, reject) => { doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
    doc.fontSize(17).text('EXCHANGE DISPATCH PACKING MANIFEST');
    doc.fontSize(9).text(`Internal packing document • ${batchNumber} • ${rows.length} dispatches`).moveDown();
    for (const r of rows) {
        signal?.throwIfAborted();
        if (doc.y > 690) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(10).text(`${r.order_id} / ${r.request_id} — ${r.carrier} — AWB: ${r.awb || 'Pending'}`);
        doc.font('Helvetica').fontSize(9).text(`${r.customer_name} • ${r.customer_phone}`);
        doc.text(Object.values(r.destination || {}).filter(Boolean).join(', '));
        doc.text(r.product_summary).moveDown();
    }
    doc.end();
    return { pdfBuffer: await complete, contentType: 'application/pdf', fileName: `${labels.safeName(batchNumber)}_packing_manifest.pdf`, labelCount: rows.length, missingCount: 0 };
}
module.exports = { sync, list, detail, mutate, download, manifest, collectSource, applySync, enrich, printable, automaticGroup, selection, filters, source };
