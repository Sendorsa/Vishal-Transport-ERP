"use client"

/**
 * Fuel by type (owner, 12 Nov 2026): one row per fuel type — Diesel, Petrol, EV — each with its own figures from its
 * own fills only (fuelWise in domain/expenditure.ts) and its own colour (lib/fuel-theme.ts). Litres of different fuels
 * and KM/L are never combined; only money is (Combined Fuel Expenditure). Used by the Overview page (/dashboard), the
 * customer page's Vehicles view and the Monthly / Quarterly / Yearly Masters (as a table).
 */
import { Bus, Droplet, Gauge, IndianRupee, Route, Sigma, Zap } from "lucide-react"
import { StatsCard } from "@/components/shared/stats-card"
import { DataTable } from "@/components/shared/data-table"
import { FuelBadge } from "@/components/shared/fuel-badge"
import { fuelName, type FuelTotals } from "@/domain/expenditure"
import { fuelTheme } from "@/lib/fuel-theme"
import { formatINR, formatNumber, round2 } from "@/lib/format"
import type { FuelType } from "@/lib/types"
import { cn } from "@/lib/utils"

const unitOf = (f: FuelType) => fuelTheme(f).unit

/** Card rows, one per fuel type. `vehicles` = the fleet's vehicles of each fuel (shown as "{Fuel} Vehicles"). */
export function FuelTypeRows({
  fuels,
  period,
  vehicles,
  combined = true,
  previous,
  vsLabel,
}: {
  fuels: FuelTotals[]
  period: string
  vehicles?: Record<FuelType, number>
  combined?: boolean
  /** The comparison period's figures (same fuels): each fuel's expenditure shows its change. */
  previous?: FuelTotals[]
  vsLabel?: string
}) {
  if (!fuels.length) return null
  const total = round2(fuels.reduce((t, f) => t + f.spend, 0))
  return (
    <div className="space-y-3">
      {fuels.map((f) => {
        const t = fuelTheme(f.fuelType)
        const u = unitOf(f.fuelType)
        const name = f.fuelType === "EV" ? "Charging" : t.label
        return (
          <div key={f.fuelType} className="grid gap-2 lg:grid-cols-[96px_minmax(0,1fr)] lg:items-center">
            <div className={cn("flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase", t.heading)}>
              <span className={cn("size-2 rounded-full", t.dot)} aria-hidden />
              {t.label}
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <StatsCard
                label={`${t.label} Expenditure`}
                icon={IndianRupee}
                className={t.card}
                value={formatINR(f.spend)}
                delta={(() => {
                  const p = previous?.find((x) => x.fuelType === f.fuelType)?.spend
                  return p ? ((f.spend - p) / p) * 100 : null
                })()}
                invertDelta
                hint={`${period} · ${vsLabel ?? `${f.fills} ${f.fuelType === "EV" ? "charges" : "fills"}`}`} info={`Σ amount (${u === "kWh" ? "kWh" : "litres"} × each fill's rate; tanker fills at their own rate) of the ${t.label} vehicles' fills in the period.`} />
              <StatsCard label={f.fuelType === "EV" ? "Energy Charged" : `${t.label} Litres`} icon={f.fuelType === "EV" ? Zap : Droplet} className={t.card} value={`${formatNumber(f.qty, 2)} ${u}`} hint={period} info={`Σ ${u === "kWh" ? "kWh" : "litres"} of the same fills — never added to another fuel's.`} />
              <StatsCard label={`Average ${t.label} Price per ${u === "kWh" ? "kWh" : "Litre"}`} icon={IndianRupee} className={t.card} value={f.avgRate ? formatINR(f.avgRate) : "—"} hint={period} info={f.avgRate ? `${formatINR(f.spend)} ÷ ${formatNumber(f.qty, 2)} ${u} = ${formatINR(f.avgRate)} per ${u}.` : "Needs fills in the period."} />
              {f.fuelType !== "EV" && (
                <StatsCard label={`${t.label} KM/L`} icon={Gauge} className={t.card} value={f.kmpl ?? "—"} hint={`${period} · ${formatNumber(f.km)} km`} info={f.kmpl ? `${formatNumber(f.km)} km ÷ ${formatNumber(f.qty, 2)} L of ${t.label.toLowerCase()} fills only = ${f.kmpl} km per litre.` : "Needs fills with odometer readings."} />
              )}
              <StatsCard label={`Average ${name} Cost per KM`} icon={Route} className={t.card} value={f.costPerKm ? formatINR(f.costPerKm) : "—"} hint={period} info={f.costPerKm ? `${formatINR(f.spend)} ÷ ${formatNumber(f.km)} km = ${formatINR(f.costPerKm)} per km.` : "Needs fills with odometer readings."} />
              <StatsCard label={`${t.label} Vehicles`} icon={f.fuelType === "EV" ? Zap : Bus} className={t.card} value={vehicles ? vehicles[f.fuelType] : f.vehicles} hint={`${f.vehicles} fuelled in ${period}`} info={vehicles ? `${t.label} vehicles in the fleet; ${f.vehicles} had a ${t.entry} in the period.` : `Distinct ${t.label} vehicles with a ${t.entry} in the period.`} />
            </div>
          </div>
        )
      })}
      {combined && fuels.length > 1 && (
        <div className="grid gap-2 lg:grid-cols-[96px_minmax(0,1fr)] lg:items-center">
          <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Combined</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatsCard
              label="Combined Fuel Expenditure"
              icon={Sigma}
              prominent
              value={formatINR(total)}
              hint={`${period} · ${fuels.map((f) => fuelTheme(f.fuelType).label).join(" + ")}`}
              info={`${fuels.map((f) => `${fuelName(f.fuelType)} ${formatINR(f.spend)}`).join(" + ")} = ${formatINR(total)}. Money only — litres, kWh and KM/L stay per fuel.`}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** The same figures as a table (the Masters): one row per fuel type, plus the combined expenditure. */
export function FuelTypeTable({ fuels }: { fuels: FuelTotals[] }) {
  const total = round2(fuels.reduce((t, f) => t + f.spend, 0))
  return (
    <DataTable
      data={fuels}
      getRowId={(f) => f.fuelType}
      showFooter
      emptyMessage="No fuel fills in this period"
      columns={[
        { id: "fuel", header: "Fuel type", cell: (f) => <FuelBadge fuel={f.fuelType} />, footer: "Combined" },
        { id: "vehicles", header: "Vehicles", align: "right", cell: (f) => f.vehicles },
        { id: "fills", header: "Fills", align: "right", cell: (f) => f.fills },
        { id: "qty", header: "Quantity", align: "right", cell: (f) => `${formatNumber(f.qty, 2)} ${unitOf(f.fuelType)}`, footer: "— (per fuel)" },
        { id: "spend", header: "Expenditure", align: "right", cell: (f) => formatINR(f.spend), footer: formatINR(total) },
        { id: "rate", header: "Average price", align: "right", cell: (f) => (f.avgRate ? `${formatINR(f.avgRate)} / ${unitOf(f.fuelType)}` : "—") },
        { id: "km", header: "KM Run", align: "right", hideOnMobile: true, cell: (f) => formatNumber(f.km) },
        { id: "kmpl", header: "KM/L", align: "right", cell: (f) => (f.fuelType === "EV" ? "—" : (f.kmpl ?? "—")) },
        { id: "cpk", header: "Cost per KM", align: "right", hideOnMobile: true, cell: (f) => (f.costPerKm ? formatINR(f.costPerKm) : "—") },
      ]}
    />
  )
}
