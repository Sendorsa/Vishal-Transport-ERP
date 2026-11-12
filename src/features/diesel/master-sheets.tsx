"use client"

import { useMemo, useState } from "react"
import { Droplet, Droplets, Flame, Fuel, Gauge, IndianRupee, Route, Sigma } from "lucide-react"
import { DataTable, type Column } from "@/components/shared/data-table"
import { NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { SimpleSelect } from "@/components/shared/simple-select"
import { StatsCard } from "@/components/shared/stats-card"
import { inPeriod } from "@/domain/consumables"
import { fyMonths, fyName, fyStartYear, inFY } from "@/domain/financial-year"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { monthLabel, shortMonthLabel, type DieselStats } from "@/domain/diesel"
import { buildMaster, last12Months, litresByFuelType, type CustomerRow, type Fluid, type MasterInput, type VehicleRow, type VendorRow } from "@/domain/fuel-master"
import { useAdBlueEntries, useAdBluePurchases } from "@/lib/api/hooks"
import { vendorAnalytics } from "@/domain/adblue-inventory"
import { QUARTER_MONTHS, QUARTERS, inQuarter, quarterLabel, quarterMonths, quarterOf, type Quarter } from "@/domain/quarters"
import { QuarterComparison } from "@/components/shared/quarter-comparison"
import { useCan } from "@/lib/app-state"
import { FuelBadge } from "@/components/shared/fuel-badge"
import { formatINR, formatNumber, monthKey, todayISO } from "@/lib/format"
import { MonthSelect, kpiExplain, useDieselIndex, useDieselMonth, useDieselMonthOptions } from "./parts"
import { IndustrialReport } from "./industrial-report"
import { FuelTypeTable } from "./fuel-type-summary"
import { fuelWise, type FuelTotals } from "@/domain/expenditure"
import type { DieselEntry } from "@/lib/types"

/** The period's fills by fuel type (each fuel from its own fills), for "By fuel type" and the cards' wording. */
const fuelsIn = (input: MasterInput, inScope: (e: DieselEntry) => boolean) => fuelWise(input.idx, input.diesel.filter(inScope))
/** "Diesel" while every fill in the period is Diesel; otherwise "Vehicle Fuel" — never call petrol or EV charging Diesel. */
const wordOf = (fuels: FuelTotals[]) => (fuels.some((f) => f.fuelType !== "DIESEL") ? "Vehicle Fuel" : "Diesel")

type Master = ReturnType<typeof buildMaster>
type ExtraMeta = Master["extras"]

/* ------------------------------------------------------------------ shared cells */

const inr = (n: number) => (n ? formatINR(n) : "—")
const qty = (n: number) => (n ? formatNumber(n, 2) : "—")
const cpk = (s: { costPerKm: number | null }) => (s.costPerKm ? formatINR(s.costPerKm) : "—")
const kmpl = (s: DieselStats) => s.kmpl ?? "—"

function useMasterInput(): { input: MasterInput | null; isLoading: boolean; can: ReturnType<typeof useCan> } {
  const can = useCan()
  const { ds, idx, isLoading } = useDieselIndex()
  const adblue = useAdBlueEntries()
  const input = useMemo(
    () =>
      ds && idx && adblue.data
        ? {
            idx,
            diesel: ds.diesel,
            adblue: adblue.data,
            customers: new Map(ds.customers.map((c) => [c.id, c])),
            vendors: new Map(ds.fuelStations.map((v) => [v.id, v])),
          }
        : null,
    [ds, idx, adblue.data]
  )
  return { input, isLoading: isLoading || adblue.isLoading, can }
}

/** "{Consumable} (L)" and "{Consumable} Spend" columns for every non-diesel consumable. */
function extraColumns<T extends { extras: Record<string, { qty: number; spend: number }> }>(extras: ExtraMeta): Column<T>[] {
  return extras.flatMap((x) => [
    { id: `${x.key}-qty`, header: `${x.label} (${x.unit})`, align: "right" as const, sortValue: (r: T) => r.extras[x.key]?.qty ?? 0, cell: (r: T) => qty(r.extras[x.key]?.qty ?? 0), footer: qty(x.total.qty) },
    { id: `${x.key}-spend`, header: `${x.label} Spend`, align: "right" as const, sortValue: (r: T) => r.extras[x.key]?.spend ?? 0, cell: (r: T) => inr(r.extras[x.key]?.spend ?? 0), footer: inr(x.total.spend) },
  ])
}

/** Combined "Running Fluid Cost" column — Diesel Spend + AdBlue Spend of the row. */
function fluidColumn<T extends { fluid: Fluid }>(m: Master): Column<T> {
  return { id: "fluid", header: "Running Fluid Cost", align: "right", sortValue: (r) => r.fluid.spend, cell: (r) => <span className="font-medium">{inr(r.fluid.spend)}</span>, footer: inr(m.fluid.spend) }
}

/** Period columns for the trend / month-breakdown tables: spends, then litres, each with its Running Fluid total. */
function periodColumns<T extends { m: Master }>(totals: { m: Master } | null, rows: T[]): Column<T>[] {
  const extra = (r: { m: Master }, key: string) => r.m.extras.find((e) => e.key === key)?.total
  const sum = (f: (r: T) => number) => rows.reduce((t, r) => t + f(r), 0)
  const foot = (f: (r: { m: Master }) => number, fmt: (n: number) => string) => fmt(totals ? f(totals) : sum(f))
  const extras = rows[0]?.m.extras ?? []
  const col = (id: string, header: string, f: (r: { m: Master }) => number, fmt: (n: number) => string, strong = false): Column<T> => ({
    id,
    header,
    align: "right",
    cell: (r) => (strong ? <span className="font-medium">{fmt(f(r))}</span> : fmt(f(r))),
    footer: foot(f, fmt),
  })
  return [
    col("spend", "Diesel Spend", (r) => r.m.totals.spend, inr),
    ...extras.map((x) => col(`${x.key}-spend`, `${x.label} Spend`, (r) => extra(r, x.key)?.spend ?? 0, inr)),
    col("fluid-spend", "Running Fluid Cost", (r) => r.m.fluid.spend, inr, true),
    col("litres", "Diesel (L)", (r) => r.m.totals.litres, qty),
    ...extras.map((x) => col(`${x.key}-qty`, `${x.label} (${x.unit})`, (r) => extra(r, x.key)?.qty ?? 0, qty)),
    col("fluid-qty", "Running Fluid (L)", (r) => r.m.fluid.qty, qty, true),
  ]
}

function customerColumns(m: Master, monthly: boolean): Column<CustomerRow>[] {
  const t = m.totals
  return [
    { id: "name", header: "Customer", sortValue: (r) => r.name, cell: (r) => <span className="font-medium">{r.name}</span>, footer: "Total" },
    { id: "veh", header: "Vehicles", align: "right", sortValue: (r) => r.vehicles, cell: (r) => r.vehicles, footer: String(m.vehicleCount) },
    { id: "litres", header: "Diesel (L)", align: "right", sortValue: (r) => r.litres, cell: (r) => qty(r.litres), footer: qty(t.litres) },
    { id: "spend", header: "Diesel Spend", align: "right", sortValue: (r) => r.spend, cell: (r) => inr(r.spend), footer: inr(t.spend) },
    { id: "km", header: "KM Run", align: "right", sortValue: (r) => r.km, cell: (r) => formatNumber(r.km), footer: formatNumber(t.km) },
    { id: "kmpl", header: "Diesel KM/L", align: "right", sortValue: (r) => r.kmpl, cell: kmpl, footer: kmpl(t) },
    ...(monthly
      ? ([
          { id: "cpk", header: "Diesel ₹/KM", align: "right", sortValue: (r) => r.costPerKm, cell: cpk, footer: cpk(t) },
          { id: "share", header: "% of Diesel Spend", align: "right", sortValue: (r) => r.share, cell: (r) => `${r.share.toFixed(1)}%`, footer: "100%" },
        ] satisfies Column<CustomerRow>[])
      : []),
    ...extraColumns<CustomerRow>(m.extras),
    fluidColumn<CustomerRow>(m),
  ]
}

function vehicleColumns(m: Master, monthly: boolean): Column<VehicleRow>[] {
  const t = m.totals
  return [
    { id: "veh", header: "Vehicle", sortValue: (r) => r.vehicle.regNo, cell: (r) => <span className="font-medium">{r.vehicle.regNo}</span>, footer: "Total" },
    { id: "cust", header: "Customer", sortValue: (r) => r.customers, cell: (r) => <span className="text-muted-foreground">{r.customers}</span> },
    ...(monthly ? ([{ id: "fuel", header: "Fuel Type", sortValue: (r) => r.vehicle.fuelType, cell: (r) => <FuelBadge fuel={r.vehicle.fuelType} /> }] satisfies Column<VehicleRow>[]) : []),
    { id: "litres", header: "Diesel (L)", align: "right", sortValue: (r) => r.litres, cell: (r) => qty(r.litres), footer: qty(t.litres) },
    { id: "spend", header: "Diesel Spend", align: "right", sortValue: (r) => r.spend, cell: (r) => inr(r.spend), footer: inr(t.spend) },
    { id: "km", header: "KM Run", align: "right", sortValue: (r) => r.km, cell: (r) => formatNumber(r.km), footer: formatNumber(t.km) },
    { id: "kmpl", header: "Diesel KM/L", align: "right", sortValue: (r) => r.kmpl, cell: kmpl, footer: kmpl(t) },
    ...(monthly
      ? ([
          { id: "cpk", header: "Diesel ₹/KM", align: "right", sortValue: (r) => r.costPerKm, cell: cpk, footer: cpk(t) },
          { id: "fills", header: "Diesel Entries", align: "right", sortValue: (r) => r.fills, cell: (r) => r.fills || "—", footer: String(t.fills) },
        ] satisfies Column<VehicleRow>[])
      : []),
    ...extraColumns<VehicleRow>(m.extras),
    fluidColumn<VehicleRow>(m),
  ]
}

function CardGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-5">{children}</div>
    </div>
  )
}

