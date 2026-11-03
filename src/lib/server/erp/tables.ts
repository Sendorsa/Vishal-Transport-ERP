/**
 * Database rows ⇄ the app's TypeScript shapes (src/lib/types.ts), for every business collection, plus row writes.
 * The one place that knows both. Reads use `to_jsonb(row)`, so timestamps keep their exact text (microseconds) —
 * the version token of optimistic concurrency (src/lib/versions.ts) must never pass through `Date`.
 * Generated columns (amounts, totals) are read, never written: the database computes money exactly (D-12).
 */
import type {
  AdBlueEntry, AdBluePurchase, AuditEvent, AuditReview, CollectionKey, CompanyProfile, Customer, DieselEntry, Driver,
  ExpenseCategory, FuelStation, Invoice, MonthLock, Payment, Settings, StatusPeriod, Tanker, TankerAdjustment, TankerLoad,
  TankerTransfer, Trip, Vehicle, VehicleAssignment, VehicleType,
} from "@/lib/types"
import type { RequestIdentity } from "@/lib/request-scope"
import { ConflictError } from "@/lib/versions"

/** One SQL statement inside the request's transaction. */
export type Sql = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>

type J = Record<string, unknown> & { id: string; created_at: string; updated_at: string }
const rows = async (sql: Sql, from: string, order = "created_at, id") =>
  (await sql<{ j: J }>(`select to_jsonb(t) as j from ${from} t order by ${order}`)).map((r) => r.j)
const str = (v: unknown) => (v == null ? "" : String(v))
const num = (v: unknown) => (v == null ? 0 : Number(v))
const numOrNull = (v: unknown) => (v == null ? null : Number(v))
const dateOrNull = (v: unknown) => (v === "" || v == null ? null : v)
const base = (j: J) => ({ id: j.id, createdAt: j.created_at, updatedAt: j.updated_at })
/** Optional TS fields: present only when set, so an untouched record compares equal after a round trip. */
const opt = <K extends string>(k: K, v: unknown) => (v == null ? {} : ({ [k]: v } as Record<K, unknown>))

/* ------------------------------------------------------------------ status periods (customers, vehicles) */

interface Periods {
  byEntity: Map<string, { ids: string[]; periods: StatusPeriod<string>[] }>
}
async function loadPeriods(sql: Sql, table: string, fk: string): Promise<Periods> {
  const byEntity = new Map<string, { ids: string[]; periods: StatusPeriod<string>[] }>()
  for (const j of await rows(sql, table, `${fk}, start_date`)) {
    const e = byEntity.get(j[fk] as string) ?? { ids: [], periods: [] }
    e.ids.push(j.id)
    e.periods.push({ status: j.status as string, startDate: j.start_date as string, endDate: (j.end_date as string) ?? null })
    byEntity.set(j[fk] as string, e)
  }
  return { byEntity }
}
/**
 * Period history is append-only in meaning, but a same-day undo replaces or removes the last period
 * (domain/status-history appendPeriod). Rows are matched by position: deletes from the end, then updates in order
 * (closing a period before the next opens, so the no-overlap constraint always holds), then inserts.
 */
async function syncPeriods(sql: Sql, table: string, fk: string, entityId: string, ids: string[], before: StatusPeriod<string>[], after: StatusPeriod<string>[]) {
  for (let i = ids.length - 1; i >= after.length; i--) await sql(`delete from ${table} where id = $1`, [ids[i]])
  for (let i = 0; i < Math.min(before.length, after.length); i++)
    if (JSON.stringify(before[i]) !== JSON.stringify(after[i]))
      await sql(`update ${table} set status = $2, start_date = $3, end_date = $4 where id = $1`, [ids[i], after[i].status, after[i].startDate, after[i].endDate])
  for (let i = before.length; i < after.length; i++)
    await sql(`insert into ${table} (${fk}, status, start_date, end_date) values ($1, $2, $3, $4)`, [entityId, after[i].status, after[i].startDate, after[i].endDate])
}

/* ------------------------------------------------------------------ generic row writes */

async function insertRow(sql: Sql, table: string, cols: Record<string, unknown>) {
  const keys = Object.keys(cols)
  await sql(`insert into ${table} (${keys.join(", ")}) values (${keys.map((k, i) => (isJson(cols[k]) ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ")})`, keys.map((k) => param(cols[k])))
}
/** Update guarded by the version loaded in this transaction: 0 rows = refused by RLS (month lock / permission) or changed. */
async function updateRow(sql: Sql, table: string, id: string, version: string, cols: Record<string, unknown>) {
  const keys = Object.keys(cols)
  const set = keys.map((k, i) => `${k} = ${isJson(cols[k]) ? `$${i + 3}::jsonb` : `$${i + 3}`}`).join(", ")
  const done = await sql(`update ${table} set ${set} where id = $1 and updated_at = $2::timestamptz returning id`, [id, version, ...keys.map((k) => param(cols[k]))])
  if (!done.length) await refused(sql, table, id, version)
}
async function deleteRow(sql: Sql, table: string, id: string, version: string) {
  const done = await sql(`delete from ${table} where id = $1 and updated_at = $2::timestamptz returning id`, [id, version])
  if (!done.length) await refused(sql, table, id, version)
}
async function refused(sql: Sql, table: string, id: string, version: string): Promise<never> {
  const [row] = await sql<{ v: string }>(`select to_jsonb(t) ->> 'updated_at' as v from ${table} t where id = $1`, [id])
  if (row && row.v !== version) throw new ConflictError()
  throw new Error("The database refused this change (your role or the month lock doesn't allow it). Nothing was saved.")
}
const isJson = (v: unknown) => v !== null && typeof v === "object"
const param = (v: unknown) => (isJson(v) ? JSON.stringify(v) : v === undefined ? null : v)

