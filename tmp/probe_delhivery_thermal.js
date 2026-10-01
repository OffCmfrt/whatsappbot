// Read-only diagnostic: no shipment creation, updates, or database cache writes.
const { pool } = require('../src/database/db');
const axios = require('axios');
const { PDFDocument, PDFArray, PDFName, decodePDFRawStream } = require('pdf-lib');
const adapter = require('../src/services/carriers/delhiveryAdapter');

(async () => {
    try {
        const { rows } = await pool.query("SELECT awb FROM shipments WHERE carrier='delhivery' AND label_url IS NOT NULL AND status NOT IN ('failed','cancelled') ORDER BY id DESC LIMIT 1");
        for (const variant of [{ pdf_size: '4R' }]) {
            const response = await axios.get(`${adapter.baseURL}/api/p/packing_slip`, {
                headers: adapter.authHeaders(), params: { wbns: rows[0].awb, pdf: 'true', ...variant }, timeout: 20000
            });
            const data = response.data;
            const link = data.packages?.[0]?.pdf_download_link || data.packages?.[0]?.pdf_link;
            if (!link) { console.log({ variant, error: 'No label link', keys: Object.keys(data) }); continue; }
            const buffer = (await axios.get(new URL(link, adapter.baseURL).href, { responseType: 'arraybuffer', timeout: 20000 })).data;
            const pdf = await PDFDocument.load(buffer);
            console.log({ variant, pages: pdf.getPages().map(p => p.getSize()), creator: pdf.getCreator() });
            if (variant.pdf_size === '4R') {
                const page = pdf.getPage(0);
                const contents = page.node.Contents();
                const streams = contents instanceof PDFArray ? contents.asArray().map(ref => pdf.context.lookup(ref)) : [contents];
                for (const stream of streams) {
                    const text = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
                    console.log({ geometry: text.match(/(?:[-\d.]+\s+){4,6}(?:cm|re)\b/g)?.slice(0, 25) });
                }
                const objects = page.node.Resources()?.lookup(PDFName.of('XObject'));
                if (objects) for (const [name, ref] of objects.entries()) {
                    const object = pdf.context.lookup(ref);
                    console.log({ object: name.toString(), subtype: object.dict?.get(PDFName.of('Subtype'))?.toString(), width: object.dict?.get(PDFName.of('Width'))?.toString(), height: object.dict?.get(PDFName.of('Height'))?.toString(), bbox: object.dict?.get(PDFName.of('BBox'))?.toString() });
                    const content = Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
                    console.log({ formGeometry: content.match(/(?:[-\d.]+\s+){4,6}(?:cm|re)\b/g)?.slice(0, 25) });
                }
            }
            if (process.argv.includes('--preview')) {
                require('http').createServer((req, res) => {
                    if (req.url === '/label.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(buffer); }
                    else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Delhivery Label Dimensions</title><embed src="/label.pdf#zoom=100" type="application/pdf" width="100%" height="1100">'); }
                }).listen(8765, '127.0.0.1', () => console.log('Label preview: http://127.0.0.1:8765'));
            }
        }
    } catch (err) { console.error('Probe failed:', err.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();
