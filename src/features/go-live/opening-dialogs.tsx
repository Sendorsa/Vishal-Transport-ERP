"use client"

/**
 * Go-live openings (owner, 3 Nov 2026) — Owner and Dev only, each dated the baseline, each audited and month-locked.
 * None of them is a purchase, a payment or revenue. Station opening balances and tanker opening stock have their own
 * dialogs on their pages; these are the three added for the shared-database go-live.
 */
import { useState } from "react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { FormModal } from "@/components/shared/form-modal"
import { Field } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { useCreateAdBlueOpening, useCreateOpeningInvoice, useCustomers, useSetOpeningOdometer } from "@/lib/api/hooks"
import { formatDate, formatINR, formatNumber, previousMonthEnd, todayISO } from "@/lib/format"
import type { Vehicle } from "@/lib/types"

/** AdBlue already on hand when records begin. Stock and value — never "AdBlue Purchased". */
export function AdBlueOpeningDialog({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const save = useCreateAdBlueOpening()
  const today = todayISO()
  const [f, setF] = useState({ date: previousMonthEnd(today), litres: "", value: "", notes: "" })
  const [error, setError] = useState<string | null>(null)
  const litres = Number(f.litres)
  const value = Number(f.value)
  const submit = async () => {
    setError(null)
    if (!f.date) return setError("Enter the date of the stock count")
    if (!(litres > 0)) return setError("Enter the litres on hand")
    if (!(value > 0)) return setError("Enter the value of the stock — every later draw is costed from it")
    await save.mutateAsync({ date: f.date, litres, value, notes: f.notes })
    toast.success(`AdBlue opening stock recorded — ${formatNumber(litres)} L on ${formatDate(f.date)}`)
    onOpenChange(false)
  }
  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title="AdBlue opening stock"
      description="AdBlue already on hand when records begin. It becomes stock and carries forward; draws are costed at the weighted average including it. It is not a purchase (never in AdBlue Purchased)."
      submitLabel="Save opening stock"
      pending={save.isPending}
      onSubmit={submit}
      className="sm:max-w-2xl"
    >
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
        <Field label="Stock as of" required>
          <Input type="date" value={f.date} max={today} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Litres on hand" required error={error ?? undefined}>
          <Input type="number" min={0} step="0.01" value={f.litres} onChange={(e) => setF({ ...f, litres: e.target.value })} autoFocus />
        </Field>
        <Field label="Stock value (₹)" required hint={litres > 0 && value > 0 ? `${formatINR(value / litres)} per litre` : "What the stock on hand cost"}>
          <Input type="number" min={0} step="0.01" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
        </Field>
        <Field label="Notes">
          <Textarea rows={1} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="e.g. bucket count" />
        </Field>
      </div>
    </FormModal>
  )
}

/** The odometer at the vehicle's last diesel fill before records begin — the first fill's KM Run starts from it. */
export function OpeningOdometerDialog({ vehicle, onOpenChange }: { vehicle: Vehicle; onOpenChange: (o: boolean) => void }) {
  const save = useSetOpeningOdometer()
  const today = todayISO()
  const [f, setF] = useState({ km: vehicle.openingOdometerKm != null ? String(vehicle.openingOdometerKm) : "", date: vehicle.openingOdometerDate ?? previousMonthEnd(today) })
  const [error, setError] = useState<string | null>(null)
  const submit = async (remove = false) => {
    setError(null)
    const km = remove ? null : Number(f.km)
    if (!remove && !(f.km.trim() && km !== null && km >= 0)) return setError("Enter the odometer reading (km)")
    if (!f.date) return setError("Enter the date of that fill")
    await save.mutateAsync({ id: vehicle.id, version: vehicle.updatedAt, km, date: f.date })
    toast.success(remove ? `Opening odometer removed for ${vehicle.regNo}` : `Opening odometer ${formatNumber(km!)} km saved for ${vehicle.regNo}`)
    onOpenChange(false)
  }
  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title={`Opening odometer · ${vehicle.regNo}`}
      description="The odometer at this vehicle's last diesel fill before records begin, and that fill's date. Its first fill after go-live measures KM Run from it. It is not a fill: no litres, no spend."
      submitLabel="Save opening odometer"
      pending={save.isPending}
      onSubmit={() => submit()}
    >
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
        <Field label="Odometer at that fill (km)" required error={error ?? undefined}>
          <Input type="number" min={0} step="0.1" value={f.km} onChange={(e) => setF({ ...f, km: e.target.value })} autoFocus />
        </Field>
        <Field label="Date of that fill" required>
          <Input type="date" value={f.date} max={today} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        {vehicle.openingOdometerKm != null && (
          <button type="button" className="text-left text-xs text-destructive underline-offset-2 hover:underline sm:col-span-2" onClick={() => submit(true)}>
            Remove the opening odometer
          </button>
        )}
      </div>
    </FormModal>
  )
}

/** An invoice still unpaid when records begin: its original number and dates, and the amount outstanding. */
export function OpeningInvoiceDialog({ onOpenChange, customerId }: { onOpenChange: (o: boolean) => void; customerId?: string }) {
  const customers = useCustomers()
  const save = useCreateOpeningInvoice()
  const today = todayISO()
  const [f, setF] = useState({ customerId: customerId ?? "", invoiceNo: "", date: "", dueDate: "", outstanding: "", notes: "" })
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setError(null)
    if (!f.customerId) return setError("Choose the customer")
    if (!f.invoiceNo.trim()) return setError("Enter the invoice number")
    if (!f.date || !f.dueDate) return setError("Enter the invoice date and due date")
    if (!(Number(f.outstanding) > 0)) return setError("Enter the amount still unpaid")
    await save.mutateAsync({ customerId: f.customerId, invoiceNo: f.invoiceNo.trim(), date: f.date, dueDate: f.dueDate, outstanding: Number(f.outstanding), notes: f.notes })
    toast.success(`Opening invoice ${f.invoiceNo.trim()} recorded — ${formatINR(Number(f.outstanding))} unpaid`)
    onOpenChange(false)
  }
  return (
    <FormModal
      open
      onOpenChange={onOpenChange}
      title="Opening invoice (unpaid at go-live)"
      description="An invoice raised before records began that is still unpaid. Receipts settle it like any invoice, and it shows in receivables and aging. It is never revenue of the period (revenue comes from trips)."
      submitLabel="Save opening invoice"
      pending={save.isPending}
      onSubmit={submit}
      className="sm:max-w-2xl"
    >
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
        <Field label="Customer" required error={error && !f.customerId ? error : undefined}>
          <SimpleSelect
            value={f.customerId}
            onChange={(v) => setF({ ...f, customerId: v })}
            placeholder="Select customer"
            options={(customers.data ?? []).sort((a, b) => (a.shortName || a.name).localeCompare(b.shortName || b.name)).map((c) => ({ value: c.id, label: c.shortName || c.name }))}
          />
        </Field>
        <Field label="Invoice number" required hint="As printed on the original invoice">
          <Input value={f.invoiceNo} onChange={(e) => setF({ ...f, invoiceNo: e.target.value })} />
        </Field>
        <Field label="Invoice date" required>
          <Input type="date" value={f.date} max={today} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Due date" required>
          <Input type="date" value={f.dueDate} min={f.date || undefined} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
        </Field>
        <Field label="Amount still unpaid (₹)" required error={error && f.customerId ? error : undefined}>
          <Input type="number" min={0} step="0.01" value={f.outstanding} onChange={(e) => setF({ ...f, outstanding: e.target.value })} />
        </Field>
        <Field label="Notes">
          <Textarea rows={1} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </FormModal>
  )
}
