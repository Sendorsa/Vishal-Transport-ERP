"use client"

import { useMemo } from "react"
import { assignmentIndex, assignmentOn } from "@/domain/assignments"
import { useCustomers, useDrivers, useExpenseMonthLocks, useExpenses, useMonthLocks, useSettings, useVehicleAssignments, useVehicles } from "@/lib/api/hooks"

/** Everything the Expense pages read, with the vehicle master's names resolved (registration, type, customer on a date). */
export function useExpenseData() {
  const expenses = useExpenses()
  const vehicles = useVehicles()
  const customers = useCustomers()
  const settings = useSettings()
  const assignments = useVehicleAssignments()
  const locks = useMonthLocks()
  const monthLocks = useExpenseMonthLocks()
  const drivers = useDrivers()

  return useMemo(() => {
    const vehicle = new Map((vehicles.data ?? []).map((v) => [v.id, v]))
    const customer = new Map((customers.data ?? []).map((c) => [c.id, c]))
    const vehicleType = new Map((settings.data?.vehicleTypes ?? []).map((t) => [t.code, t.name]))
    const idx = assignmentIndex(assignments.data ?? [])
    const regOf = (id: string) => vehicle.get(id)?.regNo ?? "Unknown vehicle"
    /** The central driver master (owner, 27 Nov 2026): a fine's driver is shown from here, so an edited name shows everywhere. */
    const driver = new Map((drivers.data ?? []).map((x) => [x.id, x]))
    const typeOf = (id: string) => {
      const code = vehicle.get(id)?.typeCode ?? ""
      return vehicleType.get(code) ?? code
    }
    const customerName = (id: string | null | undefined) => (id ? customer.get(id)?.shortName || customer.get(id)?.name || "—" : "")
    /** The vehicle's customer on `date` (a preview — the API stamps it on save). */
    const customerOn = (vehicleId: string | undefined, date: string) => (vehicleId && date ? (assignmentOn(idx, vehicleId, date)?.customerId ?? null) : null)
    return {
      ready: !!(expenses.data && vehicles.data && customers.data && settings.data && assignments.data && locks.data && monthLocks.data && drivers.data),
      error: expenses.error ?? vehicles.error,
      expenses: expenses.data ?? [],
      vehicles: vehicles.data ?? [],
      customers: customers.data ?? [],
      companies: settings.data?.companies ?? [],
      locks: locks.data ?? [],
      /** Expense months locked after review (not the Monthly Sheet Lock of the other modules). */
      monthLocks: monthLocks.data ?? [],
      drivers: drivers.data ?? [],
      driver,
      vehicle,
      regOf,
      typeOf,
      customerName,
      customerOn,
    }
  }, [expenses.data, expenses.error, vehicles.data, vehicles.error, customers.data, settings.data, assignments.data, locks.data, monthLocks.data, drivers.data])
}

export type ExpenseData = ReturnType<typeof useExpenseData>
