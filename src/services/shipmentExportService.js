/**
 * Streamed shipment export for the Shopper Hub "Shipped Orders" view.
 *
 * Why this exists: the CSV export used to ask /shipping/history for
 * limit=1000&offset=0, so it silently truncated at 1 000 rows and built the
 * whole file as one JS string on both ends. This service streams instead:
 *
 *  - rows are fetched in keyset-paginated batches (`id` cursor, which rides the
 *    primary-key index instead of re-sorting the whole table every batch), so
 *    only one batch of ~2 000 rows is ever alive in server memory and rows
 *    inserted mid-export can neither duplicate nor skip entries;
 *  - each batch is written straight to the response and we wait for `drain`
 *    before pulling the next one, so a slow client can't balloon the buffer;
 *  - the browser receives a stream too, so it never holds an 18k-row string.
 *
 * Filters mirror /shipping/history exactly (search / carrier / payment /
 * IST date range) plus a multi-select `statuses` list.
 */

const { dbAdapter } = require('../database/db');
const zlib = require('zlib');

// Grouped status filters — the same groups the Shoppers Hub pills use.
// Group keys expand to multi-value SQL; anything else is a literal status.
const SHIPMENT_STATUS_GROUPS = {
    ready: `s.status IN ('created', 'awb_assigned')`,
    pickup_scheduled: `s.status = 'pickup_scheduled'`,
    in_transit: `s.status IN ('shipped', 'in_transit', 'out_for_delivery')`,
    delivered: `s.status = 'delivered'`,
    rto: `(s.status = 'rto' OR s.status LIKE 'rto_%')`,
    rto_initiated: `s.status = 'rto_initiated'`,
    rto_delivered: `s.status = 'rto_delivered'`,
    untrackable: `s.status = 'untrackable'`,
    cancelled: `s.status IN ('cancelled', 'failed')`
};

const SHIPMENT_BASE_FROM = `
            FROM shipments s
            LEFT JOIN orders o ON o.order_id = s.order_id
            LEFT JOIN store_shoppers ss ON ss.id = s.shopper_id
            LEFT JOIN customers c ON c.phone = o.customer_phone
        `;

// Rows per round trip. 2 000 keeps the batch (and its items_json payloads)
// small enough to stay flat in memory while filling the socket quickly:
// paging by id costs ~0.5s for 34k rows, versus ~2.7s when every batch has to
// re-sort by created_at (measured on production data).
const EXPORT_BATCH_SIZE = 2000;
// Hard safety valve so a runaway filter can never stream for ever.
const EXPORT_MAX_ROWS = 200000;

const EXPORT_COLUMNS = [
    'Order ID', 'Customer', 'Phone', 'Address', 'City', 'State', 'Pincode', 'Products',
    'Carrier', 'Courier', 'AWB', 'Status', 'Payment', 'COD Amount', 'Order Total',
    'Weight (g)', 'Freight', 'Pickup Date', 'Tracking URL', 'Shipped By', 'Created At (IST)'
];

function shipmentStatusClause(key, params) {
    const group = SHIPMENT_STATUS_GROUPS[key];
    if (group) return group;
    params.push(key);
    return 's.status = ?';
}

/**
 * Builds the WHERE clause + params shared by the history list, its count and
 * the export, so the rows you see are exactly the rows you download.
 * `statuses` (comma-separated multi-select) wins over the single `status` pill.
 */
