"use client"

import { inEntryOrder } from "@/domain/payment-order"
import { useMemo, useState } from "react"
import Link from "next/link"
import { Archive, ArchiveRestore, BatteryCharging, Droplet, Fuel, IndianRupee, MapPin, MoreVertical, Pencil, Plus, ReceiptText, Scale, Sigma, Store, Truck, Users } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { DataTable } from "@/components/shared/data-table"
import { EditedBadge, HistoryButton, ReasonField } from "@/components/shared/audit"
import { FormModal } from "@/components/shared/form-modal"
import { EmptyState, Field, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { SimpleSelect } from "@/components/shared/simple-select"
import { StatsCard } from "@/components/shared/stats-card"
import { StatusBadge } from "@/components/shared/status-badge"
import { monthLabel } from "@/domain/diesel"
import { stationSummary, stationTransactions, type StationKind, type StationTxn } from "@/domain/fuel-stations"
import { QUARTERS, inQuarter } from "@/domain/quarters"
import { QuarterComparison } from "@/components/shared/quarter-comparison"
import { balanceType, ledgerFor, openingOf, stationPaymentHistory, stationLedger, tdsDate, tdsDue } from "@/domain/station-ledger"
import { cn } from "@/lib/utils"
import { format, parseISO } from "date-fns"
import { useAddFuelStationPayment, useDeleteFuelStationPayment, useUpdateFuelStationPayment, useArchiveFuelStation, useCreateFuelStation, useFuelStations, useMonthLocks, useRecordStationTds, useSetStationOpeningBalance, useTankerLoads, useUpdateFuelStation } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { canEditMonth } from "@/domain/month-lock"
import { DeleteDialog, RowActions, monthLockedReason } from "@/components/shared/row-actions"
import { formatINR, formatDate, formatNumber, monthKey, previousMonthEnd, todayISO } from "@/lib/format"
import type { CompanyCode, FuelStation, Payment, PaymentMode } from "@/lib/types"
import { useDieselIndex } from "../diesel/parts"
import { isTankerLoadId, loadsAsStationPurchases } from "@/domain/tanker"
import { usePeriod } from "../diesel/period"

/**
 * Fuel Stations — a master entity (vt:fuelStations). The same list feeds the pump field in Diesel
 * and AdBlue entries, so a station created in either place appears in both. Every figure here is
 * derived from transaction history (src/domain/fuel-stations.ts).
 */
function useStationData() {
  const { ds, idx, isLoading } = useDieselIndex()
  const stations = useFuelStations()
  const loads = useTankerLoads()
  const data = useMemo(() => {
    if (!ds || !idx || !stations.data || !loads.data) return null
    // Station purchases = vehicle fills at the pump + diesel loaded into the tanker there (credit).
    // AdBlue is inventory, and the Diesel Tanker itself is cargo, not a pump — neither is here.
    const purchases = [...ds.diesel, ...loadsAsStationPurchases(loads.data, ds.tankers)] as typeof ds.diesel
    const txnsOf = (id: string) => stationTransactions(id, purchases, [], idx.vehicles)
    // Month-by-month ledger carried through the current month (payments: all companies).
    const byId = new Map(stations.data.map((s) => [s.id, s]))
    const ledgerOf = (id: string) => stationLedger(id, purchases, ds.payments, monthKey(todayISO()), openingOf(byId.get(id) ?? {}))
    return { ds, idx, stations: stations.data.filter((v) => !v.isTanker), txnsOf, ledgerOf }
  }, [ds, idx, stations.data, loads.data])
  return { data, isLoading: isLoading || stations.isLoading || loads.isLoading }
}

/** Top Fuel Stations ranking options (quarterly view) — an explicit request, see CLAUDE.md. */
const RANKS = { fuelSpend: "Diesel Spend", dieselLitres: "Diesel Volume" } as const
type RankKey = keyof typeof RANKS

const L = (n: number) => (n ? `${formatNumber(n)} L` : "—")
const KIND_LABEL: Record<StationKind, string> = { DIESEL: "Diesel", PETROL: "Petrol", EV: "EV (kWh)", ADBLUE: "AdBlue" }

/* ------------------------------------------------------------------ Ledger bits */

/** 🔴 Debit (we owe the station) / 🟢 Credit (paid in advance) / Settled. */
function BalanceBadge({ amount, strong }: { amount: number; strong?: boolean }) {
  const t = balanceType(amount)
  if (t === "SETTLED") return <span className="num text-muted-foreground">Settled</span>
  const debit = t === "DEBIT"
  return (
    <span className={cn("num inline-flex items-center gap-1.5 whitespace-nowrap", strong && "font-semibold", debit ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>
      <span className={cn("size-2 rounded-full", debit ? "bg-red-500" : "bg-emerald-500")} />
      {debit ? "Debit" : "Credit"} {formatINR(Math.abs(amount))}
    </span>
  )
}

/** Payments Made, with the part paid in cash at the pump underneath. */
function PaidCell({ paid, manual, cash, tds = 0 }: { paid: number; manual: number; cash: number; tds?: number }) {
  return (
    <div className="flex flex-col items-end">
      <span className="num">{formatINR(paid)}</span>
      {manual > 0 && <span className="text-xs text-muted-foreground">incl. {formatINR(manual)} manual cash</span>}
      {cash > 0 && <span className="text-xs text-muted-foreground">incl. {formatINR(cash)} cash at pump</span>}
      {tds > 0 && <span className="text-xs text-muted-foreground">incl. {formatINR(tds)} TDS</span>}
    </div>
  )
}

/** "Carried forward from September" — colour of the balance it carries. */
function CarriedFrom({ month, amount }: { month: string | null; amount: number }) {
  if (!amount) return null
  return (
    <span className={cn("text-xs", amount > 0 ? "text-red-600/80 dark:text-red-400/80" : "text-emerald-600/80 dark:text-emerald-400/80")}>
      {month ? `Carried forward from ${format(parseISO(`${month}-01`), "MMMM")}` : "Opening balance"}
    </span>
  )
}

/* ------------------------------------------------------------------ List */

export function FuelStations() {
  const can = useCan()
  const { data, isLoading } = useStationData()
  const period = usePeriod(data?.idx ?? null)
  const archive = useArchiveFuelStation()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<FuelStation | null>(null)
  const [archiving, setArchiving] = useState<FuelStation | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [rankBy, setRankBy] = useState<RankKey>("fuelSpend")

  if (!can("diesel")) return <NoAccess what="fuel stations" />
  if (isLoading || !data) return <PageSkeleton />
  const all = data.stations.map((v) => ({ v, s: stationSummary(data.txnsOf(v.id).filter(period.match)) }))
  const ledgers = data.stations.map((v) => ({ v, l: ledgerFor(data.ledgerOf(v.id), period.periodMonths) })).filter((x) => x.l.opening || x.l.purchased || x.l.paid || x.l.closing)
  const tot = {
    purchased: ledgers.reduce((t, x) => t + x.l.purchased, 0),
    paid: ledgers.reduce((t, x) => t + x.l.paid, 0),
    outstanding: ledgers.reduce((t, x) => t + Math.max(0, x.l.closing), 0),
    credit: ledgers.reduce((t, x) => t + Math.max(0, -x.l.closing), 0),
  }
  const ranked = all.filter((x) => x.s[rankBy] > 0).sort((a, b) => b.s[rankBy] - a.s[rankBy])
  const archivedCount = all.filter((x) => x.v.status === "ARCHIVED").length
  const stations = all.filter((x) => showArchived || x.v.status !== "ARCHIVED").sort((a, b) => b.s.combinedSpend - a.s.combinedSpend || a.v.name.localeCompare(b.v.name))

  return (
    <div className="space-y-5">
      <PageHeader
        title="Fuel Stations"
        description="Petrol pumps and the fuel taken at each. The same list as the pump field in Diesel entries."
        actions={
          can("diesel", "create") && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add Fuel Station
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {period.control}
        {archivedCount > 0 && (
          <Button variant={showArchived ? "secondary" : "ghost"} size="sm" onClick={() => setShowArchived((x) => !x)}>
            <Archive /> {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
          </Button>
        )}
      </div>

      {/* Management reads the money first: ledger summary, then the stations, then the detail. */}
      <section>
        <h2 className="mb-2 text-sm font-semibold">Fuel station ledger · {period.label}</h2>
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatsCard label="Fuel Purchased" icon={Fuel} value={formatINR(tot.purchased)} hint={`${period.label} · fuel fills, credit & cash`} info="Σ every fuel fill at all stations in the period (credit and cash) — equals their transaction history. AdBlue is stock (AdBlue Inventory), not a station purchase." />
          <StatsCard label="Payments Made" icon={IndianRupee} value={formatINR(tot.paid)} hint={`${period.label} · vouchers + manual cash + cash at pump`} info="Σ voucher payments + manual cash payments to the stations + cash fills paid at the pump, in the period." />
          <StatsCard label="Outstanding Balance" icon={Sigma} value={<span className="text-red-600 dark:text-red-400">{formatINR(tot.outstanding)}</span>} hint="We owe — Σ debit closing balances" info="Σ closing balances that are Debit (Opening + Purchased − Paid > 0)." />
          <StatsCard label="Credit Balance" icon={Sigma} value={<span className="text-emerald-600 dark:text-emerald-400">{formatINR(tot.credit)}</span>} hint="Paid in advance — Σ credit closing balances" info="Σ closing balances that are Credit (paid more than purchased so far)." />
        </div>
      </section>

      <section>
        <div className="mb-2">
          <h2 className="text-sm font-semibold">Fuel Stations</h2>
          <p className="text-xs text-muted-foreground">View spending, litres and activity for each fuel station · {period.label}</p>
        </div>
        {stations.length === 0 ? (
          <EmptyState icon={Store} title="No fuel stations yet" description="Add one here, or create it while entering a diesel fill." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {stations.map(({ v, s }) => (
              <div key={v.id} className="group relative">
                <Card size="sm" className={`h-full gap-3 px-4 transition-all group-hover:shadow-md group-hover:ring-foreground/20 ${v.status === "ACTIVE" ? "" : "bg-muted/40 opacity-70"}`}>
                  {/* Whole card opens the station; the ⋮ menu sits above this overlay. */}
                  <Link href={`/fuel-stations/${v.id}`} className="absolute inset-0 z-0 rounded-xl" aria-label={`Open ${v.name}`} />
                  {can("diesel", "edit") && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2 z-10" aria-label={`Actions for ${v.name}`}>
                          <MoreVertical />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onSelect={() => setEditing(v)}>
                          <Pencil /> Edit Fuel Station
                        </DropdownMenuItem>
                        {v.status === "ARCHIVED" ? (
                          <DropdownMenuItem
                            onSelect={async () => {
                              await archive.mutateAsync({ id: v.id, restore: true })
                              toast.success(`${v.name} restored`)
                            }}
                          >
                            <ArchiveRestore /> Restore Fuel Station
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem variant="destructive" onSelect={() => setArchiving(v)}>
                            <Archive /> Archive Fuel Station
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <div className="min-w-0 pr-8">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-semibold">{v.name}</span>
                      {v.isInterCompany && <StatusBadge status="IC" label="VT outlet" tone="violet" className="h-4.5 px-1.5 text-[10px]" />}
                      {v.status !== "ACTIVE" && <StatusBadge status={v.status} className="h-4.5 px-1.5 text-[10px]" />}
                      <span className="relative z-10">
                        <EditedBadge id={v.id} />
                      </span>
                    </div>
                    <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                      <MapPin className="size-3" /> {v.location || "No location"}
                    </div>
                  </div>
                  <div>
                    <div className="num text-2xl font-semibold tracking-tight">{formatINR(s.combinedSpend)}</div>
                    <div className="text-xs text-muted-foreground">Total Spend · {period.label}</div>
                  </div>
                  <dl className="grid grid-cols-3 gap-x-3 border-t pt-2.5 text-sm">
                    <Figure label="Diesel" value={L(s.dieselLitres)} />
                    <Figure label="Petrol" value={L(s.petrolLitres)} />
                    <Figure label="Fills" value={s.fills || "—"} />
                  </dl>
                </Card>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Detailed reconciliation last: summary → stations → per-station ledger. */}
      <section>
        <h2 className="mb-2 text-sm font-semibold">Fuel station ledger by station · {period.label}</h2>
        <DataTable
          data={ledgers}
          getRowId={(x) => x.v.id}
          dense
          showFooter
          rowHref={(x) => `/fuel-stations/${x.v.id}`}
          emptyMessage={`No purchases or payments in ${period.label}.`}
          columns={[
            { id: "name", header: "Fuel Station", cell: (x) => <span className="font-medium">{x.v.name}</span>, footer: "Total" },
            {
              id: "open",
              header: "Opening Balance",
              align: "right",
              cell: (x) => (
                <div className="flex flex-col items-end">
                  <BalanceBadge amount={x.l.opening} />
                  <CarriedFrom month={x.l.carriedFrom} amount={x.l.opening} />
                </div>
              ),
            },
            { id: "bought", header: "Fuel Purchased", align: "right", cell: (x) => <span className="num">{formatINR(x.l.purchased)}</span>, footer: formatINR(tot.purchased) },
            { id: "paid", header: "Payments Made", align: "right", cell: (x) => <PaidCell paid={x.l.paid} manual={x.l.manualCash} cash={x.l.cashAtPump} />, footer: formatINR(tot.paid) },
            { id: "close", header: "Closing Balance", align: "right", cell: (x) => <BalanceBadge amount={x.l.closing} strong /> },
          ]}
        />
      </section>

      {period.mode === "quarter" && (
        <>
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Top Fuel Stations · {period.label}</h2>
              <SimpleSelect value={rankBy} onChange={(v) => setRankBy(v as RankKey)} options={(Object.keys(RANKS) as RankKey[]).map((k) => ({ value: k, label: `By ${RANKS[k]}` }))} className="h-8 w-44" />
            </div>
            <DataTable
              data={ranked}
              getRowId={(x) => x.v.id}
              dense
              emptyMessage={`No fuel taken in ${period.label}.`}
              rowHref={(x) => `/fuel-stations/${x.v.id}`}
              columns={[
                { id: "rank", header: "#", cell: (x) => ranked.indexOf(x) + 1 },
                { id: "name", header: "Fuel Station", cell: (x) => <span className="font-medium">{x.v.name}</span> },
                { id: "fs", header: "Diesel Spend", align: "right", cell: (x) => <span className={rankBy === "fuelSpend" ? "font-semibold" : ""}>{x.s.fuelSpend ? formatINR(x.s.fuelSpend) : "—"}</span> },
                { id: "dl", header: "Diesel Volume", align: "right", cell: (x) => <span className={rankBy === "dieselLitres" ? "font-semibold" : ""}>{L(x.s.dieselLitres)}</span> },
              ]}
            />
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold">Quarter comparison · all fuel stations · {period.year}</h2>
            <QuarterComparison
              year={period.year}
              quarters={QUARTERS.map((q) => {
                const qs = stationSummary(data.stations.flatMap((v) => data.txnsOf(v.id)).filter(inQuarter(period.year, q)))
                return { q, spend: qs.combinedSpend, volume: qs.dieselLitres }
              })}
              spendLabel="Combined Spend"
              volumeLabel="Diesel Litres"
            />
          </section>
        </>
      )}

      {adding && <StationDialog onOpenChange={setAdding} />}
      {editing && <StationDialog key={editing.id} station={editing} onOpenChange={(o) => !o && setEditing(null)} />}
      {archiving && (
        <FormModal
          open
          onOpenChange={(o) => !o && setArchiving(null)}
          title={`Archive ${archiving.name}?`}
          description="Its past fuel entries and reports stay exactly as they are. Archived stations can't be picked for new Diesel entries until restored."
          submitLabel="Archive Fuel Station"
          destructive
          pending={archive.isPending}
          onSubmit={async () => {
            await archive.mutateAsync({ id: archiving.id })
            toast.success(`${archiving.name} archived — history kept`)
            setArchiving(null)
          }}
        >
          <span />
        </FormModal>
      )}
    </div>
  )
}

function Figure({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="num truncate font-medium">{value}</dd>
    </div>
  )
}

/** Add (or edit) a fuel station in the master list. */
function StationDialog({ station, onOpenChange }: { station?: FuelStation; onOpenChange: (o: boolean) => void }) {
  const create = useCreateFuelStation()
  const update = useUpdateFuelStation()
  const stations = useFuelStations()
  const [f, setF] = useState({ name: station?.name ?? "", location: station?.location ?? "", creditDays: String(station?.creditDays ?? 30) })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async () => {
    if (!f.name.trim()) return setError("Enter the fuel station name")
    const dup = (stations.data ?? []).find((v) => v.id !== station?.id && v.name.trim().toLowerCase() === f.name.trim().toLowerCase())
    if (dup) return setError(`${dup.name} already exists`)
    setPending(true)
    try {
      const details = { name: f.name, location: f.location, creditDays: Number(f.creditDays) || 0 }
      if (station) await update.mutateAsync({ id: station.id, patch: details })
      else await create(f.name, details)
      toast.success(`${f.name.trim()} ${station ? "updated" : "added — also available in Diesel entries"}`)
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title={station ? "Edit Fuel Station" : "Add Fuel Station"}
      description="Shared with the petrol pump field in Diesel entries."
      submitLabel={station ? "Save changes" : "Add Fuel Station"}
      pending={pending}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required error={error ?? undefined} className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Sri Mahadeshwara Petroleum" autoFocus />
        </Field>
        <Field label="Location">
          <Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="e.g. Bagalur Road" />
        </Field>
        <Field label="Credit days">
          <Input type="number" min={0} value={f.creditDays} onChange={(e) => setF({ ...f, creditDays: e.target.value })} />
        </Field>
      </div>
    </FormModal>
  )
}

/* ------------------------------------------------------------------ Station page */

export function FuelStationDetail({ id }: { id: string }) {
  const can = useCan()
  const { data, isLoading } = useStationData()
  const period = usePeriod(data?.idx ?? null)
  // Payment dialog: {} = add, { payment } = edit; forMonth = the "Paid against" month to suggest.
  const [paying, setPaying] = useState<{ payment?: Payment; forMonth?: string } | null>(null)
  const [deleting, setDeleting] = useState<Payment | null>(null)
  const [tdsFor, setTdsFor] = useState<{ month: string; due: number } | null>(null)
  const [openingOpen, setOpeningOpen] = useState(false)
  const del = useDeleteFuelStationPayment()
  const [role] = useRole()
  const locks = useMonthLocks()
  // Station payments have no grace period (31 Oct 2026): only the Monthly Sheet Lock (non-Owners) — enforced in the API.
  const paymentLock = (date: string) => (!canEditMonth(role, date.slice(0, 7), todayISO(), locks.data ?? []) ? monthLockedReason(monthLabel(date.slice(0, 7))) : null)

  if (!can("diesel")) return <NoAccess what="fuel stations" />
  if (isLoading || !data) return <PageSkeleton />
  const v = data.stations.find((x) => x.id === id)
  if (!v) return <EmptyState icon={Store} title="Fuel station not found" action={<Button variant="outline" asChild><Link href="/fuel-stations">Back to fuel stations</Link></Button>} />

  const ledgerRows = data.ledgerOf(v.id)
  const led = ledgerFor(ledgerRows, period.periodMonths)
  // Payment history for the period: vouchers, manual cash and auto "Cash at Pump" rows — Σ = Payments Made.
  const stationPayments = inEntryOrder(stationPaymentHistory(v.id, data.ds.payments, data.ds.diesel)).filter(period.match)
  const voucherById = new Map(data.ds.payments.map((x) => [x.id, x]))
  const allTxns = data.txnsOf(v.id)
  const txns = allTxns.filter(period.match)
  const s = stationSummary(txns)
  const customers = new Map(data.ds.customers.map((c) => [c.id, c.shortName || c.name]))
  const p = period.label

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {v.name}
            {v.status !== "ACTIVE" && <StatusBadge status={v.status} />}
            <EditedBadge id={v.id} />
          </span>
        }
        backHref="/fuel-stations"
        backLabel="Fuel Stations"
        description={[v.location, `${v.creditDays} credit days`].filter(Boolean).join(" · ")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <HistoryButton id={v.id} />
            {(role === "OWNER" || role === "DEV") && (
              <Button variant="outline" onClick={() => setOpeningOpen(true)}>
                <Scale /> Opening Balance
              </Button>
            )}
            {can("payments", "create") && v.status !== "ARCHIVED" && (
              // Paid today; while an earlier month is shown, it's suggested as the month paid against.
              <Button onClick={() => setPaying({ forMonth: period.mode === "month" ? period.periodMonths?.[0] : undefined })}>
                <Plus /> Add Payment
              </Button>
            )}
          </div>
        }
      />
      {period.control}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Ledger Summary · {p}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatsCard
            label="Opening Balance"
            icon={Sigma}
            value={<BalanceBadge amount={led.opening} />}
            hint={led.carriedFrom && led.opening ? `Carried forward from ${format(parseISO(`${led.carriedFrom}-01`), "MMMM yyyy")}` : p}
            info="Closing balance of the month before this period, carried forward."
          />
          <StatsCard label="Fuel Purchased" icon={Fuel} value={formatINR(led.purchased)} hint={`${p} · fuel fills, credit & cash`} info="Σ every fuel fill here in the period — equals the transaction history (Fuel Spend)." />
          <StatsCard
            label="Payments Made"
            icon={IndianRupee}
            value={formatINR(led.paid)}
            hint={`${formatINR(led.vouchers)} vouchers + ${formatINR(led.manualCash)} manual cash + ${formatINR(led.cashAtPump)} cash at pump${led.tds ? ` + ${formatINR(led.tds)} TDS` : ""}`}
            info={`Voucher payments ${formatINR(led.vouchers)} + manual cash ${formatINR(led.manualCash)} + cash at pump ${formatINR(led.cashAtPump)} + TDS deducted ${formatINR(led.tds)} = ${formatINR(led.paid)}. Every one is a row in the payment history below.`}
          />
          <StatsCard
            label="Closing Balance"
            icon={Sigma}
            value={<BalanceBadge amount={led.closing} strong />}
            hint={balanceType(led.closing) === "DEBIT" ? "We owe the station" : balanceType(led.closing) === "CREDIT" ? "Paid in advance" : "Nothing due"}
            info={`Opening ${formatINR(led.opening)} + Purchased ${formatINR(led.purchased)} − Paid ${formatINR(led.paid)} = ${formatINR(led.closing)}.`}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Monthly ledger · each closing carries forward</h2>
        <DataTable
          data={[...ledgerRows].reverse()}
          getRowId={(r) => r.month}
          dense
          pageSize={24}
          emptyMessage="No credit purchases or payments yet."
          columns={[
            { id: "m", header: "Month", cell: (r) => <span className={period.periodMonths?.includes(r.month) ? "font-semibold" : ""}>{monthLabel(r.month)}</span> },
            {
              id: "open",
              header: "Opening Balance",
              align: "right",
              cell: (r) => (
                <div className="flex flex-col items-end">
                  <BalanceBadge amount={r.opening} />
                  <CarriedFrom month={ledgerRows[ledgerRows.indexOf(r) - 1]?.month ?? null} amount={r.opening} />
                </div>
              ),
            },
            { id: "bought", header: "Fuel Purchased", align: "right", cell: (r) => <span className="num">{formatINR(r.purchased)}</span> },
            { id: "paid", header: "Payments Made", align: "right", cell: (r) => <PaidCell paid={r.paid} manual={r.manualCash} cash={r.cashAtPump} tds={r.tds} /> },
            {
              id: "tds",
              header: "TDS (0.1%)",
              align: "right",
              hideOnMobile: true,
              // Uncle's answer 14: 0.1% of the month's Fuel Purchased, dated the month's last day — one per month.
              cell: (r) => {
                const due = tdsDue(r.purchased)
                const canRecord = !r.tds && due > 0 && tdsDate(r.month) <= todayISO() && !paymentLock(tdsDate(r.month)) && can("payments", "create") && v.status !== "ARCHIVED"
                return (
                  <div className="flex flex-col items-end">
                    <span className="num">{r.tds ? formatINR(r.tds) : "—"}</span>
                    <span className="text-xs text-muted-foreground">0.1% = {formatINR(due)}</span>
                    {canRecord && (
                      <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setTdsFor({ month: r.month, due })}>
                        Record TDS
                      </Button>
                    )}
                  </div>
                )
              },
            },
            { id: "close", header: "Closing Balance", align: "right", cell: (r) => <BalanceBadge amount={r.closing} strong /> },
          ]}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Payments to {v.name} · {p}</h2>
        <DataTable
          data={stationPayments}
          getRowId={(x) => x.id}
          dense
          pageSize={25}
          emptyMessage={`No payments in ${p}.`}
          columns={[
            {
              id: "d",
              header: "Payment date",
              cell: (x) => (
                <span className="inline-flex items-center gap-1.5">
                  <span className="num">{formatDate(x.date)}</span>
                  {!x.readOnly && <EditedBadge id={x.id} />}
                </span>
              ),
            },
            { id: "for", header: "Paid against", cell: (x) => (x.forMonth ? monthLabel(x.forMonth) : <span className="text-muted-foreground">—</span>) },
            { id: "no", header: "Reference", cell: (x) => <span className="font-mono text-xs text-muted-foreground">{x.reference}</span> },
            {
              id: "type",
              header: "Type",
              cell: (x) =>
                x.kind === "CASH_AT_PUMP" ? (
                  <span className="inline-flex flex-wrap gap-1">
                    <StatusBadge status="CASH" label="Cash at Pump" tone="amber" />
                    <StatusBadge status="AUTO" label="Auto Generated" tone="gray" />
                  </span>
                ) : x.kind === "MANUAL_CASH" ? (
                  <StatusBadge status="CASH" label="Manual cash" tone="amber" />
                ) : x.kind === "TDS" ? (
                  <StatusBadge status="TDS" label="TDS deducted" tone="gray" />
                ) : (
                  <StatusBadge status="NEFT" label={`Voucher · ${x.mode}`} tone="blue" />
                ),
            },
            {
              id: "src",
              header: "Source",
              cell: (x) =>
                x.kind === "CASH_AT_PUMP" ? (
                  <span className="text-xs">
                    Fuel transaction · {data.idx.vehicles.get(x.vehicleId ?? "")?.regNo ?? "—"}
                    {x.billNo ? ` · bill ${x.billNo}` : ""}
                  </span>
                ) : (
                  <span className="text-xs">Payment voucher · {x.companyCode}</span>
                ),
            },
            { id: "notes", header: "Notes", cell: (x) => <span className="text-muted-foreground">{x.notes || "—"}</span> },
            { id: "amt", header: "Amount", align: "right", cell: (x) => <span className="num font-medium">{formatINR(x.amount)}</span> },
            {
              id: "act",
              header: "",
              align: "right",
              // Editing is explicit (✏️ / 🗑), and only while the payment's month is open.
              cell: (x) =>
                x.readOnly ? (
                  // Cash at pump follows its fuel entry — never edited or deleted here.
                  <span className="text-xs text-muted-foreground" title="System generated from the cash fuel fill — change the fuel entry instead">
                    Read-only
                  </span>
                ) : (
                  <RowActions
                    editLabel="Edit payment"
                    deleteLabel="Delete payment"
                    lockedReason={paymentLock(x.date)}
                    onEdit={can("payments", "edit") ? () => setPaying({ payment: voucherById.get(x.id) }) : undefined}
                    onDelete={can("payments", "delete") ? () => setDeleting(voucherById.get(x.id) ?? null) : undefined}
                  />
                ),
            },
          ]}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Summary · {p}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          <StatsCard label="Total Diesel Litres" icon={Droplet} value={L(s.dieselLitres)} hint={p} info="Σ litres of fills by Diesel vehicles at this station." />
          <StatsCard label="Total Petrol Litres" icon={Fuel} value={L(s.petrolLitres)} hint={p} info="Σ litres of fills by Petrol vehicles at this station." />
          <StatsCard label="Total EV Usage" icon={BatteryCharging} value={s.evKwh ? `${formatNumber(s.evKwh)} kWh` : "—"} hint={p} info="Σ kWh of charging by EV vehicles at this station." />
          <StatsCard label="Number of Transactions" icon={ReceiptText} value={txns.length} hint={p} info="Count of fuel fills at this station." />
          <StatsCard label="Vehicles Served" icon={Truck} value={s.vehiclesServed} hint={p} info="Distinct vehicles fuelled here." />
          <StatsCard label="Fuel Spend" icon={IndianRupee} value={formatINR(s.fuelSpend)} hint={`${p} · Diesel + Petrol + EV`} info="Σ amount of all fuel fills here (Diesel, Petrol and EV)." />
          <StatsCard label="Customers Served" icon={Users} value={s.customersServed} hint={p} info="Distinct customers the fuelled vehicles were assigned to on each entry's date." />
        </div>
      </section>

      {period.mode === "quarter" && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Quarter comparison · {v.name} · {period.year}</h2>
          <QuarterComparison
            year={period.year}
            quarters={QUARTERS.map((q) => {
              const qs = stationSummary(allTxns.filter(inQuarter(period.year, q)))
              return { q, spend: qs.combinedSpend, volume: qs.dieselLitres }
            })}
            spendLabel="Combined Spend"
            volumeLabel="Diesel Litres"
          />
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Transaction history · {p}</h2>
        <DataTable<StationTxn>
          data={txns}
          getRowId={(t) => t.id}
          initialSort={{ id: "date", desc: true }}
          pageSize={50}
          emptyMessage={`No fuel transactions at this station in ${p.toLowerCase() === "all time" ? "any period" : p}.`}
          columns={[
            {
              id: "date",
              header: "Date",
              sortValue: (t) => t.date,
              cell: (t) => (
                <span className="inline-flex items-center gap-1.5">
                  <span className="num">{formatDate(t.date)}</span>
                  <EditedBadge id={t.id} />
                </span>
              ),
            },
            { id: "veh", header: "Vehicle", sortValue: (t) => data.idx.vehicles.get(t.vehicleId)?.regNo ?? "", cell: (t) => <span className="font-medium">{isTankerLoadId(t.id) ? `Diesel Tanker load${data.idx.vehicles.get(t.vehicleId) ? ` · ${data.idx.vehicles.get(t.vehicleId)!.regNo}` : ""}` : (data.idx.vehicles.get(t.vehicleId)?.regNo ?? "Unknown")}</span> },
            { id: "cust", header: "Customer", sortValue: (t) => customers.get(t.customerId ?? "") ?? "", cell: (t) => <span className="text-muted-foreground">{isTankerLoadId(t.id) ? "Tanker stock" : t.customerId ? (customers.get(t.customerId) ?? "Unknown") : "Unallocated"}</span> },
            { id: "kind", header: "Fuel Type", sortValue: (t) => t.kind, cell: (t) => KIND_LABEL[t.kind] },
            { id: "qty", header: "Litres", align: "right", sortValue: (t) => t.qty, cell: (t) => `${formatNumber(t.qty, 2)}${t.kind === "EV" ? " kWh" : ""}` },
            { id: "rate", header: "Rate", align: "right", sortValue: (t) => t.rate ?? 0, cell: (t) => (t.rate ? formatINR(t.rate) : "—") },
            { id: "amount", header: "Amount", align: "right", sortValue: (t) => t.amount, cell: (t) => formatINR(t.amount) },
          ]}
        />
      </section>
      {openingOpen && <OpeningBalanceDialog station={v} onOpenChange={setOpeningOpen} />}
      {paying && <PaymentDialog key={paying.payment?.id ?? "new"} station={v} payment={paying.payment} forMonth={paying.forMonth} onOpenChange={(o) => !o && setPaying(null)} />}
      {tdsFor && <TdsDialog station={v} month={tdsFor.month} due={tdsFor.due} onOpenChange={(o) => !o && setTdsFor(null)} />}
      {deleting && (
        <DeleteDialog
          title="Delete this payment?"
          submitLabel="Delete Payment"
          record={`${deleting.paymentNo} · ${formatINR(deleting.amount + deleting.tdsAmount)} to ${v.name} · ${formatDate(deleting.date)} · ${deleting.mode}`}
          impact="The station's Payments Made, closing balance and every later month's opening balance go back up by this amount; it also leaves Payments."
          pending={del.isPending}
          onConfirm={async (reason) => {
            await del.mutateAsync({ id: deleting.id, reason })
            toast.success(`${deleting.paymentNo} deleted`)
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}

/**
 * Fresh-start opening balance (Owner / Dev): what was owed to the station (+, Debit) or by it (−, Credit) on a date —
 * e.g. 31 Oct 2026. The ledger starts from it and carries it forward; it is never a purchase or a payment.
 * Refused (API) when the station has records in an earlier month, where it would be ignored. 0 removes it.
 */
function OpeningBalanceDialog({ station, onOpenChange }: { station: FuelStation; onOpenChange: (o: boolean) => void }) {
  const save = useSetStationOpeningBalance()
  const today = todayISO()
  const has = !!(station.openingBalance && station.openingBalanceDate)
  const [f, setF] = useState({
    date: has ? station.openingBalanceDate! : previousMonthEnd(today),
    amount: has ? String(Math.abs(station.openingBalance!)) : "",
    side: has && station.openingBalance! < 0 ? "CREDIT" : "DEBIT",
  })
  const [error, setError] = useState<string | null>(null)
  const amount = Number(f.amount) * (f.side === "CREDIT" ? -1 : 1)
  const submit = async () => {
    setError(null)
    if (!f.date) return setError("Enter the date the balance applies on")
    if (!f.amount.trim() || !(Number(f.amount) >= 0)) return setError("Enter the balance (0 removes it)")
    await save.mutateAsync({ id: station.id, amount, date: f.date })
    toast.success(amount ? `Opening balance saved — ${formatINR(Math.abs(amount))} ${amount > 0 ? "Debit (we owe)" : "Credit"} as of ${formatDate(f.date)}` : "Opening balance removed")
    onOpenChange(false)
  }
  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title={`Opening balance · ${station.name}`}
      description="The balance with this station on that date (e.g. 31 Oct 2026, from the supplier statement). The ledger starts from it and carries it into the next month. It is not a purchase or a payment."
      submitLabel="Save opening balance"
      pending={save.isPending}
      onSubmit={submit}
    >
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
        <Field label="Balance as of" required>
          <Input type="date" value={f.date} max={today} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Type" required>
          <SimpleSelect value={f.side} onChange={(v) => setF({ ...f, side: v })} options={[{ value: "DEBIT", label: "Debit — we owe the station" }, { value: "CREDIT", label: "Credit — the station owes us / advance paid" }]} />
        </Field>
        <Field label="Amount (₹)" required error={error ?? undefined} hint={has ? "Enter 0 to remove the opening balance" : undefined}>
          <Input type="number" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus />
        </Field>
      </div>
    </FormModal>
  )
}

/** Fuel Stations → station → Add Payment. Saved as a “Diesel vendor payment” voucher (also in Payments). */
function PaymentDialog({ station, payment, forMonth, onOpenChange }: { station: FuelStation; payment?: Payment; forMonth?: string; onOpenChange: (o: boolean) => void }) {
  const add = useAddFuelStationPayment()
  const update = useUpdateFuelStationPayment()
  const today = todayISO()
  // A TDS entry: only its amount and notes can change; it stays on its month's last day.
  const isTds = !!payment && !payment.amount && payment.tdsAmount > 0
  const [f, setF] = useState({
    date: payment?.date ?? today,
    // Paid against: the month's purchases this settles — never moves the payment off its payment date in the ledger.
    forMonth: payment ? (payment.forMonth ?? "") : (forMonth ?? today.slice(0, 7)),
    amount: payment ? String(payment.amount || payment.tdsAmount) : "",
    mode: (payment?.mode ?? "NEFT") as PaymentMode,
    company: (payment?.companyCode ?? "VT") as CompanyCode,
    notes: payment?.notes ?? "",
  })
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const submit = async () => {
    const amount = Number(f.amount)
    if (!(amount > 0)) return setError("Enter the amount paid")
    if (!f.date || f.date > today) return setError("Pick a payment date up to today")
    if (!isTds && !f.forMonth) return setError("Choose the month this payment is against")
    if (!isTds && f.forMonth > f.date.slice(0, 7)) return setError("The month paid against can't be after the payment date")
    const forMonth = isTds ? undefined : f.forMonth
    if (payment) await update.mutateAsync({ id: payment.id, patch: { paymentDate: f.date, amount, paymentMode: f.mode, notes: f.notes.trim(), forMonth }, reason })
    else await add.mutateAsync({ stationId: station.id, paymentDate: f.date, amount, paymentMode: f.mode, notes: f.notes.trim(), companyCode: f.company, forMonth })
    toast.success(payment ? `${payment.paymentNo} updated` : `Payment of ${formatINR(amount)} to ${station.name} recorded`)
    onOpenChange(false)
  }
  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title={payment ? `Edit Payment ${payment.paymentNo}` : "Add Payment"}
      description={`${station.name} · reduces what we owe this station`}
      submitLabel={payment ? "Save changes" : "Save payment"}
      pending={add.isPending || update.isPending}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Payment date" required hint={isTds ? "TDS is dated the last day of its month" : "The day the money was paid — the ledger counts it in this month"}>
          <Input type="date" value={f.date} max={today} disabled={isTds} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        {!isTds && (
          <Field label="Paid against (month)" required hint="Which month's fuel purchases this payment is for">
            <Input type="month" value={f.forMonth} max={f.date.slice(0, 7)} onChange={(e) => setF({ ...f, forMonth: e.target.value })} />
          </Field>
        )}
        <Field label="Amount (₹)" required error={error ?? undefined}>
          <Input type="number" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus />
        </Field>
        {!isTds && (
          <Field label="Payment mode" required>
            <SimpleSelect value={f.mode} onChange={(v) => setF({ ...f, mode: v as PaymentMode })} options={(["NEFT", "UPI", "CHEQUE", "CASH"] as const).map((m) => ({ value: m, label: m }))} />
          </Field>
        )}
        <Field label="Paid by" hint={payment ? "Fixed — the voucher number belongs to this company" : "The company that made the payment (VT / VTHPL)"}>
          <SimpleSelect disabled={!!payment} value={f.company} onChange={(v) => setF({ ...f, company: v as CompanyCode })} options={[{ value: "VT", label: "Vishal Transport (VT)" }, { value: "VTHPL", label: "VTHPL" }]} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="e.g. September settlement, UTR 1234" />
        </Field>
        {payment && <ReasonField value={reason} onChange={setReason} className="sm:col-span-2" />}
      </div>
    </FormModal>
  )
}

/**
 * TDS on this station's fuel bills for one month (uncle's answer 14): dated the month's last day, suggested
 * at 0.1% of that month's Fuel Purchased. Settles that much of the balance; no money leaves the bank.
 */
function TdsDialog({ station, month, due, onOpenChange }: { station: FuelStation; month: string; due: number; onOpenChange: (o: boolean) => void }) {
  const record = useRecordStationTds()
  const [f, setF] = useState({ amount: String(due), company: "VT" as CompanyCode, notes: "" })
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    const amount = Number(f.amount)
    if (!(amount > 0)) return setError("Enter the TDS amount")
    await record.mutateAsync({ stationId: station.id, month, amount, companyCode: f.company, notes: f.notes })
    toast.success(`TDS of ${formatINR(amount)} recorded for ${monthLabel(month)}`)
    onOpenChange(false)
  }
  return (
    <FormModal open onOpenChange={onOpenChange} title={`Record TDS · ${monthLabel(month)}`} description={`${station.name} · dated ${formatDate(tdsDate(month))} · reduces what we owe this station`} submitLabel="Record TDS" pending={record.isPending} onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="TDS amount (₹)" required error={error ?? undefined} hint={`0.1% of ${monthLabel(month)} Fuel Purchased = ${formatINR(due)}. Enter the amount actually deducted if it differs.`}>
          <Input type="number" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus />
        </Field>
        <Field label="Deducted by">
          <SimpleSelect value={f.company} onChange={(v) => setF({ ...f, company: v as CompanyCode })} options={[{ value: "VT", label: "Vishal Transport (VT)" }, { value: "VTHPL", label: "VTHPL" }]} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="e.g. Challan no." />
        </Field>
      </div>
    </FormModal>
  )
}