/* ------------------------------------------------------------------ collection specs */

export interface LoadCtx {
  /** Child rows needed to write a collection (status-period row ids), kept from the load. */
  extras: Map<string, unknown>
}
export interface WriteCtx extends LoadCtx {
  identity: RequestIdentity
}

interface Spec<T extends { id: string; updatedAt: string; createdAt: string }> {
  table: string | null
  load(sql: Sql, ctx: LoadCtx): Promise<T[]>
  cols?(t: T): Record<string, unknown>
  /** Child rows on insert / update (pricing, lines, allocations, status periods). */
  afterInsert?(sql: Sql, t: T, ctx: WriteCtx): Promise<void>
  afterUpdate?(sql: Sql, before: T, after: T, ctx: WriteCtx): Promise<void>
  /** Columns that never change after insert (an invoice, a payment's allocations): updates write only these. */
  updatable?: (keyof T)[]
}

const customers: Spec<Customer> = {
  table: "core.customers",
  async load(sql, ctx) {
    const [list, pricing, routes, periods] = [await rows(sql, "core.customers"), await rows(sql, "core.customer_pricing", "customer_id"), await rows(sql, "core.customer_route_rates", "customer_id, line_no"), await loadPeriods(sql, "core.customer_status_periods", "customer_id")]
    ctx.extras.set("customer_periods", periods)
    const price = new Map(pricing.map((p) => [p.customer_id as string, p]))
    return list.map((j) => {
      const p = price.get(j.id)
      return {
        ...base(j), code: str(j.code), shortName: str(j.short_name), logoDataUrl: (j.logo_data_url as string) ?? null, name: str(j.name),
        legalName: str(j.legal_name), companyCode: j.company_code as Customer["companyCode"], businessUnit: ((j.business_unit as string) ?? "STAFF_BUS") as Customer["businessUnit"],
        gstin: str(j.gstin), state: str(j.state), stateCode: str(j.state_code), city: str(j.city), contactName: str(j.contact_name), phone: str(j.phone), email: str(j.email),
        creditDays: num(j.credit_days),
        // A role that can't see pricing (diesel-only readers) gets an empty term sheet; it can't edit customers either.
        pricing: {
          model: ((p?.model as string) ?? "PER_TRIP") as Customer["pricing"]["model"], rate: num(p?.rate), includedKm: num(p?.included_km), extraKmRate: num(p?.extra_km_rate), driverBata: num(p?.driver_bata),
          routes: routes.filter((r) => r.customer_id === j.id).map((r) => ({ route: str(r.route), distanceKm: num(r.distance_km), rate: num(r.rate) })),
        },
        status: j.status as Customer["status"], statusHistory: (periods.byEntity.get(j.id)?.periods ?? []) as Customer["statusHistory"], notes: str(j.notes),
      }
    })
  },
  cols: (c) => ({
    id: c.id, code: c.code, short_name: c.shortName, logo_data_url: c.logoDataUrl ?? null, name: c.name, legal_name: c.legalName ?? "", company_code: c.companyCode,
    business_unit: c.businessUnit ?? null, gstin: c.gstin ?? "", state: c.state ?? "", state_code: c.stateCode ?? "", city: c.city ?? "", contact_name: c.contactName ?? "",
    phone: c.phone ?? "", email: c.email ?? "", credit_days: c.creditDays ?? 0, status: c.status, notes: c.notes ?? "",
  }),
  async afterInsert(sql, c, ctx) {
    await writePricing(sql, c)
    await syncPeriods(sql, "core.customer_status_periods", "customer_id", c.id, [], [], c.statusHistory ?? [])
    void ctx
  },
  async afterUpdate(sql, before, after, ctx) {
    if (JSON.stringify(before.pricing) !== JSON.stringify(after.pricing)) await writePricing(sql, after)
    const p = (ctx.extras.get("customer_periods") as Periods).byEntity.get(after.id)
    await syncPeriods(sql, "core.customer_status_periods", "customer_id", after.id, p?.ids ?? [], before.statusHistory ?? [], after.statusHistory ?? [])
  },
}
async function writePricing(sql: Sql, c: Customer) {
  const p = c.pricing
  await sql(
    `insert into core.customer_pricing (customer_id, model, rate, included_km, extra_km_rate, driver_bata) values ($1, $2, $3, $4, $5, $6)
     on conflict (customer_id) do update set model = excluded.model, rate = excluded.rate, included_km = excluded.included_km, extra_km_rate = excluded.extra_km_rate, driver_bata = excluded.driver_bata`,
    [c.id, p.model, p.rate, p.includedKm, p.extraKmRate, p.driverBata]
  )
  await sql(`delete from core.customer_route_rates where customer_id = $1`, [c.id])
  for (const [i, r] of p.routes.entries())
    await sql(`insert into core.customer_route_rates (customer_id, line_no, route, distance_km, rate) values ($1, $2, $3, $4, $5)`, [c.id, i, r.route, r.distanceKm, r.rate])
}

