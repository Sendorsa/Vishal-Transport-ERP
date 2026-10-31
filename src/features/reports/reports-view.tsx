"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ChartCard } from "@/components/shared/chart-card"
import { DataTable } from "@/components/shared/data-table"
import { Money, NoAccess, PageSkeleton, PeriodSelect } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { StatsCard } from "@/components/shared/stats-card"
import {
  AGING_BUCKETS,
  cashFlow,
  customerProfitability,
  invoiceViews,
  monthlySeries,
  profitAndLoss,
  receivablesAging,
  vehicleProfitability,
  type PnLLine,
} from "@/domain/analytics"
import { monthKeysInRange, rangeForPreset, type PeriodPreset } from "@/domain/periods"
import {
  BreakdownDonut,
  CashTrendChart,
  CustomerProfitChart,
  RevenueTrendChart,
  VehicleProfitChart,
} from "@/features/analytics/charts"
import { useDataset } from "@/lib/api/hooks"
import { useCan, useCompanyScope } from "@/lib/app-state"
import { businessUnitLabel } from "@/lib/constants"
import { downloadCsv } from "@/lib/csv"
import { formatINR, formatDateLong, formatMonthKey, formatNumber, formatPercent, todayISO } from "@/lib/format"
import { cn } from "@/lib/utils"

const TABS = [
  { value: "customers", label: "Customer profitability", finance: true },
  { value: "vehicles", label: "Vehicle profitability", finance: false },
  { value: "pnl", label: "Profit & loss", finance: true },
  { value: "cashflow", label: "Cash flow", finance: true },
  { value: "aging", label: "Receivables aging", finance: true },
] as const

