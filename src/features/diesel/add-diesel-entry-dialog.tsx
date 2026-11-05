"use client"

import { useMemo, useState } from "react"
import { endOfMonth, parseISO } from "date-fns"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { FormModal } from "@/components/shared/form-modal"
import { ReasonField } from "@/components/shared/audit"
import { Field } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { useCreateDiesel, useCreateFuelStation, useDieselEntries, useFuelStations, useTankerAdjustments, useTankerDispenses, useTankerLoads, useTankerTransfers, useTankers, useUpdateDiesel } from "@/lib/api/hooks"
import { fillMileage, fillOrder, odometerConflict } from "@/domain/diesel"
import { TANKER_SOURCE_ID, insufficientTankerMessage, isStockPool, tankerLabel, tankerOf, valueTankers } from "@/domain/tanker"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { fuelLabel } from "@/lib/constants"
import { formatDate, formatINR, formatNumber, round2, toISODate, todayISO } from "@/lib/format"
import type { Customer, DieselEntry, Vehicle } from "@/lib/types"

/** The "Direct petrol pump" diesel source; every other source value is a tanker id. */
const PUMP = "PUMP"
/** A read-only value in the form (fuel type, tanker stock, payment): an input's height and border, muted, never overflowing. */
const READ_ONLY_BOX = "flex min-h-8 min-w-0 items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1 text-sm"
/** A select whose long value (e.g. a historical stock name) ends in "…" instead of widening its column. */
const TRUNCATE_SELECT = "min-w-0 *:data-[slot=select-value]:block! *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate"

/**
 * Adds — or, with `entry`, edits — a fill for one vehicle, costed to one customer, inside one month.
 * Opened only from the vehicle diesel screen, so customer, vehicle and month come from context.
 * Mount with `key={entry.id}` when editing so the form starts from that entry.
 */