const vehicles: Spec<Vehicle> = {
  table: "core.vehicles",
  async load(sql, ctx) {
    const periods = await loadPeriods(sql, "core.vehicle_status_periods", "vehicle_id")
    ctx.extras.set("vehicle_periods", periods)
    return (await rows(sql, "core.vehicles")).map((j) => ({
      ...base(j), regNo: str(j.reg_no), companyCode: j.company_code as Vehicle["companyCode"], typeCode: str(j.type_code), make: str(j.make), model: str(j.model),
      year: num(j.year), seats: numOrNull(j.seats), fuelType: j.fuel_type as Vehicle["fuelType"], mileageKmpl: num(j.mileage_kmpl), ownership: j.ownership as Vehicle["ownership"],
      ownerName: (j.owner_name as string) ?? null, status: j.status as Vehicle["status"], statusHistory: (periods.byEntity.get(j.id)?.periods ?? []) as Vehicle["statusHistory"],
      odometerKm: num(j.odometer_km), assignedCustomerId: (j.assigned_customer_id as string) ?? null, defaultDriverId: (j.default_driver_id as string) ?? null,
      insurance: { provider: str(j.insurance_provider), policyNo: str(j.insurance_policy_no), validTill: str(j.insurance_valid_till), premium: num(j.insurance_premium) },
      roadTax: { validTill: str(j.road_tax_valid_till), amount: num(j.road_tax_amount), period: (j.road_tax_period as "QUARTERLY" | "ANNUAL") ?? "ANNUAL" },
      fitnessValidTill: str(j.fitness_valid_till), permitValidTill: str(j.permit_valid_till), emiAmount: num(j.emi_amount), notes: str(j.notes),
      openingOdometerKm: numOrNull(j.opening_odometer_km), openingOdometerDate: (j.opening_odometer_date as string) ?? null,
    }))
  },
  cols: (v) => ({
    id: v.id, reg_no: v.regNo, company_code: v.companyCode, type_code: v.typeCode || null, make: v.make ?? "", model: v.model ?? "", year: v.year || null, seats: v.seats ?? null,
    fuel_type: v.fuelType, mileage_kmpl: v.mileageKmpl ?? 0, ownership: v.ownership, owner_name: v.ownerName ?? null, status: v.status, odometer_km: v.odometerKm ?? 0,
    assigned_customer_id: v.assignedCustomerId ?? null, default_driver_id: v.defaultDriverId ?? null,
    insurance_provider: v.insurance?.provider ?? "", insurance_policy_no: v.insurance?.policyNo ?? "", insurance_valid_till: dateOrNull(v.insurance?.validTill), insurance_premium: v.insurance?.premium ?? 0,
    road_tax_valid_till: dateOrNull(v.roadTax?.validTill), road_tax_amount: v.roadTax?.amount ?? 0, road_tax_period: v.roadTax?.period ?? "ANNUAL",
    fitness_valid_till: dateOrNull(v.fitnessValidTill), permit_valid_till: dateOrNull(v.permitValidTill), emi_amount: v.emiAmount ?? 0, notes: v.notes ?? "",
    opening_odometer_km: v.openingOdometerKm ?? null, opening_odometer_date: dateOrNull(v.openingOdometerDate),
  }),
  async afterInsert(sql, v) {
    await syncPeriods(sql, "core.vehicle_status_periods", "vehicle_id", v.id, [], [], v.statusHistory ?? [])
  },
  async afterUpdate(sql, before, after, ctx) {
    const p = (ctx.extras.get("vehicle_periods") as Periods).byEntity.get(after.id)
    await syncPeriods(sql, "core.vehicle_status_periods", "vehicle_id", after.id, p?.ids ?? [], before.statusHistory ?? [], after.statusHistory ?? [])
  },
}

const drivers: Spec<Driver> = {
  table: "core.drivers",
  load: async (sql) =>
    (await rows(sql, "core.drivers")).map((j) => ({ ...base(j), name: str(j.name), phone: str(j.phone), licenseNo: str(j.license_no), licenseValidTill: str(j.license_valid_till), companyCode: j.company_code as Driver["companyCode"], status: j.status as Driver["status"] })),
  cols: (d) => ({ id: d.id, name: d.name, phone: d.phone ?? "", license_no: d.licenseNo ?? "", license_valid_till: dateOrNull(d.licenseValidTill), company_code: d.companyCode, status: d.status }),
}