export function ReportsView({ initialTab }: { initialTab?: string }) {
  const can = useCan()
  const [scope] = useCompanyScope()
  const { data: ds, isLoading } = useDataset()
  const financeReports = can("reports", "finance")
  const tabs = TABS.filter((t) => !t.finance || financeReports)
  const [tab, setTab] = useState(tabs.find((t) => t.value === initialTab)?.value ?? tabs[0].value)
  const [period, setPeriod] = useState<PeriodPreset>("fy_to_date")
  const today = todayISO()

  const r = useMemo(() => {
    if (!ds) return null
    const range = rangeForPreset(period)
    const views = invoiceViews(ds, today)
    const earliest = ds.trips.reduce((m, t) => (t.date < m ? t.date : m), today)
    const months = monthKeysInRange(range, 12, earliest)
    return {
      range,
      months,
      series: monthlySeries(ds, months),
      customers: customerProfitability(ds, range, views).filter((c) => c.trips > 0 || c.outstanding > 0),
      vehicles: vehicleProfitability(ds, range).filter((v) => v.trips > 0 || v.totalCost > 0),
      pnl: profitAndLoss(ds, range),
      cash: cashFlow(ds, range),
      aging: receivablesAging(ds, views, today),
      types: new Map(ds.settings.vehicleTypes.map((t) => [t.code, t.name])),
    }
  }, [ds, period, today])

  if (!can("reports")) return <NoAccess what="reports" />
  if (isLoading || !r) return <PageSkeleton />

  const scopeLabel = scope === "GROUP" ? "Vishal Group (VT + VTHPL)" : scope === "VT" ? "Vishal Transport" : "VTHPL"
  const exportBtn = (onClick: () => void) => (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Download /> CSV
    </Button>
  )

  return (
    <div>
      <PageHeader
        title="Reports"
        description={`${scopeLabel} · ${formatDateLong(r.range.from)} – ${formatDateLong(r.range.to)}`}
        actions={<PeriodSelect value={period} onChange={setPeriod} />}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList className="max-w-full justify-start overflow-x-auto">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ------------------------------------------------ Customer profitability */}
        <TabsContent value="customers" className="mt-4 space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <ChartCard title="Revenue vs contribution" description="Top customers in the period">
              <CustomerProfitChart rows={r.customers} limit={10} />
            </ChartCard>
            <ChartCard title="Revenue mix" description="Share of revenue by customer">
              <BreakdownDonut data={[...r.customers].sort((a, b) => b.revenue - a.revenue).map((c) => ({ name: c.customer.code, value: c.revenue }))} />
            </ChartCard>
          </div>
          <div className="flex justify-end">
            {exportBtn(() =>
              downloadCsv(
                "customer-profitability",
                r.customers.map((c) => ({ Customer: c.customer.name, Company: c.customer.companyCode, Trips: c.trips, Km: c.km, Revenue: c.revenue, "Direct cost": c.directCost, Contribution: c.contribution, "Margin %": c.margin.toFixed(1), Outstanding: c.outstanding }))
              )
            )}
          </div>
          <DataTable
            data={r.customers}
            getRowId={(c) => c.customer.id}
            rowHref={(c) => `/customers/${c.customer.id}`}
            initialSort={{ id: "rev", desc: true }}
            showFooter
            columns={[
              {
                id: "c",
                header: "Customer",
                sortValue: (c) => c.customer.name,
                cell: (c) => (
                  <div>
                    <div className="font-medium">{c.customer.name}</div>
                    <div className="text-xs text-muted-foreground">{businessUnitLabel(c.customer.businessUnit)} · {c.customer.companyCode}</div>
                  </div>
                ),
                footer: "Total",
              },
              { id: "t", header: "Trips", align: "right", hideOnMobile: true, sortValue: (c) => c.trips, cell: (c) => formatNumber(c.trips), footer: formatNumber(r.customers.reduce((s, c) => s + c.trips, 0)) },
              { id: "km", header: "Km", align: "right", hideOnMobile: true, sortValue: (c) => c.km, cell: (c) => formatNumber(c.km), footer: formatNumber(r.customers.reduce((s, c) => s + c.km, 0)) },
              { id: "rev", header: "Revenue", align: "right", sortValue: (c) => c.revenue, cell: (c) => <Money value={c.revenue} />, footer: <Money value={r.customers.reduce((s, c) => s + c.revenue, 0)} /> },
              { id: "cost", header: "Direct cost", align: "right", hideOnMobile: true, sortValue: (c) => c.directCost, cell: (c) => <Money value={c.directCost} />, footer: <Money value={r.customers.reduce((s, c) => s + c.directCost, 0)} /> },
              { id: "con", header: "Contribution", align: "right", sortValue: (c) => c.contribution, cell: (c) => <Money value={c.contribution} signed />, footer: <Money value={r.customers.reduce((s, c) => s + c.contribution, 0)} signed /> },
              { id: "m", header: "Margin", align: "right", sortValue: (c) => c.margin, cell: (c) => <MarginCell value={c.margin} /> },
              { id: "out", header: "Outstanding", align: "right", hideOnMobile: true, sortValue: (c) => c.outstanding, cell: (c) => (c.outstanding ? <Money value={c.outstanding} /> : "—") },
            ]}
          />
          <Note>Direct cost = diesel, driver salary, EMI, insurance, road tax, maintenance and attached-vehicle hire of the vehicles serving the customer, allocated by km share. Office overheads are not allocated.</Note>
        </TabsContent>

        {/* ------------------------------------------------ Vehicle profitability */}
        <TabsContent value="vehicles" className="mt-4 space-y-4">
          <ChartCard title="Contribution by vehicle" description="Best and worst performers">
            <VehicleProfitChart rows={r.vehicles} limit={16} />
          </ChartCard>
          <div className="flex justify-end">
            {exportBtn(() =>
              downloadCsv(
                "vehicle-profitability",
                r.vehicles.map((v) => ({ Vehicle: v.vehicle.regNo, Type: r.types.get(v.vehicle.typeCode), Trips: v.trips, Km: v.km, Revenue: v.revenue, Diesel: v.diesel, Driver: v.driver, Maintenance: v.maintenance, Fixed: v.fixed, Contribution: v.contribution, "Cost/km": v.costPerKm, Kmpl: v.kmpl }))
              )
            )}
          </div>
          <DataTable
            data={r.vehicles}
            getRowId={(v) => v.vehicle.id}
            rowHref={(v) => `/vehicles/${v.vehicle.id}`}
            initialSort={{ id: "con", desc: false }}
            pageSize={50}
            showFooter
            dense
            columns={[
              { id: "v", header: "Vehicle", sortValue: (v) => v.vehicle.regNo, cell: (v) => <span className="font-medium">{v.vehicle.regNo}</span>, footer: `${r.vehicles.length} vehicles` },
              { id: "type", header: "Type", hideOnMobile: true, cell: (v) => <span className="text-muted-foreground">{r.types.get(v.vehicle.typeCode)}</span> },
              { id: "km", header: "Km", align: "right", hideOnMobile: true, sortValue: (v) => v.km, cell: (v) => formatNumber(v.km) },
              { id: "rev", header: "Revenue", align: "right", sortValue: (v) => v.revenue, cell: (v) => <Money value={v.revenue} />, footer: <Money value={r.vehicles.reduce((s, v) => s + v.revenue, 0)} /> },
              { id: "d", header: "Diesel", align: "right", hideOnMobile: true, sortValue: (v) => v.diesel, cell: (v) => <Money value={v.diesel} />, footer: <Money value={r.vehicles.reduce((s, v) => s + v.diesel, 0)} /> },
              { id: "dr", header: "Driver", align: "right", hideOnMobile: true, sortValue: (v) => v.driver, cell: (v) => <Money value={v.driver} /> },
              { id: "mt", header: "Maint.", align: "right", hideOnMobile: true, sortValue: (v) => v.maintenance, cell: (v) => <Money value={v.maintenance} /> },
              { id: "fx", header: "EMI/ins/tax", align: "right", hideOnMobile: true, sortValue: (v) => v.fixed, cell: (v) => <Money value={v.fixed} /> },
              { id: "con", header: "Contribution", align: "right", sortValue: (v) => v.contribution, cell: (v) => <Money value={v.contribution} signed />, footer: <Money value={r.vehicles.reduce((s, v) => s + v.contribution, 0)} signed /> },
              { id: "cpk", header: "₹/km", align: "right", hideOnMobile: true, sortValue: (v) => v.costPerKm, cell: (v) => v.costPerKm?.toFixed(2) ?? "—" },
              { id: "m", header: "Margin", align: "right", sortValue: (v) => (v.revenue ? v.margin : null), cell: (v) => (v.revenue ? <MarginCell value={v.margin} /> : "—") },
            ]}
          />
        </TabsContent>

        {/* ------------------------------------------------ P&L */}
        <TabsContent value="pnl" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatsCard label="Income" value={formatINR(r.pnl.totalIncome)} />
            <StatsCard label="Expenses" value={formatINR(r.pnl.totalExpenses)} />
            <StatsCard label="Net profit" value={formatINR(r.pnl.netProfit)} tone={r.pnl.netProfit < 0 ? "negative" : "positive"} />
            <StatsCard label="Net margin" value={formatPercent(r.pnl.margin)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <Card size="sm" className="gap-2">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-semibold">Statement of profit & loss</CardTitle>
                {exportBtn(() =>
                  downloadCsv("profit-and-loss", [
                    ...r.pnl.income.map((l) => ({ Section: "Income", Head: l.label, Amount: l.amount })),
                    { Section: "Income", Head: "Total income", Amount: r.pnl.totalIncome },
                    ...r.pnl.expenses.map((l) => ({ Section: "Expenses", Head: l.label, Amount: l.amount })),
                    { Section: "Expenses", Head: "Total expenses", Amount: r.pnl.totalExpenses },
                    { Section: "", Head: "Net profit", Amount: r.pnl.netProfit },
                  ])
                )}
              </CardHeader>
              <CardContent className="px-0 text-sm">
                <Statement title="Income" lines={r.pnl.income} total={r.pnl.totalIncome} base={r.pnl.totalIncome} />
                <Statement title="Expenses" lines={r.pnl.expenses} total={r.pnl.totalExpenses} base={r.pnl.totalIncome} />
                <div className={cn("flex justify-between border-t-2 px-4 pt-3 text-base font-semibold", r.pnl.netProfit < 0 ? "text-destructive" : "text-success")}>
                  <span>Net profit</span>
                  <span className="num">{formatINR(r.pnl.netProfit)}</span>
                </div>
              </CardContent>
            </Card>
            <div className="space-y-4">
              <ChartCard title="Monthly revenue & profit">
                <RevenueTrendChart data={r.series} />
              </ChartCard>
              <ChartCard title="Expense mix">
                <BreakdownDonut data={r.pnl.expenses.map((l) => ({ name: l.label, value: l.amount }))} />
              </ChartCard>
            </div>
          </div>
          <DataTable
            data={r.series}
            getRowId={(m) => m.month}
            columns={[
              { id: "m", header: "Month", cell: (m) => formatMonthKey(m.month) },
              { id: "r", header: "Revenue", align: "right", cell: (m) => <Money value={m.revenue} /> },
              { id: "d", header: "Diesel", align: "right", hideOnMobile: true, cell: (m) => <Money value={m.diesel} /> },
              { id: "o", header: "Other expenses", align: "right", hideOnMobile: true, cell: (m) => <Money value={m.otherExpenses} /> },
              { id: "p", header: "Profit", align: "right", cell: (m) => <Money value={m.profit} signed /> },
              { id: "mg", header: "Margin", align: "right", cell: (m) => (m.revenue ? <MarginCell value={(m.profit / m.revenue) * 100} /> : "—") },
            ]}
          />
          <Note>Management P&L on accrual basis: revenue on completed trips (ex-GST), diesel on fill date, other heads on payment date. GST and diesel vendor settlements are balance-sheet movements and excluded; TDS deducted by customers is an asset (refundable), not an expense.</Note>
        </TabsContent>

        {/* ------------------------------------------------ Cash flow */}
        <TabsContent value="cashflow" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <StatsCard label="Receipts" value={formatINR(r.cash.receipts)} tone="positive" />
            <StatsCard label="Payments" value={formatINR(r.cash.totalOut)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <ChartCard title="Monthly cash in vs out">
              <CashTrendChart data={r.series} />
            </ChartCard>
            <Card size="sm" className="gap-2">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Cash flow statement</CardTitle>
              </CardHeader>
              <CardContent className="px-0 text-sm">
                <div className="flex justify-between px-4 py-1.5 font-medium text-success">
                  <span>+ Customer receipts</span>
                  <span className="num">{formatINR(r.cash.receipts)}</span>
                </div>
                <Statement title="− Payments" lines={r.cash.outflows} total={r.cash.totalOut} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ------------------------------------------------ Aging */}
        <TabsContent value="aging" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <StatsCard label="Total receivable" value={formatINR(r.aging.total)} hint={`As of ${formatDateLong(today)}`} />
            {AGING_BUCKETS.map((b) => (
              <StatsCard
                key={b.key}
                label={b.label}
                value={formatINR(r.aging.totals[b.key])}
                hint={r.aging.total ? formatPercent((r.aging.totals[b.key] / r.aging.total) * 100) : undefined}
                tone={b.key === "d61_90" || b.key === "d90p" ? (r.aging.totals[b.key] > 0 ? "negative" : "default") : "default"}
              />
            ))}
          </div>
          <div className="flex justify-end">
            {exportBtn(() =>
              downloadCsv(
                "receivables-aging",
                r.aging.rows.map((row) => ({ Customer: row.customer.name, Invoices: row.invoices, ...Object.fromEntries(AGING_BUCKETS.map((b) => [b.label, row[b.key]])), Total: row.total }))
              )
            )}
          </div>
          <DataTable
            data={r.aging.rows}
            getRowId={(row) => row.customer.id}
            rowHref={(row) => `/customers/${row.customer.id}`}
            initialSort={{ id: "total", desc: true }}
            showFooter
            columns={[
              { id: "c", header: "Customer", sortValue: (row) => row.customer.name, cell: (row) => <span className="font-medium">{row.customer.name}</span>, footer: "Total" },
              { id: "n", header: "Invoices", align: "right", hideOnMobile: true, cell: (row) => row.invoices },
              ...AGING_BUCKETS.map((b) => ({
                id: b.key,
                header: b.label,
                align: "right" as const,
                hideOnMobile: b.key !== "notDue" && b.key !== "d90p",
                sortValue: (row: (typeof r.aging.rows)[number]) => row[b.key],
                cell: (row: (typeof r.aging.rows)[number]) =>
                  row[b.key] ? <Money value={row[b.key]} className={b.key === "d61_90" || b.key === "d90p" ? "font-medium text-destructive" : ""} /> : <span className="text-muted-foreground">—</span>,
                footer: <Money value={r.aging.totals[b.key]} />,
              })),
              { id: "total", header: "Total", align: "right", sortValue: (row) => row.total, cell: (row) => <Money value={row.total} className="font-semibold" />, footer: <Money value={r.aging.total} /> },
            ]}
          />
          <Note>
            Buckets by days past due date. Outstanding = invoice total − receipts − TDS allocated. See{" "}
            <Link href="/invoices?status=OVERDUE" className="underline">
              overdue invoices
            </Link>
            .
          </Note>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Statement({ title, lines, total, base }: { title: string; lines: PnLLine[]; total: number; base?: number }) {
  return (
    <div className="pb-2">
      <div className="bg-muted/50 px-4 py-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>
      {lines.map((l) => (
        <div key={l.code} className="flex justify-between gap-3 px-4 py-1.5">
          <span>{l.label}</span>
          <span className="num flex gap-3">
            {base ? <span className="w-12 text-right text-xs text-muted-foreground">{formatPercent((l.amount / base) * 100, 0)}</span> : null}
            <span className="w-28 text-right">{formatINR(l.amount)}</span>
          </span>
        </div>
      ))}
      <div className="flex justify-between border-t px-4 py-1.5 font-medium">
        <span>Total {title.replace(/^[−+] /, "").toLowerCase()}</span>
        <span className="num">{formatINR(total)}</span>
      </div>
    </div>
  )
}

function MarginCell({ value, warnBelow = 0 }: { value: number; warnBelow?: number }) {
  return <span className={cn("num", value < warnBelow ? "font-medium text-destructive" : value < 10 ? "text-warning" : "text-success")}>{formatPercent(value)}</span>
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
}
