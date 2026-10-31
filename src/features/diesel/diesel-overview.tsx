"use client"

import { useDeferredValue, useMemo, useState } from "react"
import Link from "next/link"
import { formatDistanceStrict, parseISO } from "date-fns"
import { Bus, Droplet, Droplets, Flame, IndianRupee, MoreVertical, Pencil, Plus, Route, Sigma, Users, Archive, ArchiveRestore } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FormModal } from "@/components/shared/form-modal"
import { useAdBlueEntries, useArchiveCustomer } from "@/lib/api/hooks"
import { inPeriod } from "@/domain/consumables"
import { buildMaster } from "@/domain/fuel-master"
import { activeVehicleIds, searchVehicles, type VehicleHit } from "@/domain/assignments"
import type { Customer } from "@/lib/types"
import { toast } from "sonner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SearchBar } from "@/components/shared/filter-bar"
import { EmptyState, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { StatsCard } from "@/components/shared/stats-card"
import { StatusBadge } from "@/components/shared/status-badge"
import { asOfMonth, statusOn } from "@/domain/status-history"
import { customerCards, customerSlug, monthLabel, shortMonthLabel, type CustomerCard } from "@/domain/diesel"
import { useCan } from "@/lib/app-state"
import { matchesSearch } from "@/lib/utils"
import { formatINR, formatNumber, todayISO } from "@/lib/format"
import { AddCustomerDialog } from "./add-customer-dialog"
import { ChangeChip, CompanyLogo, MonthLockControl, MonthSelect, dieselHref, kpiExplain, useDieselIndex, useDieselMonth, useDieselMonthOptions } from "./parts"

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
  const adblue = useAdBlueEntries()
  // Diesel + AdBlue month figures from the shared consumables builder (same as the Monthly Master).
  const mm = useMemo(
    () =>
      ds && idx && adblue.data && month
        ? buildMaster(
            {
              idx,
              diesel: ds.diesel,
              adblue: adblue.data,
              customers: new Map(ds.customers.map((c) => [c.id, c])),
              vendors: new Map(),
            },
            inPeriod(month)
          )
        : null,
    [ds, idx, adblue.data, month]
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
    return o.cards
      .filter((c) => showArchived || !c.group.customer || statusOn(c.group.customer, asOfMonth(month, today)) === "ACTIVE" || c.spend > 0)
      .filter((c) => matchesSearch(q, c.group.name, c.group.shortName, c.group.customer?.code))
      .sort(SORTS[sort].fn)
  }, [o, sort, q, showArchived, month, today])

  if (!can("diesel")) return <NoAccess what="diesel" />
  if (isLoading || !o) return <PageSkeleton />

  const why = mm ? kpiExplain(mm.totals) : null
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

      {/* 2. Summary — Diesel and AdBlue separate, plus their Running Fluid total; each KPI names its period and formula */}
      {mm && (
        <div className="mb-6 space-y-3">
          <KpiRow title="Diesel">
            <StatsCard
              label="Diesel Spend"
              icon={Flame}
              value={formatINR(o.total)}
              delta={o.compareTotal ? ((o.total - o.compareTotal) / o.compareTotal) * 100 : null}
              invertDelta
              hint={`${periodShort} · ${vsLabel}`}
              info="Sum of all diesel fills (litres × rate) costed to any customer in the selected month."
            />
            <StatsCard label="Total Diesel Litres" icon={Droplet} value={`${formatNumber(mm.totals.litres)} L`} hint={`${periodShort} · ${mm.totals.fills} fills`} info={why!.litres} />
            <StatsCard label="Average Diesel Cost per KM" icon={Route} value={mm.totals.costPerKm ? formatINR(mm.totals.costPerKm) : "—"} hint={periodShort} info={why!.costPerKm} />
          </KpiRow>
          {mm.extras.map((x) => (
            <KpiRow key={x.key} title={x.label}>
              <StatsCard
                label={`${x.label} Spend`}
                icon={IndianRupee}
                value={formatINR(x.total.spend)}
                hint={`${periodShort} · ${x.total.entries} entries`}
                info={`Σ amount of ${x.label} entries in the selected month — not added to diesel spend.`}
              />
              <StatsCard
                label={`Total ${x.label} Litres`}
                icon={Droplets}
                value={`${formatNumber(x.total.qty, 2)} ${x.unit}`}
                hint={periodShort}
                info={`Σ ${x.label} quantity in the selected month.`}
              />
              <StatsCard
                label={`Average ${x.label} Cost per KM`}
                icon={Route}
                value={x.total.costPerKm ? formatINR(x.total.costPerKm) : "—"}
                hint={periodShort}
                info={
                  x.total.costPerKm
                    ? `${formatINR(x.total.spend)} ÷ ${x.total.km.toLocaleString("en-IN")} km (current − previous odometer on ${x.label} entries) = ${formatINR(x.total.costPerKm)} per km.`
                    : `Needs ${x.label} entries with km this month.`
                }
              />
            </KpiRow>
          ))}
          <KpiRow title="Running Fluid">
            <StatsCard
              label="Running Fluid Cost"
              icon={Sigma}
              value={formatINR(mm.fluid.spend)}
              hint={`${periodShort} · Diesel + ${mm.extras.map((x) => x.label).join(" + ")}`}
              info={`Diesel ${formatINR(mm.totals.spend)} + ${mm.extras.map((x) => `${x.label} ${formatINR(x.total.spend)}`).join(" + ")} = ${formatINR(mm.fluid.spend)}.`}
            />
            <StatsCard
              label="Running Fluid Volume"
              icon={Sigma}
              value={`${formatNumber(mm.fluid.qty)} L`}
              hint={`${periodShort} · Diesel + ${mm.extras.map((x) => x.label).join(" + ")}`}
              info={`Diesel ${formatNumber(mm.totals.litres)} L + ${mm.extras.map((x) => `${x.label} ${formatNumber(x.total.qty, 2)} ${x.unit}`).join(" + ")} = ${formatNumber(mm.fluid.qty, 2)} L.`}
            />
          </KpiRow>
          <KpiRow title="Fleet">
            <StatsCard
              label="Vehicle Count"
              icon={Bus}
              value={mm.vehicleCount}
              hint={`With a Diesel or ${mm.extras.map((x) => x.label).join(" / ")} entry in ${periodShort}`}
              info="Distinct vehicles with at least one diesel or AdBlue entry in the selected month."
            />
            <StatsCard
              label="Customer Count"
              icon={Users}
              value={mm.customerCount}
              hint={`Active in ${periodShort} · ${o.cards.length} total`}
              info="Distinct customers with at least one diesel or AdBlue entry costed to them in the selected month."
            />
          </KpiRow>
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
          <Button variant="outline" asChild>
            <Link href="/diesel/monthly-master">Monthly Master</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/diesel/quarterly-master">Quarterly Master</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/diesel/yearly-master">Yearly Master</Link>
          </Button>
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
          description="Add your first transport customer to start tracking diesel by vehicle."
          action={
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add Customer
            </Button>
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
              periodLabel={o.inProgress ? "This month to date" : monthLabel(month)}
              vsLabel={vsLabel}
              prevLabel={shortMonthLabel(o.prev)}
              today={today}
              asOf={asOfMonth(month, today)}
              active={c.group.id && ds ? activeVehicleIds(ds.assignments ?? [], idx!.vehicles, c.group.id, today) : null}
              onEdit={can("customers", "edit") ? setEditing : undefined}
              onArchive={can("customers", "delete") ? setArchiving : undefined}
              onRestore={
                can("customers", "delete")
                  ? async (cu) => {
                      await archive.mutateAsync({ id: cu.id, restore: true })
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
            await archive.mutateAsync({ id: archiving.id })
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
  periodLabel,
  vsLabel,
  prevLabel,
  today,
  asOf,
  active,
  onEdit,
  onArchive,
  onRestore,
}: {
  onEdit?: (c: Customer) => void
  onArchive?: (c: Customer) => void
  onRestore?: (c: Customer) => void
  card: CustomerCard
  periodLabel: string
  vsLabel: string
  prevLabel: string
  today: string
  /** Day the selected month is judged on — the badge shows the customer's status then. */
  asOf: string
  /** Vehicles assigned to this customer today with status ACTIVE (assignment system). */
  active: Set<string> | null
}) {
  // Worked this month for the customer but not one of its active vehicles now (transferred / archived / inactive).
  const historical = c.vehicleIds.filter((id) => !active?.has(id)).length
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
          </div>
        </div>

        <div className="flex items-end justify-between gap-2">
          <div>
            <div className="num text-2xl font-semibold tracking-tight">{formatINR(c.spend)}</div>
            <div className="text-xs text-muted-foreground">{periodLabel}</div>
          </div>
          <div className="text-right">
            <ChangeChip pct={c.changePct} />
            <div className="mt-0.5 text-[11px] text-muted-foreground">{vsLabel}</div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
          <span className="num">
            {prevLabel} {formatINR(c.prevMonthSpend)}
          </span>
          <span>{updated ? `Updated ${updated}` : "No fills yet"}</span>
        </div>
      </Card>
    </div>
  )
}

function KpiRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 lg:grid-cols-[72px_minmax(0,1fr)] lg:items-center">
      <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">{children}</div>
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
