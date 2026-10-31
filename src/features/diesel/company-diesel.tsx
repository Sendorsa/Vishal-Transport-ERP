"use client"

import { useDeferredValue, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Archive, ArchiveRestore, ArrowRightLeft, Bus, Droplet, Droplets, Fuel, Gauge, ImagePlus, IndianRupee, MoreVertical, Pencil, Plus, Route } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FormModal } from "@/components/shared/form-modal"
import type { Vehicle } from "@/lib/types"
import { EmptyState, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { SearchBar } from "@/components/shared/filter-bar"
import { StatsCard } from "@/components/shared/stats-card"
import { StatusBadge } from "@/components/shared/status-badge"
import { asOfMonth, statusOn } from "@/domain/status-history"
import { findGroup, groupMonth, monthLabel, monthProgress, prevMonthKey, shortMonthLabel, vehicleMonth } from "@/domain/diesel"
import { adBlueStats } from "@/domain/adblue"
import { useAdBlueEntries, useArchiveVehicle, useUpdateCustomer } from "@/lib/api/hooks"
import { useCan } from "@/lib/app-state"
import { formatINR, formatDate, formatNumber, todayISO } from "@/lib/format"
import { cn } from "@/lib/utils"
import { AddVehicleDialog } from "./add-vehicle-dialog"
import { TransferVehicleDialog } from "./transfer-vehicle-dialog"
import { activeVehicleIds, assignmentIndex, handoverFrom, vehicleMatches } from "@/domain/assignments"
import { CompanyLogo, DieselBreadcrumb, MonthSelect, dieselHref, kpiExplain, readLogoFile, useDieselIndex, useDieselMonth, useDieselMonthOptions, MonthLockControl } from "./parts"

/**
 * Customer page for the module's selected month:
 * customer information → summary KPIs → vehicle cards.
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
  // This customer's vehicle search (same match as Customers → Vehicles); the page is keyed by customer, so it starts empty.
  const [q, setQ] = useState("")
  const query = useDeferredValue(q)
  const today = todayISO()
  const group = idx ? findGroup(idx, slug) : null
  const adblue = useAdBlueEntries()

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
  const vsLabel = d.prog.inProgress ? `vs 1–${d.prog.day} ${shortMonthLabel(d.prevKey).split(" ")[0]}` : `vs ${shortMonthLabel(d.prevKey)}`
  const pct = (a: number | null, b: number | null) => (a && b ? ((a - b) / b) * 100 : null)
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
        id: group.customer.id,
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

      {/* 1. Customer summary — selected month */}
      <section>
        <h2 className="mb-2 text-sm font-semibold">
          Customer summary · {monthLabel(month)}
          {d.prog.inProgress && " (to date)"}
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatsCard
            label="Total Diesel Spend"
            icon={IndianRupee}
            value={formatINR(cur.spend)}
            delta={pct(cur.spend, prev.spend)}
            invertDelta
            hint={`${period} · ${vsLabel}`}
            info={why.spend}
          />
          <StatsCard label="Total Diesel Litres" icon={Droplet} value={`${formatNumber(cur.litres)} L`} hint={`${period} · ${cur.fills} fills`} info={why.litres} />
          <StatsCard
            label="Total AdBlue Spend"
            icon={IndianRupee}
            value={formatINR(d.ab.spend)}
            hint={`${period} · ${d.ab.entries} AdBlue entries`}
            info="Σ amount of AdBlue entries — kept separate from diesel spend."
          />
          <StatsCard label="Total AdBlue Litres" icon={Droplets} value={`${formatNumber(d.ab.litres, 2)} L`} hint={period} info="Σ litres of AdBlue entries — kept separate from diesel litres." />
          <StatsCard label="Total KM Run" icon={Route} value={formatNumber(cur.km)} hint={`${period} · diesel odometer readings`} info={why.km} />
          <StatsCard
            label="Average Diesel KM/L"
            icon={Gauge}
            value={cur.kmpl ?? "—"}
            hint={`${period} · diesel cost ${cur.costPerKm ? formatINR(cur.costPerKm) : "—"}/km`}
            info={`${why.kmpl} ${why.costPerKm}`}
          />
          <StatsCard
            label="Average AdBlue KM/L"
            icon={Gauge}
            value={d.ab.kmPerLitre ?? "—"}
            hint={period}
            info={
              d.ab.kmPerLitre
                ? `${formatNumber(d.ab.km)} km (AdBlue entries' current − previous odometer) ÷ ${formatNumber(d.ab.litres, 2)} L = ${d.ab.kmPerLitre}.`
                : "Needs AdBlue entries this month."
            }
          />
          <StatsCard
            label="Vehicle Count"
            icon={Bus}
            value={d.vehicles.length}
            hint={period}
            info={
              d.prog.inProgress
                ? "Vehicles deployed with this customer, plus any fuelled, given AdBlue or run for it this month."
                : "Vehicles fuelled, given AdBlue or run for this customer in the selected month."
            }
          />
        </div>
      </section>

      {/* 2. Vehicle list — selected month */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            Vehicles · {monthLabel(month)} <span className="font-normal text-muted-foreground">· open a vehicle to see or add Diesel & AdBlue entries</span>
          </h2>
          <div className="flex items-center gap-2">
            {archivedCount > 0 && (
              <Button variant={showArchived ? "secondary" : "ghost"} size="sm" onClick={() => setShowArchived((v) => !v)}>
                <Archive /> {showArchived ? "Hide archived vehicles" : `Show archived vehicles (${archivedCount})`}
              </Button>
            )}
            {archived && <span className="text-xs text-muted-foreground">Archived customer — history only. Restore it from the Diesel page to add vehicles.</span>}
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
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {[...gridVehicles]
              .sort((a, b) => a.vehicle.regNo.localeCompare(b.vehicle.regNo))
              .map((v) => (
                <div key={v.vehicle.id} className="group relative">
                  <Card size="sm" className={cn("h-full gap-3 px-4 transition-all group-hover:shadow-md group-hover:ring-foreground/20", handover(v.vehicle.id) && "bg-muted/40 opacity-70")}>
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
                          {can("vehicles", "delete") &&
                            (v.vehicle.status === "ARCHIVED" ? (
                              <DropdownMenuItem
                                onSelect={async () => {
                                  await archiveVehicle.mutateAsync({
                                    id: v.vehicle.id,
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
                      <VehicleFigure label="Diesel Spend" value={v.spend ? formatINR(v.spend) : "—"} strong />
                      <VehicleFigure label="KM Run" value={formatNumber(v.km)} />
                      <VehicleFigure label="Diesel Cost per KM" value={v.costPerKm ? formatINR(v.costPerKm) : "—"} />
                      <VehicleFigure label="KM / Litre" value={v.kmpl ?? "—"} />
                      <VehicleFigure label="AdBlue Litres" value={d.abByVehicle.get(v.vehicle.id) ? `${formatNumber(d.abByVehicle.get(v.vehicle.id)!.litres, 2)} L` : "—"} />
                      <VehicleFigure label="AdBlue Spend" value={d.abByVehicle.get(v.vehicle.id) ? formatINR(d.abByVehicle.get(v.vehicle.id)!.spend) : "—"} />
                    </dl>
                  </Card>
                </div>
              ))}
          </div>
        )}
      </section>

      {group.customer && <AddVehicleDialog open={adding} onOpenChange={setAdding} customer={group.customer} />}
      {group.customer && editingVehicle && <AddVehicleDialog key={editingVehicle.id} open vehicle={editingVehicle} customer={group.customer} onOpenChange={(o) => !o && setEditingVehicle(null)} />}
      {transferring && <TransferVehicleDialog vehicle={transferring} onOpenChange={(o) => !o && setTransferring(null)} />}
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
            await archiveVehicle.mutateAsync({ id: archivingVehicle.id })
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