function buildShipmentWhere({ search, carrier, status, statuses, payment_mode, date_from, date_to } = {}) {
    let where = ' WHERE 1=1';
    const params = [];

    if (search) {
        const like = `%${search}%`;
        where += ` AND (s.order_id ILIKE ? OR s.awb ILIKE ? OR s.courier_name ILIKE ? OR ss.name ILIKE ? OR ss.phone ILIKE ? OR c.name ILIKE ? OR o.customer_phone ILIKE ?)`;
        params.push(like, like, like, like, like, like, like);
    }
    if (carrier) { where += ' AND s.carrier = ?'; params.push(carrier); }

    const statusList = String(statuses || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    if (statusList.length) {
        where += ` AND (${statusList.map(k => shipmentStatusClause(k, params)).join(' OR ')})`;
    } else if (status) {
        where += ` AND (${shipmentStatusClause(status, params)})`;
    }

    if (payment_mode) { where += ' AND s.payment_mode = ?'; params.push(payment_mode); }
    // Date filters compare against IST calendar days (ops team works in IST)
    if (date_from && /^\d{4}-\d{2}-\d{2}$/.test(date_from)) {
        where += ` AND (s.created_at + INTERVAL '5 hours 30 minutes')::date >= ?::date`;
        params.push(date_from);
    }
    if (date_to && /^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
        where += ` AND (s.created_at + INTERVAL '5 hours 30 minutes')::date <= ?::date`;
        params.push(date_to);
    }

    return { where, params };
}

// Cheap exact count for the live "N shipments match" line in the export dialog.
async function countShipments(filters = {}) {
    const { where, params } = buildShipmentWhere(filters);
    const countFrom = filters.search ? SHIPMENT_BASE_FROM : ' FROM shipments s ';
    const rows = await dbAdapter.query(`SELECT COUNT(*)::int AS total ${countFrom}${where}`, params);
    return rows[0]?.total || 0;
}

function csvCell(value) {
    if (value === null || value === undefined) return '""';
    // Addresses carry line breaks (585 of them in production) — flattening them
    // keeps one CSV record per physical line, so the browser's progress counter
    // and every spreadsheet importer agree on the row count.
    const text = String(value).replace(/\r\n|\r|\n/g, ' ');
    return `"${text.replace(/"/g, '""')}"`;
}

// items_json is TEXT in store_shoppers but JSONB in some copies — accept both
function formatItems(itemsJson) {
    if (!itemsJson) return '';
    try {
        const parsed = typeof itemsJson === 'string' ? JSON.parse(itemsJson) : itemsJson;
        const items = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? Object.values(parsed) : []);
        if (!items.length) return String(itemsJson).slice(0, 120);
        return items.map(it => {
            const name = it.name || it.product || it.title || 'Item';
            const qty = Number(it.quantity || it.qty || 1);
            return qty > 1 ? `${name} x${qty}` : name;
        }).join(', ');
    } catch (_) {
        return String(itemsJson).slice(0, 120);
    }
}

function exportLine(row) {
    return [
        row.order_id, row.customer_name, row.customer_phone, row.customer_address, row.customer_city,
        row.customer_state, row.customer_pincode, formatItems(row.items_json), row.carrier,
        row.courier_name, row.awb, row.status, row.payment_mode, row.cod_amount, row.order_total,
        row.weight_grams, row.freight_charge, row.pickup_date, row.tracking_url, row.shipped_by,
        row.created_at_ist
    ].map(csvCell).join(',') + '\r\n';
}

function buildFileName(filters = {}) {
    const label = [
        filters.statuses || filters.status || 'all',
        filters.carrier || '',
        filters.payment_mode || '',
        filters.date_from ? `from_${filters.date_from}` : '',
        filters.date_to ? `until_${filters.date_to}` : ''
    ].filter(Boolean).join('_').replace(/[^a-zA-Z0-9_.-]+/g, '-');
    return `shipments_${label}_${new Date().toISOString().slice(0, 10)}.csv`;
}

/**
 * Streams the filtered shipment set to `res` as CSV.
 * Resolves with the number of data rows written.
 */
