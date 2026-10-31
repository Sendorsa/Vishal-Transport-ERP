"use client"

import { AdBlueDashboardCards } from "@/features/adblue/adblue-inventory"
import { useMemo, useState } from "react"
import Link from "next/link"
import { differenceInCalendarDays, parseISO, subDays } from "date-fns"
import {
  AlertTriangle,
  Bus,
  Fuel,
  HandCoins,
  Receipt,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartCard } from "@/components/shared/chart-card"
import { Money, PageSkeleton, PeriodSelect } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { StatsCard } from "@/components/shared/stats-card"
import { StatusBadge } from "@/components/shared/status-badge"
import {
  complianceAlerts,
  customerProfitability,
  dieselInRange,
  dieselLitresInRange,
  expensesInRange,
  invoiceViews,
  monthlySeries,
  payablesTotal,
  receivablesTotal,
  revenueInRange,
  unbilledTrips,
  vehicleProfitability,
} from "@/domain/analytics"
import { monthKeysInRange, rangeForPreset, type DateRange, type PeriodPreset } from "@/domain/periods"
import { useDataset } from "@/lib/api/hooks"
import { useCan, useCompanyScope } from "@/lib/app-state"
import { formatINR, formatDate, formatDateLong, formatNumber, formatPercent, toISODate, todayDate, todayISO } from "@/lib/format"
import {
  CustomerProfitChart,
  DieselTrendChart,
  ExpenseTrendChart,
  RevenueTrendChart,
  VehicleProfitChart,
} from "@/features/analytics/charts"

function previousRange(r: DateRange): DateRange | null {
  if (r.from <= "2000-01-01") return null
  const days = differenceInCalendarDays(parseISO(r.to), parseISO(r.from)) + 1
  const to = subDays(parseISO(r.from), 1)
  return { from: toISODate(subDays(to, days - 1)), to: toISODate(to) }
}

const pct = (cur: number, prev: number) => (prev ? ((cur - prev) / Math.abs(prev)) * 100 : null)

