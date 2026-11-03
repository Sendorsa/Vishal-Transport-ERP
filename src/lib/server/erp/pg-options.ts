/**
 * Postgres.js connection options for the shared database (used by http.ts; imported by the driver check).
 *
 * Postgres.js serialises each parameter by the type the SERVER reports for it. By default that means:
 *   jsonb / json        → JSON.stringify(value)          — the engine already sends JSON text, so audit snapshots
 *                                                           arrived double-encoded (a JSON string, not an object) and
 *                                                           every write failed the audit table's check (3 Nov 2026);
 *   date / timestamptz  → new Date(value).toISOString()   — cuts the microsecond version token (optimistic
 *                                                           concurrency) to milliseconds, so every edit's version
 *                                                           guard would miss, and shifts dates by the time zone.
 * The engine formats these values itself (src/lib/server/erp/tables.ts), so they pass through untouched — exactly
 * what PGlite does in the offline checks. Results are unaffected (the engine reads rows as to_jsonb text).
 */
export const PG_TYPES = {
  json: { to: 114, from: [114, 3802], serialize: (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)), parse: (x: string) => JSON.parse(x) },
  date: { to: 1184, from: [1082, 1114, 1184], serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)), parse: (x: string) => new Date(x) },
}

/** Supavisor transaction pooling: no prepared statements; a small pool per server instance. */
export const PG_OPTIONS = { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10, types: PG_TYPES } as const