async function streamShipmentsCsv(res, filters = {}) {
    const { where, params } = buildShipmentWhere(filters);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${buildFileName(filters)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no'); // proxies must not buffer the stream
    res.setHeader('X-Export-Max-Rows', String(EXPORT_MAX_ROWS));
    res.setHeader('Vary', 'Accept-Encoding');

    // A 34k-row CSV is ~11 MB of text and compresses to roughly a tenth of
    // that, which matters a lot on the Render->browser hop. The browser
    // transparently inflates it, so the progress counter still sees real rows.
    const wantsGzip = /\bgzip\b/i.test(String((res.req && res.req.headers && res.req.headers['accept-encoding']) || ''));
    const sink = wantsGzip ? zlib.createGzip({ level: 6 }) : res;
    if (wantsGzip) {
        res.setHeader('Content-Encoding', 'gzip');
        sink.pipe(res);
    }

    // Resolve only once the chunk is flushed (or queued) so a slow client
    // throttles the next DB batch instead of growing the write buffer.
    const writeChunk = (chunk) => new Promise((resolve) => {
        if (res.destroyed || res.writableEnded) return resolve();
        if (sink.write(chunk)) return resolve();
        sink.once('drain', resolve);
    });

    const finish = () => {
        if (wantsGzip) {
            if (!sink.writableEnded) sink.end();
        } else if (!res.writableEnded) {
            res.end();
        }
    };

    let clientGone = false;
    const onClose = () => { clientGone = true; };
    res.on('close', onClose);

    let written = 0;
    try {
        await writeChunk('\ufeff' + EXPORT_COLUMNS.map(csvCell).join(',') + '\r\n');

        let cursorId = null;

        while (!clientGone && written < EXPORT_MAX_ROWS) {
            // Keyset on the primary key: an index scan, never a full re-sort.
            // ids are assigned in ingestion order, so this is newest-first to
            // within a handful of rows (3 of 33 995 on production data).
            const pageWhere = cursorId === null ? where : `${where} AND s.id < ?`;
            const pageParams = cursorId === null
                ? [...params, EXPORT_BATCH_SIZE]
                : [...params, cursorId, EXPORT_BATCH_SIZE];

            const rows = await dbAdapter.query(`
                SELECT s.id, s.order_id, s.carrier, s.awb, s.courier_name, s.status,
                       s.payment_mode, s.cod_amount, s.weight_grams, s.freight_charge,
                       s.pickup_date, s.tracking_url, s.shipped_by,
                       to_char(s.created_at + INTERVAL '5 hours 30 minutes', 'YYYY-MM-DD HH24:MI:SS') AS created_at_ist,
                       COALESCE(ss.name, c.name) AS customer_name,
                       COALESCE(ss.phone, o.customer_phone) AS customer_phone,
                       COALESCE(ss.address, '') AS customer_address,
                       COALESCE(ss.city, '') AS customer_city,
                       COALESCE(ss.province, '') AS customer_state,
                       COALESCE(ss.zip, '') AS customer_pincode,
                       ss.items_json,
                       COALESCE(ss.order_total, o.total) AS order_total
                ${SHIPMENT_BASE_FROM}${pageWhere}
                ORDER BY s.id DESC
                LIMIT ?
            `, pageParams);

            if (!rows.length) break;

            let chunk = '';
            for (const row of rows) chunk += exportLine(row);
            await writeChunk(chunk);

            written += rows.length;
            if (rows.length < EXPORT_BATCH_SIZE) break;

            cursorId = rows[rows.length - 1].id;
        }

        if (written >= EXPORT_MAX_ROWS) {
            console.warn(`⚠️ Shipment export hit the ${EXPORT_MAX_ROWS}-row safety cap (${buildFileName(filters)})`);
        }
        if (!clientGone) finish();
    } catch (error) {
        if (res.headersSent) {
            finish();
        }
        throw error;
    } finally {
        res.off('close', onClose);
    }

    return written;
}

module.exports = {
    SHIPMENT_STATUS_GROUPS,
    SHIPMENT_BASE_FROM,
    EXPORT_MAX_ROWS,
    buildShipmentWhere,
    shipmentStatusClause,
    countShipments,
    streamShipmentsCsv,
    buildFileName
};
