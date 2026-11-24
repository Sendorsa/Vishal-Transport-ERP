"use client"

import { useState } from "react"
import Link from "next/link"
import { CircleDot } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/shared/data-table"
import { SearchBar } from "@/components/shared/filter-bar"
import { EmptyState, PageSkeleton } from "@/components/shared/misc"
import { StatsCard } from "@/components/shared/stats-card"
import { filteredLines, kmRun, NO_FILTERS, sheetTotals, vehicleOutstanding } from "@/domain/tyre"
import { useCan } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber } from "@/lib/format"
import { OfficeBadge } from "@/features/tyre/tyre-register"
import { useTyreData } from "@/features/tyre/tyre-data"

const km = (n: number | null) => (n === null ? "—" : formatNumber(n))

/**
 * Vehicle page → Tyres (owner, 21 Nov 2026): this vehicle's tyre / repair invoice lines, all dates, from the Tyre module
 * itself (useTyreData, filteredLines with vehicleId) — a view, nothing stored. Each line's tyre number (fitted) and
 * removing number (taken off) are the register's own replacement record; invoices are added and changed on /tyre.
 */
export function VehicleTyres({ vehicleId }: { vehicleId: string }) {
  const can = useCan()
  const d = useTyreData()
  const [search, setSearch] = useState("")
  if (!d.ready) return <PageSkeleton />

  const all = filteredLines(d.views, { ...NO_FILTERS, vehicleId })
  const rows = search ? filteredLines(d.views, { ...NO_FILTERS, vehicleId, search }) : all
  const t = sheetTotals(all)
  const outstanding = vehicleOutstanding(d.views, d.payments, vehicleId) // the same figure as the page's Dues button

  if (!all.length)
    return (
      <EmptyState
        icon={CircleDot}
        title="No tyre records for this vehicle"
        description="Tyre and repair invoices recorded for this vehicle in Tyre Data appear here."
        action={
          can("tyres") && (
            <Button asChild variant="outline">
              <Link href="/tyre">Open Tyre</Link>
            </Button>
          )
        }
      />
    )

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <StatsCard label="Tyre & repair spend (all dates)" value={formatINR(t.grandTotal)} hint={`Σ this vehicle's tyre invoices incl. GST · ${t.invoices} invoice${t.invoices === 1 ? "" : "s"}, ${all.length} line${all.length === 1 ? "" : "s"}`} />
        <StatsCard label="Outstanding to tyre vendors" value={formatINR(outstanding)} hint="This vehicle's invoices − payments allocated to them, today" tone={outstanding > 0 ? "warning" : "default"} />
      </div>
      <SearchBar value={search} onChange={setSearch} placeholder="Search tyre no., removed no., bill no., supplier…" />
      <DataTable
        data={rows}
        getRowId={(r) => r.item.id}
        rowHref={(r) => `/tyre/${r.invoice.id}`}
        initialSort={{ id: "date", desc: true }}
        pageSize={15}
        emptyMessage="No repair line matches the search."
        mobileColumns={["date", "repair", "tyre", "total"]}
        columns={[
          {
            id: "date",
            header: "Date · Bill",
            sortValue: (r) => r.invoice.date,
            cell: (r) => (
              <div>
                <div className="num">{formatDate(r.invoice.date)}</div>
                <div className="text-xs text-muted-foreground">{r.invoice.billNo ? `Bill ${r.invoice.billNo}` : "No bill no."}</div>
              </div>
            ),
          },
          {
            id: "repair",
            header: "Repair / Service",
            sortValue: (r) => d.name(r.item.repairTypeId),
            cell: (r) => (
              <div className="min-w-32">
                <div className="font-medium">{d.name(r.item.repairTypeId)}</div>
                <div className="text-xs text-muted-foreground">{[d.name(r.item.brandId), d.name(r.item.sizeId)].filter(Boolean).join(" · ")}</div>
              </div>
            ),
          },
          {
            id: "tyre",
            header: "Tyre fitted / removed",
            sortValue: (r) => r.item.tyreNumber,
            cell: (r) =>
              r.item.tyreNumber || r.item.removingNumber ? (
                <div className="num text-xs">
                  {r.item.tyreNumber && <div>Tyre {r.item.tyreNumber}</div>}
                  {r.item.removingNumber && <div className="text-muted-foreground">Removed {r.item.removingNumber}</div>}
                </div>
              ) : (
                "—"
              ),
          },
          {
            id: "km",
            header: "KM",
            hideOnMobile: true,
            cell: (r) =>
              r.item.openingKm === null && r.item.closingKm === null ? (
                "—"
              ) : (
                <div className="num text-xs">
                  {km(r.item.openingKm)} → {km(r.item.closingKm)}
                  {kmRun(r.item) !== null && <div className="text-muted-foreground">run {formatNumber(kmRun(r.item)!)}</div>}
                </div>
              ),
          },
          { id: "supplier", header: "Supplier", hideOnMobile: true, sortValue: (r) => r.invoice.supplier, cell: (r) => r.invoice.supplier },
          { id: "company", header: "Company", hideOnMobile: true, sortValue: (r) => r.invoice.company, cell: (r) => (r.invoice.office ? <OfficeBadge className="h-auto whitespace-normal" /> : r.invoice.company) },
          { id: "total", header: "Total", align: "right", sortValue: (r) => r.item.totalValue, cell: (r) => <span className="num font-medium">{formatINR(r.item.totalValue)}</span> },
        ]}
      />
    </div>
  )
}
