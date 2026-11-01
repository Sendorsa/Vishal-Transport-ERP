/**
 * Clean go-live start (owner, 1 Nov 2026): every new browser starts with the same clean workspace and never receives
 * demo data automatically. Runs in its own in-memory browser (not test-browser.ts, which loads demo data for the
 * other checks), starting from a genuinely empty localStorage.
 */
import assert from "node:assert/strict"

class MemoryStorage {
  getItem(k: string) {
    return Object.hasOwn(this, k) ? (this as unknown as Record<string, string>)[k] : null
  }
  setItem(k: string, v: string) {
    ;(this as unknown as Record<string, string>)[k] = String(v)
  }
  removeItem(k: string) {
    delete (this as unknown as Record<string, string>)[k]
  }
}
const storage = new MemoryStorage()
Object.assign(globalThis, { window: { localStorage: storage, addEventListener() {}, removeEventListener() {} } })
const setRole = (r: string) => storage.setItem("vt:ui:role", r)

async function main() {
  const { ensureSeeded, loadDemoData } = await import("./bootstrap")
  const { api } = await import("./index")
  const store = await import("@/lib/storage/local-store")
  const { valueTankers, CONFIRMED_TANKERS } = await import("@/domain/tanker")
  const { valueInventory } = await import("@/domain/adblue-inventory")
  const { buildEvent } = await import("@/domain/audit")
  const { readCollection, readMeta, writeMeta, readAuditEvents, appendAuditEvent, COLLECTION_KEYS, readSettings } = store

  const EMPTY_COLLECTIONS = COLLECTION_KEYS.filter((k) => !["vehicles", "tankers", "fuel_stations"].includes(k))
  const counts = () => Object.fromEntries(COLLECTION_KEYS.map((k) => [k, readCollection(k).length]))

  /** The clean go-live workspace, exactly. */
  function assertClean(label: string) {
    for (const k of EMPTY_COLLECTIONS) assert.equal(readCollection(k).length, 0, `${label}: no ${k}`)
    assert.deepEqual(readCollection("fuel_stations").map((s) => [s.id, !!s.isTanker]), [["dv_tanker", true]], `${label}: only the internal tanker source, no petrol pumps`)
    const tankers = readCollection("tankers")
    const vehicles = readCollection("vehicles")
    assert.deepEqual(tankers.map((t) => [t.id, t.name, t.regNo]), CONFIRMED_TANKERS.map((t) => [t.id, t.name, t.regNo]), `${label}: exactly JIO, Office and Mini`)
    assert.deepEqual(vehicles.map((v) => v.regNo).sort(), ["KA51AF1429", "KA53C0538", "TN70AX9480"], `${label}: only the three tanker vehicles`)
    for (const t of tankers) {
      const v = vehicles.find((x) => x.id === t.vehicleId)
      assert.ok(v && v.regNo === t.regNo, `${label}: ${t.name} is linked to its own vehicle record`)
      assert.equal(t.status, "ACTIVE")
    }
    for (const v of vehicles) {
      assert.equal(v.assignedCustomerId, null, `${label}: ${v.regNo} points at no customer`)
      assert.equal(v.defaultDriverId, null, `${label}: ${v.regNo} points at no driver`)
      assert.equal(v.fuelType, "DIESEL")
    }
    const stock = valueTankers({ loads: readCollection("tanker_loads"), fills: readCollection("diesel_entries"), external: readCollection("tanker_dispenses"), transfers: readCollection("tanker_transfers"), adjustments: readCollection("tanker_adjustments") }).stock
    for (const t of tankers) assert.equal(stock.get(t.id)?.litres ?? 0, 0, `${label}: ${t.name} starts with zero stock`)
    assert.equal(valueInventory(readCollection("adblue_purchases"), readCollection("adblue_entries")).stockLitres, 0, `${label}: AdBlue stock is zero`)
    assert.deepEqual(readSettings()!.companies.map((c) => c.code).sort(), ["VT", "VTHPL"], `${label}: company configuration kept`)
    assert.equal(readMeta()?.source, "EMPTY", `${label}: marked so it is never replaced by demo data`)
  }

  /* ---------------------------------------------------------------- 1. a brand-new browser */
  assert.equal(readMeta(), null, "starts genuinely empty")
  ensureSeeded()
  assertClean("first visit")
  const first = readAuditEvents().filter((e) => e.action === "DATA_RESET")
  assert.deepEqual(first.map((e) => [e.actor.kind, e.label]), [["SYSTEM", "Clean workspace created on first use"]], "recorded once, as the app")
  ensureSeeded()
  assert.equal(readAuditEvents().filter((e) => e.action === "DATA_RESET").length, 1, "a second visit changes nothing")

  /* ---------------------------------------------------------------- 2. the clean workspace works: tanker stock is zero in the API too */
  setRole("DEV")
  const jio = readCollection("vehicles").find((v) => v.regNo === "TN70AX9480")!
  const today = (await import("@/lib/format")).todayISO()
  const fill = { date: today, vehicleId: jio.id, customerId: null, litres: 10, rate: 95, odometerKm: 100, billNo: "", paymentMode: "CREDIT" as const, notes: "" }
  await assert.rejects(api.diesel.create({ ...fill, vendorId: "dv_vishal" }), /Choose the fuel station/, "a pump fill must name a fuel station that exists")
  assertClean("after a refused write")
  const station = await api.fuelStations.create({ name: "Test Pump" })
  const pumpFill = await api.diesel.create({ ...fill, vendorId: station.id })
  assert.equal(pumpFill.amount, 950, "a pump fill at a station that was added works as before")
  // An ordinary diesel vehicle (a tanker vehicle never takes tanker cargo) finds every tanker empty.
  const bus = { ...jio, id: "veh_check_bus", regNo: "KA01CHK0001", notes: "" }
  store.writeCollection("vehicles", [...readCollection("vehicles"), bus])
  for (const t of CONFIRMED_TANKERS)
    await assert.rejects(api.diesel.create({ ...fill, vehicleId: bus.id, vendorId: "dv_tanker", tankerId: t.id } as Parameters<typeof api.diesel.create>[0]), /Insufficient tanker inventory/, `${t.name} starts with nothing to draw`)

  /* ---------------------------------------------------------------- 3. Settings → Clear all data leaves the same clean workspace */
  const eventsBefore = readAuditEvents().length
  await api.admin.clearAllData()
  assertClean("after Clear all data")
  assert.ok(readAuditEvents().length > eventsBefore, "the audit log is kept (and the clear is recorded)")
  assert.equal(storage.getItem("vt:ui:role"), "DEV", "the session is kept")

  /* ---------------------------------------------------------------- 4. demo data the app loaded by itself becomes the clean workspace */
  loadDemoData()
  appendAuditEvent(buildEvent({ action: "DATA_RESET", module: "System", recordType: "Data", recordId: "workspace", label: "Demo data loaded on first use" }, { kind: "SYSTEM", userId: null, name: null, role: null }, "aud_autodemo01", new Date().toISOString()))
  assert.ok(readCollection("customers").length > 0, "(auto-loaded demo data present)")
  ensureSeeded()
  assertClean("auto-loaded demo data, untouched")
  assert.equal(readAuditEvents().at(-1)!.label, "Automatically loaded demo data replaced by the clean go-live workspace")

  /* ---------------------------------------------------------------- 5. data someone chose or typed is never replaced */
  await api.admin.resetDemoData() // Settings → Reset to demo data, as DEV
  const chosen = counts()
  ensureSeeded()
  assert.deepEqual(counts(), chosen, "demo data chosen in Settings is kept")
  loadDemoData()
  appendAuditEvent(buildEvent({ action: "DATA_RESET", module: "System", recordType: "Data", recordId: "workspace", label: "Demo data loaded on first use" }, { kind: "SYSTEM", userId: null, name: null, role: null }, "aud_autodemo02", new Date().toISOString()))
  // A user edited it before this version (any later access already sees the edit in the audit log).
  appendAuditEvent(buildEvent({ action: "UPDATED", module: "Customers", recordType: "Customer", recordId: readCollection("customers")[0].id, label: "edited by a user" }, { kind: "SESSION", userId: null, name: null, role: "OWNER" }, "aud_useredit01", new Date().toISOString()))
  const typed = counts()
  ensureSeeded()
  assert.deepEqual(counts(), typed, "auto-loaded demo data someone has typed into is real: kept")
  writeMeta({ version: store.SCHEMA_VERSION, seededAt: "", source: "RESTORED" })
  ensureSeeded()
  assert.deepEqual(counts(), typed, "restored data is kept")

  console.log("clean start: new browsers get the clean workspace (3 tankers, zero stock, no pumps / customers / drivers / entries), never demo data; Clear all gives the same; auto-loaded demo data is replaced, chosen or typed data kept: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
