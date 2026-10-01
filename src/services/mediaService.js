/**
 * Media Service — handles downloading media from Meta WhatsApp API
 * and uploading to Supabase Storage for persistent access.
 *
 * WhatsApp media URLs expire after ~24 hours, so we download and
 * store in Supabase Storage (cheap, already in our stack).
 *
 * OPTIMIZATIONS:
 * - Streams downloads directly to disk (no RAM bloat for large files)
 * - Caches bucket existence (1 HTTP check instead of N)
 * - Compresses images via sharp (WebP for 60-80% size reduction)
 * - Generates thumbnails for chat display (avoids loading full images)
 * - Uses temp disk storage for uploads (multer disk → compress → upload → cleanup)
 * - Efficient DB queries with specific column selection
 */

const axios = require('axios');
const { dbAdapter } = require('../database/db');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const os = require('os');
const { pipeline } = require('stream/promises');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BUCKET = 'support-attachments';

// Meta API helpers (reuse whatsappService token)
const getMetaToken = () => process.env.WHATSAPP_ACCESS_TOKEN;
const META_API = 'https://graph.facebook.com/v21.0';

// ── Bucket cache ─────────────────────────────────────────────
// Avoid checking bucket existence on every upload (saves 1 HTTP req per file)
let _bucketChecked = false;
let _bucketCheckPromise = null;

async function ensureBucket() {
    if (_bucketChecked) return;
    if (_bucketCheckPromise) return _bucketCheckPromise;

    _bucketCheckPromise = (async () => {
        try {
            const resp = await axios.get(`${SUPABASE_URL}/storage/v1/bucket/${STORAGE_BUCKET}`, {
                headers: supabaseHeaders(),
                timeout: 5000
            });
            // Ensure bucket is public (might have been created as private)
            if (!resp.data?.public) {
                await axios.put(
                    `${SUPABASE_URL}/storage/v1/bucket/${STORAGE_BUCKET}`,
                    { public: true },
                    { headers: supabaseHeaders(), timeout: 10000 }
                );
                console.log('[MEDIA] Updated bucket to public:', STORAGE_BUCKET);
            }
            _bucketChecked = true;
        } catch (e) {
            if (e.response?.status === 404 || e.response?.status === 400) {
                await axios.post(
                    `${SUPABASE_URL}/storage/v1/bucket`,
                    { name: STORAGE_BUCKET, public: true, file_size_limit: 52428800 },
                    { headers: supabaseHeaders(), timeout: 10000 }
                );
                console.log('[MEDIA] Created Supabase Storage bucket:', STORAGE_BUCKET);
                _bucketChecked = true;
            } else {
                throw e;
            }
        } finally {
            _bucketCheckPromise = null;
        }
    })();

    return _bucketCheckPromise;
}

function supabaseHeaders() {
    return {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json'
    };
}

// ── Temp file management ─────────────────────────────────────
const TEMP_DIR = path.join(os.tmpdir(), 'whatsapp-media');

async function ensureTempDir() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
    }
}

async function cleanupTempFile(filePath) {
    try {
        if (filePath) await fs.unlink(filePath);
    } catch (e) {
        // Ignore cleanup errors
    }
}

