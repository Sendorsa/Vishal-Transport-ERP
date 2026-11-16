/**
 * Every field survives the shared database:  npm run check:erp-fields
 * The full demo dataset (every collection, nearly every optional field) goes through the production write path
 * (tables.ts: cols / afterInsert) into PostgreSQL (PGlite, every migration) and is loaded back through the production
 * read path (tables.ts: load). Each record must come back exactly as written — a field that is dropped, renamed or
 * mangled on the way (a column the mapping forgets) fails here instead of silently losing data in Production.
 * Triggers are off for the bulk load (session_replication_role = replica: no audit-presence / FK / stock triggers);
 * the business rules on those paths are covered by check:erp-db. Never touches a real project.
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist"
import type { CollectionKey } from "@/lib/types"
import { applyUpserts, loadSettings, SPECS, WRITE_ORDER, writeSettings, type Sql } from "./tables"

/**
 * Fields the database deliberately stores differently — each with its reason. Anything else that differs is a bug.
 * (Values: the app's in-memory shape vs what the database gives back.)
 */
const BY_DESIGN: Partial<Record<CollectionKey, Record<string, string>>> = {
  // AdBlue: a stock draw's ₹ is costed on read (FIFO); a stored entry's vendorId is legacy (D-15).
  adblue_entries: { amount: "computed on read for stock draws", vendorId: "legacy field, not stored (AdBlue is never bought at stations)" },
}

