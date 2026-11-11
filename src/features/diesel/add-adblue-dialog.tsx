"use client"

import { useState } from "react"
import { endOfMonth, parseISO } from "date-fns"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { FormModal } from "@/components/shared/form-modal"
import { ReasonField } from "@/components/shared/audit"
import { Field } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdBlueEntries, useAdBluePurchases, useAdBlueStockDraws, useSaveAdBlue } from "@/lib/api/hooks"
import { insufficientMessage, isDirectAdBlue, valueInventory } from "@/domain/adblue-inventory"
import { adBlueNeighbours } from "@/domain/adblue"
import { formatDate, formatINR, formatNumber, toISODate, todayISO } from "@/lib/format"
import type { AdBlueEntry, Customer, PaymentMode, Vehicle } from "@/lib/types"

/**
 * Records (or, with `entry`, edits) an AdBlue top-up for one vehicle — kept apart from diesel entries.
 * Two sources (uncle's answer 25): From bulk stock (a draw, costed at the inventory's average rate) or a
 * Direct Vendor Purchase (bought for this vehicle at its own rate; bulk stock is not touched).
 */
export function AddAdBlueDialog({
  open,
  onOpenChange,
  vehicle,
  customer,
  month,
  entry,
  initialSource = "STOCK",
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  vehicle: Vehicle
  customer: Customer | null
  month: string
  /** Edit this entry instead of adding a new one. */
  entry?: AdBlueEntry
  /** New entries: which source the form starts on. */
  initialSource?: "STOCK" | "DIRECT"
}) {
  const entries = useAdBlueEntries()
  const purchases = useAdBluePurchases()
  const stock = useAdBlueStockDraws() // every draw on the shared stock — also those of customers this account isn't shown
  const save = useSaveAdBlue()
  const today = todayISO()
  const monthEnd = toISODate(endOfMonth(parseISO(`${month}-01`)))
  const maxDate = monthEnd < today ? monthEnd : today
  const blank = entry
    ? { date: entry.date, closingKm: String(entry.closingKm), qty: String(entry.quantityLitres), invoiceNo: entry.invoiceNo, notes: entry.notes, source: isDirectAdBlue(entry) ? "DIRECT" : "STOCK", vendorName: entry.vendorName ?? "", rate: entry.rate ? String(entry.rate) : "", paymentMode: entry.paymentMode ?? "CASH" }
    : { date: maxDate, closingKm: "", qty: "", invoiceNo: "", notes: "", source: initialSource as string, vendorName: "", rate: "", paymentMode: "CASH" }
  const [f, setF] = useState(blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [reason, setReason] = useState("")
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }))

  // Previous reading = the vehicle's last AdBlue entry on or before this date (any customer).
  const { prev, next } = adBlueNeighbours(entries.data ?? [], vehicle.id, f.date, entry?.id)
  const closing = Number(f.closingKm)
  const qty = Number(f.qty)
  // From stock: the draw is checked against stock and costed at the weighted-average rate.
  // Direct: litres × the vendor's rate; never checked against or taken from bulk stock.
  const direct = f.source === "DIRECT"
  const others = (stock.data ?? []).filter((e) => e.id !== entry?.id)
  const draft = { id: entry?.id ?? "draft", date: f.date, createdAt: entry?.createdAt ?? new Date().toISOString(), quantityLitres: qty > 0 ? qty : 0 }
  const before = valueInventory(purchases.data ?? [], others)
  const after = valueInventory(purchases.data ?? [], direct ? others : [...others, draft])
  const rate = Number(f.rate)
  const amount = direct ? (qty > 0 && rate > 0 ? qty * rate : 0) : (after.costOf.get(draft.id) ?? 0)
  const vendors = [...new Set((entries.data ?? []).map((e) => e.vendorName?.trim()).filter((v): v is string => !!v))].sort()
  const kmRun = prev && f.closingKm !== "" ? closing - prev.closingKm : null
  const kmPerLitre = kmRun && kmRun > 0 && qty > 0 ? kmRun / qty : null
  const costPerKm = kmRun && kmRun > 0 && amount > 0 ? amount / kmRun : null

  const close = () => {
    setF(blank)
    setErrors({})
    setReason("")
    onOpenChange(false)
  }

  const submit = async () => {
    const errs: Record<string, string> = {}
    if (!f.date.startsWith(month) || f.date > today) errs.date = "Pick a date in this month, not in the future"
    if (f.closingKm === "" || closing < 0) errs.closingKm = "Enter current odometer"
    else if (prev && !(closing > prev.closingKm)) errs.closingKm = "Closing odometer must be greater than the last recorded odometer."
    else if (next && !(closing < next.closingKm)) errs.closingKm = `Must be less than the next AdBlue entry (${formatNumber(next.closingKm)} km on ${formatDate(next.date)})`
    if (!(qty > 0)) errs.qty = "Enter AdBlue litres"
    else if (!direct && after.shortfall) errs.qty = insufficientMessage(after.shortfall.available)
    if (direct && !f.vendorName.trim()) errs.vendorName = "Enter the vendor"
    if (direct && !(rate > 0)) errs.rate = "Enter the rate per litre"
    setErrors(errs)
    if (Object.keys(errs).length) return
    await save.mutateAsync({
      id: entry?.id, version: entry?.updatedAt,
      data: {
        vehicleId: vehicle.id,
        customerId: entry ? entry.customerId : (customer?.id ?? null),
        date: f.date,
        closingKm: closing,
        quantityLitres: qty,
        invoiceNo: f.invoiceNo.trim(),
        notes: f.notes.trim(),
        ...(direct ? { source: "DIRECT" as const, vendorName: f.vendorName.trim(), rate, paymentMode: f.paymentMode as PaymentMode } : { source: "STOCK" as const }),
      },
      reason,
    })
    toast.success(`AdBlue entry ${entry ? "updated" : "saved"} — ${formatNumber(qty, 2)} L, ${formatINR(amount)}`)
    close()
  }

  return (
    <FormModal
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(o) : close())}
      title={entry ? "Edit AdBlue entry" : "Add AdBlue entry"}
      description={`${vehicle.regNo} · AdBlue only — does not change diesel figures`}
      submitLabel={entry ? "Update AdBlue entry" : "Save AdBlue entry"}
      pending={save.isPending}
      onSubmit={submit}
    >
      <div className="rounded-lg border bg-muted/40 p-3 text-sm">
        <div className="text-xs text-muted-foreground">Last AdBlue entry</div>
        {prev ? (
          <div className="num">
            {formatDate(prev.date)} · Last recorded odometer <span className="font-semibold">{formatNumber(prev.closingKm)} km</span>
          </div>
        ) : (
          <div>None — this is the first AdBlue entry, so KM Run starts from the next one.</div>
        )}
      </div>
      <Field label="AdBlue source">
        <Tabs value={f.source} onValueChange={set("source")}>
          <TabsList className="grid h-9 w-full grid-cols-2">
            <TabsTrigger value="STOCK">From Bulk Stock</TabsTrigger>
            <TabsTrigger value="DIRECT">Direct Vendor Purchase</TabsTrigger>
          </TabsList>
        </Tabs>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date" required error={errors.date}>
          <Input type="date" value={f.date} min={`${month}-01`} max={maxDate} onChange={(e) => set("date")(e.target.value)} />
        </Field>
        <Field label="Current odometer (km)" required error={errors.closingKm} hint={prev ? `Previous: ${formatNumber(prev.closingKm)} km` : undefined}>
          <Input type="number" min={0} value={f.closingKm} onChange={(e) => set("closingKm")(e.target.value)} />
        </Field>
        <Field
          label="AdBlue quantity (litres)"
          required
          error={errors.qty}
          hint={direct ? "Bought for this vehicle — bulk stock is not changed" : `From inventory · ${formatNumber(before.stockLitres, 2)} L in stock${before.avgRate ? ` · avg ₹${before.avgRate.toFixed(2)}/L` : ""}`}
        >
          <Input type="number" step="0.01" min={0} value={f.qty} onChange={(e) => set("qty")(e.target.value)} />
        </Field>
        {direct ? (
          <>
            <Field label="Vendor" required error={errors.vendorName}>
              <Input value={f.vendorName} list="adblue-direct-vendors" onChange={(e) => set("vendorName")(e.target.value)} placeholder="e.g. Rajaram Automobiles" />
              <datalist id="adblue-direct-vendors">
                {vendors.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </Field>
            <Field label="Rate (₹ / L)" required error={errors.rate}>
              <Input type="number" step="0.01" min={0} value={f.rate} onChange={(e) => set("rate")(e.target.value)} />
            </Field>
            <Field label="Payment mode">
              <SimpleSelect value={f.paymentMode} onChange={set("paymentMode")} options={(["CASH", "UPI", "NEFT", "CHEQUE"] as const).map((m) => ({ value: m, label: m === "CASH" ? "Cash" : m }))} />
            </Field>
          </>
        ) : null}
        <Field label={direct ? "Total amount" : "Cost (from inventory)"} hint={direct ? "Litres × rate" : "Litres × weighted-average rate — calculated, not typed"}>
          <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm num">{qty > 0 ? formatINR(amount) : "—"}</div>
        </Field>
        <Field label={direct ? "Invoice / receipt no." : "Reference / job card"}>
          <Input value={f.invoiceNo} onChange={(e) => set("invoiceNo")(e.target.value)} />
        </Field>
        <Field label="Notes">
          <Textarea rows={1} value={f.notes} onChange={(e) => set("notes")(e.target.value)} />
        </Field>
        {entry && <ReasonField value={reason} onChange={setReason} className="sm:col-span-2" />}
      </div>
      <div className="grid grid-cols-3 gap-3 rounded-lg border bg-muted/40 p-3 text-sm [&>div]:min-w-0 [&_.num]:[overflow-wrap:anywhere]">
        <div>
          <div className="text-xs text-muted-foreground">KM Run</div>
          <div className={kmRun !== null && kmRun <= 0 ? "num font-semibold text-destructive" : "num font-semibold"}>{kmRun !== null ? `${formatNumber(kmRun)} km` : "—"}</div>
          {kmRun !== null && prev && <div className="num text-[11px] text-muted-foreground">{formatNumber(closing)} − {formatNumber(prev.closingKm)}</div>}
        </div>
        <div>
          <div className="text-xs text-muted-foreground">KM per litre AdBlue</div>
          <div className="num font-medium">{kmPerLitre ? kmPerLitre.toFixed(1) : "—"}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">AdBlue cost per km</div>
          <div className="num font-medium">{costPerKm ? formatINR(costPerKm) : "—"}</div>
        </div>
      </div>
    </FormModal>
  )
}
