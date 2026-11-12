"use client"

/**
 * TanStack Query hooks — the only way components read or write data.
 * Query keys are per collection so the future API swap keeps cache semantics.
 */
import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "./client"
import { withVersions } from "@/lib/versions"
import { useCompanyScope, useRole } from "@/lib/app-state"
import { canEditMonth, monthLockInfo } from "@/domain/month-lock"
import { canSetMonthLock } from "@/lib/permissions"
import { todayISO } from "@/lib/format"
import { scopeDataset, type Dataset } from "@/domain/analytics"
import { withRuns } from "@/domain/adblue"
import type { InvoiceDraftInput } from "@/domain/invoicing"
import type { CollectionKey, Customer, Driver, EntityStatus, NewEntity, Payment, Settings, Vehicle } from "@/lib/types"
import type { AdBlueInput, AdBluePurchaseInput, TankerAdjustmentInput, TankerInput, TankerLoadInput, TankerTransferInput, TripInput } from "@/lib/api"

export const queryKeys = {
  customers: ["customers"] as const,
  vehicles: ["vehicles"] as const,
  drivers: ["drivers"] as const,
  trips: ["trips"] as const,
  diesel_entries: ["diesel_entries"] as const,
  adblue_entries: ["adblue_entries"] as const,
  vehicle_assignments: ["vehicle_assignments"] as const,
  month_locks: ["month_locks"] as const,
  fuel_stations: ["fuel_stations"] as const,
  adblue_purchases: ["adblue_purchases"] as const,
  tanker_loads: ["tanker_loads"] as const,
  tanker_dispenses: ["tanker_dispenses"] as const,
  tankers: ["tankers"] as const,
  tanker_transfers: ["tanker_transfers"] as const,
  tanker_adjustments: ["tanker_adjustments"] as const,
  invoices: ["invoices"] as const,
  payments: ["payments"] as const,
  settings: ["settings"] as const,
  audit: ["audit"] as const,
}

/**
 * Which queries to refresh when another user changed a module (the audit trail's module names): shared-database sync.
 * Unknown modules refresh nothing but the audit log.
 */
const MODULE_KEYS: Record<string, (keyof typeof queryKeys)[]> = {
  Diesel: ["diesel_entries", "vehicles"],
  AdBlue: ["adblue_entries", "adblue_purchases"],
  "Diesel Tanker": ["tankers", "tanker_loads", "tanker_transfers", "tanker_adjustments", "tanker_dispenses", "diesel_entries"],
  "Fuel Stations": ["fuel_stations", "payments"],
  Payments: ["payments", "invoices"],
  Customers: ["customers"],
  Vehicles: ["vehicles", "vehicle_assignments", "diesel_entries", "adblue_entries"],
  Drivers: ["drivers"],
  Trips: ["trips"],
  Invoices: ["invoices", "trips"],
  Settings: ["settings"],
  "Month Lock": ["month_locks"],
}
export function keysForModules(modules: string[]) {
  return [...new Set([...modules.flatMap((m) => MODULE_KEYS[m] ?? []), "audit" as const])]
}

/* ------------------------------------------------------------------ Reads */

