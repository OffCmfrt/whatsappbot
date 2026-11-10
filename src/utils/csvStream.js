const zlib = require('zlib');

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_ROWS = 200000;

/**
 * Escape a CSV cell.
 * Quotes every value, doubles embedded quotes, and flattens line breaks.
 */
function csvCell(value) {
    if (value === null || value === undefined) return '""';

    const text = String(value)
        .replace(/\r\n|\r|\n/g, ' ')
        .replace(/"/g, '""');

    return `"${text}"`;
}

/**
 * Convert a row array into a CSV record.
 */
function csvRow(values) {
    return values.map(csvCell).join(',') + '\r\n';
}

/**
 * Wait for the writable stream to accept more data.
 * Stops waiting if the client disconnects or the stream errors.
 */
function writeChunk(sink, res, chunk) {
    return new Promise((resolve, reject) => {
        if (res.destroyed || res.writableEnded || sink.destroyed) {
            return resolve(false);
        }

        if (sink.write(chunk)) {
            return resolve(true);
        }

        const cleanup = () => {
            sink.off('drain', onDrain);
            sink.off('error', onError);
            res.off('close', onClose);
        };

        const onDrain = () => {
            cleanup();
            resolve(true);
        };

        const onError = (error) => {
            cleanup();
            reject(error);
        };

        const onClose = () => {
            cleanup();
            resolve(false);
        };

        sink.once('drain', onDrain);
        sink.once('error', onError);
        res.once('close', onClose);
    });
}

/**
 * Stream CSV rows to an HTTP response using bounded database batches.
 *
 * Required options:
 * - columns: CSV header names
 * - fetchBatch(cursor, batchSize): returns an array of database rows
 * - getCursor(lastRow): returns the cursor for the next batch
 * - mapRow(row): returns an array of CSV values in column order
 *
 * Optional options:
 * - filename
 * - batchSize
 * - maxRows
 * - gzip
 * - bom
 */
async function streamCsv(res, options = {}) {
    const {
        columns,
        fetchBatch,
        getCursor,
        mapRow,
        filename = 'export.csv',
        batchSize = DEFAULT_BATCH_SIZE,
        maxRows = DEFAULT_MAX_ROWS,
        gzip = true,
        bom = true
    } = options;

    if (!Array.isArray(columns) || typeof fetchBatch !== 'function' ||
        typeof getCursor !== 'function' || typeof mapRow !== 'function') {
        throw new TypeError('columns, fetchBatch, getCursor and mapRow are required');
    }

    if (!Number.isInteger(batchSize) || batchSize < 1 ||
        !Number.isInteger(maxRows) || maxRows < 1) {
        throw new RangeError('batchSize and maxRows must be positive integers');
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Export-Max-Rows', String(maxRows));
    res.setHeader('Vary', 'Accept-Encoding');

    const acceptsGzip = gzip &&
        /\bgzip\b/i.test(String(res.req?.headers?.['accept-encoding'] || ''));

    const sink = acceptsGzip
        ? zlib.createGzip({ level: 6 })
        : res;
    let streamError = null;

const onSinkError = (error) => {
    streamError = error;
};

if (acceptsGzip) {
    sink.on('error', onSinkError);
}

    if (acceptsGzip) {
        res.setHeader('Content-Encoding', 'gzip');
        sink.pipe(res);
    }

    let clientGone = false;

    const onClose = () => {
        if (!res.writableFinished) {
            clientGone = true;
            if (acceptsGzip && !sink.destroyed) sink.destroy();
        }
    };

    res.on('close', onClose);

    let written = 0;
    let cursor = null;

    try {
        const header = (bom ? '\ufeff' : '') + csvRow(columns);
        if (!await writeChunk(sink, res, header)) {
            return 0;
        }

        while (!clientGone && written < maxRows) {
    if (streamError) throw streamError;

    const limit = Math.min(batchSize, maxRows - written);
    const rows = await fetchBatch(cursor, limit);

    if (streamError) throw streamError;

            if (!Array.isArray(rows)) {
                throw new TypeError('fetchBatch must return an array');
            }

            if (rows.length === 0) break;

            let chunk = '';

            for (const row of rows) {
                chunk += csvRow(mapRow(row));
            }

            if (!await writeChunk(sink, res, chunk)) {
                break;
            }

            written += rows.length;

            if (rows.length < limit || written >= maxRows) {
                break;
            }

            cursor = getCursor(rows[rows.length - 1]);
        }
        if (streamError) throw streamError;

        if (!clientGone) {
            if (acceptsGzip) {
                sink.end();
            } else if (!res.writableEnded) {
                res.end();
            }
        }

        return written;
    } catch (error) {
        if (acceptsGzip && !sink.destroyed) {
            sink.destroy();
        }

        if (res.headersSent) {
            if (!res.destroyed) res.destroy(error);
        }

        throw error;
        } finally {
        res.off('close', onClose);

        if (acceptsGzip) {
            sink.off('error', onSinkError);
        }
    }
}

module.exports = {
    DEFAULT_BATCH_SIZE,
    DEFAULT_MAX_ROWS,
    csvCell,
    csvRow,
    streamCsv
};