const assignments: Spec<VehicleAssignment> = {
  table: "core.vehicle_assignments",
  load: async (sql) =>
    (await rows(sql, "core.vehicle_assignments", "vehicle_id, start_date")).map((j) => ({ ...base(j), vehicleId: j.vehicle_id as string, customerId: (j.customer_id as string) ?? null, startDate: j.start_date as string, endDate: (j.end_date as string) ?? null, status: j.status as VehicleAssignment["status"] })),
  cols: (a) => ({ id: a.id, vehicle_id: a.vehicleId, customer_id: a.customerId, start_date: a.startDate, end_date: a.endDate, status: a.status }),
}

const monthLocks: Spec<MonthLock> = {
  table: "core.month_locks",
  load: async (sql) => (await rows(sql, "core.month_locks")).map((j) => ({ ...base(j), month: str(j.month), state: j.state as MonthLock["state"], changedBy: j.changed_by_role as MonthLock["changedBy"] })),
  cols: (m) => ({ id: m.id, month: m.month, state: m.state, changed_by_role: m.changedBy }),
}

const fuelStations: Spec<FuelStation> = {
  table: "fuel.fuel_stations",
  load: async (sql) =>
    (await rows(sql, "fuel.fuel_stations")).map((j) => ({
      ...base(j), name: str(j.name), location: str(j.location), isInterCompany: !!j.is_inter_company, creditDays: num(j.credit_days), status: j.status as FuelStation["status"],
      ...opt("isTanker", j.is_tanker_source ? true : null), ...opt("openingBalance", numOrNull(j.opening_balance)), ...opt("openingBalanceDate", j.opening_balance_date),
    })),
  // is_tanker_source is never written: only dv_tanker (seeded by migration) has it.
  cols: (s) => ({ id: s.id, name: s.name, location: s.location ?? "", is_inter_company: !!s.isInterCompany, credit_days: s.creditDays ?? 30, status: s.status, opening_balance: s.openingBalance || null, opening_balance_date: s.openingBalance ? s.openingBalanceDate : null }),
}

const tankers: Spec<Tanker> = {
  table: "fuel.tankers",
  load: async (sql) => (await rows(sql, "fuel.tankers")).map((j) => ({ ...base(j), name: str(j.name), regNo: str(j.reg_no), vehicleId: (j.vehicle_id as string) ?? null, capacityLitres: numOrNull(j.capacity_litres), status: j.status as Tanker["status"], notes: str(j.notes) })),
  cols: (t) => ({ id: t.id, name: t.name, reg_no: t.regNo, vehicle_id: t.vehicleId, capacity_litres: t.capacityLitres, status: t.status, notes: t.notes ?? "" }),
}

const diesel: Spec<DieselEntry> = {
  table: "fuel.diesel_entries",
  load: async (sql) =>
    (await rows(sql, "fuel.diesel_entries")).map((j) => ({
      ...base(j), companyCode: j.company_code as DieselEntry["companyCode"], date: j.date as string, vehicleId: j.vehicle_id as string, customerId: (j.customer_id as string) ?? null,
      vendorId: j.station_id as string, litres: num(j.litres), rate: num(j.rate), amount: num(j.amount), odometerKm: numOrNull(j.odometer_km), billNo: str(j.bill_no),
      paymentMode: j.payment_mode as DieselEntry["paymentMode"], notes: str(j.notes), ...opt("tankerId", j.tanker_id),
    })),
  // amount and from_tanker are generated by the database.
  cols: (e) => ({ id: e.id, company_code: e.companyCode, date: e.date, vehicle_id: e.vehicleId, customer_id: e.customerId, station_id: e.vendorId, tanker_id: e.tankerId ?? null, litres: e.litres, rate: e.rate, odometer_km: e.odometerKm, bill_no: e.billNo ?? "", payment_mode: e.paymentMode, notes: e.notes ?? "" }),
}

const tankerLoads: Spec<TankerLoad> = {
  table: "fuel.tanker_loads",
  load: async (sql) =>
    (await rows(sql, "fuel.tanker_loads")).map((j) => ({
      ...base(j), tankerId: j.tanker_id as string, date: j.date as string, stationId: str(j.station_id), ...opt("opening", j.opening ? true : null), invoiceNo: str(j.invoice_no),
      litres: num(j.litres), rate: num(j.rate), amount: num(j.amount), notes: str(j.notes),
    })),
  cols: (l) => ({ id: l.id, tanker_id: l.tankerId, date: l.date, station_id: l.stationId || null, opening: !!l.opening, invoice_no: l.invoiceNo ?? "", litres: l.litres, rate: l.rate, amount: l.amount, notes: l.notes ?? "" }),
}

const tankerTransfers: Spec<TankerTransfer> = {
  table: "fuel.tanker_transfers",
  load: async (sql) => (await rows(sql, "fuel.tanker_transfers")).map((j) => ({ ...base(j), date: j.date as string, fromTankerId: j.from_tanker_id as string, toTankerId: j.to_tanker_id as string, litres: num(j.litres), notes: str(j.notes) })),
  cols: (t) => ({ id: t.id, date: t.date, from_tanker_id: t.fromTankerId, to_tanker_id: t.toTankerId, litres: t.litres, notes: t.notes ?? "" }),
}

