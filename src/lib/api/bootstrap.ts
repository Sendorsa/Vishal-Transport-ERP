import { buildEvent } from "@/domain/audit"
import {
  appendAuditEvent,
  COLLECTION_KEYS,
  SCHEMA_VERSION,
  clearAll,
  isBrowser,
  migrateStorage,
  readAuditEvents,
  readCollection,
  readMeta,
  readSettings,
  writeCollection,
  writeMeta,
  writeSettings,
} from "@/lib/storage/local-store"
import type { CollectionKey, CollectionMap, Settings } from "@/lib/types"
import { DEFAULT_SETTINGS, cleanWorkspace, generateSeedData } from "@/lib/storage/seed"

/** Seeds demo data on first use (or after a schema change). Idempotent and synchronous. */
/**
 * First use, and app-loaded demo data nobody has touched, become the clean go-live workspace (owner, 1 Nov 2026):
 * demo data is never loaded automatically any more — only by Settings → Reset to demo data. Real data is never
 * replaced: restored / imported data, a workspace someone has typed into (including typed-into demo data) and data
 * of unknown origin are kept and only migrated (migrateStorage) when the data format changes.
 */
export function ensureSeeded() {
  if (!isBrowser()) return
  migrateStorage()
  const meta = readMeta()
  if (meta && meta.version === SCHEMA_VERSION && meta.source !== "DEMO") return // the common case, without reading the audit log
  if (meta && meta.source !== "DEMO") return writeMeta({ ...meta, version: SCHEMA_VERSION })
  const events = readAuditEvents()
  const lastReset = events.findLastIndex((e) => e.action === "DATA_RESET")
  const userWrote = events.slice(lastReset + 1).some((e) => e.actor.kind !== "SYSTEM")
  // Demo data the app loaded by itself (first use, before 1 Nov 2026) vs. demo data someone chose (Settings → Reset).
  const autoLoaded = lastReset < 0 || events[lastReset].actor.kind === "SYSTEM"
  if (meta && meta.version === SCHEMA_VERSION && !(autoLoaded && !userWrote)) return // chosen demo data, or typed into: kept
  // Typed-into demo data after a format change, or data whose meta key was lost: real — kept, "unknown origin" from now on.
  if (meta ? userWrote : COLLECTION_KEYS.some((k) => readCollection(k).length > 0))
    return writeMeta({ version: SCHEMA_VERSION, seededAt: meta?.seededAt ?? new Date().toISOString() })
  loadEmptyWorkspace()
  // Done by the app, not a user: recorded as a SYSTEM event (and the boundary for "Edited" badges).
  appendAuditEvent(
    buildEvent(
      { action: "DATA_RESET", module: "System", recordType: "Data", recordId: "workspace", label: !meta ? "Clean workspace created on first use" : autoLoaded && !userWrote ? "Automatically loaded demo data replaced by the clean go-live workspace" : "Demo data replaced by the clean workspace after an app data-format change" },
      { kind: "SYSTEM", userId: null, name: null, role: null },
      `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      new Date().toISOString()
    )
  )
}

export function loadDemoData() {
  clearAll()
  const data = generateSeedData(new Date())
  writeSettings(data.settings)
  for (const key of COLLECTION_KEYS) writeCollection(key, data[key] as never)
  writeMeta({ version: SCHEMA_VERSION, seededAt: new Date().toISOString(), source: "DEMO" })
}

/** Empty workspace: default master data, no transactions. */
/**
 * The clean go-live workspace (cleanWorkspace in seed.ts): company configuration, the internal tanker source and the
 * three tankers with their vehicles; nothing else, zero stock. Used on first use and by Settings → Clear all data.
 */
export function loadEmptyWorkspace() {
  clearAll()
  writeSettings(structuredClone(DEFAULT_SETTINGS))
  for (const key of COLLECTION_KEYS) writeCollection(key, [])
  const clean = cleanWorkspace(new Date())
  writeCollection("fuel_stations", clean.fuel_stations)
  writeCollection("vehicles", clean.vehicles)
  writeCollection("tankers", clean.tankers)
  writeMeta({ version: SCHEMA_VERSION, seededAt: new Date().toISOString(), source: "EMPTY" })
}

/* ------------------------------------------------------------------ Backup files */

/** A full data backup (Settings → Export) — also the format of prepared imports. The audit log is not part of it. */
export interface BackupFile {
  format: "vishal-erp-backup"
  version: number
  exportedAt: string
  /** What the file holds, e.g. "Fuel import FY 2026-27 from New data". */
  label?: string
  settings: Settings
  collections: Partial<{ [K in CollectionKey]: CollectionMap[K][] }>
}

export function exportBackup(label?: string): BackupFile {
  ensureSeeded()
  return {
    format: "vishal-erp-backup",
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    label,
    settings: readSettings()!,
    collections: Object.fromEntries(COLLECTION_KEYS.map((k) => [k, readCollection(k)])),
  }
}

/**
 * Checks a backup before anything is replaced: shape, unique ids, and that every fill, load and payment
 * points at a record in the file. Also accepts the older flat export ({ settings, customers, … }).
 */
export function parseBackup(raw: unknown): BackupFile {
  const o = (raw ?? {}) as Record<string, unknown>
  const file: BackupFile =
    o.format === "vishal-erp-backup"
      ? (o as unknown as BackupFile)
      : { format: "vishal-erp-backup", version: 0, exportedAt: String(o.exportedAt ?? ""), settings: o.settings as Settings, collections: Object.fromEntries(COLLECTION_KEYS.filter((k) => k in o).map((k) => [k, o[k]])) }
  const errors: string[] = []
  if (!file.settings || !Array.isArray(file.settings.companies)) errors.push("settings are missing")
  if (file.version > SCHEMA_VERSION) errors.push(`the file is from a newer app version (${file.version})`)
  const ids = {} as Record<CollectionKey, Set<string>>
  for (const k of COLLECTION_KEYS) {
    const list = file.collections[k] ?? []
    if (!Array.isArray(list)) {
      errors.push(`${k} is not a list`)
      continue
    }
    ids[k] = new Set()
    for (const r of list as { id?: unknown }[]) {
      if (typeof r?.id !== "string" || !r.id) errors.push(`${k}: a record has no id`)
      else if (ids[k].has(r.id)) errors.push(`${k}: duplicate id ${r.id}`)
      else ids[k].add(r.id)
    }
  }
  const c = file.collections
  const missing = (what: string, set: Set<string> | undefined, id: string | null | undefined) => {
    if (id && !set?.has(id)) errors.push(`${what} points to a missing record ${id}`)
  }
  for (const d of c.diesel_entries ?? []) {
    missing(`diesel entry ${d.id}`, ids.vehicles, d.vehicleId)
    missing(`diesel entry ${d.id}`, ids.fuel_stations, d.vendorId)
    missing(`diesel entry ${d.id}`, ids.customers, d.customerId)
  }
  for (const l of c.tanker_loads ?? []) if (!l.opening) missing(`tanker load ${l.id}`, ids.fuel_stations, l.stationId)
  for (const p of c.payments ?? []) missing(`payment ${p.id}`, ids.fuel_stations, p.direction === "OUT" ? p.vendorId : null)
  for (const x of [...(c.tanker_loads ?? []), ...(c.tanker_dispenses ?? []), ...(c.diesel_entries ?? []).filter((d) => d.tankerId)]) missing(`tanker record ${x.id}`, ids.tankers, x.tankerId)
  for (const t of c.tanker_transfers ?? []) {
    missing(`tanker transfer ${t.id}`, ids.tankers, t.fromTankerId)
    missing(`tanker transfer ${t.id}`, ids.tankers, t.toTankerId)
  }
  for (const a of c.tanker_adjustments ?? []) missing(`tanker adjustment ${a.id}`, ids.tankers, a.tankerId)
  for (const a of c.vehicle_assignments ?? []) {
    missing(`assignment ${a.id}`, ids.vehicles, a.vehicleId)
    missing(`assignment ${a.id}`, ids.customers, a.customerId)
  }
  if (errors.length) throw new Error(`This backup can't be restored: ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ""}.`)
  return file
}

/** Replaces all business data with the file's (the audit log and session stay). Call inside a storage transaction. */
export function restoreBackup(file: BackupFile) {
  clearAll()
  writeSettings(file.settings)
  for (const key of COLLECTION_KEYS) writeCollection(key, (file.collections[key] ?? []) as never)
  writeMeta({ version: SCHEMA_VERSION, seededAt: new Date().toISOString(), source: "RESTORED" })
  migrateStorage(true)
}