function SummaryCards({ m, period, yearly, fuels }: { m: Master; period: string; yearly?: boolean; fuels: FuelTotals[] }) {
  const t = m.totals
  const word = wordOf(fuels)
  // More than one fuel: litres and KM/L of different fuels are never combined — see "By fuel type".
  const mixed = word !== "Diesel"
  const why = kpiExplain(t)
  const extraSpend = m.extras.map((x) => `${x.label} ${formatINR(x.total.spend)}`).join(" + ")
  const extraQty = m.extras.map((x) => `${x.label} ${formatNumber(x.total.qty, 2)} ${x.unit}`).join(" + ")
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Running Fluid Summary · {word} + {m.extras.map((x) => x.label).join(" + ")}</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatsCard label={`${yearly ? "Yearly " : ""}${word} Spend`} icon={IndianRupee} value={formatINR(t.spend)} hint={period} info={why.spend} />
          {m.extras.map((x) => (
            <StatsCard key={x.key} label={`${yearly ? "Yearly " : ""}${x.label} Spend`} icon={IndianRupee} value={formatINR(x.total.spend)} hint={period} info={`Σ amount of ${x.label} entries in the period.`} />
          ))}
          <StatsCard label={`${yearly ? "Yearly" : "Total"} Running Fluid Cost`} icon={Sigma} value={formatINR(m.fluid.spend)} hint={`${period} · ${word} + ${m.extras.map((x) => x.label).join(" + ")}`} info={`${word} ${formatINR(t.spend)} + ${extraSpend} = ${formatINR(m.fluid.spend)}.`} />
          <StatsCard label={`${yearly ? "Yearly " : ""}${word} Litres`} icon={Droplet} value={`${formatNumber(t.litres)} L`} hint={`${period} · ${t.fills} fills`} info={why.litres} />
          {m.extras.map((x) => (
            <StatsCard key={x.key} label={`${yearly ? "Yearly " : ""}${x.label} Litres`} icon={Droplets} value={`${formatNumber(x.total.qty, 2)} ${x.unit}`} hint={`${period} · ${x.total.entries} entries`} info={`Σ ${x.label} quantity of entries in the period.`} />
          ))}
          <StatsCard label={`${yearly ? "Yearly" : "Total"} Running Fluid Volume`} icon={Sigma} value={`${formatNumber(m.fluid.qty)} L`} hint={`${period} · ${word} + ${m.extras.map((x) => x.label).join(" + ")}`} info={`${word} ${formatNumber(t.litres)} L + ${extraQty} = ${formatNumber(m.fluid.qty, 2)} L.`} />
        </div>
      </div>

      <CardGroup title={mixed ? "Vehicle fuel — per fuel type in By fuel type" : "Diesel"}>
        {!yearly && !mixed && (
          <StatsCard
            label="Average Diesel Cost per Litre"
            icon={Fuel}
            value={t.avgRate ? formatINR(t.avgRate) : "—"}
            hint={period}
            info={t.avgRate ? `Diesel/Petrol spend ÷ ${formatNumber(t.litres)} litres = ${formatINR(t.avgRate)} per litre.` : "Needs litres > 0."}
          />
        )}
        <StatsCard label="Total KM Run" icon={Route} value={formatNumber(t.km)} hint={`${period} · fill odometer readings`} info={why.km} />
        {!mixed && <StatsCard label="Average Diesel KM/L" icon={Gauge} value={t.kmpl ?? "—"} hint={period} info={why.kmpl} />}
        {yearly && !mixed && <StatsCard label="Average Diesel Cost per KM" icon={Flame} value={cpk(t)} hint={period} info={why.costPerKm} />}
      </CardGroup>

      {m.extras.map((x) => (
        <CardGroup key={x.key} title={x.label}>
          <StatsCard
            label={`Average ${x.label} KM/L`}
            icon={Gauge}
            value={x.total.perUnit ?? "—"}
            hint={period}
            info={x.total.perUnit ? `${formatNumber(x.total.km)} km (${x.label} entries' current − previous odometer) ÷ ${formatNumber(x.total.qty, 2)} ${x.unit} = ${x.total.perUnit}.` : `Needs ${x.label} entries in the period.`}
          />
          <StatsCard label={`Average ${x.label} Cost per KM`} icon={Route} value={cpk(x.total)} hint={period} info={x.total.costPerKm ? `${formatINR(x.total.spend)} ÷ ${formatNumber(x.total.km)} km = ${cpk(x.total)} per km.` : "Needs km > 0."} />
        </CardGroup>
      ))}
    </div>
  )
}

