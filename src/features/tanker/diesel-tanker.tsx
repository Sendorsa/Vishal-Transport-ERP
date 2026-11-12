"use client"

import { useMemo, useState } from "react"
import { endOfMonth, format, parseISO } from "date-fns"
import { Archive, ArchiveRestore, ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Container, History, IndianRupee, MoreVertical, PackagePlus, Pencil, Plus, SlidersHorizontal } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { DataTable } from "@/components/shared/data-table"
import { EditedBadge, ReasonField, RecordHistoryDialog } from "@/components/shared/audit"
import { DeleteDialog, RowActions, monthLockedReason } from "@/components/shared/row-actions"
import { FormModal } from "@/components/shared/form-modal"
import { Field, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { SimpleSelect } from "@/components/shared/simple-select"
import { StatsCard } from "@/components/shared/stats-card"
import { StatusBadge } from "@/components/shared/status-badge"
import { monthLabel } from "@/domain/diesel"
import { canEditMonth } from "@/domain/month-lock"
import { inEntryOrder } from "@/domain/payment-order"
import { fillAmount, isStockPool, isTankerFill, tankerLabel, tankerLedger, tankerMoves, tankerOf, tankerPeriod, tankerAvailability, valueTankers, type TankerRecords } from "@/domain/tanker"
import {
  useArchiveTanker,
  useCreateFuelStation,
  useCreateTankerAdjustment,
  useCreateTankerOpening,
  useCreateTankerTransfer,
  useDeleteTankerAdjustment,
  useDeleteTankerDispense,
  useDeleteTankerLoad,
  useDeleteTankerTransfer,
  useMonthLocks,
  useSaveTanker,
  useSaveTankerLoad,
  useIndustrialSupplies,
  useTankerAdjustments,
  useTankerDispenses,
  useTankerLoads,
  useTankerTransfers,
  useTankers,
} from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber, monthKey, previousMonthEnd, todayISO, formatLitres } from "@/lib/format"
import type { Tanker, TankerAdjustment, TankerDispense, TankerLoad, TankerTransfer } from "@/lib/types"
import { MonthLockControl, useDieselIndex } from "../diesel/parts"
import { usePeriod } from "../diesel/period"
import { hasOwnerAuthority } from "@/lib/permissions"

const L = formatLitres
const ALL = "__all__"

/** One row of the dispensing history — a registered vehicle's diesel entry, or an external dispense. */
interface DispenseRow {
  id: string
  date: string
  createdAt?: string
  tankerId: string
  external: boolean
  vehicle: string
  detail: string
  litres: number
  /** Registered fills: litres × the rate on the fill (answer 23). External: cost at the tanker's average. */
  amount: number
  rate: number | null
  record?: TankerDispense
}

/** Transfers and stock adjustments, as one list. */
interface MovementRow {
  id: string
  date: string
  createdAt?: string
  kind: "TRANSFER" | "ADJUSTMENT"
  what: string
  litres: number
  detail: string
  transfer?: TankerTransfer
  adjustment?: TankerAdjustment
}

/**
 * Diesel Tankers (answer 24: three today, more can be added) — each tanker's cargo inventory on its own
 * (loads in, dispenses out, transfers, adjustments), and all of them together. A tanker VEHICLE's own fuel
 * is an ordinary pump fill and never touches cargo (src/domain/tanker.ts).
 */
