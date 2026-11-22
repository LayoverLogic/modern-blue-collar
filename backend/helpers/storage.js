/**
 * helpers/storage.js
 * S3-compatible object storage for job photos / file uploads.
 *
 * Uses the AWS S3 SDK, so any S3-compatible backend works by changing the
 * endpoint + credentials only — no code changes:
 *   - Local demo  → MinIO  (S3_ENDPOINT=http://minio:9000)
 *   - Production  → Wasabi / AWS S3 / DigitalOcean Spaces
 *
 * STORAGE_DRIVER selects the backend:
 *   s3     (default) S3-compatible object store, configured below.
 *   local  files on local disk under LOCAL_STORAGE_DIR (default backend/storage/,
 *          gitignored). For the zero-paid-services sandbox; no network at all.
 *
 * S3 config (falls back to the WASABI_* backup vars when the S3_* vars are unset,
 * so one set of credentials can serve both photo storage and DB backups):
 *   S3_ENDPOINT          e.g. http://minio:9000 | https://s3.us-east-1.wasabisys.com
 *   S3_REGION            default us-east-1
 *   S3_BUCKET            default mbc-uploads
 *   S3_ACCESS_KEY
 *   S3_SECRET_KEY
 *   S3_FORCE_PATH_STYLE  default true (required by MinIO; harmless on Wasabi/Spaces)
 */

const fs   = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} = require('@aws-sdk/client-s3');

function getBucket() {
  return process.env.S3_BUCKET || process.env.WASABI_BUCKET || 'mbc-uploads';
}

function getDriver() {
  const d = (process.env.STORAGE_DRIVER || 's3').trim().toLowerCase();
  if (d !== 's3' && d !== 'local') throw new Error(`Unknown STORAGE_DRIVER "${d}" (expected "s3" or "local")`);
  return d;
}

/** True when the selected storage backend is usable. */
function isConfigured() {
  if (getDriver() === 'local') return true;
  const endpoint = process.env.S3_ENDPOINT || process.env.WASABI_ENDPOINT;
  const key      = process.env.S3_ACCESS_KEY || process.env.WASABI_ACCESS_KEY;
  const secret   = process.env.S3_SECRET_KEY || process.env.WASABI_SECRET_KEY;
  return Boolean(endpoint && key && secret);
}

let _client = null;
function getClient() {
  if (_client) return _client;

  const region          = process.env.S3_REGION   || process.env.WASABI_REGION   || 'us-east-1';
  const endpoint        = process.env.S3_ENDPOINT  || process.env.WASABI_ENDPOINT || undefined;
  const accessKeyId     = process.env.S3_ACCESS_KEY || process.env.WASABI_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY || process.env.WASABI_SECRET_KEY;
  const forcePathStyle  = (process.env.S3_FORCE_PATH_STYLE || 'true') !== 'false';

  _client = new S3Client({
    region,
    endpoint,
    credentials: accessKeyId ? { accessKeyId, secretAccessKey } : undefined,
    forcePathStyle,
  });
  return _client;
}

/** Ensure the bucket exists (no-op if it already does). Safe to call repeatedly. */
async function ensureBucket() {
  const Bucket = getBucket();
  const client = getClient();
  try {
    await client.send(new HeadBucketCommand({ Bucket }));
  } catch (err) {
    try {
      await client.send(new CreateBucketCommand({ Bucket }));
    } catch (e) {
      const code = e.name || e.Code || '';
      // Tolerate races / already-owned buckets; surface anything else.
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(code)) throw e;
    }
  }
}

// ── Local-disk driver ────────────────────────────────────────────────────────
function getLocalRoot() {
  return path.resolve(process.env.LOCAL_STORAGE_DIR || path.join(__dirname, '..', 'storage'));
}

/**
 * Map an object key to a path inside the local root, refusing anything that
 * could escape it: absolute paths, `..`/`.` segments, backslashes, NUL bytes,
 * empty segments. Keys look like `jobs/12/1718000000000-ab12cd34-photo.jpg`.
 */
function localPathForKey(key) {
  if (typeof key !== 'string' || !key || key.length > 1024) throw badKey(key);
  if (key.includes('\0') || key.includes('\\') || key.startsWith('/')) throw badKey(key);
  const segments = key.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw badKey(key);
  const root = getLocalRoot();
  const full = path.resolve(root, ...segments);
  if (full !== root && !full.startsWith(root + path.sep)) throw badKey(key);
  return full;
}

function badKey(key) {
  const err = new Error(`Invalid storage key: ${JSON.stringify(String(key)).slice(0, 120)}`);
  err.status = 400;
  return err;
}

function notFound(key) {
  const err = new Error('Stored file not found');
  err.key = key;
  err.name = 'NoSuchKey';
  err.status = 404;
  return err;
}

async function localPut(key, body) {
  const full = localPathForKey(key);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, body, { flag: 'wx' }); // never overwrite silently
}

async function localGet(key) {
  const full = localPathForKey(key);
  let stat;
  try { stat = await fs.promises.stat(full); } catch (e) {
    if (e.code === 'ENOENT') throw notFound(key);
    throw e;
  }
  if (!stat.isFile()) throw notFound(key);
  // Same shape the routes use from S3 GetObject: `.Body` is a readable stream.
  return { Body: fs.createReadStream(full), ContentLength: stat.size, ContentType: undefined };
}

async function localDelete(key) {
  const full = localPathForKey(key);
  try { await fs.promises.unlink(full); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// ── Public API (dispatches on STORAGE_DRIVER) ───────────────────────────────
async function putObject(key, body, contentType) {
  if (getDriver() === 'local') {
    await localPut(key, body);
    return { bucket: 'local', key };
  }
  await ensureBucket();
  await getClient().send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return { bucket: getBucket(), key };
}

/** Returns the raw S3 GetObject response — `.Body` is a readable stream. */
async function getObject(key) {
  if (getDriver() === 'local') return localGet(key);
  try {
    return await getClient().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
  } catch (e) {
    // PLAT-14: a missing object is a 404, not a 500.
    const status = e && e.$metadata && e.$metadata.httpStatusCode;
    if (e && (e.name === 'NoSuchKey' || e.Code === 'NoSuchKey' || e.name === 'NotFound' || status === 404)) throw notFound(key);
    throw e;
  }
}

async function deleteObject(key) {
  if (getDriver() === 'local') return localDelete(key);
  await getClient().send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
}

module.exports = {
  getDriver,
  getLocalRoot,
  localPathForKey,
  getBucket,
  isConfigured,
  getClient,
  ensureBucket,
  putObject,
  getObject,
  deleteObject,
};