export function DashboardView() {
  const [period, setPeriod] = useState<PeriodPreset>("last_month")
  const { data: ds, isLoading } = useDataset()
  const [scope] = useCompanyScope()
  const can = useCan()
  const finance = can("finance", "view")
  const today = todayISO()

  const m = useMemo(() => {
    if (!ds) return null
    const range = rangeForPreset(period)
    const prev = previousRange(range)
    const trendRange = rangeForPreset("last_6_months")
    const earliest = ds.trips.reduce((min, t) => (t.date < min ? t.date : min), today)
    const views = invoiceViews(ds, today)
    const revenue = revenueInRange(ds, range)
    const expenses = expensesInRange(ds, range)
    const diesel = dieselInRange(ds, range)
    const litres = dieselLitresInRange(ds, range)
    const prevRevenue = prev ? revenueInRange(ds, prev) : 0
    const prevExpenses = prev ? expensesInRange(ds, prev) : 0
    const prevDiesel = prev ? dieselInRange(ds, prev) : 0
    const overdue = views.filter((v) => v.paymentStatus === "OVERDUE")
    const unbilled = unbilledTrips(ds)
    const activeVehicles = ds.vehicles.filter((v) => v.status === "ACTIVE")
    const recentCustomers = new Set(ds.trips.filter((t) => t.date >= toISODate(subDays(todayDate(), 30))).map((t) => t.customerId))
    return {
      range,
      revenue,
      expenses,
      profit: revenue - expenses,
      prevProfit: prevRevenue - prevExpenses,
      diesel,
      litres,
      deltas: {
        revenue: prev ? pct(revenue, prevRevenue) : null,
        expenses: prev ? pct(expenses, prevExpenses) : null,
        diesel: prev ? pct(diesel, prevDiesel) : null,
      },
      receivables: receivablesTotal(views),
      overdueAmount: overdue.reduce((s, v) => s + v.outstanding, 0),
      overdue: overdue.sort((a, b) => b.outstanding - a.outstanding),
      payables: payablesTotal(ds),
      activeVehicles: activeVehicles.length,
      workshop: ds.vehicles.filter((v) => v.status === "MAINTENANCE").length,
      totalVehicles: ds.vehicles.length,
      activeCustomers: ds.customers.filter((c) => c.status === "ACTIVE").length,
      recentCustomers: recentCustomers.size,
      series: monthlySeries(ds, monthKeysInRange(trendRange, 6, earliest)),
      customerProfit: customerProfitability(ds, range, views),
      vehicleProfit: vehicleProfitability(ds, range),
      alerts: complianceAlerts(ds, today),
      unbilledCount: unbilled.length,
      unbilledValue: unbilled.reduce((s, t) => s + t.revenue, 0),
      tripsInRange: ds.trips.filter((t) => t.status === "COMPLETED" && t.date >= range.from && t.date <= range.to),
      customers: new Map(ds.customers.map((c) => [c.id, c])),
    }
  }, [ds, period, today])

  if (isLoading || !m) return <PageSkeleton />

  const periodLabel = `${formatDateLong(m.range.from)} – ${formatDateLong(m.range.to)}`
  const km = m.tripsInRange.reduce((s, t) => s + t.distanceKm, 0)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard"
        description={`${scope === "GROUP" ? "Vishal Group (VT + VTHPL)" : scope === "VT" ? "Vishal Transport" : "VTHPL"} · ${periodLabel}`}
        actions={<PeriodSelect value={period} onChange={setPeriod} />}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {finance && (
          <>
            <StatsCard label="Receivables" value={formatINR(m.receivables)} icon={HandCoins} hint={`${formatINR(m.overdueAmount)} overdue`} href="/invoices" />
            <StatsCard label="Payables" value={formatINR(m.payables)} icon={Wallet} hint="Diesel vendors (credit)" href="/diesel/ledger" />
            <StatsCard label="Revenue" value={formatINR(m.revenue)} icon={TrendingUp} delta={m.deltas.revenue} hint="vs prev. period" />
            <StatsCard label="Expenses" value={formatINR(m.expenses)} icon={TrendingDown} delta={m.deltas.expenses} invertDelta hint="vs prev. period" />
            <StatsCard
              label="Profit"
              value={formatINR(m.profit)}
              icon={Receipt}
              tone={m.profit < 0 ? "negative" : "positive"}
              hint={`Margin ${formatPercent(m.revenue ? (m.profit / m.revenue) * 100 : 0)}`}
              href="/reports?tab=pnl"
            />
          </>
        )}
        <StatsCard label="Diesel cost" value={formatINR(m.diesel)} icon={Fuel} delta={m.deltas.diesel} invertDelta hint={`${formatNumber(m.litres)} L`} href="/diesel" />
        <StatsCard label="Active vehicles" value={`${m.activeVehicles} / ${m.totalVehicles}`} icon={Bus} hint={`${m.workshop} in workshop`} href="/vehicles" />
        <StatsCard label="Active customers" value={m.activeCustomers} icon={Users} hint={`${m.recentCustomers} with trips in 30 days`} href="/customers" />
        {!finance && <StatsCard label="Trips / km" value={formatNumber(m.tripsInRange.length)} icon={Bus} hint={`${formatNumber(km)} km run`} href="/trips" />}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <AdBlueDashboardCards />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {finance ? (
          <>
            <ChartCard title="Revenue trend" description="Earned on completed trips, ex-GST · last 6 months">
              <RevenueTrendChart data={m.series} />
            </ChartCard>
            <ChartCard title="Expense trend" description="Diesel vs all other expense heads">
              <ExpenseTrendChart data={m.series} />
            </ChartCard>
            <ChartCard
              title="Customer profitability"
              description="Revenue vs contribution after vehicle-level costs"
              action={
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/reports?tab=customers">Report</Link>
                </Button>
              }
            >
              <CustomerProfitChart rows={m.customerProfit} />
            </ChartCard>
            <ChartCard
              title="Vehicle profitability"
              description="Top and bottom vehicles by contribution"
              action={
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/reports?tab=vehicles">Report</Link>
                </Button>
              }
            >
              <VehicleProfitChart rows={m.vehicleProfit} />
            </ChartCard>
          </>
        ) : (
          <ChartCard title="Diesel trend" description="Monthly cost and litres" className="lg:col-span-2">
            <DieselTrendChart data={m.series} />
          </ChartCard>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {finance && (
          <Card size="sm" className="gap-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <AlertTriangle className="size-4 text-destructive" /> Overdue invoices
              </CardTitle>
              <CardAction>
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/invoices?status=OVERDUE">View all</Link>
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="px-0">
              {m.overdue.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing overdue 🎉</p>
              ) : (
                <ul className="divide-y">
                  {m.overdue.slice(0, 6).map((inv) => (
                    <li key={inv.id}>
                      <Link href={`/invoices/${inv.id}`} className="flex items-center justify-between gap-2 px-4 py-2 text-sm hover:bg-muted/50">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{m.customers.get(inv.customerId)?.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {inv.invoiceNo} · {inv.daysOverdue} days overdue
                          </div>
                        </div>
                        <Money value={inv.outstanding} className="font-medium" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        <Card size="sm" className="gap-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <ShieldAlert className="size-4 text-warning" /> Compliance due (30 days)
            </CardTitle>
            <CardAction>
              <span className="text-xs text-muted-foreground">{m.alerts.length} items</span>
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            {m.alerts.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">All documents valid</p>
            ) : (
              <ul className="divide-y">
                {m.alerts.slice(0, 6).map((a) => (
                  <li key={`${a.vehicle.id}-${a.document}`}>
                    <Link href={`/vehicles/${a.vehicle.id}`} className="flex items-center justify-between gap-2 px-4 py-2 text-sm hover:bg-muted/50">
                      <div className="min-w-0">
                        <div className="font-medium">{a.vehicle.regNo}</div>
                        <div className="text-xs text-muted-foreground">
                          {a.document} · {formatDate(a.validTill)}
                        </div>
                      </div>
                      <StatusBadge
                        status={a.daysLeft < 0 ? "EXPIRED" : "EXPIRING"}
                        label={a.daysLeft < 0 ? `Expired ${-a.daysLeft}d` : `${a.daysLeft}d left`}
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card size="sm" className="gap-2">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Ready to bill</CardTitle>
            <CardAction>
              {can("invoices", "create") && (
                <Button size="sm" variant="outline" asChild>
                  <Link href="/invoices/new">Create invoice</Link>
                </Button>
              )}
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="num text-2xl font-semibold">{finance ? formatINR(m.unbilledValue) : formatNumber(m.unbilledCount)}</div>
              <p className="text-xs text-muted-foreground">
                {formatNumber(m.unbilledCount)} completed trips not yet invoiced
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 border-t pt-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Trips in period</div>
                <div className="num font-medium">{formatNumber(m.tripsInRange.length)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Km run</div>
                <div className="num font-medium">{formatNumber(km)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Diesel / km</div>
                <div className="num font-medium">{km ? formatINR((m.diesel / km)) : "—"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Fleet kmpl</div>
                <div className="num font-medium">{m.litres ? (km / m.litres).toFixed(2) : "—"}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
