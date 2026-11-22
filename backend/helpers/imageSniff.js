/**
 * helpers/imageSniff.js — identify an uploaded image by its bytes, never by the
 * client-supplied MIME type or filename (RT-20). Only raster formats that
 * browsers cannot execute are accepted; SVG, HTML, PDF etc. are rejected.
 */

const SERVABLE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif']);

const HEIF_BRANDS = { heic: 'image/heic', heix: 'image/heic', hevc: 'image/heic', hevx: 'image/heic', heim: 'image/heic', heis: 'image/heic', mif1: 'image/heif', msf1: 'image/heif', avif: 'image/avif', avis: 'image/avif' };
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif' };

/** @returns {{ mime: string, ext: string } | null} */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  let mime = null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) mime = 'image/jpeg';
  else if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mime = 'image/png';
  else if (/^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) mime = 'image/gif';
  else if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') mime = 'image/webp';
  else if (buf.subarray(4, 8).toString('latin1') === 'ftyp') mime = HEIF_BRANDS[buf.subarray(8, 12).toString('latin1')] || null;
  return mime ? { mime, ext: EXT[mime] } : null;
}

const isServableImage = (contentType) => SERVABLE.has(String(contentType || '').toLowerCase());

module.exports = { sniffImage, isServableImage, SERVABLE };
