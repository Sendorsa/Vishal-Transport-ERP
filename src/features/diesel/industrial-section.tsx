"use client"

import { useMemo, useState } from "react"
import { Factory, Fuel, Hash, IndianRupee, Plus, Scale, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DataTable } from "@/components/shared/data-table"
import { SearchBar } from "@/components/shared/filter-bar"
import { FormModal } from "@/components/shared/form-modal"
import { EmptyState, Field } from "@/components/shared/misc"
import { DeleteDialog, RowActions, monthLockedReason } from "@/components/shared/row-actions"
import { SimpleSelect } from "@/components/shared/simple-select"
import { StatsCard } from "@/components/shared/stats-card"
import { deletionReasonError } from "@/domain/audit"
import { monthLabel, type buildDieselIndex } from "@/domain/diesel"
import { INDUSTRIAL_PURPOSES, OTHER_PURPOSE, allocationProblem, industrialAmount, industrialTotals } from "@/domain/industrial"
import { availabilityMessage, fitsTanker, isStockPool, tankerAvailability, tankerLabel } from "@/domain/tanker"
import { canEditMonth } from "@/domain/month-lock"
import { inEntryOrder } from "@/domain/payment-order"
import { statusOn } from "@/domain/status-history"
import { useDeleteIndustrialSupply, useDieselEntries, useIndustrialSupplies, useMonthLocks, useSaveIndustrialSupply, useTankerAdjustments, useTankerDispenses, useTankerLoads, useTankerTransfers, useTankers } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber, todayISO } from "@/lib/format"
import type { Customer, IndustrialSupply } from "@/lib/types"
import { usePeriod } from "./period"

const L = (n: number) => `${formatNumber(n, 3)} L`
const ratePerL = (n: number) => `${formatINR(n)} / L`

/**
 * Diesel → customer → Industrial Use (owner, 12 Nov 2026): the customer's Industrial Diesel Supply register — diesel
 * supplied for a generator, machinery, a factory, never a vehicle. Separate from the vehicle section above: no vehicle
 * figure, stock, station or payment reads it. The cards are the selected period's supplies; search and the date range
 * narrow the register only (its footer totals the rows shown).
 */