// ── Image optimization with sharp ────────────────────────────
let _sharp = null;
function getSharp() {
    if (_sharp === undefined) {
        try {
            _sharp = require('sharp');
        } catch (e) {
            _sharp = null;
            console.warn('[MEDIA] sharp not available — image compression disabled');
        }
    }
    return _sharp;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_DIMENSION = 1920; // Resize images larger than this
const THUMBNAIL_DIMENSION = 400; // Thumbnail size for chat display
const JPEG_QUALITY = 82; // Good balance of quality vs size
const WEBP_QUALITY = 80;

/**
 * Optimize an image file: resize if too large, convert to efficient format.
 * Returns { optimizedPath, thumbnailPath, finalSize, finalMime }
 */
async function optimizeImage(inputPath, originalMime) {
    const sharp = getSharp();
    if (!sharp) {
        // No sharp — return original
        const stat = await fs.stat(inputPath);
        return { optimizedPath: inputPath, thumbnailPath: null, finalSize: stat.size, finalMime: originalMime };
    }

    try {
        const metadata = await sharp(inputPath).metadata();
        const needsResize = metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION;
        const isLargeFile = (await fs.stat(inputPath)).size > 500 * 1024; // > 500KB

        // Determine output format: convert JPEG/PNG to WebP for massive savings
        const shouldConvert = isLargeFile && IMAGE_TYPES.has(originalMime) && originalMime !== 'image/webp';
        const outputExt = shouldConvert ? '.webp' : path.extname(inputPath);
        const outputPath = inputPath.replace(/\.[^.]+$/, `_opt${outputExt}`);

        let pipeline = sharp(inputPath).rotate(); // Auto-rotate based on EXIF

        if (needsResize) {
            pipeline = pipeline.resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
                fit: 'inside',
                withoutEnlargement: true
            });
        }

        if (shouldConvert || originalMime === 'image/webp') {
            pipeline = pipeline.webp({ quality: WEBP_QUALITY });
        } else if (originalMime === 'image/jpeg' || originalMime === 'image/jpg') {
            pipeline = pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
        } else if (originalMime === 'image/png') {
            pipeline = pipeline.png({ quality: JPEG_QUALITY, compressionLevel: 9 });
        }

        await pipeline.toFile(outputPath);

        // Generate thumbnail for chat display
        const thumbPath = inputPath.replace(/\.[^.]+$/, `_thumb.webp`);
        await sharp(inputPath)
            .resize(THUMBNAIL_DIMENSION, THUMBNAIL_DIMENSION, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 75 })
            .toFile(thumbPath);

        const stat = await fs.stat(outputPath);
        const finalMime = shouldConvert ? 'image/webp' : originalMime;

        // Cleanup intermediate files
        if (outputPath !== inputPath) await cleanupTempFile(inputPath);

        return {
            optimizedPath: outputPath,
            thumbnailPath: thumbPath,
            finalSize: stat.size,
            finalMime
        };
    } catch (err) {
        console.warn('[MEDIA] Image optimization failed, using original:', err.message);
        const stat = await fs.stat(inputPath);
        return { optimizedPath: inputPath, thumbnailPath: null, finalSize: stat.size, finalMime: originalMime };
    }
}

// ── Supabase Storage upload (from file path, not buffer) ─────

/**
 * Upload a file from disk to Supabase Storage.
 * Streams the file instead of buffering entire content in RAM.
 */
async function uploadFileToStorage(filePath, storagePath, contentType) {
    console.log(`[MEDIA] uploadFileToStorage called:`, { filePath, storagePath, contentType });
    await ensureBucket();

    const fileBuffer = await fs.readFile(filePath);
    console.log(`[MEDIA] File read, size:`, fileBuffer.length, 'bytes');

    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`;
    console.log(`[MEDIA] Uploading to:`, uploadUrl);

    const uploadResp = await axios.post(
        uploadUrl,
        fileBuffer,
        {
            headers: {
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'apikey': SUPABASE_SERVICE_KEY,
                'Content-Type': contentType,
                'x-upsert': 'true'
            },
            maxBodyLength: 52428800,
            maxContentLength: 52428800,
            timeout: 60000
        }
    );
    console.log(`[MEDIA] Upload response status:`, uploadResp.status);

    // Generate signed URL (valid for 7 days) - more reliable than public URLs
    try {
        const signUrl = `${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${storagePath}`;
        console.log(`[MEDIA] Requesting signed URL from:`, signUrl);
        
        const { data: signedUrlData, error } = await axios.post(
            signUrl,
            { expiresIn: 604800 }, // 7 days in seconds
            {
                headers: {
                    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                    'apikey': SUPABASE_SERVICE_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        ).then(r => {
            console.log(`[MEDIA] Sign response:`, r.status, r.data);
            return { data: r.data, error: null };
        }).catch(e => {
            console.error(`[MEDIA] Sign error:`, e.response?.status, e.response?.data || e.message);
            return { data: null, error: e };
        });

        if (signedUrlData?.signedURL || signedUrlData?.signedUrl) {
            const rawSigned = signedUrlData.signedURL || signedUrlData.signedUrl;
            // Supabase returns relative path like /object/sign/... — need /storage/v1 prefix
            const fullSignedUrl = rawSigned.startsWith('http') 
                ? rawSigned 
                : rawSigned.startsWith('/object/')
                    ? `${SUPABASE_URL}/storage/v1${rawSigned}`
                    : `${SUPABASE_URL}${rawSigned}`;
            console.log(`[MEDIA] ✓ Signed URL generated:`, fullSignedUrl.substring(0, 100) + '...');
            return fullSignedUrl;
        } else {
            console.warn(`[MEDIA] Signed URL response missing field:`, JSON.stringify(signedUrlData));
        }
    } catch (err) {
        console.warn('[MEDIA] Signed URL generation failed, falling back to public URL:', err.message);
    }

    // Fallback to public URL
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;
    console.log(`[MEDIA] Using public URL:`, publicUrl);
    return publicUrl;
}

/**
 * Upload a buffer to Supabase Storage (legacy path for small files).
 */
async function uploadBufferToStorage(buffer, storagePath, contentType) {
    await ensureBucket();

    await axios.post(
        `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
        buffer,
        {
            headers: {
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'apikey': SUPABASE_SERVICE_KEY,
                'Content-Type': contentType,
                'x-upsert': 'true'
            },
            maxBodyLength: 52428800,
            maxContentLength: 52428800,
            timeout: 60000
        }
    );

    return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;
}