export const useCustomers = () => useQuery({ queryKey: queryKeys.customers, queryFn: () => api.customers.list() })
export const useVehicles = () => useQuery({ queryKey: queryKeys.vehicles, queryFn: () => api.vehicles.list() })
export const useDrivers = () => useQuery({ queryKey: queryKeys.drivers, queryFn: () => api.drivers.list() })
export const useTrips = () => useQuery({ queryKey: queryKeys.trips, queryFn: () => api.trips.list() })
export const useAdBlueEntries = () => useQuery({ queryKey: queryKeys.adblue_entries, queryFn: () => api.adblue.list(), select: withRuns })
/** Every bulk-stock draw (date, litres, order only) — the shared stock, for every role; refreshed with the AdBlue entries. */
export const useAdBlueStockDraws = () => useQuery({ queryKey: [...queryKeys.adblue_entries, "stock"], queryFn: () => api.adblueStock.list() })
/** Registration of every vehicle with an AdBlue entry — the AdBlue page names each record's vehicle (every role). */
export const useAdBlueVehicles = () => useQuery({ queryKey: [...queryKeys.adblue_entries, "vehicles"], queryFn: () => api.adblueVehicles.list() })
/** The AdBlue page's company-wide figures, totals by month only — every role; refreshed with the AdBlue entries and purchases. */
export const useAdBlueTotals = () => useQuery({ queryKey: [...queryKeys.adblue_entries, "totals"], queryFn: () => api.adblueTotals.get() })
export const useVehicleAssignments = () => useQuery({ queryKey: queryKeys.vehicle_assignments, queryFn: () => api.assignments.list() })
export const useFuelStations = () => useQuery({ queryKey: queryKeys.fuel_stations, queryFn: () => api.fuelStations.list() })
// Own key under "payments", so recording any payment refreshes it too.
export const useAdBluePurchases = () => useQuery({ queryKey: queryKeys.adblue_purchases, queryFn: () => api.adbluePurchases.list() })
export const useTankerLoads = () => useQuery({ queryKey: queryKeys.tanker_loads, queryFn: () => api.tankerLoads.list() })
export const useTankerDispenses = () => useQuery({ queryKey: queryKeys.tanker_dispenses, queryFn: () => api.tankerDispenses.list() })
export const useTankers = () => useQuery({ queryKey: queryKeys.tankers, queryFn: () => api.tankers.list() })
export const useTankerTransfers = () => useQuery({ queryKey: queryKeys.tanker_transfers, queryFn: () => api.tankerTransfers.list() })
export const useTankerAdjustments = () => useQuery({ queryKey: queryKeys.tanker_adjustments, queryFn: () => api.tankerAdjustments.list() })
export const useMonthLocks = () => useQuery({ queryKey: queryKeys.month_locks, queryFn: () => api.monthLocks.list() })
export const useDieselEntries = () => useQuery({ queryKey: queryKeys.diesel_entries, queryFn: () => api.diesel.list() })
export const useInvoices = () => useQuery({ queryKey: queryKeys.invoices, queryFn: () => api.invoices.list() })
export const usePayments = () => useQuery({ queryKey: queryKeys.payments, queryFn: () => api.payments.list() })
export const useSettings = () => useQuery({ queryKey: queryKeys.settings, queryFn: () => api.settings.get() })

/* ------------------------------------------------------------------ Audit trail (read-only) */

/** Central Audit Log — the API refuses every role but the Owner. */
export const useAuditLog = (enabled = true) => useQuery({ queryKey: [...queryKeys.audit, "log"], queryFn: () => api.audit.list(), enabled })
/** Ids of edited records, for the "Edited" badge. */
export const useEditedIds = () => useQuery({ queryKey: [...queryKeys.audit, "edited"], queryFn: () => api.audit.editedIds(), select: (ids) => new Set(ids) })
/** Unreviewed deletion events — the Owner's Audit Log badge. Only fetched for the Owner (the API refuses others). */
export const useUnreviewedDeletions = (enabled: boolean) => useQuery({ queryKey: [...queryKeys.audit, "unreviewed"], queryFn: () => api.audit.unreviewedDeletions(), enabled })

/** Owner: mark deletion events reviewed (never changes or hides the events). */
export function useMarkReviewed() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (eventIds: string[]) => api.audit.markReviewed(eventIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.audit }),
    onError,
  })
}

/** Dry run of restoring a deletion — eligibility, what changes, possible duplicate. Owner only. */
export const useRestoreCheck = (eventId: string | null) =>
  useQuery({ queryKey: [...queryKeys.audit, "restore-check", eventId], queryFn: () => api.audit.checkRestore(eventId!), enabled: !!eventId })

/** Owner: Restore / Push Back a deleted record. Any collection may change, so everything refreshes. */
export function useRestoreDeleted() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ eventId, reason, confirmNotDuplicate }: { eventId: string; reason: string; confirmNotDuplicate?: boolean }) => api.audit.restoreDeleted(eventId, reason, { confirmNotDuplicate }),
    onSuccess: () => qc.invalidateQueries(),
    onError,
  })
}

