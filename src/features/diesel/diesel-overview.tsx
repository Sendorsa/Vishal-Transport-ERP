"use client"

import { useDeferredValue, useMemo, useState } from "react"
import Link from "next/link"
import { formatDistanceStrict, parseISO } from "date-fns"
import { Bus, Droplet, Droplets, Factory, Flame, MoreVertical, Pencil, Plus, Route, Sigma, Users, Zap, Archive, ArchiveRestore } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FormModal } from "@/components/shared/form-modal"
import { useAdBlueEntries, useArchiveCustomer, useIndustrialSupplies } from "@/lib/api/hooks"
import { activeFleetCount, fleetExpenditure, fuelName, fuelUnit, vehiclesByFuel, withCustomerExpenditure } from "@/domain/expenditure"
import { fuelTheme } from "@/lib/fuel-theme"
import { FuelBadge } from "@/components/shared/fuel-badge"
import { inPeriod } from "@/domain/consumables"
import { buildMaster } from "@/domain/fuel-master"
import { activeVehicleIds, searchVehicles, type VehicleHit } from "@/domain/assignments"
import type { Customer, Vehicle } from "@/lib/types"
import { toast } from "sonner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SearchBar } from "@/components/shared/filter-bar"
import { EmptyState, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { StatsCard } from "@/components/shared/stats-card"
import { StatusBadge } from "@/components/shared/status-badge"
import { asOfMonth, statusOn } from "@/domain/status-history"
import { customerCards, customerSlug, monthLabel, shortMonthLabel, type CustomerCard } from "@/domain/diesel"
import { useCan, useRole } from "@/lib/app-state"
import { inDieselScope } from "@/domain/adblue"
import { cn, matchesSearch } from "@/lib/utils"
import { formatINR, formatNumber, todayISO } from "@/lib/format"
import { AddCustomerDialog } from "./add-customer-dialog"
import { ChangeChip, CompanyLogo, MonthLockControl, MonthSelect, dieselHref, useDieselIndex, useDieselMonth, useDieselMonthOptions } from "./parts"

type SortKey = "spend" | "change" | "name"

const SORTS: Record<SortKey, { label: string; fn: (a: CustomerCard, b: CustomerCard) => number }> = {
  spend: {
    label: "Highest spend",
    fn: (a, b) => b.spend - a.spend || b.prevMonthSpend - a.prevMonthSpend,
  },
  change: {
    label: "Biggest increase",
    fn: (a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity),
  },
  name: {
    label: "A–Z",
    fn: (a, b) => a.group.shortName.localeCompare(b.group.shortName),
  },
}

/** Diesel landing: pick a month, see the summary, open a customer. Navigation first — no analytics charts. */
export function DieselOverview() {
  const can = useCan()
  const [role] = useRole()
  const { ds, idx, isLoading } = useDieselIndex()
  const months = useDieselMonthOptions(idx)
  const [month, setMonth] = useDieselMonth(months)
  const today = todayISO()
  const [sort, setSort] = useState<SortKey>("spend")
  const [q, setQ] = useState("")
  // Vehicle search, separate from the customer search above (each keeps its own text).
  const [vq, setVq] = useState("")
  const vqDeferred = useDeferredValue(vq)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [archiving, setArchiving] = useState<Customer | null>(null)
  const archive = useArchiveCustomer()
  const [showArchived, setShowArchived] = useState(false)

  const o = useMemo(() => (idx && month ? customerCards(idx, month, today) : null), [idx, month, today])
  // Card amounts = the customer's Total Expenditure: vehicle fuel + industrial supplies + AdBlue, the same days for every
  // source (owner, 12 Nov 2026; withCustomerExpenditure). One industrial supplies list and one AdBlue list (Diesel scope:
  // Tata Adblue's granted customers) feed both the summary and the cards — no request per card. Not loaded → the cards and totals say "not available", never a partial figure.
  const supplies = useIndustrialSupplies()
  const adblue = useAdBlueEntries()
  const abScoped = useMemo(() => (ds && adblue.data ? inDieselScope(adblue.data, role === "TATA_ADBLUE" ? ds.customers : null) : null), [ds, adblue.data, role])
  const totalsUnknown = !supplies.data || !abScoped
  const cards = useMemo(() => (o && supplies.data && abScoped ? withCustomerExpenditure(o.cards, { supplies: supplies.data, adblue: abScoped }, o) : (o?.cards ?? [])), [o, supplies.data, abScoped])
  // Diesel + AdBlue month figures from the shared consumables builder (same as the Monthly Master).
  const mm = useMemo(
    () =>
      ds && idx && abScoped && month
        ? buildMaster(
            {
              idx,
              diesel: ds.diesel,
              adblue: abScoped,
              customers: new Map(ds.customers.map((c) => [c.id, c])),
              vendors: new Map(),
            },
            inPeriod(month)
          )
        : null,
    [ds, idx, abScoped, month]
  )

  // The fleet-wide fuel-wise figures for the month: the same fills as the customer cards (every customer the role
  // sees), split by fuel; the fuel types shown = this month's vehicles' (deployed ones while the month is in progress)
  // and the fills'. Total Expenditure = Σ the customer cards; its comparison = Σ their comparisons (same days).
  const fleet = useMemo(
    () => (ds && idx && o ? fleetExpenditure({ idx, fills: ds.diesel, month, cards: abScoped && supplies.data ? cards : o.cards, supplies: supplies.data ?? null, adblue: abScoped }) : null),
    [ds, idx, o, month, supplies.data, abScoped, cards]
  )

  // A tanker's name (JIO, Office, Mini) is its vehicle's only name; vehicle records have no name field.
  const tankerNames = useMemo(() => new Map((ds?.tankers ?? []).flatMap((t) => (t.vehicleId ? [[t.vehicleId, t.name] as const] : []))), [ds])
  const vehicleHits = useMemo(
    () => (ds && idx && month && vqDeferred.trim() ? searchVehicles(vqDeferred, [...idx.vehicles.values()], ds.assignments ?? [], today, asOfMonth(month, today), tankerNames) : []),
    [ds, idx, month, today, vqDeferred, tankerNames]
  )

  const sorted = useMemo(() => {
    if (!o) return []
    // Inactive / archived customers still count in every total; their card shows when they have
    // spend this month or when "Show archived" is on.
    return cards
      .filter((c) => showArchived || !c.group.customer || statusOn(c.group.customer, asOfMonth(month, today)) === "ACTIVE" || c.spend > 0)
      .filter((c) => matchesSearch(q, c.group.name, c.group.shortName, c.group.customer?.code))
      .sort(SORTS[sort].fn)
  }, [o, cards, sort, q, showArchived, month, today])

  if (!can("diesel")) return <NoAccess what="diesel" />
  if (isLoading || !o || supplies.isLoading || adblue.isLoading) return <PageSkeleton />

  const ab = mm?.extras.find((x) => x.key === "adblue")
  // This month's vehicles (the customer cards'), each once, by fuel type.
  const fleetByFuel = vehiclesByFuel([...new Set(o.cards.flatMap((c) => c.vehicleIds))].flatMap((id) => idx?.vehicles.get(id) ?? []))
  const unavailable = "Not available — couldn't be loaded"
  const periodShort = shortMonthLabel(month) + (o.inProgress ? " (to date)" : "")
  const vsLabel = o.inProgress ? `vs 1–${o.day} ${shortMonthLabel(o.prev).split(" ")[0]}` : `vs ${shortMonthLabel(o.prev)}`

  return (
    <div>
      {/* 1. Title + month */}
      <div className="mb-5 space-y-2">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Diesel</h1>
        <div className="flex flex-wrap items-center gap-3">
          <MonthSelect months={months} value={month} onChange={setMonth} prominent />
          <span className="text-sm text-muted-foreground">{o.inProgress ? `Month to date · ${o.day} days` : "Full month"}</span>
        </div>
        <MonthLockControl month={month} />
      </div>

      {/* 2. Fleet-wide fuel-wise summary (owner, 12 Nov 2026; domain/expenditure.ts) — one card per vehicle fuel the fleet
          uses (Diesel / Petrol / EV charging, from this month's vehicles and fills), then AdBlue (in the column of its Cost per KM card) and Industrial Diesel always,
          Total Expenditure last. Every row shares the Expenditure row's columns, so the cards line up whatever the count. */}
      {fleet && (
        <div className="mb-6 space-y-3" style={{ "--kpi-cols": fleet.fuels.length + 3 } as React.CSSProperties}>
          <KpiRow title="Expenditure" cols={fleet.fuels.length + 3}>
            {fleet.fuels.map((f) => (
              <StatsCard
                key={f.fuelType}
                label={f.fuelType === "EV" ? "EV Charging Spending" : `Vehicle ${fuelName(f.fuelType)} Spending`}
                icon={f.fuelType === "EV" ? Zap : Flame}
                className={fuelTheme(f.fuelType).card}
                value={formatINR(f.spend)}
                hint={`${periodShort} · ${f.fills} ${f.fuelType === "EV" ? "charges" : "fills"}`}
                info={`Σ amount (${f.fuelType === "EV" ? "kWh" : "litres"} × each fill's rate; tanker fills at their own rate) of every ${f.fuelType === "EV" ? "EV" : fuelName(f.fuelType).toLowerCase()} vehicle's fills in the month, every customer. A tanker load is the purchase and is never added again.`}
              />
            ))}
            <StatsCard
              label="AdBlue Spending"
              icon={Droplets}
              value={fleet.adblue ? formatINR(fleet.adblue.spend) : "—"}
              hint={fleet.adblue ? `${periodShort} · ${fleet.adblue.entries} entries` : unavailable}
              info="Σ amount of the AdBlue entries in the month: stock draws at the weighted-average cost, direct vendor purchases at their own amount. Bulk purchases are stock, not spending. Never part of Diesel."
            />
            <StatsCard
              label="Industrial Diesel Spending"
              icon={Factory}
              value={fleet.industrial ? formatINR(fleet.industrial.spend) : "—"}
              hint={fleet.industrial ? `${periodShort} · ${fleet.industrial.entries} ${fleet.industrial.entries === 1 ? "supply" : "supplies"}` : unavailable}
              info="Σ amount (litres × each supply's own rate) of the industrial supplies dated in the month, every customer — never a vehicle fill; tanker allocations are not spending."
            />
            <StatsCard
              label="Total Expenditure"
              icon={Sigma}
              value={fleet.total === null ? "—" : formatINR(fleet.total)}
              delta={fleet.total !== null && fleet.compare ? ((fleet.total - fleet.compare) / fleet.compare) * 100 : null}
              invertDelta
              hint={fleet.total === null ? unavailable : `${periodShort} · ${vsLabel}`}
              info={`${[...fleet.fuels.map((f) => `${f.fuelType === "EV" ? "EV Charging" : `Vehicle ${fuelName(f.fuelType)}`} ${formatINR(f.spend)}`), `AdBlue ${fleet.adblue ? formatINR(fleet.adblue.spend) : "—"}`, `Industrial Diesel ${fleet.industrial ? formatINR(fleet.industrial.spend) : "—"}`].join(" + ")}${fleet.total === null ? "" : ` = ${formatINR(fleet.total)}`} — the sum of the customer cards below. Tanker loads and transfers are never expenditure.`}
              prominent
            />
          </KpiRow>
          <KpiRow title="Quantities" cols={fleet.fuels.length + 3}>
            {fleet.fuels.map((f) => (
              <StatsCard
                key={f.fuelType}
                label={f.fuelType === "EV" ? "EV Charging Energy" : `Vehicle ${fuelName(f.fuelType)} Litres`}
                icon={f.fuelType === "EV" ? Zap : Droplet}
                className={fuelTheme(f.fuelType).card}
                value={`${formatNumber(f.qty, 2)} ${fuelUnit(f.fuelType)}`}
                hint={`${periodShort} · avg ${f.avgRate ? formatINR(f.avgRate) : "—"}/${fuelUnit(f.fuelType)}`}
                info={`Σ ${f.fuelType === "EV" ? "kWh" : "litres"} of the same fills${f.fuelType === "EV" ? " — never added to litres" : ""}. Average price = ${formatINR(f.spend)} ÷ ${formatNumber(f.qty, 2)} ${fuelUnit(f.fuelType)}${f.avgRate ? ` = ${formatINR(f.avgRate)} per ${fuelUnit(f.fuelType)}` : ""}.`}
              />
            ))}
            <StatsCard label="AdBlue Litres" icon={Droplets} value={fleet.adblue ? `${formatNumber(fleet.adblue.litres, 2)} L` : "—"} hint={fleet.adblue ? periodShort : unavailable} info="Σ litres of the AdBlue entries in the month — not fuel." />
            <StatsCard label="Industrial Diesel Litres" icon={Factory} value={fleet.industrial ? `${formatNumber(fleet.industrial.litres, 2)} L` : "—"} hint={fleet.industrial ? periodShort : unavailable} info="Σ litres of the industrial supplies dated in the month." />
          </KpiRow>
          <KpiRow title="Cost per KM" cols={fleet.fuels.length + 3}>
            {fleet.fuels.map((f) => (
              <StatsCard
                key={f.fuelType}
                label={f.fuelType === "EV" ? "Average Charging Cost per KM" : `Average ${fuelName(f.fuelType)} Cost per KM`}
                icon={Route}
                className={fuelTheme(f.fuelType).card}
                value={f.costPerKm ? formatINR(f.costPerKm) : "—"}
                hint={f.fuelType === "EV" ? periodShort : `${periodShort} · ${f.kmpl ?? "—"} km/L`}
                info={`${f.costPerKm ? `${formatINR(f.spend)} ÷ ${formatNumber(f.km)} km = ${formatINR(f.costPerKm)} per km.` : "Needs fills with odometer readings this month."}${f.fuelType === "EV" ? "" : ` ${fuelName(f.fuelType)} KM/L = ${formatNumber(f.km)} km ÷ ${formatNumber(f.qty, 2)} L of ${fuelName(f.fuelType).toLowerCase()} fills only — never mixed with another fuel.`}`}
              />
            ))}
            {ab && (
              <StatsCard
                label="Average AdBlue Cost per KM"
                icon={Route}
                value={ab.total.costPerKm ? formatINR(ab.total.costPerKm) : "—"}
                hint={periodShort}
                info={ab.total.costPerKm ? `${formatINR(ab.total.spend)} ÷ ${ab.total.km.toLocaleString("en-IN")} km (current − previous odometer on AdBlue entries) = ${formatINR(ab.total.costPerKm)} per km.` : "Needs AdBlue entries with km this month."}
              />
            )}
          </KpiRow>
          {mm && (
            <KpiRow title="Fleet" cols={fleet.fuels.length + 3}>
              {fleet.fuels.map((f) => (
                <StatsCard
                  key={f.fuelType}
                  label={`${fuelTheme(f.fuelType).label} Vehicles`}
                  icon={f.fuelType === "EV" ? Zap : Bus}
                  className={fuelTheme(f.fuelType).card}
                  value={fleetByFuel[f.fuelType]}
                  hint={`${f.vehicles} fuelled in ${periodShort}`}
                  info={`${fuelTheme(f.fuelType).label} vehicles working for the customers this month (deployed ones while the month is in progress, plus any fuelled); ${f.vehicles} had a ${fuelTheme(f.fuelType).entry}.`}
                />
              ))}
              <StatsCard
                label="Vehicle Count"
                icon={Bus}
                value={idx ? activeFleetCount(idx.vehicles.values()) : "—"}
                hint="Total active vehicles across all fuel types"
                info="Total active vehicles across all fuel types: every distinct vehicle whose status is Active today — Diesel, Petrol and EV, whether or not it was fuelled this month. Archived, inactive and in-workshop vehicles are not counted; a vehicle is counted once."
              />
              <StatsCard
                label="Customer Count"
                icon={Users}
                value={mm.customerCount}
                hint={`Active in ${periodShort} · ${o.cards.length} total`}
                info="Distinct customers with at least one fuel or AdBlue entry costed to them in the selected month."
              />
            </KpiRow>
          )}
        </div>
      )}

      {/* 3. Find a vehicle: its customer today (assignment history), and its diesel entries for the month */}
      <div className="mb-3">
        <SearchBar value={vq} onChange={setVq} placeholder="Search vehicle number or registration…" className="sm:w-96" />
        {vq.trim() && ds && (
          <VehicleResults
            hits={vehicleHits}
            query={vq}
            month={month}
            customers={new Map(ds.customers.map((c) => [c.id, c]))}
            tankerNames={tankerNames}
          />
        )}
      </div>

      {/* 4. Add customer + find */}
      <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          {can("customers", "create") && (
            <Button size="lg" onClick={() => setAdding(true)}>
              <Plus /> Add Customer
            </Button>
          )}
          <SearchBar value={q} onChange={setQ} placeholder="Find a customer…" />
          {/* The Masters are company-wide: not for Tata Adblue, whose access is per customer (owner, 11 Nov 2026). */}
          {role !== "TATA_ADBLUE" && (
            <>
              <Button variant="outline" asChild>
                <Link href="/diesel/monthly-master">Monthly Master</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/diesel/quarterly-master">Quarterly Master</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/diesel/yearly-master">Yearly Master</Link>
              </Button>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={showArchived ? "secondary" : "ghost"} size="sm" onClick={() => setShowArchived((v) => !v)}>
            <Archive /> {showArchived ? "Hide archived" : "Show archived"}
          </Button>
          <Tabs value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <TabsList>
              {(Object.keys(SORTS) as SortKey[]).map((k) => (
                <TabsTrigger key={k} value={k} className="text-xs">
                  {SORTS[k].label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* 5. Customer cards */}
      {o.cards.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No customers yet"
          description={can("customers", "create") ? "Add your first transport customer to start tracking diesel by vehicle." : "There are no customers' Diesel records to show."}
          action={
            can("customers", "create") && (
              <Button onClick={() => setAdding(true)}>
                <Plus /> Add Customer
              </Button>
            )
          }
        />
      ) : sorted.length === 0 ? (
        <EmptyState icon={Users} title={`No customer matches “${q}”`} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {sorted.map((c) => (
            <CustomerDieselCard
              key={c.group.slug}
              card={c}
              overallKnown={!totalsUnknown}
              periodLabel={o.inProgress ? "This month to date" : monthLabel(month)}
              vsLabel={vsLabel}
              prevLabel={shortMonthLabel(o.prev)}
              today={today}
              asOf={asOfMonth(month, today)}
              active={c.group.id && ds ? activeVehicleIds(ds.assignments ?? [], idx!.vehicles, c.group.id, today) : null}
              vehicles={idx?.vehicles}
              onEdit={can("customers", "edit") ? setEditing : undefined}
              onArchive={can("customers", "delete") ? setArchiving : undefined}
              onRestore={
                can("customers", "delete")
                  ? async (cu) => {
                      await archive.mutateAsync({ id: cu.id, version: cu.updatedAt, restore: true })
                      toast.success(`${cu.shortName} restored`)
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}

      <AddCustomerDialog open={adding} onOpenChange={setAdding} />
      {editing && <AddCustomerDialog key={editing.id} open customer={editing} onOpenChange={(v) => !v && setEditing(null)} />}
      {archiving && (
        <FormModal
          open
          onOpenChange={(v) => !v && setArchiving(null)}
          title={`Archive ${archiving.shortName}?`}
          description="This customer has historical records. Archiving will prevent new vehicles and fuel entries while preserving all historical data and report totals."
          submitLabel="Archive Customer"
          destructive
          pending={archive.isPending}
          onSubmit={async () => {
            await archive.mutateAsync({ id: archiving.id, version: archiving.updatedAt })
            toast.success(`${archiving.shortName} archived — history kept`)
            setArchiving(null)
          }}
        >
          <span />
        </FormModal>
      )}
    </div>
  )
}

function CustomerDieselCard({
  card: c,
  overallKnown,
  periodLabel,
  vsLabel,
  prevLabel,
  today,
  asOf,
  active,
  vehicles,
  onEdit,
  onArchive,
  onRestore,
}: {
  onEdit?: (c: Customer) => void
  onArchive?: (c: Customer) => void
  onRestore?: (c: Customer) => void
  /** Spend figures = the customer's Total Expenditure: vehicle fuel + industrial supplies + AdBlue (withCustomerExpenditure). */
  card: CustomerCard
  /** false when the industrial supplies or AdBlue aren't loaded: no total is shown, never a partial figure. */
  overallKnown: boolean
  periodLabel: string
  vsLabel: string
  prevLabel: string
  today: string
  /** Day the selected month is judged on — the badge shows the customer's status then. */
  asOf: string
  /** Vehicles assigned to this customer today with status ACTIVE (assignment system). */
  active: Set<string> | null
  /** Every vehicle the page knows (for the active vehicles' fuel types). */
  vehicles?: Map<string, Vehicle>
}) {
  // Worked this month for the customer but not one of its active vehicles now (transferred / archived / inactive).
  const historical = c.vehicleIds.filter((id) => !active?.has(id)).length
  const fuelMix = active && vehicles ? vehiclesByFuel([...active].flatMap((id) => vehicles.get(id) ?? [])) : null
  const updated = c.group.lastUpdated ? formatDistanceStrict(parseISO(c.group.lastUpdated), parseISO(`${today}T23:59:59`), { addSuffix: true }) : null
  return (
    <div className="group relative">
      <Card size="sm" className="h-full gap-3 px-4 transition-all group-hover:shadow-md group-hover:ring-foreground/20">
        {/* Whole card opens the customer; the ⋮ menu sits above this overlay. */}
        <Link href={dieselHref(c.group.slug)} className="absolute inset-0 z-0 rounded-xl" aria-label={`Open ${c.group.shortName}`} />
        {c.group.customer && (onEdit || onArchive) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2 z-10" aria-label={`Actions for ${c.group.shortName}`}>
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {onEdit && (
                <DropdownMenuItem onSelect={() => onEdit(c.group.customer!)}>
                  <Pencil /> Edit Customer
                </DropdownMenuItem>
              )}
              {c.group.customer.status === "ARCHIVED"
                ? onRestore && (
                    <DropdownMenuItem onSelect={() => onRestore(c.group.customer!)}>
                      <ArchiveRestore /> Restore Customer
                    </DropdownMenuItem>
                  )
                : onArchive && (
                    <DropdownMenuItem variant="destructive" onSelect={() => onArchive(c.group.customer!)}>
                      <Archive /> Archive Customer
                    </DropdownMenuItem>
                  )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="flex items-center gap-3">
          <CompanyLogo group={c.group} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 truncate font-semibold">
              {c.group.shortName}
              {c.group.customer && statusOn(c.group.customer, asOf) !== "ACTIVE" && <StatusBadge status={statusOn(c.group.customer, asOf)} className="h-4.5 px-1.5 text-[10px]" />}
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Bus className="size-3" /> Active Vehicles: {active?.size ?? 0}
              {historical > 0 && <span className="text-muted-foreground/80">· {historical} historical</span>}
            </div>
            {/* Fuel mix of the active vehicles — shown when any isn't Diesel (a Diesel-only card keeps its look). */}
            {fuelMix && (fuelMix.PETROL > 0 || fuelMix.EV > 0) && (
              <div className="mt-1 flex flex-wrap gap-1">
                {(["DIESEL", "PETROL", "EV"] as const).map((f) => fuelMix[f] > 0 && <FuelBadge key={f} fuel={f} count={fuelMix[f]} className="h-4.5 px-1.5 text-[10px]" />)}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-end justify-between gap-2">
          <div>
            <div className="num text-2xl font-semibold tracking-tight">{overallKnown ? formatINR(c.spend) : "—"}</div>
            <div className="text-xs text-muted-foreground">{periodLabel}</div>
            <div className="text-[11px] text-muted-foreground">{overallKnown ? "Total Expenditure · fuel, industrial, AdBlue" : "Not available — couldn't be loaded"}</div>
          </div>
          <div className="text-right">
            <ChangeChip pct={overallKnown ? c.changePct : null} />
            <div className="mt-0.5 text-[11px] text-muted-foreground">{vsLabel}</div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
          <span className="num">
            {prevLabel} {overallKnown ? formatINR(c.prevMonthSpend) : "—"}
          </span>
          <span>{updated ? `Updated ${updated}` : "No fills yet"}</span>
        </div>
      </Card>
    </div>
  )
}

function KpiRow({ title, cols = 3, children }: { title: string; cols?: number; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 lg:grid-cols-[96px_minmax(0,1fr)] lg:items-center">
      <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>
      {/* Columns = the Expenditure row's card count (--kpi-cols, set on the summary), so every row lines up; up to four
          from lg, five or six only from xl (narrower would cut exact ₹ figures). */}
      <div className={cn("grid grid-cols-2 gap-3 md:grid-cols-3", cols <= 4 ? "lg:grid-cols-[repeat(var(--kpi-cols,3),minmax(0,1fr))]" : "xl:grid-cols-[repeat(var(--kpi-cols,3),minmax(0,1fr))]")}>{children}</div>
    </div>
  )
}

/** Matching vehicles, each once: registration, name, today's customer and — when different — the selected month's. */
function VehicleResults({ hits, query, month, customers, tankerNames }: { hits: VehicleHit[]; query: string; month: string; customers: Map<string, Customer>; tankerNames: Map<string, string> }) {
  const SHOWN = 25
  const name = (id: string | null) => (id ? (customers.get(id)?.name ?? "Unknown customer") : "Unassigned")
  if (!hits.length) return <EmptyState icon={Bus} title={`No vehicle matches “${query.trim()}”`} description="Check the registration number, or clear the search." className="mt-2 py-6" />
  return (
    <Card className="mt-2 gap-0 py-0">
      <ul className="divide-y">
        {hits.slice(0, SHOWN).map(({ vehicle: v, currentCustomerId, customerIdAsOf }) => {
          const target = customerIdAsOf ?? currentCustomerId
          const customer = target ? customers.get(target) : undefined
          return (
            <li key={v.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2.5 text-sm">
              <div className="min-w-44">
                <div className="flex items-center gap-1.5 font-mono font-medium">
                  {v.regNo}
                  <FuelBadge fuel={v.fuelType} className="font-sans" />
                  {v.status !== "ACTIVE" && <StatusBadge status={v.status} />}
                </div>
                <div className="text-xs text-muted-foreground">{[tankerNames.get(v.id), [v.make, v.model].filter(Boolean).join(" "), v.typeCode].filter(Boolean).join(" · ")}</div>
              </div>
              <div className="min-w-0 flex-1">
                <div className={currentCustomerId ? "font-medium" : "text-muted-foreground"}>{name(currentCustomerId)}</div>
                <div className="text-xs text-muted-foreground">
                  {customerIdAsOf !== currentCustomerId ? `In ${shortMonthLabel(month)}: ${name(customerIdAsOf)}` : "Customer today"}
                </div>
              </div>
              {customer && (
                <Button variant="outline" size="sm" asChild>
                  <Link href={dieselHref(customerSlug(customer), month, v.regNo)}>Diesel entries · {shortMonthLabel(month)}</Link>
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {hits.length > SHOWN && <p className="border-t px-4 py-2 text-xs text-muted-foreground">{hits.length - SHOWN} more — type more of the number to narrow the list.</p>}
    </Card>
  )
}