export function DieselTanker() {
  const can = useCan()
  const [role] = useRole()
  const { ds, idx, isLoading } = useDieselIndex()
  const period = usePeriod(idx)
  const tankers = useTankers()
  const loads = useTankerLoads()
  const external = useTankerDispenses()
  const transfers = useTankerTransfers()
  const adjustments = useTankerAdjustments()
  const industrial = useIndustrialSupplies() // Industrial Diesel Supply draws (12 Nov 2026): part of each tanker's stock
  const locks = useMonthLocks()
  const archive = useArchiveTanker()
  const delLoad = useDeleteTankerLoad()
  const delExternal = useDeleteTankerDispense()
  const delTransfer = useDeleteTankerTransfer()
  const delAdjustment = useDeleteTankerAdjustment()
  const [selected, setSelected] = useState<string>(ALL)
  const [showArchived, setShowArchived] = useState(false)
  const [editingTanker, setEditingTanker] = useState<{ tanker?: Tanker } | null>(null)
  const [historyOf, setHistoryOf] = useState<string | null>(null)
  const [openingFor, setOpeningFor] = useState<Tanker | null>(null)
  const [loading, setLoading] = useState<{ load?: TankerLoad } | null>(null)
  const [moving, setMoving] = useState<"TRANSFER" | "ADJUSTMENT" | null>(null)
  const [deleting, setDeleting] = useState<
    { kind: "load"; load: TankerLoad } | { kind: "external"; record: TankerDispense } | { kind: "transfer"; record: TankerTransfer } | { kind: "adjustment"; record: TankerAdjustment } | null
  >(null)

  const d = useMemo(() => {
    if (!ds || !idx || !tankers.data || !loads.data || !external.data || !transfers.data || !adjustments.data || !industrial.data) return null
    const records = { loads: loads.data, fills: ds.diesel, external: external.data, transfers: transfers.data, adjustments: adjustments.data, industrial: industrial.data }
    const v = valueTankers(records)
    // Only the company tankers (JIO, Office, Mini) are shown. A stock pool (no registration, e.g. tnk_default with the
    // history recorded before tankers were split) keeps its records — they still cost the historical fills and are
    // station purchases — but is never listed or totalled here (owner, 31 Oct 2026: DIESEL_TANKER_CLEANUP_REPORT.md).
    // ponytail: a transfer between a pool and a tanker would count on the tanker only; none exist and the pool can't be picked.
    const pools = new Set(tankers.data.filter(isStockPool).map((t) => t.id))
    const shown = (id: string) => !pools.has(id)
    const moves = tankerMoves(records).filter((m) => shown(m.tankerId))
    const through = monthKey(todayISO())
    const customers = new Map(ds.customers.map((c) => [c.id, c.shortName || c.name]))
    const byId = new Map(tankers.data.map((t) => [t.id, t]))
    const name = (id: string) => byId.get(id)?.name ?? "Unknown tanker"
    const dispenses: DispenseRow[] = inEntryOrder([
      ...ds.diesel.filter(isTankerFill).map(
        (e): DispenseRow => ({
          id: e.id,
          date: e.date,
          createdAt: e.createdAt,
          tankerId: tankerOf(e),
          external: false,
          vehicle: idx.vehicles.get(e.vehicleId)?.regNo ?? "Unknown",
          detail: [e.customerId ? customers.get(e.customerId) : "Unallocated", e.odometerKm === null ? null : `odometer ${formatNumber(e.odometerKm)}`, e.notes].filter(Boolean).join(" · "),
          litres: e.litres,
          amount: fillAmount(e, v.costOf),
          rate: e.rate > 0 ? e.rate : null,
        })
      ),
      ...external.data.map(
        (x): DispenseRow => ({ id: x.id, date: x.date, createdAt: x.createdAt, tankerId: tankerOf(x), external: true, vehicle: x.vehicleNo, detail: x.notes, litres: x.litres, amount: v.costOf.get(x.id) ?? 0, rate: null, record: x })
      ),
    ]).filter((x) => shown(x.tankerId))
    const movements: MovementRow[] = inEntryOrder([
      ...transfers.data.filter((t) => shown(t.fromTankerId) && shown(t.toTankerId)).map((t): MovementRow => ({ id: t.id, date: t.date, createdAt: t.createdAt, kind: "TRANSFER", what: `${name(t.fromTankerId)} → ${name(t.toTankerId)}`, litres: t.litres, detail: t.notes, transfer: t })),
      ...adjustments.data.filter((a) => shown(a.tankerId)).map((a): MovementRow => ({ id: a.id, date: a.date, createdAt: a.createdAt, kind: "ADJUSTMENT", what: name(a.tankerId), litres: a.litres, detail: a.reason, adjustment: a })),
    ])
    // Opening + Loaded + Transfers + Adjustments − Dispensed = Closing per tanker (tankerLedger / tankerPeriod),
    // asserted in npm run check:diesel. Closing and carry-forward show in the ledgers, never as extra cards (CLAUDE.md).
    return { v, records, moves, through, dispenses, movements, byId, name, loads: inEntryOrder(loads.data.filter((l) => shown(tankerOf(l)))), stations: new Map(ds.fuelStations.map((s) => [s.id, s.name])) }
  }, [ds, idx, tankers.data, loads.data, external.data, transfers.data, adjustments.data, industrial.data])

  if (!can("diesel")) return <NoAccess what="the diesel tankers" />
  if (isLoading || !d || !tankers.data) return <PageSkeleton />
  const all = tankers.data.filter((t) => !isStockPool(t)).sort((a, b) => Number(a.status === "ARCHIVED") - Number(b.status === "ARCHIVED") || a.name.localeCompare(b.name))
  const visible = all.filter((t) => showArchived || t.status !== "ARCHIVED" || t.id === selected)
  const tanker = selected === ALL ? null : (d.byId.get(selected) ?? null)
  const scope = tanker?.id ?? null
  const ledger = tankerLedger(d.moves, scope, d.through)
  const m = tankerPeriod(ledger, period.periodMonths)
  const p = period.label
  const stockOf = (id: string) => d.v.stock.get(id)?.litres ?? 0
  const currentStock = scope ? stockOf(scope) : all.reduce((t, x) => t + stockOf(x.id), 0)
  const mine = <R extends { date: string; tankerId?: string }>(r: R) => period.match(r) && (!scope || tankerOf(r) === scope)
  const loadsInPeriod = d.loads.filter(mine)
  const dispensesInPeriod = d.dispenses.filter(mine)
  const movementsInPeriod = d.movements.filter(
    (x) => period.match(x) && (!scope || (x.transfer ? x.transfer.fromTankerId === scope || x.transfer.toTankerId === scope : x.adjustment!.tankerId === scope))
  )
  const fillAmountInPeriod = dispensesInPeriod.filter((x) => !x.external).reduce((t, x) => t + x.amount, 0)
  const month = period.mode === "month" ? period.periodMonths?.[0] : undefined
  // A period that ended before this month shows its month-end inventory, never today's.
  const lastMonth = period.periodMonths?.at(-1)
  const endedMonth = lastMonth && lastMonth < monthKey(todayISO()) ? lastMonth : null
  const open = (date: string) => canEditMonth(role, date.slice(0, 7), todayISO(), locks.data ?? [])
  const mayEdit = can("diesel", "edit")
  const mayDelete = can("diesel", "delete")
  const mayManage = can("vehicles", "edit")
  // Fresh-start opening stock (Owner / Dev): one per tanker.
  const mayOpen = hasOwnerAuthority(role)
  const hasOpening = new Set((loads.data ?? []).filter((l) => l.opening).map((l) => tankerOf(l)))
  const active = all.filter((t) => t.status === "ACTIVE")
  const tankerCount = all.filter((t) => t.status === "ACTIVE").length
  const comparison = comparisonTankers(all, showArchived)
    .map((t) => {
      const pm = tankerPeriod(tankerLedger(d.moves, t.id, d.through), period.periodMonths)
      const fills = d.dispenses.filter((x) => !x.external && x.tankerId === t.id && period.match(x))
      return { t, pm, fillAmount: fills.reduce((s, x) => s + x.amount, 0) }
    })
  const total = (f: (r: (typeof comparison)[number]) => number) => comparison.reduce((s, r) => s + f(r), 0)
  const cells = comparison

  return (
    <div className="space-y-5">
      <PageHeader
        title="Diesel Tankers"
        description="Bulk diesel carried in the company tankers and dispensed to vehicles — each tanker's stock on its own. A tanker's own fuel is a normal diesel entry and never comes from its cargo."
        actions={
          <div className="flex flex-wrap gap-2">
            {can("diesel", "create") && (
              <>
                <Button variant="outline" onClick={() => setLoading({})} disabled={!active.length}>
                  <ArrowDownToLine /> Load Diesel Into Tanker
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" aria-label="More tanker actions">
                      <MoreVertical />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem disabled={active.length < 2} onSelect={() => setMoving("TRANSFER")}>
                      <ArrowLeftRight /> Transfer Between Tankers
                    </DropdownMenuItem>
                    {mayEdit && (
                      <DropdownMenuItem disabled={!active.length} onSelect={() => setMoving("ADJUSTMENT")}>
                        <SlidersHorizontal /> Adjust Stock
                      </DropdownMenuItem>
                    )}
                    {mayManage && (
                      <DropdownMenuItem onSelect={() => setEditingTanker({})}>
                        <Plus /> Add Tanker
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <SimpleSelect
          value={selected}
          onChange={setSelected}
          options={[{ value: ALL, label: "All tankers" }, ...visible.map((t) => ({ value: t.id, label: `${tankerLabel(t)}${t.status === "ARCHIVED" ? " (archived)" : ""}` }))]}
          className="h-8 min-w-56"
        />
        {period.control}
        {month && <MonthLockControl month={month} />}
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold">
          {tanker ? tanker.name : "All tankers"} · inventory · {p}
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-5">
          {endedMonth ? (
            <StatsCard
              label="Closing Inventory"
              icon={Container}
              value={L(m.closing)}
              hint={`As of ${format(endOfMonth(parseISO(`${endedMonth}-01`)), "d MMM yyyy")}`}
              info={`Inventory at the end of the period: Opening ${L(m.opening)} + Opening stock ${L(m.openingStock)} + Loaded ${L(m.loaded)} + Transfers in ${L(m.transferIn)} + Adjustments ${L(m.adjusted)} − Dispensed ${L(m.dispensed)} − Industrial supplied ${L(m.industrial)} − Transfers out ${L(m.transferOut)} = ${L(m.closing)}.`}
            />
          ) : (
            <StatsCard
              label="Current Tanker Inventory"
              icon={Container}
              value={L(currentStock)}
              hint="As of today"
              info={`${tanker ? `${tanker.name}: ` : "All tankers: "}Σ loaded + transfers in + adjustments − Σ dispensed − Σ industrial supplied − transfers out, all time.`}
            />
          )}
          <StatsCard
            label="Carry Forward Fuel"
            icon={Container}
            value={L(m.opening)}
            hint={m.carriedFrom ? `Carried from ${format(parseISO(`${m.carriedFrom}-01`), "MMMM yyyy")}` : "No previous inventory"}
            info="The previous month's Closing Inventory, which is this period's Opening Inventory. Calculated from the ledger, never entered."
          />
          <StatsCard
            label="Fuel Purchase Cost"
            icon={IndianRupee}
            value={formatINR(m.loadedCost)}
            hint={`${L(m.loaded)} loaded`}
            info="Σ amount (litres × supplier rate) of tanker loads dated in the period. Opening stock, carry-forward diesel, transfers between tankers and remaining stock value are never included."
          />
          <StatsCard label="Diesel Loaded" icon={ArrowDownToLine} value={L(m.loaded)} hint={`${p} · ${formatINR(m.loadedCost)}`} info="Σ litres of tanker loads dated in the period (amount = litres × rate)." />
          <StatsCard
            label="Diesel Dispensed"
            icon={ArrowUpFromLine}
            value={L(m.dispensed)}
            hint={`${p} · fills ${formatINR(fillAmountInPeriod)}`}
            info="Σ litres dispensed in the period: tanker-sourced diesel entries + external-vehicle dispenses. The ₹ is the fills' amount at the rate recorded on each fill."
          />
        </div>
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">
              Tankers ({tankerCount}) · {p}
            </h2>
            <p className="text-xs text-muted-foreground">
              Each tanker&apos;s own stock. Transfers move diesel between tankers and cancel out in the total.
            </p>
          </div>
          {all.some((t) => t.status === "ARCHIVED") && (
            <Button variant={showArchived ? "secondary" : "ghost"} size="sm" onClick={() => setShowArchived((x) => !x)}>
              <Archive /> {showArchived ? "Hide archived" : `Show archived (${all.filter((t) => t.status === "ARCHIVED").length})`}
            </Button>
          )}
        </div>
        {cells.length > 0 && (
          <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {cells.map(({ t, pm }) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelected(t.id)}
                aria-label={`Show ${tankerLabel(t)}`}
                className={`rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted/50 ${t.id === selected ? "ring-2 ring-primary" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-semibold">{t.name}</span>
                  {t.status === "ARCHIVED" && <StatusBadge status="ARCHIVED" />}
                </div>
                <div className="font-mono text-sm">{t.regNo}</div>
                <div className="mt-2 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                  <span>{t.vehicleId ? "Vehicle record linked" : "Not in the vehicle list"}</span>
                  <span>
                    {endedMonth ? "Closing" : "In stock"} <span className="num text-sm font-medium text-foreground">{L(pm.closing)}</span>
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
        <DataTable
          data={comparison}
          getRowId={(r) => r.t.id}
          dense
          showFooter
          pageSize={50}
          onRowClick={(r) => setSelected(r.t.id)}
          emptyMessage="No tankers yet — add one from the ⋮ menu."
          columns={[
            {
              id: "t",
              header: "Tanker",
              cell: (r) => (
                <div className={r.t.id === selected ? "underline" : ""}>
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    {r.t.name}
                    {r.t.status === "ARCHIVED" && <StatusBadge status="ARCHIVED" />}
                    <EditedBadge id={r.t.id} />
                  </span>
                  <div className="font-mono text-xs text-muted-foreground">{r.t.regNo}</div>
                </div>
              ),
              footer: "All tankers",
            },
            { id: "o", header: "Opening", align: "right", cell: (r) => <span className="num">{L(r.pm.opening + r.pm.openingStock)}</span>, footer: L(total((r) => r.pm.opening + r.pm.openingStock)) },
            { id: "l", header: "Loaded", align: "right", cell: (r) => <span className="num">{L(r.pm.loaded)}</span>, footer: L(total((r) => r.pm.loaded)) },
            { id: "tr", header: "Transfers (net)", align: "right", hideOnMobile: true, cell: (r) => <span className="num">{L(r.pm.transferIn - r.pm.transferOut)}</span>, footer: L(total((r) => r.pm.transferIn - r.pm.transferOut)) },
            { id: "a", header: "Adjustments", align: "right", hideOnMobile: true, cell: (r) => <span className="num">{L(r.pm.adjusted)}</span>, footer: L(total((r) => r.pm.adjusted)) },
            { id: "d", header: "Dispensed", align: "right", cell: (r) => <span className="num">{L(r.pm.dispensed)}</span>, footer: L(total((r) => r.pm.dispensed)) },
            { id: "ind", header: "Industrial", align: "right", hideOnMobile: true, cell: (r) => <span className="num">{L(r.pm.industrial)}</span>, footer: L(total((r) => r.pm.industrial)) },
            { id: "c", header: "Closing", align: "right", cell: (r) => <span className="num font-semibold">{L(r.pm.closing)}</span>, footer: L(total((r) => r.pm.closing)) },
            { id: "pc", header: "Purchase Cost", align: "right", hideOnMobile: true, cell: (r) => <span className="num">{formatINR(r.pm.loadedCost)}</span>, footer: formatINR(total((r) => r.pm.loadedCost)) },
            { id: "fa", header: "Fills Amount", align: "right", hideOnMobile: true, cell: (r) => <span className="num">{formatINR(r.fillAmount)}</span>, footer: formatINR(total((r) => r.fillAmount)) },
            {
              id: "act",
              header: "",
              align: "right",
              cell: (r) => (
                <span onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.t.name}`}>
                        <MoreVertical />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onSelect={() => setHistoryOf(r.t.id)}>
                        <History /> History
                      </DropdownMenuItem>
                      {mayManage && (
                        <>
                          <DropdownMenuItem onSelect={() => setEditingTanker({ tanker: r.t })}>
                            <Pencil /> Edit Tanker
                          </DropdownMenuItem>
                          {mayOpen && r.t.status === "ACTIVE" && !hasOpening.has(r.t.id) && (
                            <DropdownMenuItem onSelect={() => setOpeningFor(r.t)}>
                              <PackagePlus /> Record Opening Stock
                            </DropdownMenuItem>
                          )}
                          {r.t.status === "ARCHIVED" ? (
                            <DropdownMenuItem onSelect={() => archive.mutate({ id: r.t.id, version: r.t.updatedAt, restore: true }, { onSuccess: () => toast.success(`${r.t.name} restored`) })}>
                              <ArchiveRestore /> Restore Tanker
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem variant="destructive" onSelect={() => archive.mutate({ id: r.t.id, version: r.t.updatedAt }, { onSuccess: () => toast.success(`${r.t.name} archived — its history stays in every report`) })}>
                              <Archive /> Archive Tanker
                            </DropdownMenuItem>
                          )}
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              ),
            },
          ]}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Monthly tanker ledger · {tanker ? tanker.name : "all tankers"} · each closing carries forward</h2>
        <DataTable
          data={[...ledger].reverse()}
          getRowId={(r) => r.month}
          dense
          pageSize={24}
          emptyMessage="No diesel loaded or dispensed yet."
          columns={[
            { id: "m", header: "Month", cell: (r) => <span className={period.periodMonths?.includes(r.month) ? "font-semibold" : ""}>{monthLabel(r.month)}</span> },
            {
              id: "open",
              header: "Opening Inventory",
              align: "right",
              cell: (r) => {
                const prev = ledger[ledger.indexOf(r) - 1]
                return (
                  <div className="flex flex-col items-end">
                    <span className="num">{L(r.opening + r.openingStock)}</span>
                    {prev && r.opening > 0 && <span className="text-xs text-muted-foreground">Carried forward from {format(parseISO(`${prev.month}-01`), "MMMM")}</span>}
                    {r.openingStock > 0 && <span className="text-xs text-muted-foreground">Opening stock {L(r.openingStock)}</span>}
                  </div>
                )
              },
            },
            { id: "in", header: "Loaded", align: "right", cell: (r) => <span className="num">{L(r.loaded)}</span> },
            ...(scope ? [{ id: "ti", header: "Transfers In", align: "right" as const, hideOnMobile: true, cell: (r: (typeof ledger)[number]) => <span className="num">{L(r.transferIn)}</span> }] : []),
            ...(scope ? [{ id: "to", header: "Transfers Out", align: "right" as const, hideOnMobile: true, cell: (r: (typeof ledger)[number]) => <span className="num">{L(r.transferOut)}</span> }] : []),
            { id: "adj", header: "Adjustments", align: "right", hideOnMobile: true, cell: (r) => <span className="num">{L(r.adjusted)}</span> },
            { id: "out", header: "Dispensed", align: "right", cell: (r) => <span className="num">{L(r.dispensed)}</span> },
            { id: "ind", header: "Industrial", align: "right", hideOnMobile: true, cell: (r) => <span className="num">{L(r.industrial)}</span> },
            { id: "close", header: "Closing Inventory", align: "right", cell: (r) => <span className="num font-semibold">{L(r.closing)}</span> },
          ]}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Loads · {p}</h2>
        <DataTable
          data={loadsInPeriod}
          getRowId={(l) => l.id}
          dense
          pageSize={25}
          emptyMessage={`No diesel loaded in ${p}.`}
          columns={[
            {
              id: "d",
              header: "Date",
              cell: (l) => (
                <span className="inline-flex items-center gap-1.5">
                  <span className="num">{formatDate(l.date)}</span>
                  <EditedBadge id={l.id} />
                </span>
              ),
            },
            ...(scope ? [] : [{ id: "tk", header: "Tanker", cell: (l: TankerLoad) => <span className="text-xs">{d.name(tankerOf(l))}</span> }]),
            { id: "s", header: "Supplier / Fuel Station", cell: (l) => <span className="font-medium">{l.opening ? "Opening stock" : (d.stations.get(l.stationId) ?? "Unknown")}</span> },
            { id: "i", header: "Invoice", hideOnMobile: true, cell: (l) => <span className="text-muted-foreground">{l.invoiceNo || "—"}</span> },
            { id: "l", header: "Litres Loaded", align: "right", cell: (l) => <span className="num">{L(l.litres)}</span> },
            { id: "r", header: "Rate / L", align: "right", cell: (l) => <span className="num">{formatINR(l.rate)}</span> },
            { id: "a", header: "Purchase Cost", align: "right", cell: (l) => <span className="num font-medium">{formatINR(l.amount)}</span> },
            { id: "n", header: "Notes", hideOnMobile: true, cell: (l) => <span className="text-xs text-muted-foreground">{l.notes || "—"}</span> },
            {
              id: "act",
              header: "",
              align: "right",
              cell: (l) => (
                <RowActions
                  lockedReason={(mayEdit || mayDelete) && !open(l.date) ? monthLockedReason(monthLabel(l.date.slice(0, 7))) : null}
                  onEdit={mayEdit && !l.opening ? () => setLoading({ load: l }) : undefined}
                  onDelete={mayDelete ? () => setDeleting({ kind: "load", load: l }) : undefined}
                />
              ),
            },
          ]}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Dispenses · {p}</h2>
        <DataTable
          data={dispensesInPeriod}
          getRowId={(x) => x.id}
          dense
          pageSize={25}
          emptyMessage={`No diesel dispensed in ${p}.`}
          columns={[
            {
              id: "d",
              header: "Date",
              cell: (x) => (
                <span className="inline-flex items-center gap-1.5">
                  <span className="num">{formatDate(x.date)}</span>
                  <EditedBadge id={x.id} />
                </span>
              ),
            },
            ...(scope ? [] : [{ id: "tk", header: "Tanker", cell: (x: DispenseRow) => <span className="text-xs">{d.name(x.tankerId)}</span> }]),
            {
              id: "v",
              header: "Vehicle",
              cell: (x) => (
                <span className="inline-flex items-center gap-1.5 font-medium">
                  {x.vehicle}
                  {x.external ? <StatusBadge status="EXT" label="External" tone="amber" /> : <StatusBadge status="REG" label="Registered" tone="blue" />}
                </span>
              ),
            },
            { id: "x", header: "Details", hideOnMobile: true, cell: (x) => <span className="text-xs text-muted-foreground">{x.detail || "—"}</span> },
            { id: "l", header: "Litres Dispensed", align: "right", cell: (x) => <span className="num">{L(x.litres)}</span> },
            { id: "r", header: "Rate / L", align: "right", hideOnMobile: true, cell: (x) => <span className="num">{x.rate ? formatINR(x.rate) : "avg"}</span> },
            { id: "c", header: "Amount", align: "right", cell: (x) => <span className="num">{formatINR(x.amount)}</span> },
            {
              id: "act",
              header: "",
              align: "right",
              // A registered vehicle's dispense is its diesel entry — edited / deleted on that vehicle's diesel page.
              cell: (x) =>
                !x.external ? (
                  <span className="text-xs text-muted-foreground" title="A diesel entry — edit or delete it on the vehicle's diesel page">
                    Diesel entry
                  </span>
                ) : (
                  <RowActions
                    lockedReason={(mayEdit || mayDelete) && !open(x.date) ? monthLockedReason(monthLabel(x.date.slice(0, 7))) : null}
                    onDelete={mayDelete ? () => setDeleting({ kind: "external", record: x.record! }) : undefined}
                  />
                ),
            },
          ]}
        />
      </section>

      {(movementsInPeriod.length > 0 || d.movements.length > 0) && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Transfers & stock adjustments · {p}</h2>
          <DataTable
            data={movementsInPeriod}
            getRowId={(x) => x.id}
            dense
            pageSize={25}
            emptyMessage={`No transfers or adjustments in ${p}.`}
            columns={[
              {
                id: "d",
                header: "Date",
                cell: (x) => (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="num">{formatDate(x.date)}</span>
                    <EditedBadge id={x.id} />
                  </span>
                ),
              },
              { id: "k", header: "Type", cell: (x) => (x.kind === "TRANSFER" ? <StatusBadge status="TRANSFER" label="Transfer" tone="blue" /> : <StatusBadge status="ADJUST" label="Adjustment" tone="amber" />) },
              { id: "w", header: "Tanker(s)", cell: (x) => <span className="font-medium">{x.what}</span> },
              { id: "l", header: "Litres", align: "right", cell: (x) => <span className="num">{x.kind === "ADJUSTMENT" && x.litres > 0 ? "+" : ""}{L(x.litres)}</span> },
              { id: "n", header: "Reason / Notes", cell: (x) => <span className="text-xs text-muted-foreground">{x.detail || "—"}</span> },
              {
                id: "act",
                header: "",
                align: "right",
                cell: (x) => (
                  <RowActions
                    lockedReason={mayDelete && !open(x.date) ? monthLockedReason(monthLabel(x.date.slice(0, 7))) : null}
                    onDelete={mayDelete ? () => setDeleting(x.transfer ? { kind: "transfer", record: x.transfer } : { kind: "adjustment", record: x.adjustment! }) : undefined}
                  />
                ),
              },
            ]}
          />
        </section>
      )}

      {editingTanker && <TankerDialog key={editingTanker.tanker?.id ?? "new"} tanker={editingTanker.tanker} onOpenChange={(o) => !o && setEditingTanker(null)} />}
      {historyOf && <RecordHistoryDialog recordId={historyOf} onOpenChange={(o) => !o && setHistoryOf(null)} />}
      {openingFor && <OpeningStockDialog tanker={openingFor} onOpenChange={(o) => !o && setOpeningFor(null)} />}
      {loading && <LoadDialog key={loading.load?.id ?? "new"} load={loading.load} tankers={all} defaultTanker={scope} onOpenChange={(o) => !o && setLoading(null)} />}
      {moving && <MovementDialog kind={moving} tankers={all} defaultTanker={scope} records={d.records} onOpenChange={(o) => !o && setMoving(null)} />}
      {deleting && (
        <DeleteDialog
          title={
            deleting.kind === "load" ? "Delete this tanker load?" : deleting.kind === "external" ? "Delete this external dispense?" : deleting.kind === "transfer" ? "Delete this transfer?" : "Delete this stock adjustment?"
          }
          record={
            deleting.kind === "load"
              ? `${d.name(tankerOf(deleting.load))} · ${deleting.load.opening ? "Opening stock" : (d.stations.get(deleting.load.stationId) ?? "Unknown station")} · ${formatDate(deleting.load.date)} · ${L(deleting.load.litres)} · ${formatINR(deleting.load.amount)}`
              : deleting.kind === "external"
                ? `${d.name(tankerOf(deleting.record))} · ${deleting.record.vehicleNo} · ${formatDate(deleting.record.date)} · ${L(deleting.record.litres)}`
                : deleting.kind === "transfer"
                  ? `${d.name(deleting.record.fromTankerId)} → ${d.name(deleting.record.toTankerId)} · ${formatDate(deleting.record.date)} · ${L(deleting.record.litres)}`
                  : `${d.name(deleting.record.tankerId)} · ${formatDate(deleting.record.date)} · ${L(deleting.record.litres)} · ${deleting.record.reason}`
          }
          impact={
            deleting.kind === "load"
              ? "The tanker's inventory, its monthly ledger and carry-forward, Fuel Purchase Cost and the supplier station's purchases and balance are recalculated. Refused if the diesel has already been dispensed."
              : deleting.kind === "transfer"
                ? "The litres go back to the first tanker; both tankers' ledgers are recalculated. Refused if the receiving tanker has already dispensed them."
                : "The tanker's inventory, monthly ledger and carry-forward are recalculated."
          }
          pending={delLoad.isPending || delExternal.isPending || delTransfer.isPending || delAdjustment.isPending}
          onConfirm={async (reason) => {
            if (deleting.kind === "load") await delLoad.mutateAsync({ id: deleting.load.id, version: deleting.load.updatedAt, reason })
            else if (deleting.kind === "external") await delExternal.mutateAsync({ id: deleting.record.id, version: deleting.record.updatedAt, reason })
            else if (deleting.kind === "transfer") await delTransfer.mutateAsync({ id: deleting.record.id, version: deleting.record.updatedAt, reason })
            else await delAdjustment.mutateAsync({ id: deleting.record.id, version: deleting.record.updatedAt, reason })
            toast.success("Deleted")
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ Dialogs */

/** Tankers listed for the period: archived ones only when shown. */
const comparisonTankers = (all: Tanker[], showArchived: boolean) => all.filter((t) => showArchived || t.status !== "ARCHIVED")

/** The tanker picker for new records: active tankers (plus the record's own tanker when editing). */
function tankerOptions(tankers: Tanker[], keep?: string) {
  return tankers.filter((t) => t.status === "ACTIVE" || t.id === keep).map((t) => ({ value: t.id, label: tankerLabel(t) }))
}
const firstActive = (tankers: Tanker[], preferred: string | null) => preferred ?? (tankers.filter((t) => t.status === "ACTIVE").length === 1 ? tankers.find((t) => t.status === "ACTIVE")!.id : "")

/** Add / edit a tanker — no code or schema change needed for a new one. */
function TankerDialog({ tanker, onOpenChange }: { tanker?: Tanker; onOpenChange: (o: boolean) => void }) {
  const { ds } = useDieselIndex()
  const save = useSaveTanker()
  const [f, setF] = useState({
    name: tanker?.name ?? "",
    regNo: tanker?.regNo ?? "",
    vehicleId: tanker?.vehicleId ?? "",
    capacityLitres: tanker?.capacityLitres ? String(tanker.capacityLitres) : "",
    notes: tanker?.notes ?? "",
  })
  const submit = async () => {
    await save.mutateAsync({
      id: tanker?.id, version: tanker?.updatedAt,
      data: {
        name: f.name,
        regNo: f.regNo,
        vehicleId: f.vehicleId || null,
        capacityLitres: f.capacityLitres ? Number(f.capacityLitres) : null,
        notes: f.notes,
      },
    })
    toast.success(tanker ? "Tanker updated" : `${f.name.trim()} added`)
    onOpenChange(false)
  }
  const vehicles = (ds?.vehicles ?? []).filter((v) => v.status !== "ARCHIVED" || v.id === tanker?.vehicleId).sort((a, b) => a.regNo.localeCompare(b.regNo))
  return (
    <FormModal open onOpenChange={onOpenChange} title={tanker ? "Edit tanker" : "Add tanker"} description="Each tanker keeps its own stock. Tankers are archived, never deleted." submitLabel={tanker ? "Save changes" : "Add tanker"} pending={save.isPending} onSubmit={submit} className="sm:max-w-2xl">
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
        <Field label="Tanker name" required>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Tanker TN70AX9480" autoFocus />
        </Field>
        <Field label="Registration number" required hint="Must be unique">
          <Input value={f.regNo} onChange={(e) => setF({ ...f, regNo: e.target.value })} placeholder="e.g. TN70AX9480" className="uppercase placeholder:normal-case" />
        </Field>
        <Field label="Tanker vehicle" hint="Its own fuel is then refused from tanker cargo">
          <SimpleSelect value={f.vehicleId} onChange={(v) => setF({ ...f, vehicleId: v })} placeholder="Not in the vehicle list" options={[{ value: "", label: "Not in the vehicle list" }, ...vehicles.map((v) => ({ value: v.id, label: v.regNo }))]} />
        </Field>
        <Field label="Capacity (L)">
          <Input type="number" min={0} value={f.capacityLitres} onChange={(e) => setF({ ...f, capacityLitres: e.target.value })} placeholder="Not known" />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </FormModal>
  )
}

function LoadDialog({ load, tankers, defaultTanker, onOpenChange }: { load?: TankerLoad; tankers: Tanker[]; defaultTanker: string | null; onOpenChange: (o: boolean) => void }) {
  const { ds } = useDieselIndex()
  const save = useSaveTankerLoad()
  const createPump = useCreateFuelStation()
  const today = todayISO()
  const [f, setF] = useState({
    tankerId: load ? tankerOf(load) : firstActive(tankers, defaultTanker),
    date: load?.date ?? today,
    stationId: load?.stationId ?? "",
    invoiceNo: load?.invoiceNo ?? "",
    litres: load ? String(load.litres) : "",
    rate: load ? String(load.rate) : "",
    notes: load?.notes ?? "",
  })
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const litres = Number(f.litres)
  const rate = Number(f.rate)
  const submit = async () => {
    setError(null)
    if (!f.tankerId) return setError("Choose the tanker")
    if (!f.stationId) return setError("Choose the supplier / fuel station")
    if (!(litres > 0)) return setError("Enter litres loaded")
    if (!(rate > 0)) return setError("Enter the rate per litre")
    await save.mutateAsync({ id: load?.id, version: load?.updatedAt, data: { tankerId: f.tankerId, date: f.date, stationId: f.stationId, invoiceNo: f.invoiceNo, litres, rate, notes: f.notes }, reason })
    toast.success(`${load ? "Load updated" : "Loaded"} — +${L(litres)} into ${tankers.find((t) => t.id === f.tankerId)?.name ?? "the tanker"}`)
    onOpenChange(false)
  }
  return (
    <FormModal open onOpenChange={onOpenChange} title={load ? "Edit tanker load" : "Load Diesel Into Tanker"} description="Increases that tanker's inventory. Owed to the supplier station like any credit purchase." submitLabel={load ? "Save changes" : "Save load"} pending={save.isPending} onSubmit={submit} className="sm:max-w-2xl">
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
        <Field label="Tanker" required>
          <SimpleSelect value={f.tankerId} onChange={(v) => setF({ ...f, tankerId: v })} placeholder="Select tanker" options={tankerOptions(tankers, load && tankerOf(load))} />
        </Field>
        <Field label="Date" required>
          <Input type="date" value={f.date} max={today} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Supplier / Fuel Station" required error={error ?? undefined}>
          <CreatableSelect
            value={f.stationId}
            onChange={(v) => setF({ ...f, stationId: v })}
            options={(ds?.fuelStations ?? []).filter((v) => v.status === "ACTIVE" && !v.isTanker).map((v) => ({ value: v.id, label: v.location ? `${v.name} — ${v.location}` : v.name }))}
            onCreate={createPump}
            placeholder="Select supplier"
          />
        </Field>
        <Field label="Invoice Number">
          <Input value={f.invoiceNo} onChange={(e) => setF({ ...f, invoiceNo: e.target.value })} />
        </Field>
        <Field label="Litres Loaded" required>
          <Input type="number" min={0} step="0.01" value={f.litres} onChange={(e) => setF({ ...f, litres: e.target.value })} autoFocus />
        </Field>
        <Field label="Rate per Litre (₹)" required>
          <Input type="number" min={0} step="0.01" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
        </Field>
        <Field label="Total Amount">
          <div className="flex h-8 items-center rounded-lg border bg-muted/40 px-2.5 text-sm num">{litres > 0 && rate > 0 ? formatINR(litres * rate) : "—"}</div>
        </Field>
        <Field label="Notes">
          <Textarea rows={1} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        {load && <ReasonField value={reason} onChange={setReason} className="sm:col-span-2" />}
      </div>
    </FormModal>
  )
}

/**
 * Fresh-start opening stock for one tanker: litres already in it on a date (e.g. the 31 Oct 2026 dip reading). Adds to
 * that tanker's stock and carries forward; never a purchase, owed to no station. Value is optional.
 */
function OpeningStockDialog({ tanker, onOpenChange }: { tanker: Tanker; onOpenChange: (o: boolean) => void }) {
  const save = useCreateTankerOpening()
  const today = todayISO()
  const [f, setF] = useState({ date: previousMonthEnd(today), litres: "", value: "", notes: "" })
  const [error, setError] = useState<string | null>(null)
  const litres = Number(f.litres)
  const value = f.value.trim() ? Number(f.value) : 0
  const submit = async () => {
    setError(null)
    if (!f.date) return setError("Enter the date of the opening stock")
    if (!(litres > 0)) return setError("Enter the litres in the tanker")
    if (!(value >= 0)) return setError("The value can't be negative")
    await save.mutateAsync({ tankerId: tanker.id, date: f.date, litres, value, notes: f.notes })
    toast.success(`Opening stock recorded — ${L(litres)} in ${tanker.name} on ${formatDate(f.date)}`)
    onOpenChange(false)
  }
  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title={`Opening stock · ${tankerLabel(tanker)}`}
      description="Diesel already in this tanker on that date (e.g. the 31 Oct 2026 dip reading). It becomes the tanker's stock and carries into the next month. It is not a purchase and nothing is owed to any station."
      submitLabel="Save opening stock"
      pending={save.isPending}
      onSubmit={submit}
      className="sm:max-w-2xl"
    >
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
        <Field label="Stock as of" required>
          <Input type="date" value={f.date} max={today} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Litres in the tanker" required error={error ?? undefined}>
          <Input type="number" min={0} step="0.01" value={f.litres} onChange={(e) => setF({ ...f, litres: e.target.value })} autoFocus />
        </Field>
        <Field label="Stock value (₹)" hint="Optional — leave blank if not known. Tanker fills are costed at the rate entered on each fill.">
          <Input type="number" min={0} step="0.01" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
        </Field>
        <Field label="Notes">
          <Textarea rows={1} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="e.g. dip reading" />
        </Field>
      </div>
    </FormModal>
  )
}

/** Transfer between two tankers (never a purchase), or a stock adjustment with a mandatory reason. */
function MovementDialog({ kind, tankers, defaultTanker, records, onOpenChange }: { kind: "TRANSFER" | "ADJUSTMENT"; tankers: Tanker[]; defaultTanker: string | null; records: TankerRecords; onOpenChange: (o: boolean) => void }) {
  const transfer = useCreateTankerTransfer()
  const adjust = useCreateTankerAdjustment()
  const today = todayISO()
  const [f, setF] = useState({ from: firstActive(tankers, defaultTanker), to: "", date: today, litres: "", direction: "-" as "+" | "-", text: "" })
  const [error, setError] = useState<string | null>(null)
  const litres = Number(f.litres)
  // What can leave the tanker ON THE CHOSEN DATE — the API's rule (tankerAvailability): later loads don't count.
  const [openedAt] = useState(() => new Date().toISOString())
  const available = useMemo(
    () => (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? tankerAvailability(records, { id: "new", date: f.date, createdAt: openedAt, tankerId: f.from, kind: kind === "TRANSFER" ? "TRANSFER_OUT" : "FILL" }).available : null),
    [records, f.from, f.date, openedAt, kind]
  )
  const submit = async () => {
    setError(null)
    if (!(litres > 0)) return setError("Enter the litres")
    if (kind === "TRANSFER") {
      if (!f.from || !f.to) return setError("Choose both tankers")
      await transfer.mutateAsync({ date: f.date, fromTankerId: f.from, toTankerId: f.to, litres, notes: f.text })
      toast.success(`Transferred ${L(litres)}`)
    } else {
      if (!f.from) return setError("Choose the tanker")
      await adjust.mutateAsync({ date: f.date, tankerId: f.from, litres: f.direction === "+" ? litres : -litres, reason: f.text })
      toast.success("Stock adjusted")
    }
    onOpenChange(false)
  }
  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title={kind === "TRANSFER" ? "Transfer Between Tankers" : "Adjust Tanker Stock"}
      description={kind === "TRANSFER" ? "Moves diesel from one tanker to another. Not a purchase — company stock doesn't change." : "Corrects a tanker's stock (dip reading, leak, spillage). Recorded in the audit log with its reason."}
      submitLabel={kind === "TRANSFER" ? "Transfer" : "Save adjustment"}
      pending={transfer.isPending || adjust.isPending}
      onSubmit={submit}
      className="sm:max-w-2xl"
    >
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
        <Field label={kind === "TRANSFER" ? "From tanker" : "Tanker"} required hint={available !== null ? `Available on ${formatDate(f.date)}: ${L(available)}` : undefined}>
          <SimpleSelect value={f.from} onChange={(v) => setF({ ...f, from: v })} placeholder="Select tanker" options={tankerOptions(tankers)} />
        </Field>
        {kind === "TRANSFER" ? (
          <Field label="To tanker" required>
            <SimpleSelect value={f.to} onChange={(v) => setF({ ...f, to: v })} placeholder="Select tanker" options={tankerOptions(tankers).filter((o) => o.value !== f.from)} />
          </Field>
        ) : (
          <Field label="Adjustment" required>
            <SimpleSelect value={f.direction} onChange={(v) => setF({ ...f, direction: v as "+" | "-" })} options={[{ value: "-", label: "Remove litres (−)" }, { value: "+", label: "Add litres (+)" }]} />
          </Field>
        )}
        <Field label="Date" required>
          <Input type="date" value={f.date} max={today} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Litres" required error={error ?? undefined}>
          <Input type="number" min={0} step="0.01" value={f.litres} onChange={(e) => setF({ ...f, litres: e.target.value })} autoFocus />
        </Field>
        <Field label={kind === "TRANSFER" ? "Notes" : "Reason"} required={kind === "ADJUSTMENT"} className="sm:col-span-2">
          <Textarea rows={2} value={f.text} placeholder={kind === "ADJUSTMENT" ? "e.g. Dip reading 30 Sep 2026 — 42 L less than the ledger" : undefined} onChange={(e) => setF({ ...f, text: e.target.value })} />
        </Field>
      </div>
    </FormModal>
  )
}