/** One record's history, loaded when the history dialog opens. */
export const useRecordHistory = (recordId: string, enabled: boolean) => useQuery({ queryKey: [...queryKeys.audit, "record", recordId], queryFn: () => api.audit.history(recordId), enabled })

/**
 * Everything, scoped to the selected company. Analytics screens use this; when the
 * backend exists these become dedicated report endpoints.
 */
export function useDataset(opts?: { allCompanies?: boolean }): { data: Dataset | undefined; isLoading: boolean; error: unknown } {
  const [selectedScope] = useCompanyScope()
  // Diesel is organised by customer, never by internal legal entity.
  const scope = opts?.allCompanies ? "GROUP" : selectedScope
  const qs = [useSettings(), useCustomers(), useVehicles(), useDrivers(), useTrips(), useDieselEntries(), useInvoices(), usePayments(), useVehicleAssignments(), useFuelStations(), useTankerLoads(), useTankers()] as const
  const [s, c, v, d, t, de, i, p, va, fs, tl, tk] = qs
  const data = useMemo(() => {
    if (!s.data || !c.data || !v.data || !d.data || !t.data || !de.data || !i.data || !p.data || !va.data || !fs.data || !tl.data || !tk.data) return undefined
    return scopeDataset(
      { settings: s.data, customers: c.data, vehicles: v.data, drivers: d.data, trips: t.data, diesel: de.data, invoices: i.data, payments: p.data, assignments: va.data, fuelStations: fs.data, tankerLoads: tl.data, tankers: tk.data },
      scope
    )
  }, [s.data, c.data, v.data, d.data, t.data, de.data, i.data, p.data, va.data, fs.data, tl.data, tk.data, scope])
  return { data, isLoading: qs.some((q) => q.isLoading), error: qs.find((q) => q.error)?.error }
}

/* ------------------------------------------------------------------ Writes */

/** Refreshes the given collections — and always the audit trail, since every write adds an event. */
function useInvalidate() {
  const qc = useQueryClient()
  return (...keys: (CollectionKey | "settings")[]) =>
    Promise.all([...keys, "audit" as const].map((k) => qc.invalidateQueries({ queryKey: queryKeys[k] })))
}

const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong")

/**
 * Runs an API call carrying the version (`updatedAt`) of the record the user's screen showed — optimistic concurrency
 * (src/lib/versions.ts): if someone else saved it since, the server refuses with a clear message instead of
 * overwriting their change. No version (a new record) = no check.
 */
const v = <T,>(id: string | undefined, version: string | undefined, call: () => T) => withVersions(id ? { [id]: version } : {}, call)

export function useSaveCustomer() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, data, version }: { id?: string; data: NewEntity<Customer>; version?: string }) =>
      v(id, version, () => id ? api.customers.update(id, data) : api.customers.create(data)),
    onSuccess: () => invalidate("customers"),
    onError,
  })
}

export function useUpdateCustomer() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, patch, version }: { id: string; patch: Partial<NewEntity<Customer>>; version?: string }) => v(id, version, () => api.customers.update(id, patch)),
    onSuccess: () => invalidate("customers"),
    onError,
  })
}

/** Archive (soft delete) or restore — records are never removed. */
export function useArchiveCustomer() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, restore, version }: { id: string; restore?: boolean; version?: string }) => v(id, version, () => (restore ? api.customers.restore(id) : api.customers.archive(id))),
    onSuccess: () => invalidate("customers"),
    onError,
  })
}

export function useSaveVehicle() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, data, version }: { id?: string; data: Partial<NewEntity<Vehicle>> & { assignedSince?: string }; version?: string }) =>
      v(id, version, () => id ? api.vehicles.update(id, data) : api.vehicles.create(data as NewEntity<Vehicle>)),
    // A customer change is a transfer: assignments change, and so do the entries' customers from today.
    onSuccess: () => invalidate("vehicles", "vehicle_assignments", "diesel_entries", "adblue_entries"),
    onError,
  })
}

