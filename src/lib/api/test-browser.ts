import { loadDemoData } from "./bootstrap"
import { appendAuditEvent, SCHEMA_VERSION, writeMeta } from "@/lib/storage/local-store"
import { buildEvent } from "@/domain/audit"

/**
 * In-memory stand-in for the browser, for the runnable API checks (check:audit, check:actions).
 * Import it before the API: it installs `window.localStorage`. Nothing touches real browser data.
 */

/** Stored keys are own properties (so Object.keys(localStorage) lists them, like the real thing). */
class MemoryStorage {
  getItem(k: string) {
    return Object.hasOwn(this, k) ? (this as unknown as Record<string, string>)[k] : null
  }
  setItem(k: string, v: string) {
    if (k === failure.key) {
      if (failure.once) failure.key = null
      throw new Error(`simulated storage failure on ${k}`)
    }
    ;(this as unknown as Record<string, string>)[k] = String(v)
  }
  removeItem(k: string) {
    delete (this as unknown as Record<string, string>)[k]
  }
}

/** Make writes to `key` throw (once, or until reset with key = null). */
export const failure: { key: string | null; once: boolean } = { key: null, once: false }

export const storage = new MemoryStorage()
Object.assign(globalThis, { window: { localStorage: storage, addEventListener() {}, removeEventListener() {} } })

// The checks exercise the API on the demo data. First use no longer loads it (the clean go-live workspace does), so
// load it explicitly and mark it as data of unknown origin: the checks' data is never replaced behind their back.
loadDemoData()
writeMeta({ version: SCHEMA_VERSION, seededAt: new Date().toISOString() })
appendAuditEvent(
  buildEvent(
    { action: "DATA_RESET", module: "System", recordType: "Data", recordId: "workspace", label: "Demo data loaded for the checks" },
    { kind: "SYSTEM", userId: null, name: null, role: null },
    "aud_checkdemo01",
    new Date().toISOString()
  )
)

/** The mock-session role the API reads (vt:ui:role). */
/** Removed roles can still be stored by an old browser — they must read as Employee. */
export const setRole = (r: "OWNER" | "DEV" | "EMPLOYEE" | "ACCOUNTANT" | "OPS_MANAGER") => storage.setItem("vt:ui:role", r)

/**
 * A tanker for checks that load / dispense diesel (demo data has none): written straight to storage like
 * demo data (no audit event), after seeding. Returns its id.
 */
export async function checkTanker(id = "tnk_check", regNo = "KA00CHK0001") {
  const { ensureSeeded } = await import("./bootstrap")
  const { readCollection, writeCollection } = await import("@/lib/storage/local-store")
  ensureSeeded()
  if (!readCollection("tankers").some((t) => t.id === id)) {
    const at = "2026-01-01T00:00:00.000Z"
    writeCollection("tankers", [...readCollection("tankers"), { id, name: `Check Tanker ${regNo}`, regNo, vehicleId: null, capacityLitres: null, status: "ACTIVE", notes: "", createdAt: at, updatedAt: at }])
  }
  return id
}

/** Every tanker record as the API returns it — the input of src/domain/tanker.ts. */
export async function tankerRecordsOf() {
  const { api } = await import("./index")
  return { loads: await api.tankerLoads.list(), fills: await api.diesel.list(), external: await api.tankerDispenses.list(), transfers: await api.tankerTransfers.list(), adjustments: await api.tankerAdjustments.list() }
}
