"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangle, ChevronDown, Gauge, Lock, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { Field } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { monthLabel } from "@/domain/diesel"
import { canEditMonth } from "@/domain/month-lock"
import { deletionReasonError } from "@/domain/audit"
import { CREDIT, financialChanges, isTyreWork, itemProblem, kmRun, lineAmounts, masterOptions, OFFICE_LABEL, referenceLabel, referenceNoun, sameBill, tdsProblem, TYRE_PAYMENT_TYPES, TYRE_TDS_PERCENT, tyreTdsSplit, tyreTotals } from "@/domain/tyre"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { useCreateTyreMaster, useDieselEntries, useSaveTyreInvoice } from "@/lib/api/hooks"
import { currentOdometer } from "@/domain/vehicle-summary"
import { useCan, useRole } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber, round2, todayISO } from "@/lib/format"
import type { TyreInvoice, TyreTaxType } from "@/lib/types"
import { useTyreData } from "./tyre-data"
import { TdsBreakdown } from "./tyre-payment-dialog"

interface LineDraft {
  key: string
  id?: string
  repairTypeId: string
  brandId: string
  sizeId: string
  tyreNumber: string
  openingKm: string
  closingKm: string
  quantity: string
  rate: string
  gstRate: string
  removingNumber: string
  remarks: string
  /** Tyre details shown (brand, size, number, KM, removing number, remarks). */
  details: boolean
}

const PAYMENT_MODES = ["Cash", "UPI", "NEFT", "Cheque", "Credit"]
const PURCHASE_MODES = ["Cash", "Credit"]
const DEFAULT_GST = "18" // the 2026–27 register: 9% CGST + 9% SGST on almost every line

let seq = 0
const blankLine = (gstRate = DEFAULT_GST): LineDraft => ({ key: `l${++seq}`, repairTypeId: "", brandId: "", sizeId: "", tyreNumber: "", openingKm: "", closingKm: "", quantity: "1", rate: "", gstRate, removingNumber: "", remarks: "", details: false })
const num = (s: string) => (s.trim() === "" ? NaN : Number(s))
const kmOf = (s: string) => (s.trim() === "" ? null : Number(s))

/**
 * Add Invoice (no `invoice`) or Edit Invoice, as a large modal over the page that opened it (the register, or the
 * invoice page) — never a route of its own, so the page behind keeps its search, filters and pagination. The Dialog
 * renders in a portal on <body> with fixed positioning: centred on the viewport whatever the sidebar does, never clipped
 * by a parent's overflow or transform. Phones: full screen. Closing with unsaved input asks first.
 */
export function TyreInvoiceDialog({ invoice, onClose }: { invoice?: TyreInvoice; onClose: () => void }) {
  const can = useCan()
  const [role] = useRole()
  const d = useTyreData()
  if (!d.ready) return null // the opener shows its button only once the data is there
  const blocked = !can("tyres", invoice ? "edit" : "create")
    ? `Your role can't ${invoice ? "edit" : "add"} tyre invoices.`
    : invoice && !canEditMonth(role, invoice.date.slice(0, 7), todayISO(), d.locks)
      ? `${monthLabel(invoice.date.slice(0, 7))} is locked — only the Owner can change it.`
      : null
  return <Form invoice={invoice} onClose={onClose} blocked={blocked} />
}

