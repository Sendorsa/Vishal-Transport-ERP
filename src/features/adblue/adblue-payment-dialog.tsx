"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Lock, Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { DeletionReasonField, HistoryButton } from "@/components/shared/audit"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { Field } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { deletionReasonError } from "@/domain/audit"
import { monthLabel } from "@/domain/diesel"
import { canEditMonth } from "@/domain/month-lock"
import { ADBLUE_PAYMENT_MODES, ADBLUE_TDS_PERCENT, ALLOCATION_STATUS_LABEL, allocateOldestFirst, allocationStatus, PAYABLE_KIND_LABEL, payableLabel, PURCHASE_PAY_LABEL, type Payable, paymentProblem, referenceLabel, settledOf, tdsProblem, tdsSplit, unallocated, type AllocationStatus } from "@/domain/adblue-payments"
import { useAllocateAdBluePayment, useApplyAdBlueAdvance, useCreateAdBluePayment, useSettings, useUpdateAdBluePayment } from "@/lib/api/hooks"
import { useRole } from "@/lib/app-state"
import { formatDate, formatINR, formatLitres, formatNumber, round2, todayISO } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { AdBluePayment, CompanyCode } from "@/lib/types"
import { useAdBlueFinance } from "./adblue-data"

const NONE = "_none"
const num = (s: string) => (s.trim() === "" ? 0 : Number(s))
/** Bulk (into stock) or Direct (straight into a vehicle) — every place a purchase is listed for payment. */
export function PayableKindBadge({ kind }: { kind: Payable["kind"] }) {
  return (
    <Badge variant="outline" className={cn("px-1.5 py-0 text-[11px] font-medium", kind === "DIRECT" ? "border-violet-300 text-violet-800 dark:border-violet-800 dark:text-violet-300" : "text-muted-foreground")}>
      {PAYABLE_KIND_LABEL[kind]}
    </Badge>
  )
}

const ALLOC_CLASS: Record<AllocationStatus, string> = {
  FULL: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  PARTIAL: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  ADVANCE: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
}
/** Fully allocated · Partially allocated · Advance / Unallocated. */
export function AllocationBadge({ payment }: { payment: AdBluePayment }) {
  const s = allocationStatus(payment)
  return (
    <Badge variant="outline" className={cn("font-medium whitespace-nowrap", ALLOC_CLASS[s])}>
      {ALLOCATION_STATUS_LABEL[s]}
    </Badge>
  )
}

/** Settled, with "₹ paid + ₹ TDS (x%)" under it when TDS was deducted. */
export function SettledAmount({ payment: p }: { payment: AdBluePayment }) {
  return (
    <div className="flex flex-col items-end">
      <span className="num font-medium">{formatINR(settledOf(p))}</span>
      {p.tdsAmount > 0 && (
        <span className="num max-w-36 text-right text-xs whitespace-normal text-muted-foreground">
          {formatINR(p.amount)} paid + {formatINR(p.tdsAmount)} TDS ({formatNumber(p.tdsRate ?? 0, 4)}%)
        </span>
      )}
    </div>
  )
}