/** Lock state of `month` (yyyy-MM) and whether the current role may add / change data dated in it. */
export function useMonthLock(month: string) {
  const [role] = useRole()
  const locks = useMonthLocks()
  const info = monthLockInfo(month, todayISO(), locks.data ?? [])
  const isOwner = canSetMonthLock(role) // lock / unlock: the Owner and Dev only (the Employee sees the state)
  return { info, isOwner, canEdit: canEditMonth(role, month, todayISO(), locks.data ?? []) } // locked data: Owner and Dev only
}

/** Owner: lock a month early, or unlock a closed month for users. */
export function useSetMonthLock() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ month, state }: { month: string; state: "OPEN" | "LOCKED" }) => api.monthLocks.set(month, state),
    onSuccess: () => invalidate("month_locks"),
    onError,
  })
}

/** Transfer a vehicle to another customer from an effective date (earlier months stay as they were). */
/** `toast: false` — the caller shows the API's explanation itself (the Transfer Vehicle dialog, next to the date). */
export function useTransferVehicle({ toast = true }: { toast?: boolean } = {}) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, customerId, effectiveDate, reason, version }: { id: string; customerId: string | null; effectiveDate: string; reason?: string; version?: string }) => v(id, version, () => api.vehicles.transfer(id, customerId, effectiveDate, reason)),
    onSuccess: () => invalidate("vehicles", "vehicle_assignments", "diesel_entries", "adblue_entries"),
    onError: toast ? onError : undefined,
  })
}

/**
 * Corrects an assignment's start date (same assignment, customer and history; audited with the reason) — and, for a
 * transfer date, the previous assignment's end. `versions`: both assignments as the screen showed them. No toast on
 * failure: the dialog shows the API's explanation (e.g. an entry the new date would move) next to the date.
 */
export function useCorrectAssignmentStart() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, startDate, reason, versions }: { id: string; startDate: string; reason: string; versions: Record<string, string> }) => withVersions(versions, () => api.assignments.correctStartDate(id, { startDate, reason })),
    onSuccess: () => invalidate("vehicle_assignments", "vehicles", "diesel_entries", "adblue_entries"),
  })
}

export function useArchiveVehicle() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, restore, version }: { id: string; restore?: boolean; version?: string }) => v(id, version, () => (restore ? api.vehicles.restore(id) : api.vehicles.archive(id))),
    onSuccess: () => invalidate("vehicles"),
    onError,
  })
}

/** Drivers: Active / Inactive / Archived — never deleted. */
export function useSetDriverStatus() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, status, version }: { id: string; status: EntityStatus; version?: string }) => v(id, version, () => api.drivers.update(id, { status })),
    onSuccess: () => invalidate("drivers"),
    onError,
  })
}

export function useSaveDriver() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (data: NewEntity<Driver>) => api.drivers.create(data),
    onSuccess: () => invalidate("drivers"),
    onError,
  })
}

export function useSaveTrip() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, data, reason, version }: { id?: string; data: TripInput; reason?: string; version?: string }) =>
      v(id, version, () => id ? api.trips.update(id, data, reason) : api.trips.create(data)),
    onSuccess: () => invalidate("trips"),
    onError,
  })
}

export function useDeleteTrip() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: ({ id, reason, version }: { id: string; reason: string; version?: string }) => v(id, version, () => api.trips.remove(id, reason)), onSuccess: () => invalidate("trips"), onError })
}

export function useUpdateDiesel() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, data, reason, version }: { id: string; data: Parameters<typeof api.diesel.update>[1]; reason?: string; version?: string }) => v(id, version, () => api.diesel.update(id, data, reason)),
    onSuccess: () => invalidate("diesel_entries", "vehicles"), // a corrected reading can change the vehicle's last known km
    onError,
  })
}

export function useCreateDiesel() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: api.diesel.create,
    onSuccess: () => invalidate("diesel_entries", "vehicles"),
    onError,
  })
}