async function main() {
  const db = new PGlite({ extensions: { btree_gist } })
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users (id), provider text, identity_data jsonb, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
  `)
  const dir = new URL("../../../../supabase/migrations/", import.meta.url)
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(new URL(f, dir), "utf8"))
  const sql: Sql = async (text, params) => (await db.query(text, params ?? [])).rows as never[]
  await db.exec(`set session_replication_role = replica; set timezone = 'UTC';`)
  // The demo data as the offline checks load it — installed after PGlite starts (it looks for \`window\`).
  await import("@/lib/api/test-browser")
  const { readCollection, readSettings, writeCollection } = await import("@/lib/storage/local-store")
  // Industrial Diesel Supply (12 Nov 2026): the demo data has none — two supplies at different rates, one split across two
  // tankers, every field set (triggers and foreign keys are off in this check, so the tanker ids needn't exist).
  const supplyCustomer = readCollection("customers")[0].id
  writeCollection("industrial_supplies", [
    { id: "ind_field1", createdAt: "2026-10-05T04:30:00.000Z", updatedAt: "2026-10-05T04:30:00.000Z", customerId: supplyCustomer, date: "2026-10-05", litres: 500.125, rate: 94.5625, amount: 47293.07, purpose: "Generator operation", remarks: "DG set, plant 2", allocations: [{ tankerId: "tnk_field_a", litres: 300.125 }, { tankerId: "tnk_field_b", litres: 200 }], createdBy: null, updatedBy: null },
    { id: "ind_field2", createdAt: "2026-10-06T04:30:00.000Z", updatedAt: "2026-10-06T04:30:00.000Z", customerId: supplyCustomer, date: "2026-10-06", litres: 120, rate: 96, amount: 11520, purpose: "Borewell pump", remarks: "", allocations: [{ tankerId: "tnk_field_a", litres: 120 }], createdBy: null, updatedBy: null },
  ])
  // AdBlue vendors (16 Nov 2026): the demo data has no AdBlue — two vendors (one archived), a linked purchase, a stock
  // draw and a direct purchase naming their vendor, every field set.
  const abVehicle = readCollection("vehicles")[0].id
  const at = "2026-10-05T04:30:00.000Z"
  writeCollection("adblue_vendors", [
    { id: "adv_field1", createdAt: at, updatedAt: at, name: "Field Vendor", defaultRate: 45.125, contactPerson: "Ravi", phone: "98450 00000", notes: "Bulk supplier", status: "ACTIVE" },
    { id: "adv_field2", createdAt: at, updatedAt: at, name: "Old Vendor", defaultRate: null, contactPerson: "", phone: "", notes: "", status: "ARCHIVED" },
  ])
  writeCollection("adblue_purchases", [{ id: "adp_field1", createdAt: at, updatedAt: at, date: "2026-10-05", adblueVendorId: "adv_field1", vendorName: "Field Vendor", product: "AdBlue ISO 22241", buckets: 10, litresPerBucket: 20, totalLitres: 200, pricePerBucket: 900, totalCost: 9000, invoiceNo: "INV-1", notes: "Field check" }])
  writeCollection("adblue_entries", [
    { id: "adb_field1", createdAt: at, updatedAt: at, source: "STOCK", adblueVendorId: "adv_field1", beforeVendorTracking: false, vehicleId: abVehicle, customerId: null, vendorId: "", date: "2026-10-06", closingKm: 1000, quantityLitres: 15, amount: 0, invoiceNo: "JC-1", notes: "" },
    { id: "adb_field2", createdAt: at, updatedAt: at, beforeVendorTracking: true, source: "DIRECT", adblueVendorId: "adv_field1", vendorName: "Field Vendor", rate: 95.5, paymentMode: "CASH", vehicleId: abVehicle, customerId: null, vendorId: "", date: "2026-10-07", closingKm: 1100, quantityLitres: 10, amount: 955, invoiceNo: "R-1", notes: "Direct" },
  ])
  const ctx = { extras: new Map(), identity: { profileId: "10000000-0000-0000-0000-0000000000f1", userId: "00000000-0000-0000-0000-0000000000f1", role: "DEV" as const, email: null, name: null } }

  // Settings (companies, vehicle types, expense categories, tax): the migrations seed reference rows; write the demo ones over them.
  const settings = readSettings()!
  await writeSettings(sql, await loadSettings(sql), settings)
  const s2 = await loadSettings(sql)
  for (const k of ["companies", "vehicleTypes", "expenseCategories"] as const)
    for (const x of settings[k] as { code: string }[]) assert.deepEqual((s2[k] as { code: string }[]).find((y) => y.code === x.code), x, `settings.${k} ${x.code} round trip`)
  assert.deepEqual([s2.defaultTaxRate, s2.tdsRate, s2.sacCode], [settings.defaultTaxRate, settings.tdsRate, settings.sacCode], "settings tax fields round trip")

  const problems: string[] = []
  let records = 0
  for (const key of WRITE_ORDER) {
    const spec = SPECS[key] as unknown as { table: string | null; load: (s: Sql, c: typeof ctx) => Promise<Record<string, unknown>[]> }
    if (!spec.table) continue // external tanker dispenses: no table by design (D-15)
    const before = (await spec.load(sql, ctx)) as never[] // reference rows the migrations seed (dv_tanker…)
    const mine = (readCollection(key) as unknown as Record<string, unknown>[]).filter((r) => !(before as { id: string }[]).some((b) => b.id === r.id))
    try {
      await applyUpserts(sql, key, before, mine as never, ctx)
    } catch (e) {
      problems.push(`${key}: the database refused the demo records — ${(e as Error).message}`)
      continue
    }
    const back = new Map((await spec.load(sql, ctx)).map((r) => [r.id as string, r]))
    for (const r of mine) {
      records++
      const got = back.get(r.id as string)
      if (!got) {
        problems.push(`${key} ${r.id}: not loaded back`)
        continue
      }
      for (const f of new Set([...Object.keys(r), ...Object.keys(got)])) {
        if (f === "updatedAt" || BY_DESIGN[key]?.[f]) continue // the database stamps its own version
        const a = r[f] ?? null
        const b = got[f] ?? null
        const same = f === "createdAt" ? Date.parse(String(a)) === Date.parse(String(b)) : JSON.stringify(norm(a)) === JSON.stringify(norm(b))
        if (!same) problems.push(`${key}.${f} (${r.id}): wrote ${JSON.stringify(a)?.slice(0, 120)} → read ${JSON.stringify(b)?.slice(0, 120)}`)
      }
    }
  }
  // One line per field (with the count), so a systematic mapping bug reads as one finding, not thousands.
  const byField = new Map<string, { n: number; sample: string }>()
  for (const p of problems) {
    const k = p.replace(/ \(.*$/, "").replace(/ [a-z]+_[a-z0-9_]+:.*$/, "")
    const e = byField.get(k) ?? { n: 0, sample: p }
    e.n++
    byField.set(k, e)
  }
  if (byField.size) {
    for (const [k, e] of byField) console.error(`✗ ${k} — ${e.n}× e.g. ${e.sample}`)
    process.exit(1)
  }
  assert.ok(records > 1000, `the demo dataset was loaded (${records} records)`)
  console.log(`shared database field round trip: ${records} demo records in ${WRITE_ORDER.length - 1} collections written and read back unchanged`)
}

/** Empty optional values compare equal: "" / [] / {} / undefined are how the app writes "not set". */
function norm(v: unknown): unknown {
  if (v === "" || v === undefined || (Array.isArray(v) && !v.length)) return null // no status history = [] (historyOf treats both alike)
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]).filter(([, x]) => x !== null).sort(([a], [b]) => String(a).localeCompare(String(b))))
  return v
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
