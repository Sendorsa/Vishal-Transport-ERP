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
  writeCollection("adblue_purchases", [{ id: "adp_field1", createdAt: at, updatedAt: at, date: "2026-10-05", adblueVendorId: "adv_field1", vendorName: "Field Vendor", product: "AdBlue ISO 22241", buckets: 10, litresPerBucket: 20, totalLitres: 200, pricePerBucket: 900, totalCost: 9000, invoiceNo: "INV-1", notes: "Field check", gstRate: 18 }])
  // AdBlue supplier payments: ₹10,000 settled at 0.1% on the ₹10,620 purchase (every field set), and a cash payment for a direct purchase on credit (entry_id), the rest advance.
  writeCollection("adblue_payments", [
    { id: "abp_field1", createdAt: at, updatedAt: at, date: "2026-10-08", vendorId: "adv_field1", amount: 9990, tdsAmount: 10, tdsRate: 0.1, mode: "RTGS", utr: "UTR AB 77", companyCode: "VTHPL", notes: "Part paid", allocations: [{ purchaseId: "adp_field1", amount: 10000 }] },
    { id: "abp_field2", createdAt: at, updatedAt: at, date: "2026-10-09", vendorId: "adv_field1", amount: 620.5, tdsAmount: 0, tdsRate: null, mode: "Cash", utr: "R-AB-1", companyCode: null, notes: "", allocations: [{ purchaseId: "adb_field3", amount: 490, direct: true }] },
  ])
  writeCollection("adblue_entries", [
    { id: "adb_field1", createdAt: at, updatedAt: at, source: "STOCK", adblueVendorId: "adv_field1", beforeVendorTracking: false, vehicleId: abVehicle, customerId: null, vendorId: "", date: "2026-10-06", closingKm: 1000, quantityLitres: 15, amount: 0, invoiceNo: "JC-1", notes: "" },
    { id: "adb_field2", createdAt: at, updatedAt: at, beforeVendorTracking: true, source: "DIRECT", adblueVendorId: "adv_field1", vendorName: "Field Vendor", rate: 95.5, paymentMode: "CASH", vehicleId: abVehicle, customerId: null, vendorId: "", date: "2026-10-07", closingKm: 1100, quantityLitres: 10, amount: 955, invoiceNo: "R-1", notes: "Direct" },
    // A direct purchase on the vendor's credit (owner, 18 Nov 2026): paymentMode CREDIT, paid by abp_field2 below (entry_id).
    { id: "adb_field3", createdAt: at, updatedAt: at, beforeVendorTracking: false, source: "DIRECT", adblueVendorId: "adv_field1", vendorName: "Field Vendor", rate: 98, paymentMode: "CREDIT", vehicleId: abVehicle, customerId: null, vendorId: "", date: "2026-10-08", closingKm: 1200, quantityLitres: 5, amount: 490, invoiceNo: "R-2", notes: "On credit" },
  ])
  // Tyre Data (17 Nov 2026): the migration already holds the starting repair types (unique names), so the demo copies
  // give way to one value of each list (one archived) and an invoice with every field set — CGST + SGST and IGST lines.
  const { lineAmounts } = await import("@/domain/tyre")
  writeCollection("tyre_masters", [
    { id: "tym_f_sup", createdAt: at, updatedAt: at, kind: "SUPPLIER", name: "Field Tyres", status: "ACTIVE" },
    { id: "tym_f_rep", createdAt: at, updatedAt: at, kind: "REPAIR_TYPE", name: "Field Repair", status: "ACTIVE" },
    { id: "tym_f_brd", createdAt: at, updatedAt: at, kind: "BRAND", name: "Field Brand", status: "ARCHIVED" },
    { id: "tym_f_siz", createdAt: at, updatedAt: at, kind: "SIZE", name: "235/75 R17.5", status: "ACTIVE" },
  ])
  const tyreLine = (id: string, quantity: number, rate: number, gstRate: number, taxType: "CGST_SGST" | "IGST", full: boolean) => ({
    id, repairTypeId: "tym_f_rep", brandId: full ? "tym_f_brd" : null, sizeId: full ? "tym_f_siz" : null, tyreNumber: full ? "B0426 / B0427" : "", openingKm: full ? 73636 : null, closingKm: full ? 84210.5 : null,
    quantity, rate, gstRate, taxType, ...lineAmounts(quantity, rate, gstRate, taxType), removingNumber: full ? "R-12" : "", remarks: full ? "Front axle" : "",
  })
  writeCollection("tyre_invoices", [
    { id: "tyr_field2", createdAt: at, updatedAt: at, date: "2026-10-07", vehicleId: abVehicle, customerId: null, office: true, supplierId: "tym_f_sup", billNo: "", purchaseMode: "", paymentMode: "", paymentDetails: "", remarks: "", items: [tyreLine("tyi_field3", 1, 400, 0, "CGST_SGST", false)] },
    { id: "tyr_field1", createdAt: at, updatedAt: at, date: "2026-10-06", vehicleId: abVehicle, customerId: readCollection("customers")[0].id, office: false, supplierId: "tym_f_sup", billNo: "003/26-27", purchaseMode: "Credit", paymentMode: "UPI", paymentDetails: "UTR 4455", remarks: "Two new tyres", items: [tyreLine("tyi_field1", 2, 14650, 18, "CGST_SGST", true), tyreLine("tyi_field2", 1.5, 333.33, 28, "IGST", false)] },
  ])
  // A fuel station payment with TDS deducted ("Deduct TDS?", 17 Nov 2026): total settled − 0.1% TDS = paid; tdsRate kept.
  {
    const { round2 } = await import("@/lib/format")
    const pays = readCollection("payments")
    const sp = pays.find((p) => p.categoryCode === "DIESEL_SETTLEMENT" && p.mode !== "TDS" && p.amount > 1000)!
    const tds = round2((sp.amount * 0.1) / 100)
    writeCollection("payments", pays.map((p) => (p === sp ? { ...p, amount: round2(sp.amount - tds), tdsAmount: tds, tdsRate: 0.1 } : p)))
  }
  // Tyre vendor payments: one allocated (part advance, every field set), one paying a direct purchase on credit (entry_id), the rest advance.
  writeCollection("tyre_payments", [
    { id: "tpy_field1", createdAt: at, updatedAt: at, date: "2026-10-08", supplierId: "tym_f_sup", amount: 1499, tdsAmount: 1.5, tdsRate: 0.1, mode: "IMPS", utr: "UTR 4455", reference: "003/26-27", companyCode: "VT", notes: "Part advance", allocations: [{ invoiceId: "tyr_field1", amount: 1000.25 }, { invoiceId: "tyr_field2", amount: 400 }] },
    { id: "tpy_field2", createdAt: at, updatedAt: at, date: "2026-10-08", supplierId: "tym_f_sup", amount: 10, mode: "Cash", utr: "R-9", reference: "", companyCode: null, notes: "", allocations: [], tdsAmount: 0, tdsRate: null },
  ])
  // PUC and several drivers per vehicle (21 Nov 2026): the demo data has neither — one vehicle with driver periods (closed and open, two drivers, one re-assigned) and
  // a PUC date, one with a PUC date only.
  {
    const [d1, d2] = readCollection("drivers")
    const vs = readCollection("vehicles")
    writeCollection("vehicles", vs.map((v, i) => (i === 0 ? { ...v, pucValidTill: "2027-01-15", driverPeriods: [{ id: "vdp_field1", driverId: d1.id, startDate: "2026-09-01", endDate: "2026-10-15" }, { id: "vdp_field2", driverId: d2.id, startDate: "2026-10-01", endDate: null }, { id: "vdp_field3", driverId: d1.id, startDate: "2026-11-01", endDate: null }], documentAlertHistory: [{ id: "vda_field1", document: "Insurance", regNo: v.regNo, expiryDate: "2026-11-20", alertDate: "2026-11-13", newExpiryDate: "2027-11-20", resolvedAt: "2026-11-15T05:12:09.123Z" }, { id: "vda_field2", document: "Road tax", regNo: v.regNo, expiryDate: "2026-11-18", alertDate: "2026-11-13", newExpiryDate: null, resolvedAt: "2026-11-16T05:12:09.000Z" }] } : i === 1 ? { ...v, pucValidTill: "2026-11-30" } : v)))
  }
  // Expense (Phase 2B, 20261128000000): one record of each section with every field set (vehicles in order, broker name
  // spelling, company confirmed, driver, request id, import batch, null dates), a broker, a section lock and an import batch.
  {
    const vs = readCollection("vehicles")
    const cust = readCollection("customers")[0].id
    const drv = readCollection("drivers")[0].id
    const e = (id: string, x: Record<string, unknown>) => ({
      id, createdAt: "2026-11-20T09:02:15.851Z", updatedAt: "2026-11-21T10:47:05.599Z", section: "ROAD_TAX", date: "2026-11-02", vehicleIds: [vs[0].id], customerId: cust, companyCode: "VT",
      description: "", amount: 0, remarks: "", validFrom: "", validTill: "", taxType: "", provider: "", policyNo: "", paymentMode: "", paymentReference: "", paymentStatus: null, paymentDate: "",
      driverId: null, entryType: null, broker: "", billNo: "", purpose: "", operatingCompany: "", vehicleCount: 1, paidAmount: 0, requestId: null, importBatchId: null, ...x,
    })
    writeCollection("expense_import_batches", [{ id: "imp_field1", createdAt: at, updatedAt: at, sourceLabel: "Office Mac — Chrome", sourceFingerprint: "a".repeat(64), exportedAt: "2026-11-27T08:00:00.000Z", summary: { counts: { expenses: { IMPORTED: 1 } } }, sourceSnapshot: { expenses: [] }, items: [{ sourceCollection: "brokers", sourceId: "brk_x", outcome: "SKIPPED", targetId: "brk_field1", reason: "Same broker" }, { sourceCollection: "expenses", sourceId: "exp_field1", outcome: "IMPORTED", targetId: "exp_field1", reason: "" }] }])
    writeCollection("brokers", [{ id: "brk_field1", createdAt: at, updatedAt: at, name: "Manjanna  RTO" }])
    writeCollection("expenses", [
      e("exp_field1", { companyConfirmed: true, description: "MV TAX", amount: 30310.25, remarks: "Paid by Popular", validFrom: "2026-10-01", validTill: "2026-12-31", taxType: "Same state", requestId: "4b1c2d3e-0f12-4a5b-8c6d-7e8f90a1b2c3", importBatchId: "imp_field1" }),
      e("exp_field2", { section: "INSURANCE", companyCode: "VTHPL", description: "Comprehensive", amount: 52000, validFrom: "2026-11-01", validTill: "2027-10-31", provider: "New India", policyNo: "P-1", paymentMode: "NEFT", paymentReference: "UTR 9" }),
      e("exp_field3", { section: "FITNESS", companyCode: null, description: "FC 1 YEAR", amount: 1250 }),
      e("exp_field4", { section: "FINE", companyCode: null, taxType: "Signal jump", description: "near  hosur,  9 pm", amount: 500, paymentStatus: "PAID", paymentDate: "2026-11-03", paymentReference: "", driverId: drv }),
      e("exp_field5", { section: "BROKER", vehicleIds: [vs[2].id, vs[0].id, vs[1].id], customerId: null, companyCode: null, entryType: "CHARGE", broker: "manjanna rto", billNo: "B-7", description: "PSV registration", amount: 69000, paidAmount: 20000, paymentDate: "2026-11-04", paymentMode: "Cash", purpose: "Bus", operatingCompany: "Minda", vehicleCount: 3 }),
      e("exp_field6", { section: "BROKER", vehicleIds: [], customerId: null, companyCode: null, entryType: "PAYMENT", broker: "Manjanna  RTO", paidAmount: 5000, paymentDate: "2026-11-05", date: "2026-11-05", vehicleCount: 0 }),
    ] as never)
    writeCollection("expense_month_locks", [{ id: "eml_field1", createdAt: at, updatedAt: at, month: "2026-10", section: "ROAD_TAX" }])
  }
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