export function useDeleteDiesel() {
  const invalidate = useInvalidate()
  // Tanker fills return litres to the tanker; vehicles' "last known km" is unaffected.
  return useMutation({ mutationFn: ({ id, reason, version }: { id: string; reason: string; version?: string }) => v(id, version, () => api.diesel.remove(id, reason)), onSuccess: () => invalidate("diesel_entries", "vehicles"), onError })
}

export function useCreateInvoice() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: InvoiceDraftInput) => api.invoices.create(input),
    onSuccess: () => invalidate("invoices", "trips"),
    onError,
  })
}

export function useInvoiceAction() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, action, reason, version }: { id: string; action: "issue" | "cancel"; reason?: string; version?: string }) =>
      v(id, version, () => action === "issue" ? api.invoices.issue(id) : api.invoices.cancel(id, reason)),
    onSuccess: () => invalidate("invoices", "trips"),
    onError,
  })
}

export function useCreatePayment() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: Omit<NewEntity<Payment>, "paymentNo">) => api.payments.create(input),
    onSuccess: () => invalidate("payments"),
    onError,
  })
}

export function useDeletePayment() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: ({ id, reason, version }: { id: string; reason: string; version?: string }) => v(id, version, () => api.payments.remove(id, reason)), onSuccess: () => invalidate("payments"), onError })
}

export function useUpdateSettings() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => api.settings.update(patch),
    onSuccess: () => invalidate("settings"),
    onError,
  })
}

export function useAdminAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (action: "reset" | "clear") => (action === "reset" ? api.admin.resetDemoData() : api.admin.clearAllData()),
    onSuccess: () => qc.invalidateQueries(),
    onError,
  })
}

/** The full backup file, for download (one-off read, not cached). */
export const fetchBackup = () => api.admin.exportBackup()

/** Replaces all data from a backup / prepared import file (Owner and Dev; refused in the API for others). */
export function useRestoreBackup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ data, fileName }: { data: unknown; fileName: string }) => api.admin.restoreBackup(data, fileName),
    onSuccess: () => qc.invalidateQueries(),
    onError,
  })
}

/* ------------------------------------------------------------------ Inline master-list creation */

/** Adds a vehicle type to the master list (settings) and returns its code. */
export function useCreateVehicleType() {
  const save = useUpdateSettings()
  return async (name: string, mileage?: number) => {
    const { vehicleTypes } = await api.settings.get()
    const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "TYPE"
    let code = base
    for (let i = 2; vehicleTypes.some((t) => t.code === code); i++) code = `${base}_${i}`
    const n = name.toLowerCase()
    const category = /truck|hcv|lcv|tipper|trailer|lorry/.test(n) ? "TRUCK" : /car|taxi|sedan|suv/.test(n) ? "CAR" : /van|traveller|tempo/.test(n) ? "VAN" : /pickup|pick-up|auto|ace/.test(n) ? "PICKUP" : "BUS"
    await save.mutateAsync({ vehicleTypes: [...vehicleTypes, { code, name, category, defaultSeats: null, defaultMileage: mileage || 5 }] })
    return code
  }
}

/** Creates a driver with just a name (details can be filled later) and returns its id. */
export function useCreateDriverByName() {
  const save = useSaveDriver()
  return async (name: string, companyCode: Driver["companyCode"]) => {
    const d = await save.mutateAsync({ name, phone: "", licenseNo: "", licenseValidTill: "", companyCode, status: "ACTIVE" })
    return d.id
  }
}

/**
 * Creates a fuel station in the one master list (vt:fuelStations) and returns its id. Used by the
 * Diesel / AdBlue entry dialogs and the Fuel Stations page — an existing name returns that station.
 */
export function useCreateFuelStation() {
  const invalidate = useInvalidate()
  return async (name: string, details?: { location?: string; creditDays?: number }) => {
    try {
      const station = await api.fuelStations.create({ name, ...details })
      await invalidate("fuel_stations")
      return station.id
    } catch (e) {
      // Not a useMutation, so nothing else reports it: every caller (Fuel Stations, the Diesel and tanker-load dialogs'
      // inline "Create …") would otherwise fail silently and leave the dialog waiting.
      onError(e)
      throw e
    }
  }
}