const tankerAdjustments: Spec<TankerAdjustment> = {
  table: "fuel.tanker_adjustments",
  load: async (sql) => (await rows(sql, "fuel.tanker_adjustments")).map((j) => ({ ...base(j), date: j.date as string, tankerId: j.tanker_id as string, litres: num(j.litres), reason: str(j.reason) })),
  cols: (a) => ({ id: a.id, date: a.date, tanker_id: a.tankerId, litres: a.litres, reason: a.reason }),
}

const adbluePurchases: Spec<AdBluePurchase> = {
  table: "fuel.adblue_purchases",
  load: async (sql) =>
    (await rows(sql, "fuel.adblue_purchases")).map((j) => ({
      ...base(j), date: j.date as string, vendorName: str(j.vendor_name), product: str(j.product), buckets: num(j.buckets), litresPerBucket: num(j.litres_per_bucket),
      totalLitres: num(j.total_litres), pricePerBucket: num(j.price_per_bucket), totalCost: num(j.total_cost), invoiceNo: str(j.invoice_no), notes: str(j.notes), ...opt("opening", j.opening ? true : null),
    })),
  cols: (p) => ({ id: p.id, date: p.date, vendor_name: p.vendorName ?? "", product: p.product ?? "", buckets: p.buckets, litres_per_bucket: p.litresPerBucket, price_per_bucket: p.pricePerBucket, invoice_no: p.invoiceNo ?? "", notes: p.notes ?? "", opening: !!p.opening }),
}

const adblueEntries: Spec<AdBlueEntry> = {
  table: "fuel.adblue_entries",
  load: async (sql) =>
    (await rows(sql, "fuel.adblue_entries")).map((j) => ({
      ...base(j), source: j.source as AdBlueEntry["source"], ...opt("vendorName", j.vendor_name), ...opt("rate", numOrNull(j.rate)), ...opt("paymentMode", j.payment_mode),
      vehicleId: j.vehicle_id as string, customerId: (j.customer_id as string) ?? null, vendorId: "", date: j.date as string, closingKm: num(j.closing_km), quantityLitres: num(j.quantity_litres),
      amount: num(j.amount), invoiceNo: str(j.invoice_no), notes: str(j.notes),
    })),
  cols: (e) => {
    const direct = e.source === "DIRECT"
    return { id: e.id, source: e.source ?? "STOCK", vehicle_id: e.vehicleId, customer_id: e.customerId, date: e.date, closing_km: e.closingKm, quantity_litres: e.quantityLitres, vendor_name: direct ? e.vendorName : null, rate: direct ? e.rate : null, payment_mode: direct ? e.paymentMode : null, invoice_no: e.invoiceNo ?? "", notes: e.notes ?? "" }
  },
}

const trips: Spec<Trip> = {
  table: "ops.trips",
  load: async (sql) =>
    (await rows(sql, "ops.trips")).map((j) => ({
      ...base(j), tripNo: str(j.trip_no), companyCode: j.company_code as Trip["companyCode"], date: j.date as string, customerId: j.customer_id as string, vehicleId: j.vehicle_id as string,
      driverId: (j.driver_id as string) ?? null, route: str(j.route), startKm: num(j.start_km), endKm: num(j.end_km), distanceKm: num(j.distance_km), pricingModel: j.pricing_model as Trip["pricingModel"],
      baseAmount: num(j.base_amount), extraKmAmount: num(j.extra_km_amount), bataAmount: num(j.bata_amount), tollParking: num(j.toll_parking), revenue: num(j.revenue), status: j.status as Trip["status"],
      invoiceId: (j.invoice_id as string) ?? null, notes: str(j.notes),
    })),
  cols: (t) => ({
    id: t.id, trip_no: t.tripNo, company_code: t.companyCode, date: t.date, customer_id: t.customerId, vehicle_id: t.vehicleId, driver_id: t.driverId, route: t.route ?? "", start_km: t.startKm,
    end_km: t.endKm, distance_km: t.distanceKm, pricing_model: t.pricingModel, base_amount: t.baseAmount, extra_km_amount: t.extraKmAmount, bata_amount: t.bataAmount, toll_parking: t.tollParking,
    revenue: t.revenue, status: t.status, invoice_id: t.invoiceId, notes: t.notes ?? "",
  }),
}

