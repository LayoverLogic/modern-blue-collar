/**
 * helpers/csv.js — CSV reading and writing shared by imports and exports.
 *
 * Writing (exports):
 *   csvCell(v)            one quoted cell; formula-injection safe (RT-10): a cell
 *                         starting with = + - @ TAB or CR gets a leading apostrophe,
 *                         EXCEPT plain numbers that cannot be formulas (L9):
 *                           ^\+[0-9 ]+$          E.164 / international phones "+353 87 123 4567"
 *                           ^-[0-9]+(\.[0-9]+)?$  negative amounts "-12.50"
 *                         Such a cell holds only digits, spaces and one sign: no
 *                         function name, cell / sheet reference, DDE (| !) or string,
 *                         so a spreadsheet can at most read it as a number — it cannot
 *                         call anything or fetch anything. Apache Superset exempts
 *                         negative numbers the same way (superset/utils/csv.py,
 *                         negative_number_re); LibreOffice Calc (checked: soffice CSV
 *                         import, formulas evaluated) reads "+15555550110" as a number
 *                         and "+353 87 123 4567" as text, while "=1+1" stays a formula.
 *                         OWASP's list of trigger characters is unchanged for every
 *                         other value (+1-620-555… , +A1, -1+1, =…, @… still get the ').
 *   toCSV(rows, columns)  header + rows; `columns` are keys of each row object
 *   csvLine(values)       one line from an array of values
 *   contentDisposition(f) RFC 6266 / 5987 header: ASCII fallback + filename*=UTF-8''…
 *
 * Reading (imports):
 *   parseCsv(text)        RFC 4180: quoted fields, doubled quotes, CR/LF/CRLF line
 *                         ends, newlines inside quotes, UTF-8 BOM stripped.
 *                         → { headers: string[], rows: string[][], lineOf: number[] }
 *                         (lineOf[i] = 1-based physical line where data row i starts)
 *                         Throws CsvError on an unterminated quote.
 */
'use strict';

class CsvError extends Error {
  constructor(message, line) { super(message); this.name = 'CsvError'; this.line = line; }
}

function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') {
    if (typeof value.toFixed === 'function' && typeof value.toNumber === 'function') return value.toString(); // Prisma.Decimal
    return JSON.stringify(value);
  }
  return String(value);
}

// L9: values that start with + or - but can only ever be a number
const SAFE_SIGNED = /^(\+[0-9 ]+|-[0-9]+(\.[0-9]+)?)$/;

function csvCell(value) {
  let v = cellText(value);
  if (/^[=+\-@\t\r]/.test(v) && !SAFE_SIGNED.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

const csvLine = (values) => values.map(csvCell).join(',');

function toCSV(rows, columns) {
  const header = columns.join(',');
  const lines  = rows.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  return [header, ...lines].join('\n');
}

/** RFC 6266 / 5987 Content-Disposition for a (possibly non-ASCII) file name. */
function contentDisposition(filename) {
  const ascii = filename.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').replace(/\s+/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function parseCsv(input) {
  let text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = [];
  const lineOf = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let quoteLine = 0;
  let fieldStarted = false; // anything seen for the current record
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    // skip completely blank lines
    if (!(row.length === 1 && row[0] === '')) { records.push(row); lineOf.push(rowLine); }
    row = []; fieldStarted = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else {
        if (ch === '\n') line += 1;
        else if (ch === '\r' && text[i + 1] !== '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; quoteLine = line; fieldStarted = true; continue; }
    if (ch === ',') { endField(); fieldStarted = true; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
      line += 1; rowLine = line;
      continue;
    }
    if (!fieldStarted) rowLine = line;
    fieldStarted = true;
    field += ch;
  }
  if (inQuotes) throw new CsvError(`Unterminated quoted field starting on line ${quoteLine}`, quoteLine);
  if (field !== '' || row.length) endRow();
  if (!records.length) return { headers: [], rows: [], lineOf: [] };
  const headers = records[0].map((h) => h.trim());
  return { headers, rows: records.slice(1), lineOf: lineOf.slice(1) };
}

module.exports = { CsvError, cellText, csvCell, csvLine, toCSV, contentDisposition, parseCsv };