export function AddDieselEntryDialog({
  open,
  onOpenChange,
  vehicle,
  customer,
  month,
  entry,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  vehicle: Vehicle
  customer: Customer | null
  month: string
  entry?: DieselEntry
}) {
  const stations = useFuelStations()
  const entries = useDieselEntries()
  const create = useCreateDiesel()
  const update = useUpdateDiesel()
  const createPump = useCreateFuelStation()
  const tankers = useTankers()
  const loads = useTankerLoads()
  const external = useTankerDispenses()
  const transfers = useTankerTransfers()
  const adjustments = useTankerAdjustments()
  const today = todayISO()
  const monthEnd = toISODate(endOfMonth(parseISO(`${month}-01`)))
  const maxDate = monthEnd < today ? monthEnd : today
  const defaultDate = maxDate

  const blank = entry
    ? { date: entry.date, vendorId: entry.vendorId, litres: String(entry.litres), rate: String(entry.rate), odometerKm: entry.odometerKm === null ? "" : String(entry.odometerKm), billNo: entry.billNo, paymentMode: entry.paymentMode as string, tankerId: entry.vendorId === TANKER_SOURCE_ID ? tankerOf(entry) : "" }
    : { date: defaultDate, vendorId: "", litres: "", rate: "", odometerKm: "", billNo: "", paymentMode: "CREDIT", tankerId: "" }
  const [f, setF] = useState(blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [reason, setReason] = useState("")
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }))

  const vehicleFills = useMemo(
    () => (entries.data ?? []).filter((e) => e.vehicleId === vehicle.id && e.id !== entry?.id).sort(fillOrder),
    [entries.data, vehicle.id, entry?.id]
  )
  // The reading as typed — blank stays blank (null), never a substitute such as the vehicle's last known km.
  const odo = f.odometerKm.trim() === "" ? null : Number(f.odometerKm)
  // Previous fill = latest fill before this one in (date, odometer) order — same rule the KPIs use.
  const lastFill = [...vehicleFills].reverse().find((e) => e.odometerKm !== null && (e.date < f.date || (e.date === f.date && e.odometerKm <= (odo ?? Infinity))))
  const lastOdo = lastFill?.odometerKm ?? null
  const lastRate = useMemo(
    () => (entries.data ?? []).filter((e) => e.vendorId === f.vendorId).sort((a, b) => b.date.localeCompare(a.date))[0]?.rate,
    [entries.data, f.vendorId]
  )
  const litres = Number(f.litres)
  // Diesel source (owner, 31 Oct 2026): a direct petrol-pump fill, or one of the company tankers (JIO / Office / Mini).
  // A tanker fill is an internal stock movement: it takes litres out of that tanker and is never a purchase — the
  // purchase was the tanker load. Its rate is the source rate entered on the fill (answer 23), never an average.
  const fromTanker = f.vendorId === TANKER_SOURCE_ID
  const wasTankerFill = entry?.vendorId === TANKER_SOURCE_ID
  // A tanker's own fuel is a pump fill, never its cargo (an own fill already recorded from cargo stays editable).
  const ownTanker = (tankers.data ?? []).find((t) => t.vehicleId === vehicle.id)
  // A historical fill on a stock pool (no registration) keeps it; the pool is never offered (DIESEL_TANKER_CLEANUP_REPORT.md).
  const pool = (tankers.data ?? []).find((t) => wasTankerFill && t.id === f.tankerId && isStockPool(t))
  const tankerOptions =
    vehicle.fuelType === "DIESEL" && !ownTanker
      ? (tankers.data ?? []).filter((t) => !isStockPool(t) && (t.status === "ACTIVE" || t.id === f.tankerId))
      : (tankers.data ?? []).filter((t) => wasTankerFill && t.id === tankerOf(entry!) && !isStockPool(t))
  const sourceOptions = [
    { value: PUMP, label: "Direct petrol pump" },
    ...tankerOptions.map((t) => ({ value: t.id, label: `Tanker — ${tankerLabel(t)}` })),
    ...(pool ? [{ value: pool.id, label: `${pool.name} (historical stock)` }] : []),
  ]
  const tankerId = fromTanker ? f.tankerId : ""
  const valuation = valueTankers({ loads: loads.data ?? [], fills: (entries.data ?? []).filter((e) => e.id !== entry?.id), external: external.data ?? [], transfers: transfers.data ?? [], adjustments: adjustments.data ?? [] })
  const cargo = valuation.stock.get(tankerId) ?? { litres: 0, value: 0, avgRate: null }
  // Shown for reference only — the user enters the rate actually used for this fill.
  const lastLoad = useMemo(
    () => (loads.data ?? []).filter((l) => !l.opening && tankerOf(l) === tankerId).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))[0],
    [loads.data, tankerId]
  )
  const rate = fromTanker ? Number(f.rate || 0) : Number(f.rate || lastRate || 0)
  const setSource = (v: string) =>
    setF((cur) =>
      v === PUMP
        ? { ...cur, vendorId: entry && !wasTankerFill ? entry.vendorId : "", tankerId: "", rate: wasTankerFill ? "" : cur.rate }
        : { ...cur, vendorId: TANKER_SOURCE_ID, tankerId: v, rate: cur.vendorId === TANKER_SOURCE_ID ? cur.rate : "" }
    )
  const ev = vehicle.fuelType === "EV" // fuel type comes from the vehicle record
  const unit = ev ? "kWh" : "L"
  const amount = round2(litres * rate)
  const kmSince = lastOdo === null || odo === null ? null : odo - lastOdo
  const kmpl = fillMileage(kmSince, litres) // the same mileage as the Diesel entries table

  const close = () => {
    setF(blank)
    setErrors({})
    setReason("")
    onOpenChange(false)
  }

  const submit = async () => {
    const errs: Record<string, string> = {}
    if (!f.date.startsWith(month)) errs.date = `Pick a date in this month`
    if (f.date > today) errs.date = "Date can't be in the future"
    if (!(litres > 0)) errs.litres = ev ? "Enter units (kWh)" : "Enter litres"
    else if (litres > 600) errs.litres = "More than a tank — check the value"
    if (fromTanker) {
      if (ownTanker && !wasTankerFill) errs.vendorId = `${ownTanker.name}'s own fuel isn't taken from tanker cargo — pick a fuel station`
      else if (!tankerId) errs.vendorId = "Choose the tanker"
      else if (litres > cargo.litres) errs.litres = insufficientTankerMessage(cargo.litres)
      if (!f.rate.trim()) errs.rate = "Enter the source rate per litre for this fill"
      else if (!(rate > 50 && rate < 200)) errs.rate = "Rate should be ₹50–200 per litre"
    } else if (!f.vendorId) errs.vendorId = "Choose the fuel station (or add it)"
    if (!fromTanker && f.vendorId && (ev ? !(rate > 0 && rate < 100) : !(rate > 50 && rate < 200))) errs.rate = ev ? "Rate should be ₹1–100 per kWh" : "Rate should be ₹50–200 per litre"
    // An imported fill recorded without a reading may stay without one; every other fill needs a valid reading that
    // fits between the vehicle's previous and next fills (odometerConflict — the same rule the API enforces).
    if (odo === null) {
      if (!entry || entry.odometerKm !== null) errs.odometerKm = "Enter the odometer reading"
    } else if (!(Number.isFinite(odo) && odo >= 0)) errs.odometerKm = "Enter a valid odometer reading"
    else {
      const c = odometerConflict(vehicleFills, f.date, odo)
      if (c) errs.odometerKm = c.side === "previous" ? `Below last fill (${formatNumber(c.km)} km)` : `Above next fill (${formatNumber(c.km)} km on ${formatDate(c.date)})`
    }
    setErrors(errs)
    if (Object.keys(errs).length) return
    const data = { date: f.date, vendorId: f.vendorId, litres, rate, odometerKm: odo, billNo: f.billNo.trim(), paymentMode: (fromTanker ? "CREDIT" : f.paymentMode) as "CREDIT" | "CASH", tankerId: fromTanker ? tankerId : undefined }
    if (entry) await update.mutateAsync({ id: entry.id, version: entry.updatedAt, data, reason })
    else await create.mutateAsync({ ...data, vehicleId: vehicle.id, customerId: customer?.id ?? null })
    toast.success(`Diesel entry ${entry ? "updated" : "saved"} — ${formatINR(amount)}`)
    close()
  }

  return (
    <FormModal
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(o) : close())}
      title={entry ? "Edit diesel entry" : "Add diesel entry"}
      description={`${vehicle.regNo} · costed to ${customer?.shortName ?? "Unallocated"}`}
      submitLabel={entry ? "Save changes" : "Save entry"}
      pending={create.isPending || update.isPending}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date" required error={errors.date}>
          <Input type="date" value={f.date} min={`${month}-01`} max={maxDate} onChange={(e) => set("date")(e.target.value)} />
        </Field>
        <Field label="Payment">
          {fromTanker ? (
            <div className={READ_ONLY_BOX}>
              <span className="truncate">Nothing to pay</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">tanker cargo</span>
            </div>
          ) : (
            <SimpleSelect value={f.paymentMode} onChange={set("paymentMode")} options={[{ value: "CREDIT", label: "Credit (vendor account)" }, { value: "CASH", label: "Cash" }]} />
          )}
        </Field>
        <Field label="Diesel source" required error={fromTanker ? errors.vendorId : undefined}>
          <SimpleSelect value={fromTanker ? tankerId : PUMP} onChange={setSource} options={sourceOptions} className={TRUNCATE_SELECT} />
        </Field>
        {/* The tanker's stock takes the Fuel Station's place, so every later field keeps its position in both states. */}
        {fromTanker ? (
          <Field label="Tanker stock">
            <div className={READ_ONLY_BOX} title="This fill is taken out of the tanker's stock">
              <span className="num truncate">{pool || !tankerId ? "—" : `${formatNumber(cargo.litres, 2)} L`}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{pool ? "historical stock" : "available"}</span>
            </div>
          </Field>
        ) : (
          <Field label="Fuel Station" required error={errors.vendorId}>
            <CreatableSelect
              value={f.vendorId}
              onChange={(v) => setF((cur) => ({ ...cur, vendorId: v }))}
              options={(stations.data ?? []).filter((v) => v.status === "ACTIVE" && !v.isTanker).map((v) => ({ value: v.id, label: v.location ? `${v.name} — ${v.location}` : v.name }))}
              onCreate={createPump}
              placeholder="Select fuel station"
            />
          </Field>
        )}
        <Field label="Fuel type">
          <div className={READ_ONLY_BOX} title="Set on the vehicle record">
            <span className="truncate">{fuelLabel(vehicle.fuelType)}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">from vehicle</span>
          </div>
        </Field>
        <Field label={ev ? "Units (kWh)" : "Litres"} required error={errors.litres}>
          <Input type="number" step="0.01" value={f.litres} onChange={(e) => set("litres")(e.target.value)} autoFocus />
        </Field>
        {fromTanker ? (
          <Field
            label="Source rate (₹ / L)"
            required
            error={errors.rate}
            hint={lastLoad ? `Reference: last load ${formatINR(lastLoad.rate)} / L on ${formatDate(lastLoad.date)}` : "The rate this diesel is costed at"}
          >
            <Input type="number" step="0.01" value={f.rate} onChange={(e) => set("rate")(e.target.value)} />
          </Field>
        ) : (
          <Field label={ev ? "Rate (₹ / kWh)" : "Rate (₹ / L)"} required error={errors.rate} hint={lastRate ? `Last at this pump: ${formatINR(lastRate)}` : undefined}>
            <Input type="number" step="0.01" value={f.rate} placeholder={lastRate?.toFixed(2)} onChange={(e) => set("rate")(e.target.value)} />
          </Field>
        )}
        <Field label="Odometer (km)" required error={errors.odometerKm}>
          <Input type="number" value={f.odometerKm} placeholder={`Last known ${formatNumber(vehicle.odometerKm)}`} onChange={(e) => set("odometerKm")(e.target.value)} />
        </Field>
        <Field label="Bill / indent no.">
          <Input value={f.billNo} onChange={(e) => set("billNo")(e.target.value)} />
        </Field>
        {entry && <ReasonField value={reason} onChange={setReason} className="sm:col-span-2" />}
      </div>
      <div className="grid grid-cols-3 gap-3 rounded-lg border bg-muted/40 p-3 text-sm [&>div]:min-w-0 [&_.num]:[overflow-wrap:anywhere]">
        <div>
          <div className="text-xs text-muted-foreground">Amount</div>
          <div className="num font-semibold">{formatINR(amount)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Since last fill</div>
          <div className="num font-medium">{kmSince !== null ? `${formatNumber(kmSince)} km` : "—"}</div>
          {lastFill && <div className="text-[11px] text-muted-foreground">{formatDate(lastFill.date)}</div>}
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Mileage</div>
          <div className={kmpl && kmpl < vehicle.mileageKmpl * 0.9 ? "num font-medium text-destructive" : "num font-medium"}>
            {kmpl ? `${kmpl.toFixed(2)} km/${unit}` : "—"}
          </div>
          <div className="text-[11px] text-muted-foreground">rated {vehicle.mileageKmpl}</div>
        </div>
      </div>
    </FormModal>
  )
}