export function useUpdateFuelStation() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, patch, version }: { id: string; patch: { name: string; location: string; creditDays: number }; version?: string }) => v(id, version, () => api.fuelStations.update(id, patch)),
    onSuccess: () => invalidate("fuel_stations"),
    onError,
  })
}

/**
 * Fresh-start opening balances (31 Oct 2026 baseline), Owner / Dev: a station's opening balance, one tanker's
 * opening stock. Never purchases or payments.
 */
export function useSetStationOpeningBalance() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, amount, date, version }: { id: string; amount: number; date: string; version?: string }) => v(id, version, () => api.fuelStations.setOpeningBalance(id, { amount, date })),
    onSuccess: () => invalidate("fuel_stations"),
    onError,
  })
}
export function useCreateTankerOpening() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (input: Parameters<typeof api.tankerLoads.createOpening>[0]) => api.tankerLoads.createOpening(input), onSuccess: () => invalidate("tanker_loads", "diesel_entries"), onError })
}
/** Records a payment to a fuel station (a payment voucher — reduces the station's balance). */
export function useAddFuelStationPayment() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: Parameters<typeof api.fuelStationPayments.create>[0]) => api.fuelStationPayments.create(input),
    onSuccess: () => invalidate("payments"),
    onError,
  })
}

export function useUpdateFuelStationPayment() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, patch, reason, version }: { id: string; patch: Parameters<typeof api.fuelStationPayments.update>[1]; reason?: string; version?: string }) => v(id, version, () => api.fuelStationPayments.update(id, patch, reason)),
    onSuccess: () => invalidate("payments"),
    onError,
  })
}

/** TDS on a station's bills for a month (0.1%, dated the month's last day) — one per station per month. */
export function useRecordStationTds() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (input: Parameters<typeof api.fuelStationPayments.recordTds>[0]) => api.fuelStationPayments.recordTds(input), onSuccess: () => invalidate("payments"), onError })
}

export function useDeleteFuelStationPayment() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: ({ id, reason, version }: { id: string; reason: string; version?: string }) => v(id, version, () => api.fuelStationPayments.remove(id, reason)), onSuccess: () => invalidate("payments"), onError })
}

/** Diesel Tanker: loads in, external dispenses out. Tanker-sourced fills' cost changes too (diesel_entries). */
export function useSaveTankerLoad() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, data, reason, version }: { id?: string; data: TankerLoadInput; reason?: string; version?: string }) => v(id, version, () => (id ? api.tankerLoads.update(id, data, reason) : api.tankerLoads.create(data))),
    onSuccess: () => invalidate("tanker_loads", "diesel_entries"),
    onError,
  })
}
export function useDeleteTankerLoad() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: ({ id, reason, version }: { id: string; reason: string; version?: string }) => v(id, version, () => api.tankerLoads.remove(id, reason)), onSuccess: () => invalidate("tanker_loads", "diesel_entries"), onError })
}
export function useDeleteTankerDispense() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: ({ id, reason, version }: { id: string; reason: string; version?: string }) => v(id, version, () => api.tankerDispenses.remove(id, reason)), onSuccess: () => invalidate("tanker_dispenses", "diesel_entries"), onError })
}

