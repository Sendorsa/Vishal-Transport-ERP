"use client"

import { EditedBadge, HistoryButton } from "@/components/shared/audit"
import { useDeferredValue, useMemo, useState } from "react"
import Link from "next/link"
import { FileText, Pencil, Route, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ChartCard } from "@/components/shared/chart-card"
import { DataTable, type Column } from "@/components/shared/data-table"
import { DetailList } from "@/components/shared/entity-drawer"
import { EmptyState, Money, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { SearchBar } from "@/components/shared/filter-bar"
import { PageHeader } from "@/components/shared/page-header"
import { StatsCard } from "@/components/shared/stats-card"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import {
  customerProfitability,
  invoiceViews,
  monthlySeries,
  scopeDataset,
  vehicleProfitability,
  type InvoiceView,
} from "@/domain/analytics"
import { customerVehicles, vehicleMatches, type CustomerVehicle } from "@/domain/assignments"
import { monthKeysInRange, rangeForPreset } from "@/domain/periods"
import { PRICING_MODELS } from "@/domain/pricing"
import { RevenueTrendChart } from "@/features/analytics/charts"
import { useDataset } from "@/lib/api/hooks"
import { useCan } from "@/lib/app-state"
import { businessUnitLabel } from "@/lib/constants"
import { formatINR, formatDate, formatNumber, formatPercent, todayISO } from "@/lib/format"
import type { Trip } from "@/lib/types"
import { CustomerForm } from "./customer-form"

export function CustomerDetail({ id }: { id: string }) {
  const can = useCan()
  const finance = can("finance", "view")
  const { data: all, isLoading } = useDataset()
  const [editing, setEditing] = useState(false)
  const today = todayISO()

  const d = useMemo(() => {
    if (!all) return null
    const customer = all.customers.find((c) => c.id === id)
    if (!customer) return { customer: null }
    // Restrict the dataset to this customer's trips / invoices / receipts.
    const ds = scopeDataset(all, customer.companyCode)
    const views = invoiceViews(ds, today).filter((v) => v.customerId === id)
    const fy = rangeForPreset("fy_to_date")
    const profit = customerProfitability(ds, fy, views).find((p) => p.customer.id === id)!
    const trips = ds.trips.filter((t) => t.customerId === id)
    const vehicleIds = new Set(trips.map((t) => t.vehicleId))
    const customerDs = { ...ds, trips, diesel: [], payments: ds.payments.filter((p) => p.customerId === id), invoices: ds.invoices.filter((i) => i.customerId === id) }
    const series = monthlySeries(customerDs, monthKeysInRange(rangeForPreset("last_6_months"), 6))
    // Per-vehicle split for this customer
    const vp = vehicleProfitability(ds, fy).filter((v) => vehicleIds.has(v.vehicle.id))
    const byVehicle = vp.map((v) => {
      const ct = trips.filter((t) => t.vehicleId === v.vehicle.id && t.status === "COMPLETED" && t.date >= fy.from)
      const km = ct.reduce((s, t) => s + t.distanceKm, 0)
      const revenue = ct.reduce((s, t) => s + t.revenue, 0)
      const cost = v.km ? (v.totalCost * km) / v.km : 0
      return { vehicle: v.vehicle, trips: ct.length, km, revenue, cost, contribution: revenue - cost }
    })
    return { customer, views, profit, trips, series, byVehicle, vehicles: new Map(ds.vehicles.map((v) => [v.id, v])), drivers: new Map(ds.drivers.map((x) => [x.id, x])) }
  }, [all, id, today])

  if (!can("customers")) return <NoAccess what="customers" />
  if (isLoading || !d) return <PageSkeleton />
  if (!d.customer) return <EmptyState icon={Users} title="Customer not found" action={<Button asChild variant="outline"><Link href="/customers">Back to customers</Link></Button>} />

  const c = d.customer
  if (editing)
    return (
      <div>
        <PageHeader title={`Edit ${c.name}`} backHref={`/customers/${c.id}`} backLabel={c.name} />
        <CustomerForm customer={c} onDone={() => setEditing(false)} />
      </div>
    )

  const { profit, views } = d!
  const overdue = views!.filter((v) => v.paymentStatus === "OVERDUE").reduce((s, v) => s + v.outstanding, 0)
  const meta = PRICING_MODELS[c.pricing.model]

  const invoiceColumns: Column<InvoiceView>[] = [
    { id: "no", header: "Invoice", sortValue: (r) => r.invoiceNo, cell: (r) => <span className="font-medium">{r.invoiceNo}</span> },
    { id: "date", header: "Date", sortValue: (r) => r.date, cell: (r) => formatDate(r.date) },
    { id: "due", header: "Due", hideOnMobile: true, sortValue: (r) => r.dueDate, cell: (r) => formatDate(r.dueDate) },
    { id: "total", header: "Total", align: "right", sortValue: (r) => r.total, cell: (r) => <Money value={r.total} /> },
    { id: "out", header: "Outstanding", align: "right", sortValue: (r) => r.outstanding, cell: (r) => (r.outstanding ? <Money value={r.outstanding} /> : "—") },
    { id: "status", header: "Status", cell: (r) => <StatusBadge status={r.paymentStatus} /> },
  ]
  const tripColumns: Column<Trip>[] = [
    { id: "date", header: "Date", sortValue: (t) => t.date, cell: (t) => formatDate(t.date) },
    { id: "no", header: "Trip", hideOnMobile: true, cell: (t) => t.tripNo },
    { id: "veh", header: "Vehicle", cell: (t) => d.vehicles!.get(t.vehicleId)?.regNo },
    { id: "driver", header: "Driver", hideOnMobile: true, cell: (t) => (t.driverId ? d.drivers!.get(t.driverId)?.name : "Owner-driven") },
    { id: "km", header: "Km", align: "right", sortValue: (t) => t.distanceKm, cell: (t) => formatNumber(t.distanceKm) },
    ...(finance ? ([{ id: "rev", header: "Revenue", align: "right", sortValue: (t) => t.revenue, cell: (t) => <Money value={t.revenue} /> }] satisfies Column<Trip>[]) : []),
    { id: "status", header: "Status", cell: (t) => <StatusBadge status={t.status === "COMPLETED" ? (t.invoiceId ? "INVOICED" : "UNBILLED") : t.status} /> },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        backHref="/customers"
        backLabel="Customers"
        title={c.name}
        meta={
          <>
            <EditedBadge id={c.id} />
            <HistoryButton id={c.id} />
            <CompanyBadge code={c.companyCode} />
            <StatusBadge status={c.status} />
          </>
        }
        description={`${c.code} · ${businessUnitLabel(c.businessUnit)} · ${c.city}, ${c.state}`}
        actions={
          <>
            {can("customers", "edit") && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {can("trips", "create") && (
              <Button variant="outline" asChild>
                <Link href={`/trips/new?customerId=${c.id}`}>
                  <Route /> New trip
                </Link>
              </Button>
            )}
            {can("invoices", "create") && (
              <Button asChild>
                <Link href={`/invoices/new?customerId=${c.id}`}>
                  <FileText /> New invoice
                </Link>
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {finance && <StatsCard label="Revenue (FY to date)" value={formatINR(profit!.revenue)} hint={`${formatNumber(profit!.trips)} trips`} />}
        {finance && (
          <StatsCard
            label="Contribution"
            value={formatINR(profit!.contribution)}
            tone={profit!.contribution < 0 ? "negative" : "positive"}
            hint={`Margin ${formatPercent(profit!.margin)}`}
          />
        )}
        {finance && <StatsCard label="Outstanding" value={formatINR(profit!.outstanding)} hint={`${formatINR(overdue)} overdue`} tone={overdue > 0 ? "warning" : "default"} />}
        <StatsCard label="Km (FY)" value={formatNumber(profit!.km)} hint={`${profit!.vehicles} vehicles deployed`} />
        <StatsCard label="Credit terms" value={`${c.creditDays} days`} hint={c.gstin || "Unregistered"} />
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {can("vehicles") && <TabsTrigger value="vehicles">Vehicles</TabsTrigger>}
          {finance && <TabsTrigger value="invoices">Invoices ({views!.length})</TabsTrigger>}
          <TabsTrigger value="trips">Trips</TabsTrigger>
          {finance && <TabsTrigger value="profitability">Profitability</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <div className="grid gap-4">
            <Card size="sm">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Profile</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailList
                  items={[
                    ["Legal name", c.legalName],
                    ["Billing company", c.companyCode],
                    ["GSTIN", c.gstin || "—"],
                    ["Place of supply", `${c.state} (${c.stateCode})`],
                    ["Contact", c.contactName || "—"],
                    ["Phone", c.phone || "—"],
                    ["Email", c.email || "—"],
                  ]}
                />
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Pricing — {meta.label}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <DetailList
                  items={[
                    [meta.rateLabel, formatINR(c.pricing.rate)],
                    ...(meta.includedKmLabel ? ([[meta.includedKmLabel, `${formatNumber(c.pricing.includedKm)} km`]] as [string, string][]) : []),
                    ...(c.pricing.extraKmRate ? ([["Extra km rate", formatINR(c.pricing.extraKmRate)]] as [string, string][]) : []),
                    ...(c.pricing.driverBata ? ([["Driver bata", formatINR(c.pricing.driverBata)]] as [string, string][]) : []),
                  ]}
                />
                {c.pricing.routes.length > 0 && (
                  <ul className="divide-y rounded-lg border text-sm">
                    {c.pricing.routes.map((r) => (
                      <li key={r.route} className="flex justify-between gap-2 px-3 py-1.5">
                        <span className="truncate">{r.route}</span>
                        <span className="num shrink-0 text-muted-foreground">
                          {r.distanceKm} km · <b className="text-foreground">{formatINR(r.rate)}</b>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">{meta.hint}</p>
              </CardContent>
            </Card>
          </div>
          {finance ? (
            <ChartCard title="Revenue summary" description="Monthly revenue earned from this customer">
              <RevenueTrendChart data={d.series!} showProfit={false} />
            </ChartCard>
          ) : (
            <Card size="sm">
              <CardContent className="py-6 text-center text-sm text-muted-foreground">Financial summary hidden for your role.</CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="invoices" className="mt-3">
          <DataTable
            columns={invoiceColumns}
            data={[...views!].sort((a, b) => b.outstanding - a.outstanding || b.date.localeCompare(a.date))}
            getRowId={(r) => r.id}
            rowHref={(r) => `/invoices/${r.id}`}
            emptyMessage="No invoices yet."
          />
        </TabsContent>

        {can("vehicles") && (
          <TabsContent value="vehicles" className="mt-3">
            {/* Keyed by customer: opening another customer starts with an empty search. */}
            <CustomerVehicles key={id} customerId={id} />
          </TabsContent>
        )}

        <TabsContent value="trips" className="mt-3">
          <DataTable
            columns={tripColumns}
            data={d.trips}
            getRowId={(t) => t.id}
            rowHref={(t) => `/trips/${t.id}`}
            initialSort={{ id: "date", desc: true }}
            pageSize={20}
          />
        </TabsContent>

        <TabsContent value="profitability" className="mt-3">
          <DataTable
            columns={[
              { id: "veh", header: "Vehicle", sortValue: (r) => r.vehicle.regNo, cell: (r) => <Link className="font-medium hover:underline" href={`/vehicles/${r.vehicle.id}`}>{r.vehicle.regNo}</Link> },
              { id: "trips", header: "Trips", align: "right", sortValue: (r) => r.trips, cell: (r) => formatNumber(r.trips), footer: formatNumber(profit!.trips) },
              { id: "km", header: "Km", align: "right", sortValue: (r) => r.km, cell: (r) => formatNumber(r.km), footer: formatNumber(profit!.km) },
              { id: "rev", header: "Revenue", align: "right", sortValue: (r) => r.revenue, cell: (r) => <Money value={r.revenue} />, footer: <Money value={profit!.revenue} /> },
              { id: "cost", header: "Allocated cost", align: "right", sortValue: (r) => r.cost, cell: (r) => <Money value={r.cost} />, footer: <Money value={profit!.directCost} /> },
              { id: "contrib", header: "Contribution", align: "right", sortValue: (r) => r.contribution, cell: (r) => <Money value={r.contribution} signed />, footer: <Money value={profit!.contribution} signed /> },
            ]}
            data={d.byVehicle}
            getRowId={(r) => r.vehicle.id}
            initialSort={{ id: "contrib", desc: true }}
            showFooter
          />
          <p className="mt-2 text-xs text-muted-foreground">
            FY to date. Vehicle costs (diesel, driver, EMI, insurance, tax, maintenance) are allocated by this customer&apos;s share of each vehicle&apos;s km. Office overheads are excluded.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/**
 * This customer's vehicles only, from the assignment history (customerVehicles): assigned now by default, or
 * previously assigned. Searched by registration, name (a tanker's "JIO"), make / model / type.
 */
function CustomerVehicles({ customerId }: { customerId: string }) {
  const { data: ds } = useDataset({ allCompanies: true }) // a customer's vehicles can belong to either company
  const [q, setQ] = useState("")
  const query = useDeferredValue(q)
  const [show, setShow] = useState<"current" | "previous">("current")
  const today = todayISO()
  const d = useMemo(() => {
    if (!ds) return null
    const list = customerVehicles(customerId, ds.assignments ?? [], new Map(ds.vehicles.map((v) => [v.id, v])), today)
    return {
      list,
      names: new Map((ds.tankers ?? []).flatMap((t) => (t.vehicleId ? [[t.vehicleId, t.name] as const] : []))),
      customers: new Map(ds.customers.map((c) => [c.id, c.name])),
      types: new Map(ds.settings.vehicleTypes.map((t) => [t.code, t.name])),
    }
  }, [ds, customerId, today])
  if (!d) return <PageSkeleton />
  const inTab = d.list.filter((r) => r.current === (show === "current"))
  const rows = inTab.filter((r) => vehicleMatches(query, r.vehicle, d.names.get(r.vehicle.id)))
  const counts = { current: d.list.filter((r) => r.current).length, previous: d.list.filter((r) => !r.current).length }
  const columns: Column<CustomerVehicle>[] = [
    {
      id: "veh",
      header: "Vehicle",
      sortValue: (r) => r.vehicle.regNo,
      cell: (r) => (
        <div>
          <Link className="font-mono font-medium hover:underline" href={`/vehicles/${r.vehicle.id}`}>
            {r.vehicle.regNo}
          </Link>
          <div className="text-xs text-muted-foreground">{[d.names.get(r.vehicle.id), [r.vehicle.make, r.vehicle.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "—"}</div>
        </div>
      ),
    },
    { id: "type", header: "Type", hideOnMobile: true, sortValue: (r) => r.vehicle.typeCode, cell: (r) => d.types.get(r.vehicle.typeCode) ?? (r.vehicle.typeCode || "—") },
    {
      id: "assignment",
      header: "Assignment",
      sortValue: (r) => r.startDate,
      cell: (r) =>
        r.current ? (
          <span>Assigned since {formatDate(r.startDate)}</span>
        ) : (
          <div>
            <div>
              {formatDate(r.startDate)} – {r.endDate ? formatDate(r.endDate) : "—"}
            </div>
            <div className="text-xs text-muted-foreground">Now {r.nowWith ? `with ${d.customers.get(r.nowWith) ?? "another customer"}` : "unassigned"}</div>
          </div>
        ),
    },
    { id: "status", header: "Vehicle status", hideOnMobile: true, cell: (r) => <StatusBadge status={r.vehicle.status} /> },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <SearchBar value={q} onChange={setQ} placeholder="Search this customer's vehicles…" className="sm:w-80" />
        <Tabs value={show} onValueChange={(v) => setShow(v as typeof show)}>
          <TabsList>
            <TabsTrigger value="current" className="text-xs">
              Assigned now ({counts.current})
            </TabsTrigger>
            <TabsTrigger value="previous" className="text-xs">
              Previously assigned ({counts.previous})
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => r.vehicle.id}
        initialSort={{ id: "veh", desc: false }}
        pageSize={20}
        emptyMessage={
          query.trim()
            ? `No ${show === "current" ? "vehicle assigned now" : "previously assigned vehicle"} matches “${query.trim()}”.`
            : show === "current"
              ? "No vehicle is assigned to this customer today."
              : "No vehicle was assigned to this customer before."
        }
      />
    </div>
  )
}