/** TDS % (editable) and the live split: total settled − TDS = net paid to the vendor. */
export function TdsBreakdown({ percent, onPercent, split, error, payee }: { percent: string; onPercent: (v: string) => void; split: ReturnType<typeof tdsSplit> | null; error?: string; payee: string }) {
  const p = Number(percent)
  return (
    <div className="mt-3 grid gap-3">
      <Field label="TDS Percentage (%)" required error={error} hint={`Default ${ADBLUE_TDS_PERCENT}% — change it if a different rate applies`} className="sm:max-w-56">
        <Input type="number" min={0} max={99.9999} step="0.0001" inputMode="decimal" value={percent} onChange={(e) => onPercent(e.target.value)} className="num" />
      </Field>
      <dl className="grid content-start gap-1.5 rounded-md bg-muted/40 p-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Total amount settled</dt>
          <dd className="num">{formatINR(split?.settled ?? 0)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">TDS deducted{Number.isFinite(p) && percent.trim() !== "" ? ` (${formatNumber(p, 4)}%)` : ""}</dt>
          <dd className="num">− {formatINR(split?.tds ?? 0)}</dd>
        </div>
        <div className="flex justify-between gap-3 border-t pt-1.5">
          <dt className="font-semibold">Net amount paid to {payee || "the vendor"}</dt>
          <dd className="num text-base font-semibold text-emerald-700 dark:text-emerald-400">{formatINR(split?.paid ?? 0)}</dd>
        </div>
      </dl>
    </div>
  )
}

/**
 * The AdBlue payment modal (owner, 18 Nov 2026):
 *   Add Payment (no `payment`): pick the vendor (searchable; preselected from a vendor page), date, mode, reference
 *     (UTR / cheque / receipt number by mode), amount, "Deduct TDS?", paid by, notes — then allocate it to that vendor's
 *     outstanding purchases ("Allocate oldest first" fills them, editable); the rest only as confirmed advance credit.
 *   Apply advance (`payment`, not `edit`): one payment's unallocated part to outstanding purchases.
 *   Apply vendor advance (`vendorAdvance`): all the vendor's advance credit (across its payments, oldest first) — no new
 *     payment is created.
 *   Edit (`payment` + `edit`): every field and the allocations (prefilled as recorded; changed only by the user), with a
 *     reason for a financial change.
 * The API recalculates TDS and checks the same rules. Payments never touch stock.
 */
export function AdBluePaymentDialog({ vendorId: fixedVendor, payment, edit, vendorAdvance, onClose }: { vendorId?: string; payment?: AdBluePayment; edit?: boolean; vendorAdvance?: boolean; onClose: () => void }) {
  const d = useAdBlueFinance()
  const [role] = useRole()
  const settings = useSettings()
  const create = useCreateAdBluePayment()
  const allocate = useAllocateAdBluePayment()
  const applyAdvance = useApplyAdBlueAdvance()
  const update = useUpdateAdBluePayment()
  const today = todayISO()
  const [vendorId, setVendorId] = useState(fixedVendor ?? payment?.vendorId ?? "")
  const vendor = vendorId ? d.vendorName(vendorId) : ""
  const account = d.accounts.find((a) => a.vendorId === vendorId)
  const applying = !!payment && !edit
  const advanceMode = applying || !!vendorAdvance
  const advanceLeft = applying ? unallocated(payment!) : vendorAdvance ? (account?.advance ?? 0) : 0

  const own = useMemo(() => {
    const m = new Map<string, number>()
    if (edit && payment) for (const a of payment.allocations) m.set(a.purchaseId, round2((m.get(a.purchaseId) ?? 0) + a.amount))
    return m
  }, [edit, payment])
  const [f, setF] = useState(() => ({
    date: edit ? payment!.date : today,
    amount: edit ? String(settledOf(payment!)) : "",
    mode: edit ? payment!.mode : "",
    utr: edit ? payment!.utr : "",
    companyCode: edit ? (payment!.companyCode ?? NONE) : NONE,
    notes: edit ? payment!.notes : "",
    tdsOn: edit ? payment!.tdsRate != null : false,
    tdsPercent: String(edit ? (payment!.tdsRate ?? ADBLUE_TDS_PERCENT) : ADBLUE_TDS_PERCENT),
  }))
  const [apply, setApply] = useState<Record<string, string>>(() => Object.fromEntries([...own].map(([k, v]) => [k, String(v)])))
  const [acceptAdvance, setAcceptAdvance] = useState(edit ? unallocated(payment!) > 0 : false)
  const [reason, setReason] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }))
  const pickVendor = (id: string) => {
    setVendorId(id)
    setApply({}) // another vendor's purchases: start again
    setAcceptAdvance(false)
  }

  // The vendor's purchases that still owe something (an edited payment's own allocations put back), oldest first; plus
  // the purchases this payment already pays, so they stay editable.
  const open = useMemo(
    () =>
      d.payables
        .filter((p) => p.vendorId === vendorId)
        .map((p) => ({ p, pay: d.payOfPayable(p), left: round2(d.payOfPayable(p).outstanding + (own.get(p.id) ?? 0)), locked: !canEditMonth(role, p.date.slice(0, 7), today, d.locks) }))
        .filter((x) => x.left > 0 || own.has(x.p.id))
        .sort((a, b) => a.p.date.localeCompare(b.p.date) || a.p.createdAt.localeCompare(b.p.createdAt)),
    [d, vendorId, role, today, own]
  )
  const owedBefore = round2(open.reduce((t, x) => t + x.left, 0))
  const total = num(f.amount)
  const percent = f.tdsPercent.trim() === "" ? NaN : Number(f.tdsPercent)
  const tdsErr = !advanceMode && f.tdsOn ? tdsProblem(total, percent) : null
  const split = !advanceMode && f.tdsOn && total > 0 && !tdsErr ? tdsSplit(total, percent) : null
  const amount = advanceMode ? advanceLeft : total
  const allocations = open.filter((x) => num(apply[x.p.id] ?? "") !== 0).map((x) => ({ purchaseId: x.p.id, amount: num(apply[x.p.id]) }))
  const allocated = round2(allocations.reduce((t, a) => t + a.amount, 0))
  const rest = round2(amount - allocated)
  const label = (id: string) => (d.payableOf(id) ? payableLabel(d.payableOf(id)!, formatDate) : "Purchase")
  const outstanding = (id: string) => open.find((x) => x.p.id === id)?.left
  const problem = !vendorId
    ? "Choose the AdBlue vendor"
    : advanceMode
      ? allocations.length === 0
        ? "Enter the amount to apply to at least one purchase"
        : (paymentProblem({ date: payment?.date ?? today, amount: advanceLeft, mode: payment?.mode ?? "NEFT", utr: payment?.utr ?? "advance", allocations, acceptAdvance: true }, today, outstanding, label)?.replace("are more than the payment", "are more than the advance left") ?? null)
      : (tdsErr ?? paymentProblem({ date: f.date, amount, mode: f.mode, utr: f.utr, allocations, acceptAdvance }, today, outstanding, label))
  const allocChanged = edit && (allocations.length !== own.size || allocations.some((a) => own.get(a.purchaseId) !== round2(a.amount)))
  const financial = edit ? [f.date !== payment!.date, total !== settledOf(payment!), f.mode !== payment!.mode, (f.tdsOn ? percent : null) !== (payment!.tdsRate ?? null), allocChanged].some(Boolean) : false
  const reasonErr = financial ? deletionReasonError(reason, "correcting") : null
  const lockedMonth = !advanceMode && f.date && !canEditMonth(role, f.date.slice(0, 7), today, d.locks) ? `${monthLabel(f.date.slice(0, 7))} is locked — only the Owner and Dev can date a payment in it.` : null
  const pending = create.isPending || allocate.isPending || update.isPending || applyAdvance.isPending
  const vendorOptions = d.vendors
    .filter((v) => v.status === "ACTIVE" || d.accounts.some((a) => a.vendorId === v.id && a.outstanding > 0))
    .map((v) => {
      const a = d.accounts.find((x) => x.vendorId === v.id)
      return { value: v.id, label: `${v.name}${a?.outstanding ? ` · ${formatINR(a.outstanding)} outstanding` : ""}` }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  // Fill the outstanding purchases oldest first with what is left — shown, editable, never saved without the user.
  const fillOldest = () => setApply(Object.fromEntries(Object.entries(allocateOldestFirst(amount, open.map((x) => ({ id: x.p.id, left: x.left, locked: x.locked })))).map(([k, v]) => [k, String(v)])))

  const submit = async () => {
    setSubmitted(true)
    if (problem || lockedMonth || reasonErr) return
    if (vendorAdvance) {
      await applyAdvance.mutateAsync({ vendorId, allocations })
      toast.success(`${formatINR(allocated)} of advance credit applied`, { description: "No new payment — the vendor's existing payments now cover these purchases." })
    } else if (applying) {
      await allocate.mutateAsync({ id: payment!.id, allocations, version: payment!.updatedAt })
      toast.success(`${formatINR(allocated)} of advance applied`)
    } else {
      const body = { date: f.date, amount: total, tdsPercent: f.tdsOn ? percent : null, mode: f.mode, utr: f.utr, companyCode: f.companyCode === NONE ? null : (f.companyCode as CompanyCode), notes: f.notes, allocations, acceptAdvance: rest > 0 && acceptAdvance }
      if (edit) {
        await update.mutateAsync({ id: payment!.id, data: body, reason, version: payment!.updatedAt })
        toast.success("Payment updated")
      } else {
        await create.mutateAsync({ ...body, vendorId })
        toast.success(`Payment to ${vendor} recorded`, { description: [split && `${formatINR(split.paid)} paid + ${formatINR(split.tds)} TDS`, rest > 0 && `${formatINR(rest)} kept as advance credit`].filter(Boolean).join(" · ") || undefined })
      }
    }
    onClose()
  }

  const show = (e: string | null | undefined) => (submitted ? (e ?? undefined) : undefined)
  const fieldError = (re: RegExp) => (problem && re.test(problem) ? show(problem) : undefined)
  const row = (k: string, v: string, strong?: boolean, tone?: string) => (
    <div className="flex justify-between gap-3">
      <dt className={strong ? "font-semibold" : "text-muted-foreground"}>{k}</dt>
      <dd className={cn("num", strong && "font-semibold", tone)}>{v}</dd>
    </div>
  )

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 sm:px-6">
          <DialogTitle>{advanceMode ? "Apply advance credit" : edit ? "Edit payment" : "Make payment"}</DialogTitle>
          <DialogDescription>
            {applying
              ? `${vendor} · ${payment!.mode} · ${referenceLabel(payment!.mode)} ${payment!.utr} · ${formatDate(payment!.date)} · ${formatINR(advanceLeft)} advance left of ${formatINR(settledOf(payment!))}`
              : vendorAdvance
                ? `${vendor} holds ${formatINR(advanceLeft)} of our money. Apply it to outstanding purchases — no new payment is recorded.`
                : edit
                  ? `${vendor} · recorded ${formatDate(payment!.date)} · changes are kept in the payment's history`
                  : "Choose the vendor, enter the payment, then allocate it to the purchases it pays. Anything left over is advance credit. Stock is not changed."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
          {!advanceMode && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="AdBlue Vendor" required error={!vendorId ? show(problem) : undefined} className="sm:col-span-2">
                {fixedVendor || edit ? (
                  <div className="flex min-h-9 items-center rounded-md border bg-muted/40 px-3 text-sm font-medium">{vendor}</div>
                ) : (
                  <CreatableSelect value={vendorId} options={vendorOptions} onChange={pickVendor} placeholder="Search and choose the vendor…" invalid={submitted && !vendorId} />
                )}
              </Field>
              {vendorId && account && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-sm sm:col-span-2 sm:grid-cols-4">
                  <div><dt className="text-xs text-muted-foreground">Purchased</dt><dd className="num">{formatINR(account.purchased)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Paid</dt><dd className="num">{formatINR(account.settled)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Outstanding</dt><dd className="num font-medium text-rose-700 dark:text-rose-400">{formatINR(account.outstanding)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Advance credit</dt><dd className="num text-sky-700 dark:text-sky-400">{formatINR(account.advance)}</dd></div>
                </dl>
              )}
              <Field label="Payment Date" required error={show(lockedMonth) ?? fieldError(/payment date|future/)}>
                <Input type="date" value={f.date} max={today} onChange={(e) => set("date")(e.target.value)} />
              </Field>
              <Field label="Payment Mode" required error={fieldError(/how it was paid|Credit means/)}>
                <SimpleSelect value={f.mode} onChange={set("mode")} options={ADBLUE_PAYMENT_MODES.map((m) => ({ value: m, label: m }))} placeholder="Choose…" />
              </Field>
              <Field label={f.mode ? referenceLabel(f.mode) : "Reference number"} required error={fieldError(/UTR|cheque number|receipt number|already recorded/)} hint={f.mode === "Cash" ? "The cash receipt number" : f.mode === "Cheque" ? "The cheque's number" : f.mode ? "Bank / UPI transaction reference (UTR)" : "Choose the mode first"}>
                <Input value={f.utr} onChange={(e) => set("utr")(e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Amount Being Paid (₹)" required error={fieldError(/amount must|2 decimals \(paise\)$/)} hint={f.tdsOn ? "The amount settled against the vendor, before TDS" : "The amount settled against the vendor"}>
                <Input type="number" inputMode="decimal" min={0} step="0.01" value={f.amount} onChange={(e) => set("amount")(e.target.value)} className="num" placeholder="0.00" />
              </Field>

              <div className="rounded-lg border p-3 sm:col-span-2">
                <label className="flex items-center justify-between gap-3">
                  <span>
                    <span className="text-sm font-medium">Deduct TDS?</span>
                    <span className="block text-xs text-muted-foreground">Withhold TDS — the vendor is paid the rest; the full amount is settled.</span>
                  </span>
                  <Switch checked={f.tdsOn} onCheckedChange={(on) => setF((s) => ({ ...s, tdsOn: on }))} aria-label="Deduct TDS" />
                </label>
                {f.tdsOn && <TdsBreakdown percent={f.tdsPercent} onPercent={set("tdsPercent")} split={split} error={show(tdsErr)} payee={vendor} />}
              </div>

              <Field label="Paid By" hint="Optional">
                <SimpleSelect value={f.companyCode} onChange={set("companyCode")} options={[{ value: NONE, label: "Not recorded" }, ...(settings.data?.companies ?? []).map((c) => ({ value: c.code, label: c.name }))]} />
              </Field>
              <Field label="Notes">
                <Textarea rows={1} value={f.notes} onChange={(e) => set("notes")(e.target.value)} />
              </Field>
            </div>
          )}

          {vendorId && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{edit ? "Allocated to purchases" : `Outstanding purchases from ${vendor}`}</h3>
                {open.length > 0 && amount > 0 && (
                  <Button type="button" variant="outline" size="sm" onClick={fillOldest}>
                    Allocate oldest first
                  </Button>
                )}
              </div>
              {edit && <p className="text-xs text-muted-foreground">As recorded — change an amount only to re-allocate this payment; nothing moves by itself.</p>}
              {open.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Nothing is outstanding with {vendor}{advanceMode ? "." : " — the whole payment will be advance credit."}</p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  <li className="hidden grid-cols-[1fr_7rem_7rem_7rem_9rem] gap-3 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground md:grid">
                    <span>Purchase date · Type · Bill</span>
                    <span className="text-right">Purchase amount</span>
                    <span className="text-right">Already paid</span>
                    <span className="text-right">Outstanding</span>
                    <span className="text-right">Amount to allocate</span>
                  </li>
                  {open.map(({ p, pay, left, locked }) => (
                    <li key={p.id} className="grid grid-cols-2 items-center gap-x-3 gap-y-1 px-3 py-2 text-sm md:grid-cols-[1fr_7rem_7rem_7rem_9rem]">
                      <div className="col-span-2 md:col-span-1">
                        <span className="num">{formatDate(p.date)}</span> · <PayableKindBadge kind={p.kind} /> <span className="font-medium">Bill {p.billNo || "—"}</span> <span className="text-xs text-muted-foreground">· {formatLitres(p.litres)}</span>
                      </div>
                      <div className="num text-xs md:text-right md:text-sm"><span className="text-muted-foreground md:hidden">Amount </span>{formatINR(pay.value)}</div>
                      <div className="num text-xs md:text-right md:text-sm"><span className="text-muted-foreground md:hidden">Paid </span>{formatINR(round2(pay.value - left))}</div>
                      <div className="num text-xs font-medium md:text-right md:text-sm"><span className="font-normal text-muted-foreground md:hidden">Outstanding </span>{formatINR(left)}</div>
                      <div className="md:justify-self-end">
                        {locked ? (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={`${monthLabel(p.date.slice(0, 7))} is locked`}>
                            <Lock className="size-3.5" /> locked{own.has(p.id) ? ` · ${formatINR(own.get(p.id)!)}` : ""}
                          </span>
                        ) : (
                          <Input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            max={left}
                            step="0.01"
                            value={apply[p.id] ?? ""}
                            onChange={(e) => setApply((a) => ({ ...a, [p.id]: e.target.value }))}
                            className="num h-8 w-full md:w-36"
                            placeholder="0.00"
                            aria-label={`Amount for ${PAYABLE_KIND_LABEL[p.kind].toLowerCase()} bill ${p.billNo || "—"} of ${formatDate(p.date)}`}
                          />
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <dl className="grid gap-1 rounded-md bg-muted/40 p-3 text-sm sm:grid-cols-2 sm:gap-x-8">
                {advanceMode ? (
                  <>
                    {row("Advance credit available", formatINR(advanceLeft))}
                    {row("Applied now", formatINR(allocated))}
                    {row("Advance left after this", formatINR(Math.max(0, rest)), false, rest > 0 ? "text-sky-700 dark:text-sky-400" : undefined)}
                    {row("Vendor outstanding after this", formatINR(Math.max(0, round2(owedBefore - allocated))), true)}
                  </>
                ) : (
                  <>
                    {row("Total payment (settled)", formatINR(split?.settled ?? total))}
                    {row("TDS deducted", formatINR(split?.tds ?? 0))}
                    {row("Actual amount paid (bank / cash)", formatINR(split?.paid ?? total))}
                    {row("Allocated to purchases", formatINR(allocated))}
                    {row("Unallocated → advance credit", formatINR(Math.max(0, rest)), false, rest > 0 ? "text-sky-700 dark:text-sky-400" : undefined)}
                    {row("Vendor outstanding after this", formatINR(Math.max(0, round2(owedBefore - allocated))), true)}
                  </>
                )}
              </dl>
              {!advanceMode && rest > 0 && amount > 0 && (
                <label className="flex items-start gap-2 rounded-md border border-sky-300/60 bg-sky-50 px-3 py-2 text-sm dark:border-sky-800 dark:bg-sky-950/40">
                  <Checkbox checked={acceptAdvance} onCheckedChange={(c) => setAcceptAdvance(c === true)} className="mt-0.5" />
                  <span>
                    Keep <span className="num font-medium">{formatINR(rest)}</span> as advance credit with {vendor}
                    <span className="block text-xs text-muted-foreground">Not on any purchase yet — apply it later with Apply Advance on the vendor&apos;s page.</span>
                  </span>
                </label>
              )}
            </section>
          )}
          {submitted && problem && vendorId && <p className="text-sm text-destructive">{problem}</p>}

          {edit && (
            <Field label="Reason for change" required={financial} error={show(reasonErr)} hint={financial ? "Required — you changed the date, amount, mode, TDS or allocations. Kept in the payment's history." : "Optional for the reference and notes"}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Amount corrected from the bank statement" />
            </Field>
          )}
        </div>

        <DialogFooter className="mx-0 mb-0 shrink-0 flex-row items-center justify-end gap-2 rounded-b-xl px-4 py-3 sm:px-6">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {advanceMode ? "Apply advance" : edit ? "Save changes" : "Save Payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Delete (the Owner / Dev): permanent — the payment and its allocations are removed; the audit log keeps them. */
export function DeleteAdBluePaymentDialog({ payment: p, vendor, bills, pending, onConfirm, onClose }: { payment: AdBluePayment; vendor: string; bills: string[]; pending: boolean; onConfirm: (reason: string) => Promise<unknown>; onClose: () => void }) {
  const [reason, setReason] = useState("")
  const [touched, setTouched] = useState(false)
  const error = deletionReasonError(reason)
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this payment?</DialogTitle>
          <DialogDescription>
            {vendor} · {p.mode} · {referenceLabel(p.mode)} {p.utr} · {formatDate(p.date)}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid gap-1 rounded-md bg-muted/40 p-3 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Total settled</dt>
            <dd className="num font-medium">{formatINR(settledOf(p))}</dd>
          </div>
          {p.tdsAmount > 0 && (
            <>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">TDS ({formatNumber(p.tdsRate ?? 0, 4)}%)</dt>
                <dd className="num">{formatINR(p.tdsAmount)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Paid to vendor</dt>
                <dd className="num">{formatINR(p.amount)}</dd>
              </div>
            </>
          )}
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Allocated to</dt>
            <dd className="text-right">{bills.length ? bills.join(", ") : "No purchase (advance)"}</dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">
          The payment and its allocations are <span className="font-medium text-foreground">removed permanently</span>: the vendor&apos;s paid, outstanding and advance credit, TDS and the ledger are recalculated
          {bills.length ? ", and those purchases are owed again" : ", and its advance credit is gone"}. AdBlue stock is not affected. Only the audit log keeps it, with the reason. This can&apos;t be undone.
        </p>
        <DeletionReasonField value={reason} onChange={setReason} onBlur={() => setTouched(true)} error={touched ? error : null} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!!error || pending} onClick={() => onConfirm(reason.trim())}>
            Delete Payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One payment, read only: amounts, TDS, reference, allocations, status, history. */
export function AdBluePaymentDetailsDialog({ payment: p, onClose, onEdit, onDelete }: { payment: AdBluePayment; onClose: () => void; onEdit?: () => void; onDelete?: () => void }) {
  const d = useAdBlueFinance()
  const basic: [string, React.ReactNode][] = [
    ["Vendor", <Link key="v" href={`/adblue/vendors/${p.vendorId}`} className="underline-offset-2 hover:underline">{d.vendorName(p.vendorId)}</Link>],
    ["Payment date", formatDate(p.date)],
    [referenceLabel(p.mode), <span key="r" className="num break-all">{p.utr}</span>],
    ["Payment mode", p.mode],
    ["Paid by", p.companyCode ?? "Not recorded"],
    ["Notes", p.notes || "—"],
  ]
  // Settled = actual amount paid + TDS (settledOf) — the figures as recorded, never recalculated here.
  const breakdown: [string, React.ReactNode][] = [
    ["Total settled", <span key="s" className="num font-medium">{formatINR(settledOf(p))}</span>],
    ["TDS %", p.tdsRate != null && p.tdsAmount > 0 ? <span key="tr" className="num">{formatNumber(p.tdsRate, 4)}%</span> : p.tdsRate === 0 ? "0%" : "Not deducted"],
    ["TDS amount", <span key="t" className="num">{formatINR(p.tdsAmount)}</span>],
    ["Actual amount paid", <span key="p" className="num">{formatINR(p.amount)}</span>],
    ["Advance left", <span key="a" className="num">{formatINR(unallocated(p))}</span>],
  ]
  const list = (rows: [string, React.ReactNode][]) => (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right">{v}</dd>
        </div>
      ))}
    </dl>
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Payment · {formatINR(settledOf(p))} <AllocationBadge payment={p} />
          </DialogTitle>
          <DialogDescription>{`${d.vendorName(p.vendorId)} · ${formatDate(p.date)}`}</DialogDescription>
        </DialogHeader>
        <section className="space-y-1.5">
          <h3 className="text-sm font-semibold">Basic information</h3>
          {list(basic)}
        </section>
        <section className="space-y-1.5">
          <h3 className="text-sm font-semibold">Payment breakdown</h3>
          {list(breakdown)}
        </section>
        <section className="space-y-1.5">
          <h3 className="text-sm font-semibold">Purchase allocations</h3>
          {p.allocations.length ? (
            <ul className="divide-y rounded-md border text-sm">
              {p.allocations.map((a, n) => {
                const x = d.payableOf(a.purchaseId)
                return (
                  <li key={n} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <span className="min-w-0">
                      <span className="block">{x ? payableLabel(x, formatDate) : "Purchase"}</span>
                      {x && <span className="text-xs text-muted-foreground">{PURCHASE_PAY_LABEL[d.payOfPayable(x).status]}</span>}
                    </span>
                    <span className="num shrink-0">{formatINR(a.amount)}</span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No purchase — the whole payment is advance credit.</p>
          )}
        </section>
        <DialogFooter className="items-center sm:justify-between">
          <HistoryButton id={p.id} />
          <div className="flex flex-wrap justify-end gap-2">
            {onDelete && (
              <Button variant="outline" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onDelete}>
                <Trash2 /> Delete
              </Button>
            )}
            {onEdit && (
              <Button variant="outline" onClick={onEdit}>
                <Pencil /> Edit
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
