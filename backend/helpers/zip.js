/**
 * helpers/zip.js — streaming ZIP writer on top of fflate (pure JS, zero dependencies,
 * MIT; https://github.com/101arrowz/fflate). Chosen over archiver (pulls in readable-stream,
 * glob, lazystream… a large tree), jszip (buffers the whole archive in memory) and yazl
 * (fine, but one more transitive dependency and no compression control per entry).
 * fflate streams entry by entry, so an exit export of a whole company never has to fit
 * in memory, and npm audit has nothing to say about it.
 *
 *   const zip = createZipStream(writable)           // e.g. an Express res
 *   await zip.addText('customers.csv', csvString)   // or addChunks(name, asyncIterable)
 *   await zip.addStream('photos/1/a.jpg', readable, { compress: false })
 *   const entries = await zip.finish()              // [{ path, bytes, sha256 }]
 *
 * Every entry's byte count and sha256 (of the UNcompressed content) is recorded so callers
 * can write a manifest. Entry names are sanitised (no absolute paths, no "..", no
 * backslashes) so an archive can never write outside its folder when unpacked.
 */
'use strict';

const crypto = require('crypto');
const { Zip, ZipDeflate, ZipPassThrough } = require('fflate');

function safeEntryName(name) {
  const parts = String(name).replace(/\\/g, '/').split('/')
    .map((p) => p.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length) throw new Error(`invalid zip entry name ${JSON.stringify(name)}`);
  return parts.join('/');
}

function createZipStream(out) {
  const entries = [];
  let failed = null;
  let done;
  let pending = null;
  const finished = new Promise((resolve, reject) => { done = { resolve, reject }; });
  const zip = new Zip((err, chunk, final) => {
    if (err) { failed = err; done.reject(err); return; }
    if (chunk && chunk.length) {
      const ok = out.write(Buffer.from(chunk)); // copy: fflate owns its buffers
      if (!ok) pending = new Promise((r) => out.once('drain', r));
    }
    if (final) done.resolve();
  });
  const backpressure = async () => { if (pending) { const p = pending; pending = null; await p; } };
  const names = new Set();

  async function addChunks(name, chunks, { compress = true, mtime = new Date() } = {}) {
    if (failed) throw failed;
    let path = safeEntryName(name);
    if (names.has(path)) { const m = /^(.*?)(\.[^./]*)?$/.exec(path); let i = 2; while (names.has(`${m[1]}-${i}${m[2] || ''}`)) i += 1; path = `${m[1]}-${i}${m[2] || ''}`; }
    names.add(path);
    const file = compress ? new ZipDeflate(path, { level: 6 }) : new ZipPassThrough(path);
    file.mtime = mtime;
    zip.add(file);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for await (const c of chunks) {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      if (!buf.length) continue;
      hash.update(buf); bytes += buf.length;
      file.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), false);
      await backpressure();
    }
    file.push(new Uint8Array(0), true);
    await backpressure();
    const entry = { path, bytes, sha256: hash.digest('hex') };
    entries.push(entry);
    return entry;
  }

  return {
    entries,
    addChunks,
    addText: (name, text, opts) => addChunks(name, [Buffer.from(String(text), 'utf8')], opts),
    addStream: (name, readable, opts) => addChunks(name, readable, opts),
    async finish() {
      zip.end();
      await finished;
      return entries;
    },
    abort() { try { zip.terminate(); } catch { /* already ended */ } },
  };
}

/** Collect a zip into a Buffer (small archives, tests). */
async function zipToBuffer(build) {
  const chunks = [];
  const sink = { write: (c) => { chunks.push(Buffer.from(c)); return true; }, once() {} };
  const zip = createZipStream(sink);
  await build(zip);
  await zip.finish();
  return Buffer.concat(chunks);
}

module.exports = { createZipStream, zipToBuffer, safeEntryName };