function VendorTables({ m, adblue }: { m: Master; adblue: ReturnType<typeof vendorAnalytics> }) {
  const ab = { litres: adblue.reduce((t, r) => t + r.litres, 0), amount: adblue.reduce((t, r) => t + r.amount, 0), purchases: adblue.reduce((t, r) => t + r.purchases, 0) }
  return (
    <div className="grid gap-4 xl:grid-cols-2 [&>*]:min-w-0">
      {m.byVendor.map((v) => (
        <div key={v.key}>
          <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground uppercase">{v.label} purchases</h3>
          <DataTable<VendorRow>
            data={v.rows}
            getRowId={(r) => r.id}
            initialSort={{ id: "amount", desc: true }}
            showFooter
            dense
            emptyMessage={`No ${v.label} entries.`}
            columns={[
              { id: "name", header: "Pump / vendor", sortValue: (r) => r.name, cell: (r) => <span className="font-medium">{r.name}</span>, footer: "Total" },
              { id: "n", header: "Entries", align: "right", sortValue: (r) => r.entries, cell: (r) => r.entries, footer: String(v.total.entries) },
              { id: "qty", header: v.unit === "L" ? "Litres" : v.unit, align: "right", sortValue: (r) => r.qty, cell: (r) => qty(r.qty), footer: qty(v.total.qty) },
              { id: "amount", header: "Amount", align: "right", sortValue: (r) => r.spend, cell: (r) => inr(r.spend), footer: inr(v.total.spend) },
              { id: "rate", header: `Avg Rate / ${v.unit === "L" ? "Litre" : v.unit}`, align: "right", sortValue: (r) => r.avgRate, cell: (r) => (r.avgRate ? formatINR(r.avgRate) : "—"), footer: v.total.avgRate ? formatINR(v.total.avgRate) : "" },
            ]}
          />
        </div>
      ))}
      <div>
        <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground uppercase">AdBlue purchases (inventory)</h3>
        <DataTable
          data={adblue}
          getRowId={(r) => r.vendor}
          initialSort={{ id: "amount", desc: true }}
          showFooter
          dense
          emptyMessage="No AdBlue bought into inventory this month."
          columns={[
            { id: "name", header: "Vendor", sortValue: (r) => r.vendor, cell: (r) => <span className="font-medium">{r.vendor}</span>, footer: "Total" },
            { id: "n", header: "Purchases", align: "right", sortValue: (r) => r.purchases, cell: (r) => r.purchases, footer: String(ab.purchases) },
            { id: "qty", header: "Litres", align: "right", sortValue: (r) => r.litres, cell: (r) => qty(r.litres), footer: qty(ab.litres) },
            { id: "amount", header: "Amount", align: "right", sortValue: (r) => r.amount, cell: (r) => inr(r.amount), footer: inr(ab.amount) },
            { id: "rate", header: "Avg Rate / Litre", align: "right", sortValue: (r) => r.avgRate, cell: (r) => (r.avgRate ? formatINR(r.avgRate) : "—"), footer: ab.litres ? formatINR(ab.amount / ab.litres) : "" },
          ]}
        />
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

/* ------------------------------------------------------------------ Monthly Master */

export function MonthlyMaster() {
  const { input, isLoading, can } = useMasterInput()
  const purchases = useAdBluePurchases()
  const { idx } = useDieselIndex()
  const months = useDieselMonthOptions(idx)
  const [month, setMonth] = useDieselMonth(months)

  const d = useMemo(() => {
    if (!input || !month) return null
    const m = buildMaster(input, inPeriod(month))
    const trend = last12Months(month).map((mk) => ({ month: mk, label: shortMonthLabel(mk), m: buildMaster(input, inPeriod(mk)) }))
    return { m, trend, fuels: fuelsIn(input, inPeriod(month)) }
  }, [input, month])

  if (!can("diesel")) return <NoAccess what="diesel" />
  if (isLoading || !d) return <PageSkeleton />
  const period = monthLabel(month) + (month === monthKey(todayISO()) ? " (to date)" : "")
  const trendRows = [...d.trend].reverse()
  type TrendRow = (typeof trendRows)[number]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Diesel Monthly Master"
        backHref="/diesel"
        backLabel="Diesel"
        description="Fuel & consumables for the month — Diesel and AdBlue shown separately, with their combined Running Fluid total."
        actions={<MonthSelect months={months} value={month} onChange={setMonth} prominent />}
      />
      <SummaryCards m={d.m} period={period} fuels={d.fuels} />

      <Section title="By fuel type">
        <FuelTypeTable fuels={d.fuels} />
      </Section>

      <Section title="Customer summary">
        <DataTable data={d.m.byCustomer} getRowId={(r) => r.id} columns={customerColumns(d.m, true)} initialSort={{ id: "spend", desc: true }} showFooter pageSize={100} emptyMessage="No entries this month." />
      </Section>

      <Section title="Vehicle summary">
        <DataTable data={d.m.byVehicle} getRowId={(r) => r.vehicle.id} columns={vehicleColumns(d.m, true)} initialSort={{ id: "veh", desc: false }} showFooter pageSize={100} dense emptyMessage="No entries this month." />
      </Section>

      <Section title="Petrol pump / vendor summary">
        <VendorTables m={d.m} adblue={vendorAnalytics((purchases.data ?? []).filter((p) => p.date.startsWith(month)))} />
      </Section>

      <Section title={`Monthly trend · 12 months to ${monthLabel(month)}`}>
        <DataTable<TrendRow>
          data={trendRows}
          getRowId={(r) => r.month}
          pageSize={12}
          dense
          showFooter
          columns={[
            { id: "m", header: "Month", cell: (r) => <span className={r.month === month ? "font-semibold" : ""}>{monthLabel(r.month)}</span>, footer: "12-month total" },
            ...periodColumns(null, trendRows),
            { id: "km", header: "KM Run", align: "right", cell: (r) => (r.m.totals.km ? formatNumber(r.m.totals.km) : "—"), footer: formatNumber(trendRows.reduce((t, r) => t + r.m.totals.km, 0)) },
          ]}
        />
      </Section>
      <IndustrialReport match={(e) => e.date.startsWith(month)} period={period} />
    </div>
  )
}

/* ------------------------------------------------------------------ Yearly Master */

export function YearlyMaster() {
  const { input, isLoading, can } = useMasterInput()
  const { idx } = useDieselIndex()
  const months = useDieselMonthOptions(idx)
  const [globalMonth] = useDieselMonth(months)
  // Calendar year (Jan–Dec) or financial year (Apr–Mar, src/domain/financial-year.ts) — the same entries and formulas.
  const [basis, setBasis] = useState<"calendar" | "fy">("calendar")
  const [picked, setPicked] = useState<string | null>(null)
  const dates = useMemo(() => [todayISO(), ...(input?.diesel ?? []).map((e) => e.date), ...(input?.adblue ?? []).map((e) => e.date)], [input])
  const years = useMemo(
    () => [...new Set(dates.map((d) => (basis === "fy" ? String(fyStartYear(d)) : d.slice(0, 4))))].sort().reverse(),
    [dates, basis]
  )
  const anchor = globalMonth ?? todayISO()
  const fallback = basis === "fy" ? String(fyStartYear(anchor)) : anchor.slice(0, 4)
  const year = picked && years.includes(picked) ? picked : years.includes(fallback) ? fallback : years[0]

  const d = useMemo(() => {
    if (!input || !year) return null
    const monthsOf = basis === "fy" ? fyMonths(Number(year)) : Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
    const scope = basis === "fy" ? inFY(Number(year)) : inPeriod(year)
    const m = buildMaster(input, scope)
    const byMonth = monthsOf.map((mk) => ({ month: mk, m: buildMaster(input, inPeriod(mk)) }))
    return { m, byMonth, fuels: fuelsIn(input, scope) }
  }, [input, year, basis])

  if (!can("diesel")) return <NoAccess what="diesel" />
  if (isLoading || !d) return <PageSkeleton />
  const t = d.m.totals
  const yearName = basis === "fy" ? fyName(Number(year)) : year
  const running = basis === "fy" ? fyStartYear(todayISO()) === Number(year) : year === todayISO().slice(0, 4)
  const period = running ? `${yearName} (to date)` : yearName
  type MonthRow = (typeof d.byMonth)[number]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Diesel Yearly Master"
        backHref="/diesel"
        backLabel="Diesel"
        description={`${basis === "fy" ? "Financial-year (1 April – 31 March)" : "Calendar-year (January – December)"} fuel & consumables — Diesel and AdBlue shown separately, with their combined Running Fluid total.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={basis} onValueChange={(v) => setBasis(v as "calendar" | "fy")}>
              <TabsList>
                <TabsTrigger value="calendar">Calendar Year</TabsTrigger>
                <TabsTrigger value="fy">Financial Year</TabsTrigger>
              </TabsList>
            </Tabs>
            <SimpleSelect value={year} onChange={setPicked} options={years.map((y) => ({ value: y, label: basis === "fy" ? fyName(Number(y)) : y }))} className="h-10 min-w-32 text-base font-semibold" />
          </div>
        }
      />
      <SummaryCards m={d.m} period={period} yearly fuels={d.fuels} />

      <Section title="By fuel type">
        <FuelTypeTable fuels={d.fuels} />
      </Section>

      <Section title="Month breakdown">
        <DataTable<MonthRow>
          data={d.byMonth}
          getRowId={(r) => r.month}
          pageSize={12}
          showFooter
          columns={[
            { id: "m", header: "Month", cell: (r) => <span className={r.m.totals.fills || r.m.extras.some((x) => x.total.entries) ? "font-medium" : "text-muted-foreground"}>{shortMonthLabel(r.month)}</span>, footer: `${yearName} total` },
            ...periodColumns(d, d.byMonth),
            { id: "km", header: "KM Run", align: "right", cell: (r) => (r.m.totals.km ? formatNumber(r.m.totals.km) : "—"), footer: formatNumber(t.km) },
            { id: "kmpl", header: "Diesel KM/L", align: "right", cell: (r) => kmpl(r.m.totals), footer: kmpl(t) },
            { id: "cpk", header: "Diesel ₹/KM", align: "right", cell: (r) => cpk(r.m.totals), footer: cpk(t) },
          ]}
        />
      </Section>

      <Section title="Customer yearly summary">
        <DataTable data={d.m.byCustomer} getRowId={(r) => r.id} columns={customerColumns(d.m, false)} initialSort={{ id: "spend", desc: true }} showFooter pageSize={100} emptyMessage={`No entries in ${yearName}.`} />
      </Section>

      <Section title="Vehicle yearly summary">
        <DataTable data={d.m.byVehicle} getRowId={(r) => r.vehicle.id} columns={vehicleColumns(d.m, false)} initialSort={{ id: "veh", desc: false }} showFooter pageSize={100} dense emptyMessage={`No entries in ${yearName}.`} />
      </Section>
      <IndustrialReport match={basis === "fy" ? inFY(Number(year)) : (e) => e.date.startsWith(year)} period={period} />
    </div>
  )
}

/* ------------------------------------------------------------------ Quarterly Master */

/**
 * Calendar-quarter view (Q1 Jan–Mar … Q4 Oct–Dec), built by `buildMaster` over the quarter's
 * entries — the same source and formulas as the Monthly and Yearly Master, never stored. The
 * month table below shows the quarter reconciling with its three months.
 */
export function QuarterlyMaster() {
  const { input, isLoading, can } = useMasterInput()
  const { idx } = useDieselIndex()
  const months = useDieselMonthOptions(idx)
  const [globalMonth] = useDieselMonth(months)
  const years = useMemo(
    () => [...new Set([todayISO().slice(0, 4), ...(input?.diesel ?? []).map((e) => e.date.slice(0, 4)), ...(input?.adblue ?? []).map((e) => e.date.slice(0, 4))])].sort().reverse(),
    [input]
  )
  const [picked, setPicked] = useState<{ year?: string; q?: Quarter }>({})
  const year = picked.year ?? (globalMonth ? globalMonth.slice(0, 4) : years[0])
  const q = picked.q ?? quarterOf(globalMonth || todayISO())

  const d = useMemo(() => {
    if (!input || !year) return null
    const m = buildMaster(input, inQuarter(year, q))
    const split = litresByFuelType(input.idx, input.diesel, inQuarter(year, q))
    const byMonth = quarterMonths(year, q).map((mk) => ({ month: mk, m: buildMaster(input, inPeriod(mk)) }))
    const quarters = QUARTERS.map((x) => {
      const qm = buildMaster(input, inQuarter(year, x))
      return { q: x, spend: qm.fluid.spend, volume: qm.totals.litres }
    })
    return { m, split, byMonth, quarters, fuels: fuelsIn(input, inQuarter(year, q)) }
  }, [input, year, q])

  if (!can("diesel")) return <NoAccess what="diesel" />
  if (isLoading || !d) return <PageSkeleton />
  const { m, split } = d
  const ab = m.extras.find((x) => x.key === "adblue")?.total
  const period = `${quarterLabel(year, q)} · ${QUARTER_MONTHS[q]}`
  const abOf = (r: { extras: Record<string, { qty: number; spend: number }> }) => r.extras.adblue ?? { qty: 0, spend: 0 }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Diesel Quarterly Master"
        backHref="/diesel"
        backLabel="Diesel"
        description="Calendar quarters — Diesel and AdBlue shown separately, with their combined spend. Calculated from the same entries as the Monthly and Yearly Master."
        actions={
          <div className="flex items-center gap-2">
            <SimpleSelect value={String(q)} onChange={(v) => setPicked((p) => ({ ...p, q: Number(v) as Quarter }))} options={QUARTERS.map((x) => ({ value: String(x), label: `Q${x} · ${QUARTER_MONTHS[x]}` }))} className="h-10 min-w-40 text-base font-semibold" />
            <SimpleSelect value={year} onChange={(v) => setPicked((p) => ({ ...p, year: v }))} options={years.map((y) => ({ value: y, label: y }))} className="h-10 min-w-28 text-base font-semibold" />
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatsCard label="Total Diesel Litres" icon={Droplet} value={`${formatNumber(split.DIESEL)} L`} hint={`${period} · ${m.totals.fills} fills`} info="Σ litres of fills by Diesel vehicles dated in the quarter." />
        <StatsCard label="Total Petrol Litres" icon={Fuel} value={split.PETROL ? `${formatNumber(split.PETROL)} L` : "—"} hint={period} info="Σ litres of fills by Petrol vehicles dated in the quarter." />
        <StatsCard label="Total AdBlue Litres" icon={Droplets} value={`${formatNumber(ab?.qty ?? 0, 2)} L`} hint={`${period} · ${ab?.entries ?? 0} entries`} info="Σ AdBlue quantity of entries dated in the quarter — kept separate from fuel." />
        <StatsCard label={`${wordOf(d.fuels)} Spend`} icon={IndianRupee} value={formatINR(m.totals.spend)} hint={period} info="Σ amount of fuel fills dated in the quarter (same figure as the Monthly / Yearly Master's spend); per fuel type in By fuel type." />
        <StatsCard label="AdBlue Spend" icon={IndianRupee} value={formatINR(ab?.spend ?? 0)} hint={period} info="Σ amount of AdBlue entries dated in the quarter." />
        <StatsCard label="Combined Spend" icon={Sigma} value={formatINR(m.fluid.spend)} hint={`${period} · ${wordOf(d.fuels)} + AdBlue`} info={`${wordOf(d.fuels)} ${formatINR(m.totals.spend)} + AdBlue ${formatINR(ab?.spend ?? 0)} = ${formatINR(m.fluid.spend)}.`} />
      </div>

      <Section title="By fuel type">
        <FuelTypeTable fuels={d.fuels} />
      </Section>

      <Section title={`Months in ${quarterLabel(year, q)} — the quarter is their sum`}>
        <DataTable
          data={d.byMonth}
          getRowId={(r) => r.month}
          showFooter
          dense
          columns={[
            { id: "m", header: "Month", cell: (r) => monthLabel(r.month), footer: `${quarterLabel(year, q)} total` },
            { id: "dl", header: "Diesel (L)", align: "right", cell: (r) => qty(r.m.totals.litres), footer: qty(m.totals.litres) },
            { id: "ds", header: "Diesel Spend", align: "right", cell: (r) => inr(r.m.totals.spend), footer: inr(m.totals.spend) },
            { id: "al", header: "AdBlue (L)", align: "right", cell: (r) => qty(r.m.extras[0]?.total.qty ?? 0), footer: qty(ab?.qty ?? 0) },
            { id: "as", header: "AdBlue Spend", align: "right", cell: (r) => inr(r.m.extras[0]?.total.spend ?? 0), footer: inr(ab?.spend ?? 0) },
            { id: "cs", header: "Combined Spend", align: "right", cell: (r) => inr(r.m.fluid.spend), footer: inr(m.fluid.spend) },
          ]}
        />
      </Section>

      <Section title={`Customer breakdown · ${quarterLabel(year, q)}`}>
        <DataTable<CustomerRow>
          data={m.byCustomer}
          getRowId={(r) => r.id}
          initialSort={{ id: "cs", desc: true }}
          showFooter
          pageSize={100}
          emptyMessage="No entries this quarter."
          columns={[
            { id: "name", header: "Customer", sortValue: (r) => r.name, cell: (r) => <span className="font-medium">{r.name}</span>, footer: "Total" },
            { id: "dl", header: "Diesel Litres", align: "right", sortValue: (r) => r.litres, cell: (r) => qty(r.litres), footer: qty(m.totals.litres) },
            { id: "al", header: "AdBlue Litres", align: "right", sortValue: (r) => abOf(r).qty, cell: (r) => qty(abOf(r).qty), footer: qty(ab?.qty ?? 0) },
            { id: "ds", header: "Diesel Spend", align: "right", sortValue: (r) => r.spend, cell: (r) => inr(r.spend), footer: inr(m.totals.spend) },
            { id: "as", header: "AdBlue Spend", align: "right", sortValue: (r) => abOf(r).spend, cell: (r) => inr(abOf(r).spend), footer: inr(ab?.spend ?? 0) },
            { id: "cs", header: "Combined Spend", align: "right", sortValue: (r) => r.fluid.spend, cell: (r) => <span className="font-medium">{inr(r.fluid.spend)}</span>, footer: inr(m.fluid.spend) },
          ]}
        />
      </Section>

      <Section title={`Vehicle breakdown · ${quarterLabel(year, q)}`}>
        <DataTable<VehicleRow>
          data={m.byVehicle}
          getRowId={(r) => r.vehicle.id}
          initialSort={{ id: "veh", desc: false }}
          showFooter
          dense
          pageSize={100}
          emptyMessage="No entries this quarter."
          columns={[
            { id: "veh", header: "Vehicle", sortValue: (r) => r.vehicle.regNo, cell: (r) => <span className="font-medium">{r.vehicle.regNo}</span>, footer: "Total" },
            { id: "cust", header: "Customer", sortValue: (r) => r.customers, cell: (r) => <span className="text-muted-foreground">{r.customers}</span> },
            { id: "dl", header: "Diesel Litres", align: "right", sortValue: (r) => r.litres, cell: (r) => qty(r.litres), footer: qty(m.totals.litres) },
            { id: "al", header: "AdBlue Litres", align: "right", sortValue: (r) => abOf(r).qty, cell: (r) => qty(abOf(r).qty), footer: qty(ab?.qty ?? 0) },
            { id: "ds", header: "Diesel Spend", align: "right", sortValue: (r) => r.spend, cell: (r) => inr(r.spend), footer: inr(m.totals.spend) },
            { id: "as", header: "AdBlue Spend", align: "right", sortValue: (r) => abOf(r).spend, cell: (r) => inr(abOf(r).spend), footer: inr(ab?.spend ?? 0) },
          ]}
        />
      </Section>

      <Section title={`Quarter comparison · ${year}`}>
        <QuarterComparison year={year} quarters={d.quarters} spendLabel="Combined Spend" volumeLabel="Diesel Litres" />
      </Section>
      <IndustrialReport match={inQuarter(year, q)} period={period} />
    </div>
  )
}
