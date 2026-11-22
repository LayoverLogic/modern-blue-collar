/**
 * helpers/prisma.js — the ONE shared PrismaClient for the whole backend.
 *
 * Prisma 7 is Rust-free: the client runs a WASM query compiler and talks to
 * Postgres through the `pg` driver via @prisma/adapter-pg. No engine binary is
 * downloaded at install or run time.
 *
 * Every route, seed, backup and test uses `require('<path>/helpers/prisma')`
 * instead of `new PrismaClient()` (one connection pool per process).
 *
 * Money (Phase 2b): money columns are Decimal(12,2) in Postgres. This client is
 * extended so every Decimal field listed in MONEY_FIELDS is read back as a
 * plain JS number (exact for 2-decimal values far beyond MONEY_MAX), so routes,
 * seeds, CSV exports and the API keep seeing numbers like before. Arithmetic
 * on money is done with Prisma.Decimal in helpers/documents.js, never on
 * floats. server.js also installs a JSON replacer that turns any Decimal that
 * slips through (nested includes, raw queries) into a number.
 *
 * Quote / Invoice creates without `currency` get the brand currency
 * (helpers/locale.js), so direct inserts (seeds, tests) are stamped correctly.
 */
require('./loadEnv');
const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg }          = require('@prisma/adapter-pg');
const { parseDatabaseUrl }  = require('./databaseUrl');

/** Decimal columns per model (Prisma client model keys). */
const MONEY_FIELDS = {
  quote:         ['amount', 'subtotal', 'taxTotal'],
  invoice:       ['amount', 'subtotal', 'taxTotal'],
  quoteLine:     ['quantity', 'unitPrice', 'taxRate', 'lineTotal'],
  invoiceLine:   ['quantity', 'unitPrice', 'taxRate', 'lineTotal'],
  priceBookItem: ['price', 'cost'],
  inventoryItem: ['unitCost'],
  jobPart:       ['unitCost'],
};

const isDecimal = (v) => v != null && typeof v === 'object' && Prisma.Decimal.isDecimal(v);
const toNumber = (v) => (isDecimal(v) ? v.toNumber() : v);

function resultExtension() {
  const result = {};
  for (const [model, fields] of Object.entries(MONEY_FIELDS)) {
    result[model] = {};
    for (const f of fields) {
      result[model][f] = { needs: { [f]: true }, compute: (row) => toNumber(row[f]) };
    }
  }
  return result;
}

function withCurrency(args) {
  if (args && args.data && !Array.isArray(args.data) && args.data.currency === undefined) {
    const { getLocale } = require('./locale');
    args.data.currency = getLocale().currency;
  }
  return args;
}

if (!global.__mbcPrisma) {
  const { connectionString, schema } = parseDatabaseUrl(process.env.DATABASE_URL);
  const adapter = new PrismaPg({ connectionString }, schema !== 'public' ? { schema } : undefined);
  const base = new PrismaClient({ adapter });
  global.__mbcPrisma = base.$extends({
    name: 'mbc-money',
    result: resultExtension(),
    query: {
      quote:   { create: ({ args, query }) => query(withCurrency(args)) },
      invoice: { create: ({ args, query }) => query(withCurrency(args)) },
    },
  });
}

module.exports = global.__mbcPrisma;