// ── Meta WhatsApp Media Download (streaming) ─────────────────

/**
 * Get the download URL for a WhatsApp media message.
 */
async function getMediaMetadata(mediaId) {
    const res = await axios.get(`${META_API}/${mediaId}`, {
        headers: { 'Authorization': `Bearer ${getMetaToken()}` },
        timeout: 15000
    });
    return res.data;
}

/**
 * Download a media file from Meta's servers directly to disk.
 * Returns the temp file path (caller must cleanup).
 */
async function downloadMediaToDisk(mediaUrl) {
    await ensureTempDir();
    const tempPath = path.join(TEMP_DIR, `dl_${crypto.randomBytes(8).toString('hex')}`);

    const response = await axios({
        method: 'get',
        url: mediaUrl,
        responseType: 'stream',
        timeout: 120000,
        maxContentLength: 52428800
    });

    const writer = require('fs').createWriteStream(tempPath);
    await pipeline(response.data, writer);

    return tempPath;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Process an incoming WhatsApp media message:
 * 1. Fetch media metadata from Meta
 * 2. Stream download to disk (no RAM bloat)
 * 3. Optimize images (compress + thumbnail)
 * 4. Upload to Supabase Storage
 * 5. Cleanup temp files
 * 6. Return attachment info for DB storage
 */
async function processIncomingMedia(mediaObj, messageType) {
    if (!mediaObj || !mediaObj.id) {
        console.warn('[MEDIA] No media ID in message');
        return null;
    }

    const mediaId = mediaObj.id;
    const mime = mediaObj.mime_type || 'application/octet-stream';
    const caption = mediaObj.caption || '';
    let tempFilePath = null;
    let optimizedPath = null;
    let thumbnailPath = null;

    try {
        // 1. Get download URL
        const meta = await getMediaMetadata(mediaId);

        // 2. Stream download to disk
        tempFilePath = await downloadMediaToDisk(meta.url);

        // 3. Optimize if it's an image
        const isImage = IMAGE_TYPES.has(mime);
        let finalPath = tempFilePath;
        let finalSize = (await fs.stat(tempFilePath)).size;
        let finalMime = mime;
        let thumbUrl = null;

        if (isImage) {
            const result = await optimizeImage(tempFilePath, mime);
            optimizedPath = result.optimizedPath;
            thumbnailPath = result.thumbnailPath;
            finalPath = optimizedPath;
            finalSize = result.finalSize;
            finalMime = result.finalMime;
        }

        // 4. Determine storage path
        const ext = mimeToExt(finalMime, messageType);
        const now = new Date();
        const dateFolder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
        const uniqueId = crypto.randomBytes(8).toString('hex');
        const storagePath = `${typeFolder(messageType)}/${dateFolder}/${uniqueId}${ext}`;

        // 5. Upload to Supabase Storage
        const publicUrl = await uploadFileToStorage(finalPath, storagePath, finalMime);

        // 6. Upload thumbnail if generated
        if (thumbnailPath) {
            const thumbStoragePath = `thumbnails/${dateFolder}/${uniqueId}_thumb.webp`;
            thumbUrl = await uploadFileToStorage(thumbnailPath, thumbStoragePath, 'image/webp');
        }

        // 7. Cleanup ALL temp files
        await cleanupTempFile(tempFilePath);
        if (optimizedPath && optimizedPath !== tempFilePath) await cleanupTempFile(optimizedPath);
        if (thumbnailPath) await cleanupTempFile(thumbnailPath);

        const friendlyName = mediaObj.filename || `${messageType}_${uniqueId}${ext}`;
        console.log(`[MEDIA] Processed ${messageType} (${finalSize} bytes) → ${publicUrl.substring(0, 80)}...`);

        return {
            fileUrl: publicUrl,
            thumbnailUrl: thumbUrl,
            fileType: messageType,
            fileName: friendlyName,
            fileSize: finalSize,
            mimeType: finalMime,
            caption
        };
    } catch (error) {
        // Cleanup on error
        if (tempFilePath) await cleanupTempFile(tempFilePath);
        if (optimizedPath && optimizedPath !== tempFilePath) await cleanupTempFile(optimizedPath);
        if (thumbnailPath) await cleanupTempFile(thumbnailPath);

        console.error('[MEDIA] Failed to process media:', error.message);
        if (error.response?.data) console.error('[MEDIA] Error detail:', JSON.stringify(error.response.data).substring(0, 300));
        return null;
    }
}

/**
 * Send an image to a WhatsApp customer from a URL.
 */
async function sendImageToCustomer(to, imageUrl, caption = '') {
    const whatsappService = require('./whatsappService');
    return whatsappService.sendImage(to, imageUrl, caption, 'manual_reply');
}

/**
 * Upload a file from disk (multer diskStorage path) to Supabase Storage.
 * More memory-efficient than buffer-based upload — no RAM copy of file content.
 * @param {string} filePath - Path to file on disk
 * @param {string} originalName - Original filename
 * @param {string} mimeType - MIME type
 * @returns {{ fileUrl: string, thumbnailUrl: string|null, fileName: string, fileSize: number, mimeType: string }}
 */
async function uploadFromFilePath(filePath, originalName, mimeType) {
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(originalName || '') || mimeToExt(mimeType, 'image');

    let finalPath = filePath;
    let finalSize = (await fs.stat(filePath)).size;
    let finalMime = mimeType;
    let thumbUrl = null;

    // Optimize if it's an image
    const isImage = IMAGE_TYPES.has(mimeType);
    if (isImage) {
        const result = await optimizeImage(filePath, mimeType);
        finalPath = result.optimizedPath;
        finalSize = result.finalSize;
        finalMime = result.finalMime;

        // Upload thumbnail
        if (result.thumbnailPath) {
            const now = new Date();
            const dateFolder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
            const thumbStoragePath = `thumbnails/${dateFolder}/${uniqueId}_thumb.webp`;
            thumbUrl = await uploadFileToStorage(result.thumbnailPath, thumbStoragePath, 'image/webp');
            await cleanupTempFile(result.thumbnailPath);
        }
    }

    // Upload main file
    const now = new Date();
    const dateFolder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const finalExt = path.extname(finalPath);
    const storagePath = `outgoing/${dateFolder}/${uniqueId}${finalExt}`;
    const publicUrl = await uploadFileToStorage(finalPath, storagePath, finalMime);

    // Cleanup temp files (but NOT the original multer temp file — caller handles that)
    if (finalPath !== filePath) await cleanupTempFile(finalPath);

    return {
        fileUrl: publicUrl,
        thumbnailUrl: thumbUrl,
        fileName: originalName || `file${ext}`,
        fileSize: finalSize,
        mimeType: finalMime
    };
}

/**
 * Upload a file from a multipart form submission to Supabase Storage.
 * Optimized: compresses images, generates thumbnails, cleans up temp files.
 * @param {Buffer} buffer - File buffer (from multer)
 * @param {string} originalName - Original filename
 * @param {string} mimeType - MIME type
 * @returns {{ fileUrl: string, thumbnailUrl: string|null, fileName: string, fileSize: number, mimeType: string }}
 */
async function uploadFromDashboard(buffer, originalName, mimeType) {
    await ensureTempDir();
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(originalName || '') || mimeToExt(mimeType, 'image');
    const tempPath = path.join(TEMP_DIR, `dash_${uniqueId}${ext}`);

    // Write buffer to temp file
    await fs.writeFile(tempPath, buffer);

    let finalPath = tempPath;
    let finalSize = buffer.length;
    let finalMime = mimeType;
    let thumbUrl = null;

    // Optimize if it's an image
    const isImage = IMAGE_TYPES.has(mimeType);
    if (isImage) {
        const result = await optimizeImage(tempPath, mimeType);
        finalPath = result.optimizedPath;
        finalSize = result.finalSize;
        finalMime = result.finalMime;

        // Upload thumbnail
        if (result.thumbnailPath) {
            const now = new Date();
            const dateFolder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
            const thumbStoragePath = `thumbnails/${dateFolder}/${uniqueId}_thumb.webp`;
            thumbUrl = await uploadFileToStorage(result.thumbnailPath, thumbStoragePath, 'image/webp');
            await cleanupTempFile(result.thumbnailPath);
        }
    }

    // Upload main file
    const now = new Date();
    const dateFolder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const finalExt = path.extname(finalPath);
    const storagePath = `outgoing/${dateFolder}/${uniqueId}${finalExt}`;
    const publicUrl = await uploadFileToStorage(finalPath, storagePath, finalMime);

    // Cleanup temp files
    await cleanupTempFile(tempPath);
    if (finalPath !== tempPath) await cleanupTempFile(finalPath);

    return {
        fileUrl: publicUrl,
        thumbnailUrl: thumbUrl,
        fileName: originalName || `file${ext}`,
        fileSize: finalSize,
        mimeType: finalMime
    };
}

// ── Helpers ──────────────────────────────────────────────────

function typeFolder(messageType) {
    switch (messageType) {
        case 'image': return 'images';
        case 'video': return 'videos';
        case 'audio': return 'audio';
        case 'document': return 'documents';
        case 'sticker': return 'stickers';
        default: return 'other';
    }
}

function mimeToExt(mime, messageType) {
    const map = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'video/mp4': '.mp4',
        'video/3gpp': '.3gp',
        'audio/aac': '.aac',
        'audio/ogg': '.ogg',
        'audio/mpeg': '.mp3',
        'application/pdf': '.pdf',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.ms-excel': '.xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'text/plain': '.txt'
    };
    if (map[mime]) return map[mime];
    if (messageType === 'image') return '.jpg';
    if (messageType === 'video') return '.mp4';
    if (messageType === 'audio') return '.ogg';
    return '.bin';
}