const invoices: Spec<Invoice> = {
  table: "billing.invoices",
  async load(sql) {
    const [list, lines, links] = [await rows(sql, "billing.invoices"), await rows(sql, "billing.invoice_lines", "invoice_id, line_no"), (await sql<{ j: { invoice_id: string; line_no: number; trip_id: string } }>(`select to_jsonb(t) as j from billing.invoice_line_trips t order by invoice_id, line_no, trip_id`)).map((r) => r.j)]
    return list.map((j) => ({
      ...base(j), invoiceNo: str(j.invoice_no), companyCode: j.company_code as Invoice["companyCode"], customerId: j.customer_id as string, date: j.date as string, dueDate: j.due_date as string,
      periodFrom: j.period_from as string, periodTo: j.period_to as string,
      lines: lines.filter((l) => l.invoice_id === j.id).map((l) => ({
        id: str(l.line_id), description: str(l.description), sac: str(l.sac), quantity: num(l.quantity), unit: str(l.unit), rate: num(l.rate), amount: num(l.amount), vehicleId: (l.vehicle_id as string) ?? null,
        tripIds: links.filter((x) => x.invoice_id === j.id && x.line_no === l.line_no).map((x) => x.trip_id),
      })),
      subtotal: num(j.subtotal), taxType: j.tax_type as Invoice["taxType"], taxRate: num(j.tax_rate), cgst: num(j.cgst), sgst: num(j.sgst), igst: num(j.igst), total: num(j.total),
      status: j.status as Invoice["status"], notes: str(j.notes), ...opt("opening", j.opening ? true : null),
    }))
  },
  cols: (i) => ({
    id: i.id, invoice_no: i.invoiceNo, company_code: i.companyCode, customer_id: i.customerId, date: i.date, due_date: i.dueDate, period_from: i.periodFrom, period_to: i.periodTo, subtotal: i.subtotal,
    tax_type: i.taxType, tax_rate: i.taxRate, cgst: i.cgst, sgst: i.sgst, igst: i.igst, total: i.total, status: i.status, opening: !!i.opening, notes: i.notes ?? "",
  }),
  updatable: ["status"], // issue / cancel only (the database refuses any other change)
  async afterInsert(sql, i) {
    for (const [n, l] of i.lines.entries()) {
      await sql(`insert into billing.invoice_lines (invoice_id, line_no, line_id, description, sac, quantity, unit, rate, amount, vehicle_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [i.id, n, l.id, l.description, l.sac, l.quantity, l.unit, l.rate, l.amount, l.vehicleId])
      for (const t of l.tripIds) await sql(`insert into billing.invoice_line_trips (invoice_id, line_no, trip_id) values ($1, $2, $3)`, [i.id, n, t])
    }
  },
}

const payments: Spec<Payment> = {
  table: "finance.payments",
  async load(sql) {
    const [list, allocs] = [await rows(sql, "finance.payments"), (await sql<{ j: { payment_id: string; invoice_id: string; amount: number } }>(`select to_jsonb(t) as j from finance.payment_allocations t order by created_at, invoice_id`)).map((r) => r.j)]
    return list.map((j) => ({
      ...base(j), paymentNo: str(j.payment_no), companyCode: j.company_code as Payment["companyCode"], direction: j.direction as Payment["direction"], date: j.date as string,
      partyType: j.party_type as Payment["partyType"], customerId: (j.customer_id as string) ?? null, vendorId: (j.station_id as string) ?? null, vehicleId: (j.vehicle_id as string) ?? null,
      partyName: str(j.party_name), categoryCode: (j.category_code as string) ?? null, amount: num(j.amount), tdsAmount: num(j.tds_amount), mode: j.mode as Payment["mode"],
      reference: str(j.reference), allocations: allocs.filter((a) => a.payment_id === j.id).map((a) => ({ invoiceId: a.invoice_id, amount: Number(a.amount) })), notes: str(j.notes),
      ...opt("forMonth", j.for_month),
    }))
  },
  cols: (p) => ({
    id: p.id, payment_no: p.paymentNo, company_code: p.companyCode, direction: p.direction, date: p.date, party_type: p.partyType, customer_id: p.customerId ?? null, station_id: p.vendorId ?? null,
    vehicle_id: p.vehicleId ?? null, party_name: p.partyName, category_code: p.categoryCode, amount: p.amount, tds_amount: p.tdsAmount ?? 0, mode: p.mode, reference: p.reference ?? "", notes: p.notes ?? "",
    for_month: p.forMonth ?? null,
  }),
  async afterInsert(sql, p) {
    for (const a of p.allocations) await sql(`insert into finance.payment_allocations (payment_id, invoice_id, amount) values ($1, $2, $3)`, [p.id, a.invoiceId, a.amount])
  },
}

/** External dispenses have no table (D-15: none since 31 Oct 2026, nothing imported): an empty, read-only list. */
const tankerDispenses: Spec<{ id: string; updatedAt: string; createdAt: string }> = { table: null, load: async () => [] }

/** Every collection the API reads, with how it is stored. FK order: parents first (deletes run in reverse). */
export const SPECS: Record<CollectionKey, Spec<never>> = {
  customers, drivers, vehicles, vehicle_assignments: assignments, month_locks: monthLocks, fuel_stations: fuelStations, tankers,
  diesel_entries: diesel, tanker_loads: tankerLoads, tanker_transfers: tankerTransfers, tanker_adjustments: tankerAdjustments,
  adblue_purchases: adbluePurchases, adblue_entries: adblueEntries, tanker_dispenses: tankerDispenses, invoices, trips, payments,
} as unknown as Record<CollectionKey, Spec<never>>
export const WRITE_ORDER: CollectionKey[] = ["customers", "drivers", "vehicles", "vehicle_assignments", "month_locks", "fuel_stations", "tankers", "diesel_entries", "tanker_loads", "tanker_transfers", "tanker_adjustments", "adblue_purchases", "adblue_entries", "invoices", "trips", "payments", "tanker_dispenses"]

/** Applies one collection's changes: deletes (by the caller, in reverse FK order) are separate from upserts. */
export async function applyUpserts(sql: Sql, key: CollectionKey, before: { id: string; updatedAt: string }[], after: { id: string; updatedAt: string }[], ctx: WriteCtx) {
  const spec = SPECS[key] as unknown as Spec<{ id: string; updatedAt: string; createdAt: string }>
  const old = new Map(before.map((r) => [r.id, r]))
  const changed = after.filter((r) => !old.has(r.id) || JSON.stringify(old.get(r.id)) !== JSON.stringify(r))
  if (!changed.length) return
  if (!spec.table || !spec.cols) throw new Error("External tanker dispenses aren't recorded in the shared database (none since 31 Oct 2026).")
  // Updates first, then inserts: an assignment / status period closes before the next one opens.
  for (const r of changed.filter((x) => old.has(x.id))) {
    const prev = old.get(r.id)! as { id: string; updatedAt: string; createdAt: string }
    const all = spec.cols(r as never)
    const cols = Object.fromEntries(Object.entries(all).filter(([k]) => k !== "id" && (!spec.updatable || spec.updatable.some((u) => camel(k) === u))))
    const prevCols = spec.cols(prev as never)
    const diff: Record<string, unknown> = Object.fromEntries(Object.entries(cols).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(prevCols[k])))
    if (key === "month_locks" && Object.keys(diff).length) diff.changed_by = ctx.identity.profileId // who changed it, from the verified session
    // The "last known km" cache alone: the database raises it itself when a fill is saved (bump_vehicle_odometer, for
    // anyone allowed to add the fill — an Employee can't edit vehicles), so the app's own copy of that bump is skipped.
    if (key === "vehicles" && Object.keys(diff).length === 1 && "odometer_km" in diff) delete diff.odometer_km
    if (Object.keys(diff).length) await updateRow(sql, spec.table, r.id, prev.updatedAt, diff)
    await spec.afterUpdate?.(sql, prev as never, r as never, ctx)
  }
  for (const r of changed.filter((x) => !old.has(x.id))) {
    await insertRow(sql, spec.table, { ...spec.cols(r as never), ...(key === "month_locks" ? { changed_by: ctx.identity.profileId } : {}), created_at: (r as unknown as { createdAt: string }).createdAt })
    await spec.afterInsert?.(sql, r as never, ctx)
  }
}
export async function applyDeletes(sql: Sql, key: CollectionKey, before: { id: string; updatedAt: string }[], after: { id: string }[]) {
  const spec = SPECS[key]
  const keep = new Set(after.map((r) => r.id))
  for (const r of before.filter((x) => !keep.has(x.id))) {
    if (!spec.table) continue
    if (key === "customers" || key === "vehicles" || key === "drivers" || key === "fuel_stations" || key === "tankers" || key === "invoices")
      throw new Error("Master records and invoices are never deleted — archive or cancel them.")
    await deleteRow(sql, spec.table, r.id, r.updatedAt)
  }
}
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/* ------------------------------------------------------------------ settings */

export async function loadSettings(sql: Sql): Promise<Settings> {
  const [companies, types, categories, [app]] = [await rows(sql, "core.companies", "is_primary desc, code"), await rows(sql, "core.vehicle_types", "created_at, code"), await rows(sql, "finance.payment_categories", "created_at, code"), await rows(sql, "core.app_settings", "id")]
  return {
    companies: companies.map((c): CompanyProfile => ({
      code: c.code as CompanyProfile["code"], name: str(c.name), legalName: str(c.legal_name), gstin: str(c.gstin), pan: str(c.pan), address: str(c.address), city: str(c.city), state: str(c.state),
      stateCode: str(c.state_code), phone: str(c.phone), email: str(c.email), bankName: str(c.bank_name), bankAccount: str(c.bank_account), ifsc: str(c.ifsc), invoicePrefix: str(c.invoice_prefix),
      isPrimary: !!c.is_primary, parentCode: (c.parent_code as CompanyProfile["parentCode"]) ?? null,
    })),
    vehicleTypes: types.map((t): VehicleType => ({ code: str(t.code), name: str(t.name), category: t.category as VehicleType["category"], defaultSeats: numOrNull(t.default_seats), defaultMileage: num(t.default_mileage) })),
    expenseCategories: categories.map((c): ExpenseCategory => ({ code: str(c.code), name: str(c.name), kind: c.kind as ExpenseCategory["kind"], vehicleLinked: !!c.vehicle_linked, active: !!c.active })),
    defaultTaxRate: num(app?.default_tax_rate), tdsRate: num(app?.tds_rate), sacCode: str(app?.sac_code),
  }
}

/** Settings lists are never shortened (master lists are deactivated, never deleted); each row is upserted by code. */
export async function writeSettings(sql: Sql, before: Settings, after: Settings) {
  const list = async <T extends { code: string }>(table: string, a: T[], b: T[], cols: (x: T) => Record<string, unknown>) => {
    const old = new Map(a.map((x) => [x.code, x]))
    if (a.some((x) => !b.some((y) => y.code === x.code))) throw new Error("Settings lists can't lose an entry — deactivate it instead.")
    for (const x of b) {
      const prev = old.get(x.code)
      if (prev && JSON.stringify(prev) === JSON.stringify(x)) continue
      const c = cols(x)
      const keys = Object.keys(c)
      await sql(
        `insert into ${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) on conflict (code) do update set ${keys.filter((k) => k !== "code").map((k) => `${k} = excluded.${k}`).join(", ")}`,
        keys.map((k) => param(c[k]))
      )
    }
  }
  await list("core.companies", before.companies, after.companies, (c) => ({ code: c.code, name: c.name, legal_name: c.legalName, gstin: c.gstin, pan: c.pan, address: c.address, city: c.city, state: c.state, state_code: c.stateCode, phone: c.phone, email: c.email, bank_name: c.bankName, bank_account: c.bankAccount, ifsc: c.ifsc, invoice_prefix: c.invoicePrefix, is_primary: c.isPrimary, parent_code: c.parentCode }))
  await list("core.vehicle_types", before.vehicleTypes, after.vehicleTypes, (t) => ({ code: t.code, name: t.name, category: t.category, default_seats: t.defaultSeats, default_mileage: t.defaultMileage }))
  await list("finance.payment_categories", before.expenseCategories, after.expenseCategories, (c) => ({ code: c.code, name: c.name, kind: c.kind, vehicle_linked: c.vehicleLinked, active: c.active }))
  if (before.defaultTaxRate !== after.defaultTaxRate || before.tdsRate !== after.tdsRate || before.sacCode !== after.sacCode)
    await sql(`update core.app_settings set default_tax_rate = $1, tds_rate = $2, sac_code = $3 where id = 1`, [after.defaultTaxRate, after.tdsRate, after.sacCode])
}

/* ------------------------------------------------------------------ audit trail */

export async function loadAudit(sql: Sql): Promise<{ events: AuditEvent[]; reviews: AuditReview[] }> {
  const ev = (await sql<{ j: Record<string, unknown> }>(`select to_jsonb(t) as j from audit.events t order by at, id`)).map((r) => r.j)
  const rv = (await sql<{ j: Record<string, unknown> }>(`select to_jsonb(t) as j from audit.reviews t order by at, event_id`)).map((r) => r.j)
  return {
    events: ev.map((j) => ({
      id: j.id as string, at: j.at as string, actor: { kind: j.actor_kind as "SESSION" | "SYSTEM", userId: (j.actor_user_id as string) ?? null, name: (j.actor_name as string) ?? null, role: (j.actor_role as AuditEvent["actor"]["role"]) ?? null },
      action: j.action as AuditEvent["action"], module: str(j.module), recordType: str(j.record_type), recordId: str(j.record_id), label: str(j.label), recordDate: (j.record_date as string) ?? null,
      before: (j.before as AuditEvent["before"]) ?? null, after: (j.after as AuditEvent["after"]) ?? null, changes: (j.changes as AuditEvent["changes"]) ?? [], reason: (j.reason as string) ?? null,
      restoresEventId: (j.restores_event_id as string) ?? null, note: (j.note as string) ?? null,
    })),
    reviews: rv.map((j) => ({ eventId: j.event_id as string, at: j.at as string, actor: { kind: "SESSION" as const, userId: (j.actor_user_id as string) ?? null, name: null, role: j.actor_role as AuditReview["actor"]["role"] } })),
  }
}

/**
 * New audit events of this request. The actor is always the verified account of the request (RLS refuses any other),
 * never a value from the browser. `at` is the database clock.
 */
export async function insertEvents(sql: Sql, events: AuditEvent[], identity: RequestIdentity) {
  for (const e of events)
    await insertRow(sql, "audit.events", {
      id: e.id, actor_kind: "SESSION", actor_user_id: identity.profileId, actor_name: identity.name ?? identity.email, actor_role: identity.role, action: e.action, module: e.module,
      record_type: e.recordType, record_id: e.recordId, label: e.label ?? "", record_date: e.recordDate || null, before: e.before ?? null, after: e.after ?? null, changes: e.changes ?? [],
      reason: e.reason ?? null, restores_event_id: e.restoresEventId ?? null, note: e.note ?? null,
    })
}
export async function insertReviews(sql: Sql, reviews: AuditReview[], identity: RequestIdentity) {
  for (const r of reviews) await sql(`insert into audit.reviews (event_id, actor_user_id, actor_role) values ($1, $2, $3)`, [r.eventId, identity.profileId, identity.role])
}
