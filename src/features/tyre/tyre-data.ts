"use client"

import { useMemo } from "react"
import { assignmentIndex, assignmentOn } from "@/domain/assignments"
import { invoicePay, OFFICE_FILTER, OFFICE_LABEL, paidByInvoice, tyreTotals, vendorAccounts, type TyreInvoiceView } from "@/domain/tyre"
import type { TyreMasterKind } from "@/lib/types"
import { useCustomers, useMonthLocks, useSettings, useTyreInvoices, useTyreMasters, useTyrePayments, useVehicleAssignments, useVehicles } from "@/lib/api/hooks"

/**
 * Everything the Tyre pages read, with names resolved: invoices as register rows (totals, vehicle, its type, company,
 * supplier), payments (each invoice's paid / outstanding, each vendor's account), the masters, and the company a vehicle had on a date (the invoice form's preview — the API decides).
 */
export function useTyreData() {
  const invoices = useTyreInvoices()
  const payments = useTyrePayments()
  const masters = useTyreMasters()
  const customers = useCustomers()
  const vehicles = useVehicles()
  const settings = useSettings()
  const assignments = useVehicleAssignments()
  const locks = useMonthLocks()

  return useMemo(() => {
    const master = new Map((masters.data ?? []).map((m) => [m.id, m]))
    const vehicle = new Map((vehicles.data ?? []).map((v) => [v.id, v]))
    const customer = new Map((customers.data ?? []).map((c) => [c.id, c]))
    const vehicleType = new Map((settings.data?.vehicleTypes ?? []).map((t) => [t.code, t]))
    const idx = assignmentIndex(assignments.data ?? [])
    const name = (id: string | null | undefined) => (id ? (master.get(id)?.name ?? "—") : "")
    const companyName = (id: string | null | undefined) => (id ? customer.get(id)?.shortName || customer.get(id)?.name || "—" : "—")
    const typeOf = (vehicleId: string) => {
      const code = vehicle.get(vehicleId)?.typeCode ?? ""
      return { code, name: vehicleType.get(code)?.name ?? code }
    }
    const views: TyreInvoiceView[] = (invoices.data ?? []).map((x) => ({
      ...x,
      totals: tyreTotals(x.items),
      regNo: vehicle.get(x.vehicleId)?.regNo ?? "—",
      vehicleType: typeOf(x.vehicleId).name,
      vehicleTypeCode: typeOf(x.vehicleId).code,
      company: x.office ? OFFICE_LABEL : companyName(x.customerId),
      supplier: name(x.supplierId),
    }))
    // Payments: what each invoice has been paid (Σ allocations), and each vendor's account.
    const paid = paidByInvoice(payments.data ?? [])
    const payOf = (v: TyreInvoiceView) => invoicePay(v.totals.grandTotal, paid.get(v.id) ?? 0)
    const accounts = vendorAccounts(views, payments.data ?? [])
    /** The vehicle's customer on `date` (null: none — the API refuses the invoice then). */
    const customerOn = (vehicleId: string, date: string) => (vehicleId && date ? (assignmentOn(idx, vehicleId, date)?.customerId ?? null) : null)
    return {
      ready: !!(invoices.data && payments.data && masters.data && customers.data && vehicles.data && settings.data && assignments.data),
      error: invoices.error ?? payments.error ?? masters.error,
      views,
      payments: payments.data ?? [],
      payOf,
      accounts,
      masters: masters.data ?? [],
      vehicles: vehicles.data ?? [],
      customers: customers.data ?? [],
      vehicleTypes: settings.data?.vehicleTypes ?? [],
      locks: locks.data ?? [],
      name,
      companyName,
      typeOf,
      customerOn,
    }
  }, [invoices.data, invoices.error, payments.data, payments.error, masters.data, masters.error, customers.data, vehicles.data, settings.data, assignments.data, locks.data])
}

/** The filter pickers' options (register and Monthly Sheet): values in use from the records, masters for line fields. */
export function tyreFilterOptions(d: ReturnType<typeof useTyreData>) {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const masterOpts = (kind: TyreMasterKind) => d.masters.filter((m) => m.kind === kind).sort((a, b) => a.name.localeCompare(b.name)).map((m) => ({ value: m.id, label: m.status === "ARCHIVED" ? `${m.name} (archived)` : m.name }))
  return {
    // Customers, then Office / No Customer (a separate attribution, never a customer).
    company: [
      ...uniq(d.views.flatMap((v) => (v.office || !v.customerId ? [] : [v.customerId]))).map((id) => ({ value: id, label: d.companyName(id) })).sort((a, b) => a.label.localeCompare(b.label)),
      ...(d.views.some((v) => v.office) ? [{ value: OFFICE_FILTER, label: OFFICE_LABEL }] : []),
    ],
    vehicle: uniq(d.views.map((v) => v.vehicleId)).map((id) => ({ value: id, label: d.views.find((v) => v.vehicleId === id)!.regNo })).sort((a, b) => a.label.localeCompare(b.label)),
    vehicleType: uniq(d.views.map((v) => v.vehicleTypeCode)).map((code) => ({ value: code, label: d.views.find((v) => v.vehicleTypeCode === code)!.vehicleType })),
    supplier: masterOpts("SUPPLIER"),
    repairType: masterOpts("REPAIR_TYPE"),
    brand: masterOpts("BRAND"),
    size: masterOpts("SIZE"),
    paymentMode: uniq(d.views.map((v) => v.paymentMode)).map((x) => ({ value: x, label: x })),
    purchaseMode: uniq(d.views.map((v) => v.purchaseMode)).map((x) => ({ value: x, label: x })),
  }
}
