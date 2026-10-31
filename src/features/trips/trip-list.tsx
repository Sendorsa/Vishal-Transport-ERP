"use client"

import { EditedBadge } from "@/components/shared/audit"
import { useMemo, useState } from "react"
import Link from "next/link"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, type Column } from "@/components/shared/data-table"
import { ALL, FilterBar, FilterSelect, SearchBar } from "@/components/shared/filter-bar"
import { Money, NoAccess, PeriodSelect } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { StatsCard } from "@/components/shared/stats-card"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { inRange, rangeForPreset, type PeriodPreset } from "@/domain/periods"
import { useDataset } from "@/lib/api/hooks"
import { useCan, useCompanyScope } from "@/lib/app-state"
import { formatINR, formatDate, formatNumber } from "@/lib/format"
import type { Trip } from "@/lib/types"

export const tripDisplayStatus = (t: Trip) => (t.status === "COMPLETED" ? (t.invoiceId ? "INVOICED" : "UNBILLED") : t.status)

export function TripList() {
  const can = useCan()
  const [scope] = useCompanyScope()
  const finance = can("finance", "view")
  const { data: ds, isLoading } = useDataset()
  const [period, setPeriod] = useState<PeriodPreset>("this_month")
  const [q, setQ] = useState("")
  const [customer, setCustomer] = useState(ALL)
  const [vehicle, setVehicle] = useState(ALL)
  const [status, setStatus] = useState(ALL)

  const maps = useMemo(
    () => ({
      customer: new Map((ds?.customers ?? []).map((c) => [c.id, c])),
      vehicle: new Map((ds?.vehicles ?? []).map((v) => [v.id, v])),
      driver: new Map((ds?.drivers ?? []).map((d) => [d.id, d])),
    }),
    [ds]
  )

  const filtered = useMemo(() => {
    if (!ds) return undefined
    const range = rangeForPreset(period)
    const needle = q.trim().toLowerCase()
    return ds.trips.filter((t) => {
      if (!inRange(t.date, range)) return false
      if (customer !== ALL && t.customerId !== customer) return false
      if (vehicle !== ALL && t.vehicleId !== vehicle) return false
      if (status !== ALL && tripDisplayStatus(t) !== status) return false
      if (!needle) return true
      return [t.tripNo, t.route, maps.vehicle.get(t.vehicleId)?.regNo ?? "", maps.driver.get(t.driverId ?? "")?.name ?? ""].some((f) =>
        f.toLowerCase().includes(needle)
      )
    })
  }, [ds, period, q, customer, vehicle, status, maps])

  const totals = useMemo(() => {
    const done = (filtered ?? []).filter((t) => t.status === "COMPLETED")
    return {
      trips: done.length,
      km: done.reduce((s, t) => s + t.distanceKm, 0),
      revenue: done.reduce((s, t) => s + t.revenue, 0),
      unbilled: done.filter((t) => !t.invoiceId).reduce((s, t) => s + t.revenue, 0),
      planned: (filtered ?? []).filter((t) => t.status === "PLANNED").length,
    }
  }, [filtered])

  if (!can("trips")) return <NoAccess what="trips" />

  const columns: Column<Trip>[] = [
    { id: "date", header: "Date", sortValue: (t) => t.date + t.tripNo, cell: (t) => (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="num">{formatDate(t.date)}</span>
                    <EditedBadge id={t.id} />
                  </span>
                ) },
    {
      id: "no",
      header: "Trip",
      sortValue: (t) => t.tripNo,
      hideOnMobile: true,
      cell: (t) => (
        <span className="flex items-center gap-1.5">
          <span className="font-medium">{t.tripNo}</span>
          {scope === "GROUP" && <CompanyBadge code={t.companyCode} />}
        </span>
      ),
    },
    { id: "customer", header: "Customer", sortValue: (t) => maps.customer.get(t.customerId)?.name ?? "", cell: (t) => maps.customer.get(t.customerId)?.name },
    { id: "vehicle", header: "Vehicle", sortValue: (t) => maps.vehicle.get(t.vehicleId)?.regNo ?? "", cell: (t) => maps.vehicle.get(t.vehicleId)?.regNo },
    { id: "driver", header: "Driver", hideOnMobile: true, cell: (t) => <span className="text-muted-foreground">{t.driverId ? maps.driver.get(t.driverId)?.name : "Owner-driven"}</span> },
    { id: "route", header: "Route", hideOnMobile: true, cell: (t) => <span className="block max-w-56 truncate text-muted-foreground">{t.route}</span> },
    { id: "km", header: "Km", align: "right", sortValue: (t) => t.distanceKm, cell: (t) => formatNumber(t.distanceKm) },
    ...(finance ? ([{ id: "revenue", header: "Revenue", align: "right", sortValue: (t) => t.revenue, cell: (t) => <Money value={t.revenue} /> }] satisfies Column<Trip>[]) : []),
    { id: "status", header: "Status", cell: (t) => <StatusBadge status={tripDisplayStatus(t)} /> },
  ]

  const canReset = q !== "" || customer !== ALL || vehicle !== ALL || status !== ALL
  const customerOptions = (ds?.customers ?? []).map((c) => ({ value: c.id, label: c.name })).sort((a, b) => a.label.localeCompare(b.label))
  const vehicleOptions = (ds?.vehicles ?? [])
    .filter((v) => customer === ALL || v.assignedCustomerId === customer)
    .map((v) => ({ value: v.id, label: v.regNo }))
    .sort((a, b) => a.label.localeCompare(b.label))

  return (
    <div>
      <PageHeader
        title="Trips"
        description="Daily duties and trips — the source of all transport revenue."
        actions={
          <>
            <PeriodSelect value={period} onChange={setPeriod} />
            {can("trips", "create") && (
              <Button asChild>
                <Link href="/trips/new">
                  <Plus /> New trip
                </Link>
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatsCard label="Completed trips" value={formatNumber(totals.trips)} hint={`${totals.planned} planned`} isLoading={isLoading} />
        <StatsCard label="Distance" value={`${formatNumber(totals.km)} km`} hint={totals.trips ? `${formatNumber(totals.km / totals.trips)} km / trip` : undefined} isLoading={isLoading} />
        {finance && <StatsCard label="Revenue" value={formatINR(totals.revenue)} hint="Ex-GST" isLoading={isLoading} />}
        {finance && <StatsCard label="Unbilled" value={formatINR(totals.unbilled)} hint="Completed, not invoiced" tone={totals.unbilled > 0 ? "warning" : "default"} href="/invoices/new" isLoading={isLoading} />}
      </div>
      <FilterBar
        canReset={canReset}
        onReset={() => {
          setQ("")
          setCustomer(ALL)
          setVehicle(ALL)
          setStatus(ALL)
        }}
        right={filtered && `${formatNumber(filtered.length)} trips`}
      >
        <SearchBar value={q} onChange={setQ} placeholder="Trip no, route, vehicle, driver…" />
        <FilterSelect value={customer} onChange={(v) => { setCustomer(v); setVehicle(ALL) }} placeholder="Customers" options={customerOptions} />
        <FilterSelect value={vehicle} onChange={setVehicle} placeholder="Vehicles" options={vehicleOptions} />
        <FilterSelect
          value={status}
          onChange={setStatus}
          placeholder="Statuses"
          options={[
            { value: "PLANNED", label: "Planned" },
            { value: "UNBILLED", label: "Completed · unbilled" },
            { value: "INVOICED", label: "Completed · invoiced" },
            { value: "CANCELLED", label: "Cancelled" },
          ]}
        />
      </FilterBar>
      <DataTable
        columns={columns}
        data={filtered}
        isLoading={isLoading}
        getRowId={(t) => t.id}
        rowHref={(t) => `/trips/${t.id}`}
        initialSort={{ id: "date", desc: true }}
        pageSize={50}
        dense
        emptyMessage="No trips in this period."
      />
    </div>
  )
}
