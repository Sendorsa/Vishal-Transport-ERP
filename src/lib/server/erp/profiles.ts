/**
 * The AdBlue profiles on the shared database (owner, 11 Nov 2026): which `api.*` methods Tata Adblue and Adblue may call
 * through /api/erp, and what each read sends back. Every other role passes through unchanged.
 *
 * Why the server and not RLS for reads: stock, weighted-average cost, KM Run and the odometer order are calculated from
 * whole collections, so the API reads everything (RLS lets these roles read the fuel tables) and only the result sent to
 * the browser is limited. The browser can reach the database only through this route, so this list is the boundary.
 * Writes are enforced again by RLS (the `adblue` resource, private.customer_in_scope).
 * No "server-only" import: the offline checks run it (check:erp-db), and UI Preview Mode applies the same list and
 * shapes in the browser (client.ts) so a DEV previewing a profile sees what that profile would — interface only.
 */
import { previousOdometers } from "@/domain/diesel"
import { resolveCustomers } from "@/domain/assignments"
import { customerScope } from "@/lib/identity"
import { isAdBlueProfile } from "@/lib/permissions"
import { readCollection } from "@/lib/storage/local-store"
import type { Customer, IndustrialSupply, DieselEntry, Driver, FuelStation, Role, Vehicle, VehicleAssignment } from "@/lib/types"

type Shape = "as-is" | "empty" | "zero" | "stations" | "customers" | "vehicles" | "drivers" | "assignments" | "diesel" | "industrial"

const METHODS: Record<string, Shape> = {
  // Shared, not customer data: settings, month locks, tankers, the one AdBlue stock pool and its purchase history.
  "settings.get": "as-is",
  "monthLocks.list": "as-is",
  "tankers.list": "as-is",
  "adbluePurchases.list": "as-is",
  "adblueStock.list": "as-is", // every draw (date, litres)
  "adblueTotals.get": "as-is", // company-wide totals by month: the AdBlue page's figures
  // AdBlue is company-wide for both profiles (owner, 12 Nov 2026): every customer's AdBlue entries, and the registration
  // of every vehicle that has one (the AdBlue page names them). Writes stay limited (customer scope, assignment date).
  "adblue.list": "as-is",
  "adblueVehicles.list": "as-is",
  "fuelStations.list": "stations",
  // Diesel and its customers, vehicles, drivers and assignments — Tata Adblue: its granted customers only. Adblue: every customer.
  "customers.list": "customers",
  "vehicles.list": "vehicles",
  "drivers.list": "drivers",
  "assignments.list": "assignments",
  "diesel.list": "diesel",
  // Industrial Diesel Supply (12 Nov 2026): part of Diesel, read-only — the same customers as Diesel. No write method.
  "industrialSupplies.list": "industrial",
  // The shared Diesel screens also ask for these; nothing of them is shown to these roles.
  "trips.list": "empty",
  "invoices.list": "empty",
  "payments.list": "empty",
  "tankerLoads.list": "empty",
  "tankerDispenses.list": "empty",
  "tankerTransfers.list": "empty",
  "tankerAdjustments.list": "empty",
  "audit.editedIds": "empty",
  "audit.unreviewedDeletions": "zero", // a count
  // Writes: AdBlue entries (customer scope checked in the API and by RLS) and bulk purchases into the shared stock.
  "adblue.create": "as-is",
  "adblue.update": "as-is",
  "adblue.remove": "as-is",
  "adbluePurchases.create": "as-is",
}

/** The methods an AdBlue profile may call — the same list for both (pinned in check:erp-db). */
export const PROFILE_METHODS = Object.keys(METHODS)

/**
 * `call` as this role may make it: unchanged for the Owner, Dev and Employee; for an AdBlue profile, only a listed
 * method, its result limited to what the role may see. null = refused (the route logs it as `[erp-denied]`).
 * `scope`: the customers to limit Tata Adblue to — by default the request's grants (customerScope). UI Preview Mode
 * passes an empty set (client.ts): a DEV previewing Tata Adblue sees no customer's data, never DEV's.
 */
export function profileCall<T>(role: Role, method: string, call: () => Promise<T>, scope?: ReadonlySet<string> | null): (() => Promise<unknown>) | null {
  if (!isAdBlueProfile(role)) return call
  const shape = Object.hasOwn(METHODS, method) ? METHODS[method] : undefined
  if (!shape) return null
  if (shape === "empty") return async () => []
  if (shape === "zero") return async () => 0
  return async () => reshape(shape, await call(), scope === undefined ? customerScope() : scope)
}

function reshape(shape: Shape, result: unknown, scope: ReadonlySet<string> | null): unknown {
  if (shape === "as-is") return result
  // A station's opening balance is money owed — not Diesel records.
  if (shape === "stations")
    return (result as FuelStation[]).map((s) => {
      const out = { ...s }
      delete out.openingBalance
      delete out.openingBalanceDate
      return out
    })
  if (!scope) return result // Adblue: every customer
  const mine = (id: string | null) => id !== null && scope.has(id)
  switch (shape) {
    case "customers":
      return (result as Customer[]).filter((c) => mine(c.id))
    case "industrial":
      return (result as IndustrialSupply[]).filter((x) => mine(x.customerId))
    case "assignments":
      return (result as VehicleAssignment[]).filter((a) => mine(a.customerId))
    case "vehicles": {
      const ids = vehiclesInScope(mine)
      // Where a vehicle works now, when that isn't a granted customer, is not shown.
      return (result as Vehicle[]).filter((v) => ids.has(v.id)).map((v) => (mine(v.assignedCustomerId) ? v : { ...v, assignedCustomerId: null }))
    }
    case "drivers": {
      const ids = vehiclesInScope(mine)
      const drivers = new Set(readCollection("vehicles").filter((v) => ids.has(v.id)).map((v) => v.defaultDriverId))
      return (result as Driver[]).filter((d) => drivers.has(d.id))
    }
    case "diesel": {
      // KM Run: each fill's previous reading among every fill of the vehicle, whoever's customer it was.
      const all = result as DieselEntry[]
      const prev = previousOdometers(all, readCollection("vehicles"))
      return all.filter((e) => mine(e.customerId)).map((e) => ({ ...e, prevOdometerKm: prev.get(e.id) ?? null }))
    }
  }
}

/** Vehicles that ever worked for a granted customer: an assignment to it, an entry reported under it, or today's customer. */
function vehiclesInScope(mine: (id: string | null) => boolean): Set<string> {
  const assignments = readCollection("vehicle_assignments")
  const ids = new Set(assignments.filter((a) => mine(a.customerId)).map((a) => a.vehicleId))
  for (const e of [...resolveCustomers(readCollection("diesel_entries"), assignments), ...resolveCustomers(readCollection("adblue_entries"), assignments)]) if (mine(e.customerId)) ids.add(e.vehicleId)
  for (const v of readCollection("vehicles")) if (mine(v.assignedCustomerId)) ids.add(v.id)
  return ids
}
