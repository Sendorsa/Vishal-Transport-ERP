import { addDays, parseISO } from "date-fns"
import type { Customer, Invoice, InvoiceLine, NewEntity, Settings, Trip, Vehicle } from "@/lib/types"
import { round2, toISODate } from "@/lib/format"
import { calculateTax } from "./pricing"

export interface ManualLineInput {
  description: string
  quantity: number
  rate: number
}

export interface InvoiceDraftInput {
  customerId: string
  date: string
  dueDate?: string
  periodFrom: string
  periodTo: string
  tripIds: string[]
  extraLines: ManualLineInput[]
  taxRate: number
  notes: string
  status: "DRAFT" | "ISSUED"
}

/**
 * Builds invoice lines (one per vehicle, mirroring the monthly client billing sheets)
 * plus manual lines, and computes GST. Pure: used for the live preview and on save.
 */
export function buildInvoice(
  input: InvoiceDraftInput,
  ctx: { customer: Customer; trips: Trip[]; vehicles: Vehicle[]; settings: Settings }
): Omit<NewEntity<Invoice>, "invoiceNo"> {
  const { customer, settings } = ctx
  const vehicleById = new Map(ctx.vehicles.map((v) => [v.id, v]))
  const selected = ctx.trips.filter((t) => input.tripIds.includes(t.id))
  const byVehicle = new Map<string, Trip[]>()
  selected.forEach((t) => byVehicle.set(t.vehicleId, [...(byVehicle.get(t.vehicleId) ?? []), t]))
  const unit = customer.businessUnit === "GOODS" || customer.businessUnit === "TAXI" ? "Trips" : "Duties"

  const lines: InvoiceLine[] = [...byVehicle.entries()].map(([vid, ts], i) => {
    const amount = round2(ts.reduce((s, t) => s + t.revenue, 0))
    const km = ts.reduce((s, t) => s + t.distanceKm, 0)
    return {
      id: `ln_${i + 1}`,
      description: `${vehicleById.get(vid)?.regNo ?? "Vehicle"} — ${ts.length} ${unit.toLowerCase()}, ${km.toLocaleString("en-IN")} km`,
      sac: settings.sacCode,
      quantity: ts.length,
      unit,
      rate: round2(amount / ts.length),
      amount,
      vehicleId: vid,
      tripIds: ts.map((t) => t.id),
    }
  })
  input.extraLines
    .filter((l) => l.description.trim() && l.quantity * l.rate !== 0)
    .forEach((l, i) =>
      lines.push({
        id: `ln_m${i + 1}`,
        description: l.description.trim(),
        sac: settings.sacCode,
        quantity: l.quantity,
        unit: "Nos",
        rate: l.rate,
        amount: round2(l.quantity * l.rate),
        vehicleId: null,
        tripIds: [],
      })
    )

  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0))
  const company = settings.companies.find((c) => c.code === customer.companyCode)
  const intra = !customer.stateCode || customer.stateCode === company?.stateCode
  const tax = calculateTax(subtotal, input.taxRate, intra)

  return {
    companyCode: customer.companyCode,
    customerId: customer.id,
    date: input.date,
    dueDate: input.dueDate || toISODate(addDays(parseISO(input.date), customer.creditDays)),
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    lines,
    subtotal,
    taxType: tax.taxType,
    taxRate: input.taxRate,
    cgst: tax.cgst,
    sgst: tax.sgst,
    igst: tax.igst,
    total: tax.total,
    status: input.status,
    notes: input.notes,
  }
}