export function IndustrialSection({ customer, idx }: { customer: Customer; idx: ReturnType<typeof buildDieselIndex> | null }) {
  const can = useCan()
  const [role] = useRole()
  const supplies = useIndustrialSupplies()
  const tankers = useTankers()
  const tankerName = (id: string) => tankers.data?.find((t) => t.id === id)?.name ?? "Tanker"
  const sources = (x: IndustrialSupply) => x.allocations.map((a) => `${tankerName(a.tankerId)} ${formatNumber(a.litres, 3)} L`).join(" + ")
  const locks = useMonthLocks()
  const del = useDeleteIndustrialSupply()
  const period = usePeriod(idx)
  const [q, setQ] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [editing, setEditing] = useState<{ supply?: IndustrialSupply } | null>(null)
  const [deleting, setDeleting] = useState<IndustrialSupply | null>(null)

  const inPeriod = useMemo(() => inEntryOrder((supplies.data ?? []).filter((x) => x.customerId === customer.id && period.match(x))), [supplies.data, customer.id, period])
  const needle = q.trim().toLowerCase()
  const shown = inPeriod.filter((x) => (!from || x.date >= from) && (!to || x.date <= to) && (!needle || `${x.purpose} ${x.remarks}`.toLowerCase().includes(needle)))
  const t = industrialTotals(inPeriod)
  const shownTotals = industrialTotals(shown)
  const p = period.label
  const today = todayISO()
  const mayAdd = can("diesel", "create") && statusOn(customer, today) !== "ARCHIVED"
  const mayEdit = can("diesel", "edit")
  const mayDelete = can("diesel", "delete")
  const open = (x: IndustrialSupply) => canEditMonth(role, x.date.slice(0, 7), today, locks.data ?? [])
  const filtered = !!(needle || from || to)

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Factory className="size-4 text-muted-foreground" /> Industrial Use
          </h2>
          <p className="text-sm text-muted-foreground">Industrial Diesel Supply · diesel supplied to {customer.shortName || customer.name} for generators, machinery and other non-vehicle use. Kept apart from vehicle Diesel.</p>
        </div>
        {mayAdd && (
          <Button onClick={() => setEditing({})}>
            <Plus /> Add Industrial Supply
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">{period.control}</div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatsCard label="Total Diesel Supplied" icon={Fuel} value={L(t.litres)} hint={p} isLoading={supplies.isLoading} info="Σ litres of this customer's industrial supplies dated in the period." />
        <StatsCard label="Total Supply Value" icon={IndianRupee} value={formatINR(t.value)} hint={p} isLoading={supplies.isLoading} info="Σ amount (litres × that supply's rate) of the industrial supplies dated in the period." />
        <StatsCard
          label="Weighted Average Rate"
          icon={Scale}
          value={t.avgRate === null ? "—" : ratePerL(t.avgRate)}
          hint={p}
          isLoading={supplies.isLoading}
          info={t.avgRate === null ? "Total Supply Value ÷ Total Diesel Supplied — no supplies in the period." : `Total Supply Value ÷ Total Diesel Supplied = ${formatINR(t.value)} ÷ ${L(t.litres)}.`}
        />
        <StatsCard label="Supply Entries" icon={Hash} value={t.count} hint={p} isLoading={supplies.isLoading} info="Number of industrial supplies dated in the period." />
      </div>

      {supplies.error ? (
        <EmptyState icon={Factory} title="Industrial supplies couldn't be loaded" description={supplies.error instanceof Error ? supplies.error.message : "Try again in a moment."} />
      ) : !supplies.isLoading && inPeriod.length === 0 ? (
        <EmptyState
          icon={Factory}
          title={`No industrial supplies · ${p}`}
          description={mayAdd ? "Record diesel supplied to this customer for industrial use with Add Industrial Supply." : "Industrial Diesel supplied to this customer appears here."}
        />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <SearchBar value={q} onChange={setQ} placeholder="Search purpose or remarks…" className="sm:w-72" />
            <label className="grid gap-1 text-xs text-muted-foreground">
              From
              <Input type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40" />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              To
              <Input type="date" value={to} min={from || undefined} max={today} onChange={(e) => setTo(e.target.value)} className="h-8 w-40" />
            </label>
            {filtered && (
              <Button variant="ghost" size="sm" onClick={() => (setQ(""), setFrom(""), setTo(""))}>
                Clear filters
              </Button>
            )}
          </div>
          <DataTable
            data={shown}
            getRowId={(x) => x.id}
            isLoading={supplies.isLoading}
            pageSize={20}
            showFooter
            emptyMessage="No industrial supply matches the search or dates."
            columns={[
              { id: "date", header: "Date", sortValue: (x) => x.date, cell: (x) => <span className="num">{formatDate(x.date)}</span>, footer: filtered ? `${shownTotals.count} shown` : "Total" },
              { id: "litres", header: "Quantity (L)", align: "right", sortValue: (x) => x.litres, cell: (x) => <span className="num">{formatNumber(x.litres, 3)}</span>, footer: <span className="num">{formatNumber(shownTotals.litres, 3)}</span> },
              { id: "rate", header: "Rate / L", align: "right", sortValue: (x) => x.rate, cell: (x) => <span className="num">{formatINR(x.rate)}</span>, footer: shownTotals.avgRate === null ? "" : <span className="num text-muted-foreground">avg {formatINR(shownTotals.avgRate)}</span> },
              { id: "amount", header: "Total Amount", align: "right", sortValue: (x) => x.amount, cell: (x) => <span className="num font-medium">{formatINR(x.amount)}</span>, footer: <span className="num">{formatINR(shownTotals.value)}</span> },
              { id: "purpose", header: "Purpose", sortValue: (x) => x.purpose, cell: (x) => x.purpose },
              { id: "src", header: "Source tankers", hideOnMobile: true, cell: (x) => <span className="text-xs">{sources(x)}</span> },
              { id: "remarks", header: "Remarks", hideOnMobile: true, cell: (x) => <span className="text-muted-foreground">{x.remarks || "—"}</span> },
              {
                id: "act",
                header: "",
                align: "right",
                cell: (x) => (
                  <RowActions
                    lockedReason={(mayEdit || mayDelete) && !open(x) ? monthLockedReason(monthLabel(x.date.slice(0, 7))) : null}
                    onEdit={mayEdit && open(x) ? () => setEditing({ supply: x }) : undefined}
                    onDelete={mayDelete && open(x) ? () => setDeleting(x) : undefined}
                    editLabel="Edit industrial supply"
                    deleteLabel="Delete industrial supply"
                  />
                ),
              },
            ]}
          />
        </div>
      )}

      {editing && <IndustrialSupplyDialog key={editing.supply?.id ?? "new"} customer={customer} supply={editing.supply} onClose={() => setEditing(null)} />}
      {deleting && (
        <DeleteDialog
          title="Delete this industrial supply?"
          record={`${customer.shortName || customer.name} · ${formatDate(deleting.date)} · ${L(deleting.litres)} @ ${ratePerL(deleting.rate)} · ${formatINR(deleting.amount)} · ${deleting.purpose} · from ${sources(deleting)}`}
          impact={`The litres go back into ${deleting.allocations.map((a) => tankerName(a.tankerId)).join(" and ")} (tanker stock, ledger and carry-forward recalculated), and this customer's industrial supply totals change. Vehicle Diesel, KM Run, mileage, AdBlue, fuel stations and payments are not affected.`}
          pending={del.isPending}
          onConfirm={(reason) => del.mutateAsync({ id: deleting.id, version: deleting.updatedAt, reason })}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  )
}

/** Add (no `supply`) or edit an industrial supply. Total = litres × rate, calculated as you type; never typed. */
function IndustrialSupplyDialog({ customer, supply, onClose }: { customer: Customer; supply?: IndustrialSupply; onClose: () => void }) {
  const save = useSaveIndustrialSupply()
  const today = todayISO()
  // The tankers' stock, as every other tanker draw sees it (domain/tanker.ts): the API checks the same on save.
  const tankers = useTankers()
  const loads = useTankerLoads()
  const fills = useDieselEntries()
  const external = useTankerDispenses()
  const transfers = useTankerTransfers()
  const adjustments = useTankerAdjustments()
  const industrial = useIndustrialSupplies()
  const records = useMemo(
    () => ({ loads: loads.data ?? [], fills: fills.data ?? [], external: external.data ?? [], transfers: transfers.data ?? [], adjustments: adjustments.data ?? [], industrial: industrial.data ?? [] }),
    [loads.data, fills.data, external.data, transfers.data, adjustments.data, industrial.data]
  )
  const [openedAt] = useState(() => new Date().toISOString())
  const original = supply?.allocations.map((a) => a.tankerId) ?? []
  // Active company tankers (never a stock pool); an archived tanker stays on a supply that already used it.
  const choosable = (tankers.data ?? []).filter((t) => !isStockPool(t) && (t.status !== "ARCHIVED" || original.includes(t.id)))
  const [rows, setRows] = useState<{ tankerId: string; litres: string }[]>(supply ? supply.allocations.map((a) => ({ tankerId: a.tankerId, litres: String(a.litres) })) : [{ tankerId: "", litres: "" }])
  const known = (INDUSTRIAL_PURPOSES as readonly string[]).includes(supply?.purpose ?? "")
  const [f, setF] = useState({
    date: supply?.date ?? today,
    litres: supply ? String(supply.litres) : "",
    rate: supply ? String(supply.rate) : "",
    purpose: supply ? (known ? supply.purpose : OTHER_PURPOSE) : "",
    otherPurpose: supply && !known ? supply.purpose : "",
    remarks: supply?.remarks ?? "",
  })
  const [reason, setReason] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }))
  const litres = Number(f.litres)
  const rate = Number(f.rate)
  const total = f.litres !== "" && f.rate !== "" && litres > 0 && rate > 0 ? industrialAmount(litres, rate) : null
  const purpose = f.purpose === OTHER_PURPOSE ? f.otherPurpose.trim() : f.purpose
  // One tanker: all the litres come from it. Several: each row says how many.
  const allocations = rows.map((r) => ({ tankerId: r.tankerId, litres: rows.length === 1 ? litres : Number(r.litres) }))
  const allocated = allocations.reduce((t, a) => t + (Number.isFinite(a.litres) ? a.litres : 0), 0)
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(f.date)
  const availableIn = (tankerId: string) => (tankerId && validDate ? tankerAvailability(records, { id: supply?.id ?? "new", date: f.date, createdAt: supply?.createdAt ?? openedAt, tankerId, kind: "INDUSTRIAL" }) : null)
  const setRow = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const submit = async () => {
    const e: Record<string, string> = {}
    if (!f.date || f.date > today) e.date = "Pick the supply date (not in the future)"
    if (!(litres > 0)) e.litres = "Enter the litres supplied (more than 0)"
    if (!(rate > 0)) e.rate = "Enter the rate per litre (more than ₹0)"
    if (!f.purpose) e.purpose = "Choose the purpose"
    else if (f.purpose === OTHER_PURPOSE && !purpose) e.otherPurpose = "Describe the purpose"
    if (!e.litres) {
      const problem = allocationProblem(litres, allocations)
      if (problem) e.allocations = problem
      else
        for (const a of allocations) {
          const av = availableIn(a.tankerId)
          if (av && !fitsTanker(av, a.litres)) e.allocations = availabilityMessage(av, tankerLabel(choosable.find((t) => t.id === a.tankerId) ?? { name: "the tanker", regNo: "" }), f.date)
        }
    }
    const why = supply ? deletionReasonError(reason, "correcting") : null
    if (why) e.reason = why
    setErrors(e)
    if (Object.keys(e).length) return
    await save.mutateAsync({
      id: supply?.id,
      version: supply?.updatedAt,
      reason: supply ? reason : undefined,
      data: { customerId: customer.id, date: f.date, litres, rate, purpose, remarks: f.remarks.trim(), allocations },
    })
    toast.success(`Industrial supply ${supply ? "updated" : "saved"} — ${L(litres)}, ${formatINR(industrialAmount(litres, rate))}`)
    onClose()
  }

  return (
    <FormModal
      open
      onOpenChange={(o) => !o && onClose()}
      title={supply ? "Edit industrial supply" : "Add industrial supply"}
      description={`${customer.shortName || customer.name} · Industrial Diesel Supply — not linked to any vehicle`}
      submitLabel={supply ? "Update supply" : "Save supply"}
      pending={save.isPending}
      onSubmit={submit}
      className="sm:max-w-2xl"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supply Date" required error={errors.date}>
          <Input type="date" value={f.date} max={today} onChange={(e) => set("date")(e.target.value)} />
        </Field>
        <Field label="Quantity (Litres)" required error={errors.litres}>
          <Input type="number" inputMode="decimal" step="0.001" min={0} value={f.litres} onChange={(e) => set("litres")(e.target.value)} placeholder="e.g. 500" />
        </Field>
        <Field label="Rate per Litre (₹)" required error={errors.rate} hint="The rate of this supply — kept with it">
          <Input type="number" inputMode="decimal" step="0.0001" min={0} value={f.rate} onChange={(e) => set("rate")(e.target.value)} placeholder="e.g. 94.50" />
        </Field>
        <Field label="Total Amount (₹)" hint="Quantity × rate — calculated, not typed">
          <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm num font-medium" aria-live="polite">{total === null ? "—" : formatINR(total)}</div>
        </Field>
        <Field label="Purpose" required error={errors.purpose}>
          <SimpleSelect value={f.purpose} onChange={set("purpose")} placeholder="Select purpose" options={[...INDUSTRIAL_PURPOSES, OTHER_PURPOSE].map((x) => ({ value: x, label: x }))} />
        </Field>
        {f.purpose === OTHER_PURPOSE && (
          <Field label="Describe the purpose" required error={errors.otherPurpose}>
            <Input value={f.otherPurpose} onChange={(e) => set("otherPurpose")(e.target.value)} placeholder="e.g. Borewell pump" maxLength={120} />
          </Field>
        )}
        <div className="grid gap-2 rounded-lg border p-3 sm:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">Source tanker{rows.length > 1 ? "s" : ""}</span>
            <span className={`num text-xs ${f.litres !== "" && Math.round(allocated * 1000) !== Math.round(litres * 1000) ? "text-destructive" : "text-muted-foreground"}`}>
              Allocated {formatNumber(allocated, 3)} L of {f.litres === "" ? "—" : `${formatNumber(litres, 3)} L`}
            </span>
          </div>
          {rows.map((r, i) => {
            const av = availableIn(r.tankerId)
            return (
              <div key={i} className="grid grid-cols-[1fr_8rem_auto] items-start gap-2">
                <div className="grid gap-1">
                  <SimpleSelect
                    value={r.tankerId}
                    onChange={(v) => setRow(i, { tankerId: v })}
                    placeholder="Select tanker"
                    options={choosable.filter((t) => t.id === r.tankerId || !rows.some((x) => x.tankerId === t.id)).map((t) => ({ value: t.id, label: tankerLabel(t) }))}
                  />
                  <span className="num text-xs text-muted-foreground">{av ? `Available on ${formatDate(f.date)}: ${formatNumber(av.available, 2)} L` : "Pick the tanker and the date to see its stock"}</span>
                </div>
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.001"
                  min={0}
                  aria-label="Litres from this tanker"
                  value={rows.length === 1 ? f.litres : r.litres}
                  disabled={rows.length === 1}
                  onChange={(e) => setRow(i, { litres: e.target.value })}
                  placeholder="Litres"
                />
                <Button variant="ghost" size="icon-sm" aria-label="Remove this tanker" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                  <X />
                </Button>
              </div>
            )
          })}
          {errors.allocations && <p className="text-xs text-destructive">{errors.allocations}</p>}
          {rows.length < choosable.length && (
            <Button
              variant="outline"
              size="sm"
              className="justify-self-start"
              onClick={() => setRows((rs) => [...(rs.length === 1 ? [{ ...rs[0], litres: f.litres }] : rs), { tankerId: "", litres: "" }])}
            >
              <Plus /> Split across another tanker
            </Button>
          )}
        </div>
        <Field label="Remarks" className="sm:col-span-2">
          <Textarea rows={2} value={f.remarks} onChange={(e) => set("remarks")(e.target.value)} maxLength={500} />
        </Field>
        {supply && (
          <Field label="Reason for change" required error={errors.reason} hint="Saved in the record's edit history" className="sm:col-span-2">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong rate entered" maxLength={200} />
          </Field>
        )}
      </div>
    </FormModal>
  )
}
