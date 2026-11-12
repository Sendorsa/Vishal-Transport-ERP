"use client"

import { useDeferredValue, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Archive, ArchiveRestore, ArrowRightLeft, Bus, CalendarClock, Droplets, Factory, Fuel, Gauge, ImagePlus, IndianRupee, Info, MoreVertical, Pencil, Plus, Route, Sigma, Zap } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FormModal } from "@/components/shared/form-modal"
import type { Vehicle } from "@/lib/types"
import { EmptyState, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { SearchBar } from "@/components/shared/filter-bar"
import { StatsCard } from "@/components/shared/stats-card"
import { StatusBadge } from "@/components/shared/status-badge"
import { asOfMonth, statusOn } from "@/domain/status-history"
import { findGroup, groupMonth, monthLabel, monthProgress, prevMonthKey, shortMonthLabel, vehicleMonth } from "@/domain/diesel"
import { industrialTotals } from "@/domain/industrial"
import { FUEL_ORDER, fuelLitres, fuelName, fuelUnit, fuelWise, totalExpenditure, type Category, type FuelTotals } from "@/domain/expenditure"
import { fuelTheme } from "@/lib/fuel-theme"
import { FuelBadge } from "@/components/shared/fuel-badge"
import { FuelTypeRows } from "./fuel-type-summary"
import { adBlueStats } from "@/domain/adblue"
import { useAdBlueEntries, useArchiveVehicle, useIndustrialSupplies, useUpdateCustomer } from "@/lib/api/hooks"
import { useCan } from "@/lib/app-state"
import { formatINR, formatDate, formatNumber, todayISO } from "@/lib/format"
import { cn } from "@/lib/utils"
import { AddVehicleDialog } from "./add-vehicle-dialog"
import { EditAssignmentDialog, TransferVehicleDialog } from "./transfer-vehicle-dialog"
import { IndustrialSection } from "./industrial-section"
import { activeVehicleIds, assignmentIndex, handoverFrom, vehicleMatches } from "@/domain/assignments"
import { CompanyLogo, DieselBreadcrumb, MonthSelect, dieselHref, kpiExplain, readLogoFile, useDieselIndex, useDieselMonth, useDieselMonthOptions, MonthLockControl } from "./parts"

/**
 * Customer page for the module's selected month:
 * customer information → summary KPIs → Overview (Combined Fuel Outflow) / Vehicles / Industrial Use.
 * (The panels reset text-base: TabsContent sets text-sm, and the sections were written for the page's own size.)
 */
export function CompanyDiesel({ slug }: { slug: string }) {
  const can = useCan()
  const { idx, ds, isLoading } = useDieselIndex()
  const months = useDieselMonthOptions(idx)
  const [month, setMonth] = useDieselMonth(months)
  const updateCustomer = useUpdateCustomer()
  const fileRef = useRef<HTMLInputElement>(null)
  const [adding, setAdding] = useState(false)
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null)
  const [archivingVehicle, setArchivingVehicle] = useState<Vehicle | null>(null)
  const archiveVehicle = useArchiveVehicle()
  const [showArchived, setShowArchived] = useState(false)
  const [transferring, setTransferring] = useState<Vehicle | null>(null)
  const [editingAssignment, setEditingAssignment] = useState<Vehicle | null>(null)
  // This customer's vehicle search (same match as Customers → Vehicles); the page is keyed by customer, so it starts empty.
  const [q, setQ] = useState("")
  const query = useDeferredValue(q)
  const today = todayISO()
  const group = idx ? findGroup(idx, slug) : null
  const adblue = useAdBlueEntries()
  const supplies = useIndustrialSupplies()
  // Overview by default on every customer page (keyed by customer); kept while the month or a dialog changes.
  const [view, setView] = useState<"overview" | "vehicles" | "industrial">("overview")

  const d = useMemo(() => {
    if (!idx || !group || !month) return null
    const prog = monthProgress(month, today)
    // The current month also lists deployed vehicles without fills yet, so a first entry can be added.
    const cur = groupMonth(idx, group.id, month, undefined, prog.inProgress)
    const prevKey = prevMonthKey(month)
    const prev = groupMonth(idx, group.id, prevKey, prog.inProgress ? prog.day : undefined)
    // AdBlue is read from its own entries and kept apart from every diesel figure.
    const ab = (adblue.data ?? []).filter((e) => e.customerId === group.id && e.date.startsWith(month))
    const abByVehicle = new Map<string, ReturnType<typeof adBlueStats>>()
    new Set(ab.map((e) => e.vehicleId)).forEach((vid) => abByVehicle.set(vid, adBlueStats(ab.filter((e) => e.vehicleId === vid))))
    // Vehicles that only had AdBlue this month still belong in the list.
    const listed = new Set(cur.vehicles.map((v) => v.vehicle.id))
    const vehicles = [...cur.vehicles, ...[...abByVehicle.keys()].filter((id) => !listed.has(id)).flatMap((id) => vehicleMonth(idx, group.id, id, month) ?? [])]
    return {
      prog,
      cur,
      prev,
      prevKey,
      ab: adBlueStats(ab),
      abByVehicle,
      vehicles,
    }
  }, [idx, group, month, today, adblue.data])

  if (!can("diesel")) return <NoAccess what="diesel" />
  if (isLoading || !idx || !ds) return <PageSkeleton />
  if (!group || !d)
    return (
      <EmptyState
        icon={Fuel}
        title="Customer not found"
        action={
          <Button variant="outline" asChild>
            <Link href="/diesel">Back to diesel</Link>
          </Button>
        }
      />
    )

  const { cur, prev } = d
  const why = kpiExplain(cur)
  const types = new Map(ds.settings.vehicleTypes.map((t) => [t.code, t.name]))
  const canEditCustomer = Boolean(group.customer) && can("customers", "edit")
  // Archived customer: history stays visible, but no new vehicles or entries.
  const archived = group.customer?.status === "ARCHIVED"
  const period = shortMonthLabel(month) + (d.prog.inProgress ? " (to date)" : "")
  // Fuel-wise expenditure for the page's month (owner, 12 Nov 2026; domain/expenditure.ts): the customer's fills split by
  // their vehicle's fuel type — only the fuel types of this month's vehicles — plus its industrial supplies and AdBlue.
  // A source still loading or not loaded is null: its card and the total say "not available".
  const fuels = fuelWise(idx, cur.entries, d.vehicles.map((v) => v.vehicle.fuelType))
  const ownSupplies = supplies.data ? industrialTotals(supplies.data.filter((x) => x.customerId === group.id && x.date.startsWith(month))) : null
  const industrial = !group.customer ? undefined : ownSupplies ? { spend: ownSupplies.value, litres: ownSupplies.litres, entries: ownSupplies.count } : null
  const adblueSpent = adblue.data ? { spend: d.ab.spend, litres: d.ab.litres, entries: d.ab.entries } : null
  // The previous month's figures for the same fuels (same days while this month is in progress).
  const prevFuels = fuelWise(idx, prev.entries, fuels.map((f) => f.fuelType))
  const vsLabel = d.prog.inProgress ? `vs 1–${d.prog.day} ${shortMonthLabel(d.prevKey).split(" ")[0]}` : `vs ${shortMonthLabel(d.prevKey)}`
  // Visual only: archived vehicles leave the grid, but every KPI above still includes their fills.
  // Status as it was in the selected month — a later archive never relabels earlier months.
  const asOf = asOfMonth(month, today)
  const archivedThen = (v: Vehicle) => statusOn(v, asOf) === "ARCHIVED"
  // Previous owner: the vehicle was assigned elsewhere by this month → greyed, read-only history.
  const periodsByVehicle = assignmentIndex(ds.assignments ?? [])
  const customerName = new Map(ds.customers.map((c) => [c.id, c.shortName || c.name]))
  // A tanker's own vehicle record: shown with the tanker's name so it reads as one of the company tankers.
  const tankerOfVehicle = (vehicleId: string) => ds.tankers?.find((t) => t.vehicleId === vehicleId)
  const handover = (vid: string) => (group.id ? handoverFrom(periodsByVehicle.get(vid) ?? [], group.id, asOf) : null)
  // Edit / Transfer / Archive act now, so only the current owner (or nobody, for a spare vehicle) gets them.
  const ownsNow = (v: Vehicle) => !v.assignedCustomerId || v.assignedCustomerId === group.id
  const customerThen = group.customer ? statusOn(group.customer, asOf) : null
  const archivedCount = d.vehicles.filter((v) => archivedThen(v.vehicle)).length
  const shownVehicles = showArchived ? d.vehicles : d.vehicles.filter((v) => !archivedThen(v.vehicle))
  const gridVehicles = shownVehicles.filter((v) => vehicleMatches(query, v.vehicle, tankerOfVehicle(v.vehicle.id)?.name))

  const onLogo = async (file?: File) => {
    if (!file || !group.customer) return
    try {
      const logoDataUrl = await readLogoFile(file)
      await updateCustomer.mutateAsync({
        id: group.customer.id, version: group.customer.updatedAt,
        patch: { logoDataUrl },
      })
      toast.success("Logo updated")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update logo")
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <DieselBreadcrumb items={[{ label: "Diesel", href: "/diesel" }, { label: monthLabel(month), href: "/diesel" }, { label: group.shortName }]} />
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={!canEditCustomer}
              onClick={() => fileRef.current?.click()}
              className={cn("group relative rounded-lg", canEditCustomer && "cursor-pointer")}
              title={canEditCustomer ? "Change logo" : undefined}
            >
              <CompanyLogo group={group} size="lg" />
              {canEditCustomer && (
                <span className="absolute inset-0 hidden items-center justify-center rounded-lg bg-black/50 text-white group-hover:flex">
                  <ImagePlus className="size-4" />
                </span>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                onLogo(e.target.files?.[0])
                e.target.value = ""
              }}
            />
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 truncate text-xl font-semibold tracking-tight md:text-2xl">
                {group.name}
                {customerThen && customerThen !== "ACTIVE" && <StatusBadge status={customerThen} />}
              </h1>
              <p className="text-sm text-muted-foreground">
                Active Vehicles: {group.id ? activeVehicleIds(ds.assignments ?? [], idx.vehicles, group.id, today).size : 0}
                {group.customer?.city ? ` · ${group.customer.city}` : ""}
              </p>
            </div>
          </div>
          <MonthSelect months={months} value={month} onChange={setMonth} prominent />
        </div>
        <div className="mt-2">
          <MonthLockControl month={month} />
        </div>
      </div>

      {/* Overview / Vehicles / Industrial Use (owner, 12 Nov 2026). Every panel stays mounted (hidden when not chosen), so
          switching is instant and each keeps its own filters and search. The month lock control stays in the header. */}
      <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="vehicles">
            <Bus /> Vehicles
          </TabsTrigger>
          {group.customer && (
            <TabsTrigger value="industrial">
              <Factory /> Industrial Use
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="overview" forceMount className="mt-4 text-base data-[state=inactive]:hidden">
          <FuelSummary fuels={fuels} industrial={industrial} adblue={adblueSpent} period={period} onOpen={setView} />
        </TabsContent>

        {group.customer && (
          <TabsContent value="industrial" forceMount className="mt-4 text-base data-[state=inactive]:hidden">
            <IndustrialSection customer={group.customer} idx={idx} />
          </TabsContent>
        )}

        <TabsContent value="vehicles" forceMount className="mt-4 space-y-5 text-base data-[state=inactive]:hidden">
          {/* Customer summary — selected month (owner, 12 Nov 2026: in the Vehicles view only, above the vehicles) */}
          <section>
            <h2 className="mb-2 text-sm font-semibold">
              Customer summary · {monthLabel(month)}
              {d.prog.inProgress && " (to date)"}
            </h2>
            {/* One row per fuel type — each from its own fills only (never a combined KM/L) — then AdBlue and the fleet. */}
            <FuelTypeRows fuels={fuels} previous={prevFuels} vsLabel={vsLabel} period={period} />
            <div className="mt-3 grid gap-2 lg:grid-cols-[96px_minmax(0,1fr)] lg:items-center">
              <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">AdBlue · fleet</div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                <StatsCard label="Total AdBlue Spend" icon={IndianRupee} value={formatINR(d.ab.spend)} hint={`${period} · ${d.ab.entries} AdBlue entries`} info="Σ amount of AdBlue entries — kept separate from every fuel." />
                <StatsCard label="Total AdBlue Litres" icon={Droplets} value={`${formatNumber(d.ab.litres, 2)} L`} hint={period} info="Σ litres of AdBlue entries — kept separate from fuel litres." />
                <StatsCard
                  label="Average AdBlue KM/L"
                  icon={Gauge}
                  value={d.ab.kmPerLitre ?? "—"}
                  hint={period}
                  info={d.ab.kmPerLitre ? `${formatNumber(d.ab.km)} km (AdBlue entries' current − previous odometer) ÷ ${formatNumber(d.ab.litres, 2)} L = ${d.ab.kmPerLitre}.` : "Needs AdBlue entries this month."}
                />
                <StatsCard label="Total KM Run" icon={Route} value={formatNumber(cur.km)} hint={`${period} · every vehicle's fills`} info={`Distance only (every fuel): ${why.km}`} />
                <StatsCard
                  label="Vehicle Count"
                  icon={Bus}
                  value={d.vehicles.length}
                  hint={period}
                  info={d.prog.inProgress ? "Vehicles deployed with this customer, plus any fuelled, given AdBlue or run for it this month." : "Vehicles fuelled, given AdBlue or run for this customer in the selected month."}
                />
              </div>
            </div>
          </section>

          {/* Vehicle list — selected month */}
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">
                Vehicles · {monthLabel(month)} <span className="font-normal text-muted-foreground">· open a vehicle to see or add fuel & AdBlue entries</span>
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                {archivedCount > 0 && (
                  <Button variant={showArchived ? "secondary" : "ghost"} size="sm" onClick={() => setShowArchived((v) => !v)}>
                    <Archive /> {showArchived ? "Hide archived vehicles" : `Show archived vehicles (${archivedCount})`}
                  </Button>
                )}
                {archived && <span className="text-xs text-muted-foreground">Archived customer — history only.{can("customers", "edit") && " Restore it from the Diesel page to add vehicles."}</span>}
                {group.customer && !archived && can("vehicles", "edit") && (
                  <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                    <Plus /> Add vehicle
                  </Button>
                )}
              </div>
            </div>
            {shownVehicles.length > 0 && <SearchBar value={q} onChange={setQ} placeholder="Search this customer's vehicles…" className="mb-3 sm:w-80" />}
            {shownVehicles.length > 0 && gridVehicles.length === 0 ? (
              <EmptyState icon={Bus} title={`No vehicle of ${group.shortName} in ${monthLabel(month)} matches “${query.trim()}”`} description="Check the registration number, or clear the search." />
            ) : gridVehicles.length === 0 ? (
              <EmptyState
                icon={Bus}
                title={`No vehicles for ${group.shortName} in ${monthLabel(month)}`}
                action={
                  d.prog.inProgress && group.customer && !archived && can("vehicles", "edit") ? (
                    <Button onClick={() => setAdding(true)}>
                      <Plus /> Add vehicle
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              // Grouped by fuel type when the customer runs more than one (Diesel, Petrol, EV), each group its own heading.
              <div className="space-y-4">
                {FUEL_ORDER.map((fuel) => [fuel, gridVehicles.filter((v) => v.vehicle.fuelType === fuel)] as const)
                  .filter(([, list]) => list.length > 0)
                  .map(([fuel, list], _, fuelGroups) => (
                  <div key={fuel}>
                    {fuelGroups.length > 1 && (
                      <h3 className={cn("mb-2 flex items-center gap-2 text-sm font-semibold", fuelTheme(fuel).heading)}>
                        <FuelBadge fuel={fuel} /> {fuelTheme(fuel).label} vehicles · {list.length}
                      </h3>
                    )}
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {[...list]
                  .sort((a, b) => a.vehicle.regNo.localeCompare(b.vehicle.regNo))
                  .map((v) => (
                    <div key={v.vehicle.id} className="group relative">
                      <Card size="sm" className={cn("h-full gap-3 px-4 transition-all group-hover:shadow-md group-hover:ring-foreground/20", fuelTheme(v.vehicle.fuelType).card, handover(v.vehicle.id) && "bg-muted/40 opacity-70")}>
                        {/* Whole card opens the vehicle; the ⋮ menu sits above this overlay. */}
                        <Link href={dieselHref(group.slug, month, v.vehicle.regNo)} className="absolute inset-0 z-0 rounded-xl" aria-label={`Open ${v.vehicle.regNo}`} />
                        {group.customer && ownsNow(v.vehicle) && (can("vehicles", "edit") || can("vehicles", "delete")) && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2 z-10" aria-label={`Actions for ${v.vehicle.regNo}`}>
                                <MoreVertical />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              {can("vehicles", "edit") && (
                                <DropdownMenuItem onSelect={() => setEditingVehicle(v.vehicle)}>
                                  <Pencil /> Edit Vehicle
                                </DropdownMenuItem>
                              )}
                              {can("vehicles", "edit") && v.vehicle.status !== "ARCHIVED" && (
                                <DropdownMenuItem onSelect={() => setTransferring(v.vehicle)}>
                                  <ArrowRightLeft /> Transfer Vehicle
                                </DropdownMenuItem>
                              )}
                              {can("vehicles", "edit") && v.vehicle.assignedCustomerId === group.id && (
                                <DropdownMenuItem onSelect={() => setEditingAssignment(v.vehicle)}>
                                  <CalendarClock /> Edit Assignment
                                </DropdownMenuItem>
                              )}
                              {can("vehicles", "delete") &&
                                (v.vehicle.status === "ARCHIVED" ? (
                                  <DropdownMenuItem
                                    onSelect={async () => {
                                      await archiveVehicle.mutateAsync({
                                        id: v.vehicle.id, version: v.vehicle.updatedAt,
                                        restore: true,
                                      })
                                      toast.success(`${v.vehicle.regNo} restored`)
                                    }}
                                  >
                                    <ArchiveRestore /> Restore Vehicle
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem variant="destructive" onSelect={() => setArchivingVehicle(v.vehicle)}>
                                    <Archive /> Archive Vehicle
                                  </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-base font-semibold">{v.vehicle.regNo}</span>
                            <FuelBadge fuel={v.vehicle.fuelType} className="h-4.5 px-1.5 text-[10px]" />
                            {tankerOfVehicle(v.vehicle.id) && <StatusBadge status="TANKER" tone="gray" label={`Tanker · ${tankerOfVehicle(v.vehicle.id)!.name}`} className="h-4.5 px-1.5 text-[10px]" />}
                            {v.vehicle.ownership === "ATTACHED" && <StatusBadge status="ATTACHED" className="h-4.5 px-1.5 text-[10px]" />}
                            {archivedThen(v.vehicle) && <StatusBadge status="ARCHIVED" className="h-4.5 px-1.5 text-[10px]" />}
                            {handover(v.vehicle.id) && (
                              <StatusBadge
                                status="TRANSFERRED"
                                tone="gray"
                                label={`Transferred to ${customerName.get(handover(v.vehicle.id)!.toCustomerId ?? "") ?? "another customer"}`}
                                className="h-4.5 px-1.5 text-[10px]"
                              />
                            )}
                          </div>
                          {handover(v.vehicle.id)?.effectiveDate && <div className="text-xs text-muted-foreground">Effective: {formatDate(handover(v.vehicle.id)!.effectiveDate!)}</div>}
                          <div className="truncate text-xs text-muted-foreground">
                            {types.get(v.vehicle.typeCode) ?? v.vehicle.typeCode} · {v.driver?.name ?? "Owner-driven"}
                          </div>
                        </div>
                        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-2.5 text-sm">
                          <VehicleFigure label={`${fuelName(v.vehicle.fuelType)} Spend`} value={v.spend ? formatINR(v.spend) : "—"} strong />
                          <VehicleFigure label="KM Run" value={formatNumber(v.km)} />
                          <VehicleFigure label={`${v.vehicle.fuelType === "EV" ? "Charging" : fuelName(v.vehicle.fuelType)} Cost per KM`} value={v.costPerKm ? formatINR(v.costPerKm) : "—"} />
                          {v.vehicle.fuelType === "EV" ? <VehicleFigure label="Charged" value={v.kwh ? `${formatNumber(v.kwh, 2)} kWh` : "—"} /> : <VehicleFigure label="KM / Litre" value={v.kmpl ?? "—"} />}
                          <VehicleFigure label="AdBlue Litres" value={d.abByVehicle.get(v.vehicle.id) ? `${formatNumber(d.abByVehicle.get(v.vehicle.id)!.litres, 2)} L` : "—"} />
                          <VehicleFigure label="AdBlue Spend" value={d.abByVehicle.get(v.vehicle.id) ? formatINR(d.abByVehicle.get(v.vehicle.id)!.spend) : "—"} />
                        </dl>
                      </Card>
                    </div>
                  ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>

      {group.customer && <AddVehicleDialog open={adding} onOpenChange={setAdding} customer={group.customer} />}
      {group.customer && editingVehicle && <AddVehicleDialog key={editingVehicle.id} open vehicle={editingVehicle} customer={group.customer} onOpenChange={(o) => !o && setEditingVehicle(null)} />}
      {transferring && <TransferVehicleDialog vehicle={transferring} onOpenChange={(o) => !o && setTransferring(null)} />}
      {group.customer && editingAssignment && <EditAssignmentDialog vehicle={editingAssignment} customer={group.customer} onOpenChange={(o) => !o && setEditingAssignment(null)} />}
      {archivingVehicle && (
        <FormModal
          open
          onOpenChange={(o) => !o && setArchivingVehicle(null)}
          title={`Archive ${archivingVehicle.regNo}?`}
          description="This vehicle has historical records. Archiving will prevent future entries while preserving all historical data."
          submitLabel="Archive Vehicle"
          destructive
          pending={archiveVehicle.isPending}
          onSubmit={async () => {
            await archiveVehicle.mutateAsync({ id: archivingVehicle.id, version: archivingVehicle.updatedAt })
            toast.success(`${archivingVehicle.regNo} archived — history kept`)
            setArchivingVehicle(null)
          }}
        >
          <span />
        </FormModal>
      )}
    </div>
  )
}

function VehicleFigure({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("num truncate", strong ? "font-semibold" : "font-medium")}>{value}</dd>
    </div>
  )
}

/**
 * Overview (owner, 12 Nov 2026): the customer's fuel-wise spending for the month, one figure per card, only the
 * categories that apply — a vehicle fuel when one of this month's vehicles runs on it (or a fill does), Industrial
 * Diesel for a customer record, AdBlue when a diesel vehicle is present or AdBlue was given. Row 1 = ₹ with Total
 * Expenditure last (prominent), row 2 = quantities with the fuel litres total (AdBlue litres and EV kWh never in it).
 * Both rows auto-fit the same number of cards, so their columns line up whatever the count (2 to 6).
 */
function FuelSummary({
  fuels,
  industrial,
  adblue,
  period,
  onOpen,
}: {
  fuels: FuelTotals[]
  /** undefined = no customer record (no industrial supplies); null = couldn't be loaded. */
  industrial: Category | null | undefined
  adblue: Category | null
  period: string
  onOpen: (view: "vehicles" | "industrial") => void
}) {
  // Exactly two decimals (0.00 L, 14,086.80 L); the shared formatNumber shows up to two.
  const q = (n: number, unit: string) => `${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unit}`
  const na = "Not available — couldn't be loaded"
  const showAdBlue = adblue === null || adblue.entries > 0 || fuels.some((f) => f.fuelType === "DIESEL")
  const total = totalExpenditure(fuels, industrial, adblue)
  const litres = fuelLitres(fuels, industrial)
  const fillsText = (n: number) => `${n} ${n === 1 ? "fill" : "fills"}`
  const parts = [
    ...fuels.map((f) => `${f.fuelType === "EV" ? "EV Charging" : `Vehicle ${fuelName(f.fuelType)}`} ${formatINR(f.spend)}`),
    ...(industrial !== undefined ? [`Industrial Diesel ${industrial ? formatINR(industrial.spend) : "—"}`] : []),
    `AdBlue ${adblue ? formatINR(adblue.spend) : "—"}`,
  ]
  const litreParts = [
    ...fuels.filter((f) => f.fuelType !== "EV").map((f) => `${fuelName(f.fuelType)} ${q(f.qty, "L")}`),
    ...(industrial !== undefined ? [`Industrial ${industrial ? q(industrial.litres, "L") : "—"}`] : []),
  ]
  const grid = "grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]"
  return (
    <section className="space-y-3">
      <div className={grid}>
        {fuels.map((f) => (
          <SpendCell
            key={f.fuelType}
            label={f.fuelType === "EV" ? "EV Charging Spending" : `Vehicle ${fuelName(f.fuelType)} Spending`}
            icon={f.fuelType === "EV" ? Zap : Bus}
            value={formatINR(f.spend)}
            period={period}
            detail={fillsText(f.fills)}
            info={`Σ amount (${f.fuelType === "EV" ? "kWh" : "litres"} × each fill's rate; tanker fills at their own rate) of this customer's fills by ${f.fuelType === "EV" ? "EV" : fuelName(f.fuelType).toLowerCase()} vehicles in the month, under the customer the vehicle was assigned to on the fill date.`}
            onOpen={() => onOpen("vehicles")}
            openLabel="Vehicles"
          />
        ))}
        {industrial !== undefined && (
          <SpendCell
            label="Industrial Diesel Spending"
            icon={Factory}
            value={industrial ? formatINR(industrial.spend) : "—"}
            period={period}
            detail={industrial ? `${industrial.entries} ${industrial.entries === 1 ? "supply" : "supplies"}` : na}
            info="Σ amount (litres × each supply's own rate) of this customer's industrial supplies dated in the month — never a vehicle fill; its tanker allocations are not spending."
            onOpen={() => onOpen("industrial")}
            openLabel="Industrial Use"
          />
        )}
        {showAdBlue && (
          <SpendCell
            label="AdBlue Spending"
            icon={Droplets}
            value={adblue ? formatINR(adblue.spend) : "—"}
            period={period}
            detail={adblue ? `${adblue.entries} ${adblue.entries === 1 ? "entry" : "entries"}` : na}
            info="Σ amount of this customer's AdBlue entries in the month: stock draws at the weighted-average cost, direct vendor purchases at their own amount. Bulk purchases are stock, not spending. Never part of Diesel."
          />
        )}
        <SpendCell
          label="Total Expenditure"
          icon={Sigma}
          value={total === null ? "—" : formatINR(total)}
          period={period}
          detail={total === null ? na : "Every category, each once"}
          info={`${parts.join(" + ")}${total === null ? "" : ` = ${formatINR(total)}`}. Tanker loads and transfers are never expenditure.`}
          prominent
        />
      </div>
      <div className={grid}>
        {fuels.map((f) => (
          <SpendCell
            key={f.fuelType}
            label={f.fuelType === "EV" ? "EV Charging (kWh)" : `Vehicle ${fuelName(f.fuelType)} Litres`}
            icon={f.fuelType === "EV" ? Zap : Fuel}
            value={q(f.qty, fuelUnit(f.fuelType))}
            period={period}
            detail={f.fuelType === "EV" ? "Units charged — not litres" : fillsText(f.fills)}
            info={`Σ ${f.fuelType === "EV" ? "kWh" : "litres"} of the same fills.`}
          />
        ))}
        {industrial !== undefined && (
          <SpendCell
            label="Industrial Diesel Litres"
            icon={Factory}
            value={industrial ? q(industrial.litres, "L") : "—"}
            period={period}
            detail={industrial ? "Supplied out of the tankers" : na}
            info="Σ litres of this customer's industrial supplies dated in the month."
          />
        )}
        {showAdBlue && (
          <SpendCell
            label="AdBlue Litres"
            icon={Droplets}
            value={adblue ? q(adblue.litres, "L") : "—"}
            period={period}
            detail={adblue ? "Not fuel — not in the fuel total" : na}
            info="Σ litres of this customer's AdBlue entries in the month."
          />
        )}
        <SpendCell
          label="Total Fuel Litres"
          icon={Sigma}
          value={litres === null ? "—" : q(litres, "L")}
          period={period}
          detail={litres === null ? na : "Diesel + Petrol + Industrial · no AdBlue or EV kWh"}
          info={`${litreParts.join(" + ") || "No fuel litres"}${litres === null ? "" : ` = ${q(litres, "L")}`}. AdBlue litres and EV kWh are kept apart.`}
          prominent
        />
      </div>
    </section>
  )
}

/** One Overview figure (₹ or litres): label, the figure, the period and one line of detail; the overall cards slightly more prominent. */
function SpendCell({
  label,
  icon: Icon,
  value,
  period,
  detail,
  info,
  onOpen,
  openLabel,
  prominent,
}: {
  label: string
  icon: typeof Bus
  value: string
  period: string
  detail: string
  info: string
  onOpen?: () => void
  openLabel?: string
  prominent?: boolean
}) {
  return (
    <Card size="sm" className={cn("h-full gap-2 px-4", prominent ? "border-primary/40 bg-primary/5" : "bg-muted/30")}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn("flex min-w-0 items-center gap-1 text-xs font-medium", prominent ? "text-foreground" : "text-muted-foreground")}>
          {label}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={`How "${label}" is calculated: ${info}`} className="shrink-0 cursor-help rounded-sm opacity-60 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2">
                <Info className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{info}</TooltipContent>
          </Tooltip>
        </span>
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", prominent ? "bg-primary/15 text-primary" : "bg-background text-muted-foreground")}>
          <Icon className="size-4" />
        </span>
      </div>
      <div className={cn("num font-semibold tracking-tight [overflow-wrap:anywhere]", prominent ? "text-2xl md:text-3xl" : "text-xl md:text-2xl")}>{value}</div>
      <div className="text-xs text-muted-foreground">
        <div>{period}</div>
        <div>{detail}</div>
      </div>
      {onOpen && (
        <Button variant="link" size="sm" className="h-auto self-start p-0 text-xs" onClick={onOpen}>
          {openLabel} →
        </Button>
      )}
    </Card>
  )
}