function Form({ invoice, onClose, blocked }: { invoice?: TyreInvoice; onClose: () => void; blocked: string | null }) {
  const router = useRouter()
  const d = useTyreData()
  const save = useSaveTyreInvoice()
  const createSupplier = useCreateTyreMaster("SUPPLIER")
  const createRepair = useCreateTyreMaster("REPAIR_TYPE")
  const createBrand = useCreateTyreMaster("BRAND")
  const createSize = useCreateTyreMaster("SIZE")
  const today = todayISO()

  const [f, setF] = useState(() => ({
    date: invoice?.date ?? today,
    vehicleId: invoice?.vehicleId ?? "",
    supplierId: invoice?.supplierId ?? "",
    billNo: invoice?.billNo ?? "",
    purchaseMode: invoice?.purchaseMode ?? "",
    paymentMode: invoice?.paymentMode ?? CREDIT, // Add Invoice: the Payment Type, Credit unless chosen
    paymentDetails: invoice?.paymentDetails ?? "",
    remarks: invoice?.remarks ?? "",
    taxType: (invoice?.items[0]?.taxType ?? "CGST_SGST") as TyreTaxType,
    office: invoice?.office ?? false, // chosen explicitly, never a default
  }))
  const [lines, setLines] = useState<LineDraft[]>(() =>
    invoice
      ? invoice.items.map((i) => {
          const s = (n: number | null) => (n === null ? "" : String(n))
          const filled = !!(i.brandId || i.sizeId || i.tyreNumber || i.openingKm !== null || i.closingKm !== null || i.removingNumber || i.remarks)
          return { key: `l${++seq}`, id: i.id, repairTypeId: i.repairTypeId, brandId: i.brandId ?? "", sizeId: i.sizeId ?? "", tyreNumber: i.tyreNumber, openingKm: s(i.openingKm), closingKm: s(i.closingKm), quantity: String(i.quantity), rate: String(i.rate), gstRate: String(i.gstRate), removingNumber: i.removingNumber, remarks: i.remarks, details: filled || isTyreWork(d.name(i.repairTypeId)) }
        })
      : [blankLine()]
  )
  // Payment Details (Add Invoice only): what was paid with the bill. Date empty = the invoice date.
  const [pay, setPay] = useState({ amount: "", utr: "", date: "", notes: "", acceptAdvance: false, tdsOn: false, tdsPercent: String(TYRE_TDS_PERCENT) })
  const [reason, setReason] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const set = (k: Exclude<keyof typeof f, "office">) => (v: string) => setF((s) => ({ ...s, [k]: v }))
  const setLine = (key: string, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  // Picker options: active values, plus whatever this invoice already uses (even if archived since).
  const keep = invoice ? [invoice.supplierId, ...invoice.items.flatMap((i) => [i.repairTypeId, i.brandId, i.sizeId])] : []
  const opt = {
    supplier: masterOptions(d.masters, "SUPPLIER", keep),
    repair: masterOptions(d.masters, "REPAIR_TYPE", keep),
    brand: masterOptions(d.masters, "BRAND", keep),
    size: masterOptions(d.masters, "SIZE", keep),
  }
  const vehicleOptions = d.vehicles
    .filter((v) => v.status !== "ARCHIVED" || v.id === invoice?.vehicleId)
    .sort((a, b) => a.regNo.localeCompare(b.regNo))
    .map((v) => ({ value: v.id, label: `${v.regNo}${d.typeOf(v.id).name ? ` · ${d.typeOf(v.id).name}` : ""}` }))
  const used = (k: "paymentMode" | "purchaseMode", base: string[]) => [...new Set([...base, ...d.views.map((v) => v[k]).filter(Boolean)])]

  // The company comes from the vehicle's assignment on the invoice date — never typed.
  const vehicle = d.vehicles.find((v) => v.id === f.vehicleId)
  // Reference only, for typing a line's Opening / Closing KM: the vehicle's latest recorded odometer (never fills a field).
  const fills = useDieselEntries()
  const odometer = vehicle ? currentOdometer(vehicle, fills.data ?? []) : null
  const customerId = d.customerOn(f.vehicleId, f.date)
  // No customer on the date: the invoice can still be recorded, but only as an explicit Office / No Customer choice.
  const noCustomer = !!vehicle && !!f.date && !customerId
  const office = noCustomer && f.office
  const companyProblem = noCustomer && !f.office ? `${vehicle.regNo} has no customer assignment on ${formatDate(f.date)}. Assign the vehicle for that date (Diesel → customer → vehicle ⋮), check the invoice date, or record it as ${OFFICE_LABEL} below.` : null
  // Same supplier and bill number already recorded: a warning only (suppliers may reuse bill numbers).
  const duplicates = f.supplierId && f.billNo.trim() ? d.views.filter((v) => v.id !== invoice?.id && sameBill(v, { supplierId: f.supplierId, billNo: f.billNo })) : []

  // Live amounts per line and for the invoice.
  const calc = useMemo(
    () =>
      lines.map((l) => {
        const q = num(l.quantity)
        const r = num(l.rate)
        const g = num(l.gstRate)
        const ok = q > 0 && r >= 0 && g >= 0 && g <= 100
        return ok ? lineAmounts(q, r, g, f.taxType) : { baseValue: 0, cgst: 0, sgst: 0, igst: 0, totalValue: 0 }
      }),
    [lines, f.taxType]
  )
  const totals = tyreTotals(calc)
  const lineError = (l: LineDraft) => itemProblem({ repairTypeId: l.repairTypeId, quantity: num(l.quantity), rate: num(l.rate), gstRate: num(l.gstRate), openingKm: kmOf(l.openingKm), closingKm: kmOf(l.closingKm) })
  const headerErrors = {
    date: !f.date ? "Enter the invoice date" : f.date > today ? "An invoice can't be dated in the future" : null,
    vehicle: !f.vehicleId ? "Choose the vehicle" : companyProblem,
    supplier: !f.supplierId ? "Choose the supplier" : null,
  }
  const draftItems = lines.map((l) => ({ repairTypeId: l.repairTypeId, brandId: l.brandId || null, sizeId: l.sizeId || null, tyreNumber: l.tyreNumber, openingKm: kmOf(l.openingKm), closingKm: kmOf(l.closingKm), quantity: num(l.quantity), rate: num(l.rate), gstRate: num(l.gstRate), taxType: f.taxType, removingNumber: l.removingNumber, remarks: l.remarks }))
  // An edit of the date, vehicle, attribution, supplier, bill number or any repair line needs a reason (the API checks too).
  const changed = invoice ? financialChanges(invoice, { date: f.date, vehicleId: f.vehicleId, office, supplierId: f.supplierId, billNo: f.billNo, items: draftItems }) : []
  const reasonError = changed.length ? deletionReasonError(reason, "correcting") : null
  // Payment Details: Credit = nothing paid (no payment); any other type needs the amount and the UTR (the API checks too).
  const paying = !invoice && f.paymentMode !== CREDIT
  const payDate = pay.date || f.date
  const paid = paying ? num(pay.amount) : 0
  const excess = paying && paid > totals.grandTotal ? round2(paid - totals.grandTotal) : 0
  const tdsSplitNow = paying && pay.tdsOn && paid > 0 && !tdsProblem(paid, Number(pay.tdsPercent)) && pay.tdsPercent.trim() !== "" ? tyreTdsSplit(paid, Number(pay.tdsPercent)) : null
  const payErrors = {
    amount: !paying ? null : pay.amount.trim() === "" || paid === 0 ? `Enter the amount paid by ${f.paymentMode} — or choose Credit if nothing was paid` : !(paid > 0) ? "Amount Paid can't be negative" : round2(paid) !== paid ? "Amount: up to 2 decimals (paise)" : excess > 0 && !pay.acceptAdvance ? `More than the invoice total (${formatINR(totals.grandTotal)}) — keep the extra ${formatINR(excess)} as advance credit below, or correct the amount` : null,
    utr: paying && !pay.utr.trim() ? `Enter the ${referenceNoun(f.paymentMode)} — required when the Payment Type is ${f.paymentMode}` : null,
    // "Deduct TDS?": only on a payment (never Credit); the amount entered is the total settled.
    tds: paying && pay.tdsOn ? tdsProblem(paid, pay.tdsPercent.trim() === "" ? NaN : Number(pay.tdsPercent)) : null,
    date: !paying ? null : !payDate ? "Enter the payment date" : payDate > today ? "A payment can't be dated in the future" : null,
  }
  const vendorAdvance = !invoice && f.supplierId ? (d.accounts.find((a) => a.supplierId === f.supplierId)?.advance ?? 0) : 0
  const invalid = Object.values(headerErrors).some(Boolean) || lines.length === 0 || lines.some((l) => lineError(l)) || !!reasonError || Object.values(payErrors).some(Boolean)

  const submit = async () => {
    setSubmitted(true)
    if (invalid) {
      toast.error(lines.length === 0 ? "Add at least one repair line" : reasonError && !Object.values(headerErrors).some(Boolean) && !lines.some((l) => lineError(l)) ? "Enter the reason for the change" : payErrors.utr && !payErrors.amount ? payErrors.utr : "Check the highlighted fields")
      return
    }
    const data = {
      date: f.date,
      vehicleId: f.vehicleId,
      office,
      supplierId: f.supplierId,
      billNo: f.billNo,
      purchaseMode: f.purchaseMode,
      paymentMode: f.paymentMode,
      paymentDetails: f.paymentDetails,
      remarks: f.remarks,
      items: draftItems.map((x, n) => ({ ...x, id: lines[n].id })),
      ...(paying ? { payment: { amount: paid, utr: pay.utr, date: payDate, notes: pay.notes, acceptAdvance: excess > 0 && pay.acceptAdvance, tdsPercent: pay.tdsOn ? Number(pay.tdsPercent) : null } } : {}),
    }
    const saved = await save.mutateAsync({ id: invoice?.id, version: invoice?.updatedAt, data, reason })
    // The Tyre page lists the current month only: say where an invoice dated in another month went.
    const elsewhere = saved.date.slice(0, 7) !== todayISO().slice(0, 7) ? `Dated ${monthLabel(saved.date.slice(0, 7))} — it's in the Monthly Sheet.` : undefined
    toast.success(invoice ? "Invoice updated" : "Invoice saved", { description: elsewhere, ...(invoice ? {} : { action: { label: "View", onClick: () => router.push(`/tyre/${saved.id}`) } }) })
    onClose()
  }

  const show = (e: string | null | undefined) => (submitted ? (e ?? undefined) : undefined)

  // Unsaved input: anything typed since the modal opened. Closing then asks first (X, Esc, backdrop, Cancel).
  const snapshot = JSON.stringify([f, lines.map((l) => [l.id, l.repairTypeId, l.brandId, l.sizeId, l.tyreNumber, l.openingKm, l.closingKm, l.quantity, l.rate, l.gstRate, l.removingNumber, l.remarks]), reason, pay])
  const [initial] = useState(snapshot) // the input as the modal opened
  const dirty = snapshot !== initial
  const [confirmClose, setConfirmClose] = useState(false)
  const requestClose = () => (dirty && !save.isPending ? setConfirmClose(true) : onClose())
  // Who / what the invoice is about, kept in the modal's header while the lines scroll.
  const context = [vehicle?.regNo, customerId ? d.companyName(customerId) : office ? OFFICE_LABEL : null, f.supplierId ? d.name(f.supplierId) : null, f.billNo.trim() ? `Bill ${f.billNo.trim()}` : null].filter(Boolean)

  return (
    <>
    <Dialog open onOpenChange={(o) => !o && requestClose()}>
      <DialogContent
        className={
          // Large on desktop and tablet (most of the viewport); full screen on phones. Header and footer stay put,
          // the body scrolls on its own.
          "flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1280px,calc(100vw-2rem))] lg:h-[calc(100dvh-3rem)] lg:w-[calc(100vw-3rem)] max-sm:inset-0 max-sm:top-0 max-sm:h-dvh max-sm:max-h-none max-sm:overflow-hidden max-sm:w-screen max-sm:rounded-none max-sm:pb-0"
        }
        onOpenAutoFocus={(e) => e.preventDefault()} // no keyboard popping up on phones; Tab still starts in the modal
      >
        <DialogHeader className="shrink-0 gap-1 border-b px-4 py-3 pr-12 sm:px-6">
          <DialogTitle className="text-base font-semibold">{invoice ? "Edit tyre invoice" : "Add tyre invoice"}</DialogTitle>
          <DialogDescription className="truncate">{context.length ? context.join(" · ") : "One supplier bill for one vehicle — add a line for each tyre or repair on the bill."}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
        {blocked ? (
          <p className="flex items-center gap-2 rounded-lg border bg-muted/40 p-4 text-sm"><Lock className="size-4 shrink-0 text-muted-foreground" /> {blocked}</p>
        ) : (
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Invoice details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Invoice Date" required error={show(headerErrors.date)}>
                <Input type="date" value={f.date} max={today} onChange={(e) => set("date")(e.target.value)} aria-invalid={!!show(headerErrors.date)} />
              </Field>
              <Field label="Vehicle Number" required error={show(!f.vehicleId ? headerErrors.vehicle : null)} className="lg:col-span-2">
                <CreatableSelect value={f.vehicleId} options={vehicleOptions} onChange={set("vehicleId")} placeholder="Search registration…" invalid={!!show(!f.vehicleId ? headerErrors.vehicle : null)} />
              </Field>
              <Field label="Company Name" hint="From the vehicle's assignment on the invoice date">
                <div className={`flex min-h-9 items-center rounded-md border px-3 text-sm ${companyProblem ? "border-destructive/50 bg-destructive/5" : "bg-muted/40"}`}>
                  {customerId ? d.companyName(customerId) : office ? <span className="font-medium">{OFFICE_LABEL}</span> : <span className="text-muted-foreground">{vehicle ? "No customer on this date" : "Choose a vehicle"}</span>}
                </div>
              </Field>
              <Field label="Vehicle Type" hint="From the vehicle master">
                <div className="flex min-h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">{vehicle ? d.typeOf(vehicle.id).name || "—" : <span className="text-muted-foreground">Choose a vehicle</span>}</div>
              </Field>
              <Field label="Bill Number" hint="Optional">
                <Input value={f.billNo} onChange={(e) => set("billNo")(e.target.value)} placeholder="e.g. 003/26-27" />
              </Field>
              {duplicates.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs sm:col-span-2 lg:col-span-3" role="status">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <span>
                    Bill <span className="font-medium">{f.billNo.trim()}</span> from {d.name(f.supplierId)} is already recorded:{" "}
                    {duplicates.slice(0, 3).map((v, n) => (
                      <span key={v.id}>
                        {n ? "; " : ""}
                        <Link href={`/tyre/${v.id}`} className="underline" target="_blank">
                          {formatDate(v.date)} · {v.regNo} · {formatINR(v.totals.grandTotal)}
                        </Link>
                      </span>
                    ))}
                    {duplicates.length > 3 ? ` (+${duplicates.length - 3} more)` : ""}. Check it isn&apos;t entered twice — you can still save if it&apos;s a different bill.
                  </span>
                </div>
              )}
              {noCustomer && (
                <div className={`grid gap-2 rounded-md border px-3 py-2 text-xs sm:col-span-2 lg:col-span-3 ${companyProblem ? "border-destructive/40 bg-destructive/5" : "bg-muted/40"}`}>
                  {companyProblem && (
                    <p className="flex items-start gap-2 text-destructive">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {companyProblem}
                    </p>
                  )}
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={f.office} onCheckedChange={(c) => setF((s) => ({ ...s, office: c === true }))} className="mt-0.5" />
                    <span>
                      Record as <span className="font-medium">{OFFICE_LABEL}</span>
                      <span className="block text-xs text-muted-foreground">Counted in total tyre spend, never in any customer&apos;s. No customer record is created.</span>
                    </span>
                  </label>
                </div>
              )}
              <Field label="Supplier Name" required error={show(headerErrors.supplier)} className="sm:col-span-2 lg:col-span-3">
                <CreatableSelect value={f.supplierId} options={opt.supplier} onChange={set("supplierId")} onCreate={createSupplier} placeholder="Search or add a supplier…" createLabel={(q) => `Add supplier "${q}"`} invalid={!!show(headerErrors.supplier)} />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-sm">Repair lines · {lines.length}</CardTitle>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">GST</span>
                <SimpleSelect
                  value={f.taxType}
                  onChange={(v) => set("taxType")(v)}
                  options={[
                    { value: "CGST_SGST", label: "Within state · CGST + SGST" },
                    { value: "IGST", label: "Inter-state · IGST" },
                  ]}
                  className="h-8 w-56"
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {lines.map((l, n) => {
                const c = calc[n]
                const err = show(lineError(l))
                const run = kmRun({ openingKm: kmOf(l.openingKm), closingKm: kmOf(l.closingKm) })
                return (
                  <div key={l.key} className={`rounded-lg border p-3 ${err ? "border-destructive/50" : ""}`}>
                    <div className="flex items-start gap-2">
                      <span className="mt-2 w-6 shrink-0 text-xs font-semibold text-muted-foreground">{n + 1}.</span>
                      <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
                        <Field label="Repair Type" required>
                          <CreatableSelect
                            value={l.repairTypeId}
                            options={opt.repair}
                            onChange={(v) => setLine(l.key, { repairTypeId: v, details: l.details || isTyreWork(d.name(v)) })}
                            onCreate={createRepair}
                            placeholder="Search or add a repair type…"
                            createLabel={(q) => `Add repair type "${q}"`}
                            invalid={!!err && !l.repairTypeId}
                          />
                        </Field>
                        <Field label="Quantity" required>
                          <Input type="number" inputMode="decimal" min={0} step="any" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} className="num" />
                        </Field>
                        <Field label="Rate / Quantity (₹)" required>
                          <Input type="number" inputMode="decimal" min={0} step="0.01" value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} className="num" placeholder="0.00" />
                        </Field>
                        <Field label={f.taxType === "IGST" ? "IGST %" : "GST % (CGST + SGST)"}>
                          <Input type="number" inputMode="decimal" min={0} max={100} step="any" value={l.gstRate} onChange={(e) => setLine(l.key, { gstRate: e.target.value })} className="num" />
                        </Field>
                      </div>
                      <Button type="button" variant="ghost" size="icon-sm" className="mt-6 hover:bg-destructive/10 hover:text-destructive" aria-label={`Remove line ${n + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                        <Trash2 />
                      </Button>
                    </div>
                    <div className="mt-3 ml-8 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs">
                      <span>Base <span className="num font-medium">{formatINR(c.baseValue)}</span></span>
                      {f.taxType === "IGST" ? (
                        <span>IGST <span className="num font-medium">{formatINR(c.igst)}</span></span>
                      ) : (
                        <>
                          <span>CGST <span className="num font-medium">{formatINR(c.cgst)}</span></span>
                          <span>SGST <span className="num font-medium">{formatINR(c.sgst)}</span></span>
                        </>
                      )}
                      <span className="ml-auto">Line total <span className="num text-sm font-semibold">{formatINR(c.totalValue)}</span></span>
                    </div>
                    {err && <p className="mt-2 ml-8 text-xs text-destructive">{err}</p>}
                    <div className="mt-2 ml-8">
                      <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => setLine(l.key, { details: !l.details })} aria-expanded={l.details}>
                        <ChevronDown className={`size-3.5 transition-transform ${l.details ? "rotate-180" : ""}`} /> Tyre details{run !== null ? ` · ${formatNumber(run)} km run` : ""}
                      </button>
                      {l.details && (
                        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <Field label="Tyre Brand">
                            <CreatableSelect value={l.brandId} options={opt.brand} onChange={(v) => setLine(l.key, { brandId: v })} onCreate={createBrand} placeholder="Search or add…" createLabel={(q) => `Add brand "${q}"`} />
                          </Field>
                          <Field label="Tyre Size">
                            <CreatableSelect value={l.sizeId} options={opt.size} onChange={(v) => setLine(l.key, { sizeId: v })} onCreate={createSize} placeholder="Search or add…" createLabel={(q) => `Add size "${q}"`} />
                          </Field>
                          <Field label="Tyre Number(s)" className="lg:col-span-2">
                            <Input value={l.tyreNumber} onChange={(e) => setLine(l.key, { tyreNumber: e.target.value })} placeholder="Serial numbers, e.g. B0426 / 0427" />
                          </Field>
                          {vehicle && (
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border bg-muted/40 px-3 py-1.5 text-xs sm:col-span-2 lg:col-span-4" role="note">
                              <Gauge className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="text-muted-foreground">Current vehicle odometer</span>
                              {odometer ? (
                                <>
                                  <span className="num text-sm font-semibold">{formatNumber(odometer.km)} km</span>
                                  <span className="text-muted-foreground">{odometer.date ? `Last updated ${formatDate(odometer.date)}` : "From the vehicle record"} · a reference for the KM below, never filled in</span>
                                </>
                              ) : (
                                <span className="font-medium">No odometer reading recorded</span>
                              )}
                            </div>
                          )}
                          <Field label="Opening KM">
                            <Input type="number" inputMode="numeric" min={0} value={l.openingKm} onChange={(e) => setLine(l.key, { openingKm: e.target.value })} className="num" />
                          </Field>
                          <Field label="Closing KM">
                            <Input type="number" inputMode="numeric" min={0} value={l.closingKm} onChange={(e) => setLine(l.key, { closingKm: e.target.value })} className="num" />
                          </Field>
                          <Field label="Total KM Run" hint="Closing − opening">
                            <div className="flex min-h-9 items-center rounded-md border bg-muted/40 px-3 text-sm num">{run === null ? "—" : formatNumber(run)}</div>
                          </Field>
                          <Field label="Tyre Removing Number">
                            <Input value={l.removingNumber} onChange={(e) => setLine(l.key, { removingNumber: e.target.value })} />
                          </Field>
                          <Field label="Remarks" className="sm:col-span-2 lg:col-span-4">
                            <Input value={l.remarks} onChange={(e) => setLine(l.key, { remarks: e.target.value })} />
                          </Field>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
              {lines.length === 0 && <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">No repair lines — add at least one.</p>}
              <Button type="button" variant="outline" className="w-full border-dashed" onClick={() => setLines((ls) => [...ls, blankLine(ls.at(-1)?.gstRate ?? DEFAULT_GST)])}>
                <Plus /> Add Repair
              </Button>
            </CardContent>
          </Card>

          {!invoice && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Payment Details</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Payment Type" required hint={f.supplierId ? `Paid to ${d.name(f.supplierId)}` : "Paid to the supplier above"}>
                  <SimpleSelect value={f.paymentMode} onChange={set("paymentMode")} options={TYRE_PAYMENT_TYPES.map((m) => ({ value: m, label: m === CREDIT ? "Credit — nothing paid now" : m }))} />
                </Field>
                <Field label={pay.tdsOn && paying ? "Total Payment Amount (₹)" : "Amount Paid (₹)"} required={paying} error={show(payErrors.amount)} hint={pay.tdsOn && paying ? "Settled, before TDS" : undefined}>
                  <Input type="number" inputMode="decimal" min={0} step="0.01" value={paying ? pay.amount : ""} disabled={!paying} placeholder={paying ? "0.00" : "₹0.00 — Credit"} onChange={(e) => setPay((p) => ({ ...p, amount: e.target.value }))} className="num" aria-invalid={!!show(payErrors.amount)} />
                </Field>
                <Field label={paying ? referenceLabel(f.paymentMode) : "Payment reference"} required={paying} error={show(payErrors.utr)} hint={paying ? (f.paymentMode === "Cash" ? "Required — the cash receipt number" : f.paymentMode === "Cheque" ? "Required — the cheque's number" : "Required — bank / UPI transaction reference") : "Not needed for Credit"}>
                  <Input value={paying ? pay.utr : ""} disabled={!paying} onChange={(e) => setPay((p) => ({ ...p, utr: e.target.value }))} autoComplete="off" aria-invalid={!!show(payErrors.utr)} />
                </Field>
                <Field label="Payment Date" required={paying} error={show(payErrors.date)}>
                  <Input type="date" value={paying ? payDate : ""} max={today} disabled={!paying} onChange={(e) => setPay((p) => ({ ...p, date: e.target.value }))} />
                </Field>
                <Field label="Payment Notes" className="lg:col-span-2">
                  <Input value={paying ? pay.notes : ""} disabled={!paying} onChange={(e) => setPay((p) => ({ ...p, notes: e.target.value }))} />
                </Field>
                <div className="rounded-lg border p-3 sm:col-span-2 lg:col-span-3">
                  <label className="flex items-center justify-between gap-3">
                    <span>
                      <span className="text-sm font-medium">Deduct TDS?</span>
                      <span className="block text-xs text-muted-foreground">{paying ? "Withhold TDS — the vendor is paid the rest; the full amount is settled." : "TDS applies only to a payment — Credit pays nothing now."}</span>
                    </span>
                    <Switch checked={paying && pay.tdsOn} disabled={!paying} onCheckedChange={(on) => setPay((p) => ({ ...p, tdsOn: on }))} aria-label="Deduct TDS" />
                  </label>
                  {paying && pay.tdsOn && <TdsBreakdown percent={pay.tdsPercent} onPercent={(v) => setPay((p) => ({ ...p, tdsPercent: v }))} split={tdsSplitNow} error={show(payErrors.tds)} payee={d.name(f.supplierId)} />}
                </div>
                {excess > 0 && (
                  <label className="flex items-start gap-2 rounded-md border border-sky-300/60 bg-sky-50 px-3 py-2 text-sm sm:col-span-2 lg:col-span-3 dark:border-sky-800 dark:bg-sky-950/40">
                    <Checkbox checked={pay.acceptAdvance} onCheckedChange={(c) => setPay((p) => ({ ...p, acceptAdvance: c === true }))} className="mt-0.5" />
                    <span>
                      Keep the extra <span className="num font-medium">{formatINR(excess)}</span> as advance credit with {d.name(f.supplierId) || "the supplier"}
                      <span className="block text-xs text-muted-foreground">{formatINR(totals.grandTotal)} settles this bill; the rest stays with the vendor for a later bill.</span>
                    </span>
                  </label>
                )}
                <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
                  {paying
                    ? `Saved with the invoice and allocated to it: ${formatINR(Math.min(paid > 0 ? paid : 0, totals.grandTotal))} paid, ${formatINR(Math.max(0, round2(totals.grandTotal - (paid > 0 ? paid : 0))))} outstanding.`
                    : "Credit: the whole bill stays outstanding with the vendor until a payment is recorded on the vendor's page."}
                  {vendorAdvance > 0 && ` ${d.name(f.supplierId)} holds ${formatINR(vendorAdvance)} advance credit — apply it to this bill from the vendor's page after saving.`}
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{invoice ? "Payment notes and remarks" : "Purchase and remarks"}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Mode of Purchase" hint="Optional · information only">
                <Input value={f.purchaseMode} onChange={(e) => set("purchaseMode")(e.target.value)} list="tyre-purchase-modes" />
                <datalist id="tyre-purchase-modes">{used("purchaseMode", PURCHASE_MODES).map((m) => <option key={m} value={m} />)}</datalist>
              </Field>
              {invoice && (
                <>
                  <Field label="Mode of Payment" hint="As on the bill · payments are recorded on the vendor's page">
                    <Input value={f.paymentMode} onChange={(e) => set("paymentMode")(e.target.value)} list="tyre-payment-modes" />
                    <datalist id="tyre-payment-modes">{used("paymentMode", PAYMENT_MODES).map((m) => <option key={m} value={m} />)}</datalist>
                  </Field>
                  <Field label="Payment Details" className="sm:col-span-2" hint="Optional notes">
                    <Input value={f.paymentDetails} onChange={(e) => set("paymentDetails")(e.target.value)} />
                  </Field>
                </>
              )}
              <Field label="Remarks" className="sm:col-span-2">
                <Textarea value={f.remarks} onChange={(e) => set("remarks")(e.target.value)} rows={2} />
              </Field>
              {invoice && (
                <Field
                  label="Reason for change"
                  required={changed.length > 0}
                  className="sm:col-span-2"
                  error={submitted ? (reasonError ?? undefined) : undefined}
                  hint={changed.length ? `Required — you changed the ${changed.join(", ")}. Saved in the invoice's edit history.` : "Optional for payment notes and remarks — saved in the edit history"}
                >
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Rate corrected from the supplier's bill" aria-invalid={submitted && !!reasonError} />
                </Field>
              )}
            </CardContent>
          </Card>
        </div>

        <aside className="hidden self-start xl:sticky xl:top-0 xl:block">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Invoice summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <SummaryRow label={`Base value · ${lines.length} line${lines.length === 1 ? "" : "s"}`} value={totals.baseValue} />
              <SummaryRow label="CGST" value={totals.cgst} />
              <SummaryRow label="SGST" value={totals.sgst} />
              <SummaryRow label="IGST" value={totals.igst} />
              <div className="flex items-baseline justify-between border-t pt-2">
                <span className="font-semibold">Grand Total</span>
                <span className="num text-xl font-semibold">{formatINR(totals.grandTotal)}</span>
              </div>
              {!invoice && (
                <>
                  <SummaryRow label={paying ? `Paid now · ${f.paymentMode}` : "Paid now · Credit"} value={Math.min(paid > 0 ? paid : 0, totals.grandTotal)} />
                  <SummaryRow label="Outstanding" value={Math.max(0, round2(totals.grandTotal - (paid > 0 ? paid : 0)))} />
                  {excess > 0 && <SummaryRow label="Advance credit" value={excess} />}
                  {tdsSplitNow && tdsSplitNow.tds > 0 && <SummaryRow label={`of which TDS · cash ${formatINR(tdsSplitNow.paid)}`} value={tdsSplitNow.tds} />}
                </>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>

        )}
        </div>

        <DialogFooter className="mx-0 mb-0 shrink-0 flex-row items-center gap-2 rounded-b-none px-4 py-3 sm:rounded-b-xl sm:px-6 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mr-auto min-w-0">
            <div className="text-xs text-muted-foreground">
              Grand Total<span className="hidden sm:inline"> · base {formatINR(totals.baseValue)} + GST {formatINR(totals.gst)}</span>
            </div>
            <div className="num text-lg leading-tight font-semibold">{formatINR(totals.grandTotal)}</div>
          </div>
          <Button variant="outline" onClick={requestClose}>
            Cancel
          </Button>
          {!blocked && (
            <Button onClick={submit} disabled={save.isPending}>
              {invoice ? "Save changes" : "Save Invoice"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {confirmClose && (
      <Dialog open onOpenChange={(o) => !o && setConfirmClose(false)}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>{invoice ? "Your changes to this invoice" : "This invoice and its repair lines"} will be lost.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClose(false)} autoFocus>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={onClose}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}
    </>
  )
}

function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="num">{formatINR(value)}</span>
    </div>
  )
}