// ── DB: Attachments table init ───────────────────────────────

async function initializeAttachmentsTable() {
    try {
        await dbAdapter.query(`
            CREATE TABLE IF NOT EXISTS support_ticket_attachments (
                id SERIAL PRIMARY KEY,
                ticket_id INTEGER REFERENCES support_tickets(id),
                customer_phone VARCHAR(30),
                file_url TEXT NOT NULL,
                thumbnail_url TEXT,
                file_type VARCHAR(20) NOT NULL,
                file_name VARCHAR(255),
                file_size INTEGER,
                mime_type VARCHAR(100),
                caption TEXT,
                direction VARCHAR(10) DEFAULT 'incoming',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Indexes for fast lookups
        await dbAdapter.query(`CREATE INDEX IF NOT EXISTS idx_sta_ticket_id ON support_ticket_attachments(ticket_id)`);
        await dbAdapter.query(`CREATE INDEX IF NOT EXISTS idx_sta_customer_phone ON support_ticket_attachments(customer_phone)`);
        await dbAdapter.query(`CREATE INDEX IF NOT EXISTS idx_sta_created_at ON support_ticket_attachments(created_at DESC)`);
        // Add thumbnail_url column if table already exists without it
        try {
            await dbAdapter.query(`ALTER TABLE support_ticket_attachments ADD COLUMN IF NOT EXISTS thumbnail_url TEXT`);
        } catch (e) {
            // Column might already exist
        }
        console.log('[MEDIA] Attachments table initialized (with thumbnails)');
    } catch (error) {
        console.error('[MEDIA] Attachments table init error:', error.message);
    }
}

/**
 * Save an attachment record to the database.
 */
async function saveAttachment({ ticketId, customerPhone, fileUrl, thumbnailUrl, fileType, fileName, fileSize, mimeType, caption, direction }) {
    await dbAdapter.insert('support_ticket_attachments', {
        ticket_id: ticketId || null,
        customer_phone: customerPhone || null,
        file_url: fileUrl,
        thumbnail_url: thumbnailUrl || null,
        file_type: fileType,
        file_name: fileName,
        file_size: fileSize || null,
        mime_type: mimeType || null,
        caption: caption || null,
        direction: direction || 'incoming',
        created_at: new Date().toISOString()
    });
}

/**
 * Get attachments for a ticket (optimized: specific columns only).
 */
async function getAttachmentsForTicket(ticketId) {
    return dbAdapter.query(
        `SELECT id, file_url, thumbnail_url, file_type, file_name, file_size, mime_type, caption, direction, created_at
         FROM support_ticket_attachments
         WHERE ticket_id = ?
         ORDER BY created_at ASC`,
        [ticketId]
    );
}

/**
 * Get attachments for a phone number (optimized: specific columns, capped).
 */
async function getAttachmentsForPhone(customerPhone, limit = 50) {
    return dbAdapter.query(
        `SELECT id, file_url, thumbnail_url, file_type, file_name, file_size, mime_type, caption, direction, created_at
         FROM support_ticket_attachments
         WHERE customer_phone = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [customerPhone, limit]
    );
}

module.exports = {
    processIncomingMedia,
    sendImageToCustomer,
    uploadFromDashboard,
    uploadFromFilePath,
    saveAttachment,
    getAttachmentsForTicket,
    getAttachmentsForPhone,
    initializeAttachmentsTable,
    STORAGE_BUCKET
};