/** Tanker master: add / edit, archive / restore. */
export function useSaveTanker() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, data, version }: { id?: string; data: TankerInput; version?: string }) => v(id, version, () => (id ? api.tankers.update(id, data) : api.tankers.create(data))),
    onSuccess: () => invalidate("tankers"),
    onError,
  })
}
export function useArchiveTanker() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: ({ id, restore, version }: { id: string; restore?: boolean; version?: string }) => v(id, version, () => (restore ? api.tankers.restore(id) : api.tankers.archive(id))), onSuccess: () => invalidate("tankers"), onError })
}
/** Diesel moved between tankers (never a purchase). */
export function useCreateTankerTransfer() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (data: TankerTransferInput) => api.tankerTransfers.create(data), onSuccess: () => invalidate("tanker_transfers", "diesel_entries"), onError })
}
export function useDeleteTankerTransfer() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: ({ id, reason, version }: { id: string; reason: string; version?: string }) => v(id, version, () => api.tankerTransfers.remove(id, reason)), onSuccess: () => invalidate("tanker_transfers", "diesel_entries"), onError })
}
/** Stock corrections with a mandatory reason. */
export function useCreateTankerAdjustment() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (data: TankerAdjustmentInput) => api.tankerAdjustments.create(data), onSuccess: () => invalidate("tanker_adjustments", "diesel_entries"), onError })
}
export function useDeleteTankerAdjustment() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: ({ id, reason, version }: { id: string; reason: string; version?: string }) => v(id, version, () => api.tankerAdjustments.remove(id, reason)), onSuccess: () => invalidate("tanker_adjustments", "diesel_entries"), onError })
}

/** AdBlue bulk purchase (add / edit). Stock and the weighted-average cost of every draw change too. */
export function useSaveAdBluePurchase() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, data, reason, version }: { id?: string; data: AdBluePurchaseInput; reason?: string; version?: string }) => v(id, version, () => (id ? api.adbluePurchases.update(id, data, reason) : api.adbluePurchases.create(data))),
    onSuccess: () => invalidate("adblue_purchases", "adblue_entries"),
    onError,
  })
}

export function useDeleteAdBluePurchase() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: ({ id, reason, version }: { id: string; reason: string; version?: string }) => v(id, version, () => api.adbluePurchases.remove(id, reason)), onSuccess: () => invalidate("adblue_purchases", "adblue_entries"), onError })
}

/** Archive (soft delete) or restore a fuel station. */
export function useArchiveFuelStation() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, restore, version }: { id: string; restore?: boolean; version?: string }) => v(id, version, () => (restore ? api.fuelStations.restore(id) : api.fuelStations.archive(id))),
    onSuccess: () => invalidate("fuel_stations"),
    onError,
  })
}

export function useDeleteAdBlue() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: ({ id, reason, version }: { id: string; reason: string; version?: string }) => v(id, version, () => api.adblue.remove(id, reason)), onSuccess: () => invalidate("adblue_entries"), onError })
}

export function useSaveAdBlue() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, data, reason, version }: { id?: string; data: AdBlueInput; reason?: string; version?: string }) => v(id, version, () => (id ? api.adblue.update(id, data, reason) : api.adblue.create(data))),
    onSuccess: () => invalidate("adblue_entries"),
    onError,
  })
}

/* ------------------------------------------------------------------ Go-live openings (owner, 3 Nov 2026) — Owner / Dev */

/** AdBlue already on hand when records begin (stock and value; never "AdBlue Purchased"). */
export function useCreateAdBlueOpening() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (input: Parameters<typeof api.adbluePurchases.createOpening>[0]) => api.adbluePurchases.createOpening(input), onSuccess: () => invalidate("adblue_purchases", "adblue_entries"), onError })
}
/** An invoice still unpaid when records begin: original number and dates, the amount outstanding. */
export function useCreateOpeningInvoice() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (input: Parameters<typeof api.invoices.createOpening>[0]) => api.invoices.createOpening(input), onSuccess: () => invalidate("invoices"), onError })
}
/** The odometer at the vehicle's last fill before records begin (the first fill's KM Run starts from it). */
export function useSetOpeningOdometer() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, km, date, version }: { id: string; km: number | null; date: string; version?: string }) => v(id, version, () => api.vehicles.setOpeningOdometer(id, { km, date })),
    onSuccess: () => invalidate("vehicles", "diesel_entries"),
    onError,
  })
}
/** Go-live setup: the three company tankers and their vehicle records, if missing. */
export function useSetupTankerMasters() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: () => api.admin.setupTankerMasters(), onSuccess: () => invalidate("tankers", "vehicles"), onError })
}
