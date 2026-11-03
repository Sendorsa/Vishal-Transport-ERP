/**
 * The shared-database backend for `api.*` (decision D-1: business rules stay in TypeScript and run on the server).
 *
 * One request = one Postgres transaction, run as the `authenticated` role with the verified user's claims, so Row
 * Level Security applies to every statement (the server holds no privilege of its own — role erp_server, NOINHERIT):
 *   1. writes take one advisory lock (one business write at a time, as `tx()` in the browser) BEFORE loading, so every
 *      write validates against the latest committed data;
 *   2. the unchanged `api.<method>` runs on an in-memory copy (src/lib/request-scope.ts). Collections are loaded on
 *      demand: a read of one not loaded yet stops the method (NeedData), loads it, and runs the method again from the
 *      start — nothing touches the database until the method has finished, so a re-run is safe;
 *   3. the changes are written in foreign-key order (updates guarded by the version loaded), then the audit events;
 *   4. COMMIT — the deferred database checks (stock never below zero, audit presence, allocations, invoice lines) run
 *      here; any failure rolls back everything.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { registerScopeGetter, NeedData, type RequestIdentity, type RequestScope } from "@/lib/request-scope"
import type { AuditEvent, AuditReview, CollectionKey, Settings } from "@/lib/types"
import { applyDeletes, applyUpserts, insertEvents, insertReviews, loadAudit, loadSettings, SPECS, WRITE_ORDER, writeSettings, type LoadCtx, type Sql } from "./tables"

const als = new AsyncLocalStorage<RequestScope>()
registerScopeGetter(() => als.getStore())

/** Runs `fn` inside one database transaction (implemented by `postgres` in production and PGlite in the checks). */
export type Transact = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>

/** localStorage key of each collection (as src/lib/storage/local-store.ts names them). */
const KEY: Record<CollectionKey, string> = {
  customers: "vt:customers", vehicles: "vt:vehicles", drivers: "vt:drivers", trips: "vt:trips", diesel_entries: "vt:fuelEntries", adblue_entries: "vt:adBlueEntries",
  vehicle_assignments: "vt:vehicleAssignments", month_locks: "vt:monthLocks", fuel_stations: "vt:fuelStations", adblue_purchases: "vt:adBluePurchases", tanker_loads: "vt:tankerLoads",
  tanker_dispenses: "vt:tankerDispenses", tankers: "vt:tankers", tanker_transfers: "vt:tankerTransfers", tanker_adjustments: "vt:tankerAdjustments", invoices: "vt:invoices", payments: "vt:payments",
}
const COLLECTION_OF = new Map(Object.entries(KEY).map(([k, v]) => [v, k as CollectionKey]))
const SETTINGS = "vt:settings"
const EVENTS = "vt:auditEvents"
const REVIEWS = "vt:auditReviews"

async function begin(sql: Sql, identity: RequestIdentity, write: boolean) {
  await sql(`set local role authenticated`)
  await sql(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true), set_config('timezone', 'UTC', true), set_config('statement_timeout', '20s', true)`, [
    identity.userId,
    JSON.stringify({ sub: identity.userId, role: "authenticated" }),
  ])
  // ponytail: one company-wide write lock (as the browser's tx queue); per-tanker / per-station locks if writes ever queue up.
  if (write) await sql(`select pg_advisory_xact_lock(hashtext('vishal-erp:write'))`)
}

async function load(sql: Sql, key: string, ctx: LoadCtx): Promise<unknown> {
  if (key === SETTINGS) return loadSettings(sql)
  if (key === EVENTS || key === REVIEWS) {
    const a = await loadAudit(sql)
    return key === EVENTS ? a.events : a.reviews
  }
  const c = COLLECTION_OF.get(key)
  if (!c) return [] // a key the API never stores in the database
  return SPECS[c].load(sql, ctx)
}

/**
 * Runs one API call for the verified account. `expected` = the record versions the user's screen showed
 * (optimistic concurrency). Throws the method's own error (validation, permission, conflict) or a database error.
 */
export async function runInDatabase<T>(transact: Transact, identity: RequestIdentity, write: boolean, expected: Record<string, string>, call: () => Promise<T>): Promise<T> {
  return transact(async (sql) => {
    await begin(sql, identity, write)
    const ctx: LoadCtx = { extras: new Map() }
    const loaded = new Map<string, unknown>()
    for (let attempt = 0; ; attempt++) {
      // A fresh in-memory copy for every run (a re-run never sees the previous run's half-done changes).
      const cache = new Map<string, unknown>([...loaded].map(([k, v]) => [k, structuredClone(v)]))
      const scope: RequestScope = { identity, cache, written: new Set(), expected, newEvents: [], newReviews: [] }
      try {
        const result = await als.run(scope, call)
        if (write) await persist(sql, scope, loaded, ctx)
        return result
      } catch (e) {
        if (!(e instanceof NeedData) || attempt > 40) throw e
        loaded.set(e.key, await load(sql, e.key, ctx))
      }
    }
  })
}

async function persist(sql: Sql, scope: RequestScope, loaded: Map<string, unknown>, ctx: LoadCtx) {
  const wctx = { ...ctx, identity: scope.identity }
  const keys = [...scope.written]
  if (keys.includes(SETTINGS)) await writeSettings(sql, loaded.get(SETTINGS) as Settings, scope.cache.get(SETTINGS) as Settings)
  const changed = WRITE_ORDER.filter((c) => keys.includes(KEY[c]))
  const before = (c: CollectionKey) => (loaded.get(KEY[c]) ?? []) as { id: string; updatedAt: string }[]
  const after = (c: CollectionKey) => (scope.cache.get(KEY[c]) ?? []) as { id: string; updatedAt: string }[]
  for (const c of [...changed].reverse()) await applyDeletes(sql, c, before(c), after(c))
  for (const c of changed) await applyUpserts(sql, c, before(c), after(c), wctx)
  await insertEvents(sql, scope.newEvents as AuditEvent[], scope.identity)
  await insertReviews(sql, scope.newReviews as AuditReview[], scope.identity)
}

/**
 * Modules changed since `since` (20-second polling, OD-5): the audit trail records every write, so its newest events
 * say what to refresh. RLS shows each role only the modules it may view. The 2-minute overlap covers transactions
 * that committed out of `at` order; refreshing twice is harmless.
 */
export async function changesSince(transact: Transact, identity: RequestIdentity, since: string | null) {
  return transact(async (sql) => {
    await begin(sql, identity, false)
    const [now] = await sql<{ now: string }>(`select to_jsonb(clock_timestamp()) #>> '{}' as now`)
    if (!since) return { cursor: now.now, modules: [] as string[] }
    const rows = await sql<{ module: string }>(`select distinct module from audit.events where at > $1::timestamptz - interval '2 minutes'`, [since])
    return { cursor: now.now, modules: rows.map((r) => r.module) }
  })
}
