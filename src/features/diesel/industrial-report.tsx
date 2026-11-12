"use client"

import { Factory, Fuel, Hash, IndianRupee, Scale } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { EmptyState } from "@/components/shared/misc"
import { StatsCard } from "@/components/shared/stats-card"
import type { buildDieselIndex } from "@/domain/diesel"
import { industrialReport } from "@/domain/industrial"
import { tankerLabel } from "@/domain/tanker"
import { useCustomers, useIndustrialSupplies, useTankers } from "@/lib/api/hooks"
import { formatINR, formatNumber } from "@/lib/format"
import { usePeriod } from "./period"

const L = (n: number) => `${formatNumber(n, 3)} L`

/**
 * Industrial Diesel · company-wide (owner, 12 Nov 2026): diesel supplied to customers for industrial use, out of the
 * tankers — its own section, never mixed into vehicle Diesel (no KM, mileage, efficiency or vehicle figure). Totals,
 * customer-wise and tanker-wise for the supplies dated in the period (`match`). Used by the Masters and the Diesel page.
 */
export function IndustrialReport({ match, period, control, actions }: { match: (e: { date: string; customerId: string }) => boolean; period: string; control?: React.ReactNode; actions?: React.ReactNode }) {
  const supplies = useIndustrialSupplies()
  const customers = useCustomers()
  const tankers = useTankers()
  const r = industrialReport((supplies.data ?? []).filter(match))
  const customerName = (id: string) => {
    const c = customers.data?.find((x) => x.id === id)
    return c ? c.shortName || c.name : "Unknown customer"
  }
  const tankerName = (id: string) => {
    const t = tankers.data?.find((x) => x.id === id)
    return t ? tankerLabel(t) : "Unknown tanker"
  }
  const byCustomer = [...r.byCustomer].sort((a, b) => customerName(a.customerId).localeCompare(customerName(b.customerId)))
  const byTanker = [...r.byTanker].sort((a, b) => tankerName(a.tankerId).localeCompare(tankerName(b.tankerId)))

  return (
    <section className="space-y-3 border-t pt-5">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Factory className="size-4 text-muted-foreground" /> Industrial Diesel · {period}
        </h2>
        <p className="text-xs text-muted-foreground">Diesel supplied to customers for industrial use, out of the tankers. Separate from vehicle Diesel — no KM Run, mileage or vehicle figures.</p>
      </div>
      {(control || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">{control}</div>
          {actions}
        </div>
      )}
      {supplies.error ? (
        <EmptyState icon={Factory} title="Industrial supplies couldn't be loaded" description={supplies.error instanceof Error ? supplies.error.message : "Try again in a moment."} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatsCard label="Industrial Diesel Supplied" icon={Fuel} value={L(r.totals.litres)} hint={period} isLoading={supplies.isLoading} info="Σ litres of every customer's industrial supplies dated in the period. Not part of vehicle Diesel litres." />
            <StatsCard label="Industrial Supply Value" icon={IndianRupee} value={formatINR(r.totals.value)} hint={period} isLoading={supplies.isLoading} info="Σ amount (litres × each supply's own rate) of the industrial supplies dated in the period." />
            <StatsCard label="Industrial Supply Entries" icon={Hash} value={r.totals.count} hint={period} isLoading={supplies.isLoading} info="Number of industrial supplies dated in the period." />
            <StatsCard
              label="Weighted Average Supply Rate"
              icon={Scale}
              value={r.totals.avgRate === null ? "—" : `${formatINR(r.totals.avgRate)} / L`}
              hint={period}
              isLoading={supplies.isLoading}
              info={r.totals.avgRate === null ? "Industrial Supply Value ÷ Industrial Diesel Supplied — no supplies in the period." : `Industrial Supply Value ÷ Industrial Diesel Supplied = ${formatINR(r.totals.value)} ÷ ${L(r.totals.litres)}.`}
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Customer-wise</h3>
              <DataTable
                data={byCustomer}
                getRowId={(x) => x.customerId}
                isLoading={supplies.isLoading}
                dense
                showFooter
                pageSize={50}
                emptyMessage="No industrial supplies in the period."
                columns={[
                  { id: "c", header: "Customer", sortValue: (x) => customerName(x.customerId), cell: (x) => <span className="font-medium">{customerName(x.customerId)}</span>, footer: "Total" },
                  { id: "n", header: "Entries", align: "right", sortValue: (x) => x.count, cell: (x) => <span className="num">{x.count}</span>, footer: <span className="num">{r.totals.count}</span> },
                  { id: "l", header: "Litres", align: "right", sortValue: (x) => x.litres, cell: (x) => <span className="num">{formatNumber(x.litres, 3)}</span>, footer: <span className="num">{formatNumber(r.totals.litres, 3)}</span> },
                  { id: "v", header: "Value", align: "right", sortValue: (x) => x.value, cell: (x) => <span className="num">{formatINR(x.value)}</span>, footer: <span className="num">{formatINR(r.totals.value)}</span> },
                  { id: "r", header: "Avg ₹ / L", align: "right", hideOnMobile: true, cell: (x) => <span className="num">{x.avgRate === null ? "—" : formatINR(x.avgRate)}</span>, footer: <span className="num">{r.totals.avgRate === null ? "—" : formatINR(r.totals.avgRate)}</span> },
                ]}
              />
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tanker-wise</h3>
              <DataTable
                data={byTanker}
                getRowId={(x) => x.tankerId}
                isLoading={supplies.isLoading}
                dense
                showFooter
                pageSize={50}
                emptyMessage="No industrial diesel left the tankers in the period."
                columns={[
                  { id: "t", header: "Tanker", sortValue: (x) => tankerName(x.tankerId), cell: (x) => <span className="font-medium">{tankerName(x.tankerId)}</span>, footer: "Total" },
                  { id: "l", header: "Industrial Diesel supplied (L)", align: "right", sortValue: (x) => x.litres, cell: (x) => <span className="num">{formatNumber(x.litres, 3)}</span>, footer: <span className="num">{formatNumber(r.totals.litres, 3)}</span> },
                ]}
              />
            </div>
          </div>
        </>
      )}
    </section>
  )
}

/** The Diesel page's Industrial Diesel report: Monthly / Quarterly / Yearly / Financial Year / All Time (the shared period filter). */
export function IndustrialDieselSummary({ idx }: { idx: ReturnType<typeof buildDieselIndex> | null }) {
  const period = usePeriod(idx)
  return <IndustrialReport match={period.match} period={period.label} control={period.control} />
}
