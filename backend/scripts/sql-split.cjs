/**
 * scripts/sql-split.cjs — split a PostgreSQL script into statements (PLAT-15).
 *
 * Setup / run: nothing to run. Used by scripts/migrate-deploy.mjs; tested by
 * `npm run test:platform`.
 *   1. const { splitSqlStatements } = require('./sql-split.cjs');
 *   2. splitSqlStatements(sqlText) → ['CREATE TABLE ...', 'CREATE FUNCTION ... $$ ...; ... $$', ...]
 *
 * WHY: @prisma/adapter-pg's executeScript() (what the WASM schema engine calls
 * to apply a migration) does `script.split(";")`. That breaks any migration
 * with a ';' inside a string literal, a quoted identifier, a comment, or a
 * PL/pgSQL / SQL function body ($$ ... $$). This splitter only splits on ';'
 * at the top level and understands:
 *   'single quotes' (with '' escapes), E'escape strings' (with \' escapes),
 *   "quoted identifiers" (with "" escapes), $$dollar$$ and $tag$dollar$tag$
 *   quoting, -- line comments and nested /* block comments *\/.
 * Statements keep their comments and whitespace (trimmed at the ends);
 * pieces that are only comments/whitespace are dropped. Each statement is
 * still executed separately (autocommit), as before.
 */

function splitSqlStatements(sql) {
  const out = [];
  let start = 0;
  let i = 0;
  let meaningful = false; // current piece has something other than comments/space
  const n = sql.length;

  const push = (end) => {
    const piece = sql.slice(start, end).trim();
    if (piece && meaningful) out.push(piece);
    meaningful = false;
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === '-' && next === '-') { // line comment
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') { // block comment (nests in PostgreSQL)
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; } else i += 1;
      }
      continue;
    }
    if (c === "'") { // string literal; E'...' allows backslash escapes
      const prev = sql[i - 1];
      const escapeString = (prev === 'E' || prev === 'e') && !/[A-Za-z0-9_$]/.test(sql[i - 2] || '');
      meaningful = true;
      i += 1;
      while (i < n) {
        if (escapeString && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === '"') { // quoted identifier
      meaningful = true;
      i += 1;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === '$') { // dollar quoting: $$ or $tag$ (tag cannot start with a digit; $1 is a parameter)
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 256));
      const prevIsIdent = /[A-Za-z0-9_]/.test(sql[i - 1] || '');
      if (m && !prevIsIdent) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        meaningful = true;
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }
    if (c === ';') {
      push(i);
      start = i + 1;
      i += 1;
      continue;
    }
    if (!/\s/.test(c)) meaningful = true;
    i += 1;
  }
  push(n);
  return out;
}

module.exports = { splitSqlStatements };
