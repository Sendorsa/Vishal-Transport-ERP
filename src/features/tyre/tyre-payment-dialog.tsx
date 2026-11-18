"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Lock } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { DeletionReasonField, HistoryButton } from "@/components/shared/audit"
import { Field } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { deletionReasonError } from "@/domain/audit"
import { monthLabel } from "@/domain/diesel"
import { canEditMonth } from "@/domain/month-lock"
import { ALLOCATION_STATUS_LABEL, allocationStatus, paymentProblem, referenceLabel, settledOf, tdsProblem, TYRE_PAYMENT_MODES, TYRE_TDS_PERCENT, tyreTdsSplit, unallocated, type AllocationStatus } from "@/domain/tyre"
import { useAllocateTyrePayment, useCreateTyrePayment, useSettings, useUpdateTyrePayment } from "@/lib/api/hooks"
import { useRole } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber, round2, todayISO } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { CompanyCode, TyrePayment } from "@/lib/types"
import { useTyreData } from "./tyre-data"

const NONE = "_none"
const num = (s: string) => (s.trim() === "" ? 0 : Number(s))

const ALLOC_CLASS: Record<AllocationStatus, string> = {
  FULL: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  PARTIAL: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  ADVANCE: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
}
/** Fully allocated · Partially allocated · Advance / Unallocated. */
export function AllocationBadge({ payment }: { payment: TyrePayment }) {
  const s = allocationStatus(payment)
  return (
    <Badge variant="outline" className={cn("font-medium whitespace-nowrap", ALLOC_CLASS[s])}>
      {ALLOCATION_STATUS_LABEL[s]}
    </Badge>
  )
}

/** Settled, with "₹ paid + ₹ TDS (x%)" under it when TDS was deducted. */
export function SettledAmount({ payment: p, className }: { payment: TyrePayment; className?: string }) {
  return (
    <div className={cn("flex flex-col items-end", className)}>
      <span className="num font-medium">{formatINR(settledOf(p))}</span>
      {(p.tdsAmount ?? 0) > 0 && (
        <span className="num max-w-36 text-right text-xs whitespace-normal text-muted-foreground">
          {formatINR(p.amount)} paid + {formatINR(p.tdsAmount!)} TDS ({formatNumber(p.tdsRate ?? 0, 4)}%)
        </span>
      )}
    </div>
  )
}

/**
 * Add Payment (no `payment`): date, total settled, mode, reference (UTR / cheque / receipt number by mode), "Deduct TDS?",
 * paid by, notes — allocated explicitly to outstanding bills; the rest only as confirmed advance credit.
 * Apply advance (`payment`, not `edit`): the payment's unallocated settled amount to outstanding bills.
 * Edit (`payment` + `edit`): every field and the allocations (prefilled as recorded; changed only by the user), with a
 * reason for a financial change. The API recalculates TDS and checks the same rules.
 */
export function TyrePaymentDialog({ supplierId, payment, edit, onClose }: { supplierId: string; payment?: TyrePayment; edit?: boolean; onClose: () => void }) {
  const d = useTyreData()
  const [role] = useRole()
  const settings = useSettings()
  const create = useCreateTyrePayment()
  const allocate = useAllocateTyrePayment()
  const update = useUpdateTyrePayment()
  const today = todayISO()
  const vendor = d.name(supplierId)
  const applying = !!payment && !edit
  const advanceLeft = applying ? unallocated(payment!) : 0

  const own = useMemo(() => {
    const m = new Map<string, number>()
    if (edit && payment) for (const a of payment.allocations) m.set(a.invoiceId, round2((m.get(a.invoiceId) ?? 0) + a.amount))
    return m
  }, [edit, payment])
  const [f, setF] = useState(() => ({
    date: edit ? payment!.date : today,
    amount: edit ? String(settledOf(payment!)) : "",
    mode: edit ? payment!.mode : "",
    utr: edit ? payment!.utr : "",
    reference: edit ? payment!.reference : "",
    companyCode: edit ? (payment!.companyCode ?? NONE) : NONE,
    notes: edit ? payment!.notes : "",
    tdsOn: edit ? payment!.tdsRate != null : false,
    tdsPercent: String(edit ? (payment!.tdsRate ?? TYRE_TDS_PERCENT) : TYRE_TDS_PERCENT),
  }))
  const [apply, setApply] = useState<Record<string, string>>(() => Object.fromEntries([...own].map(([k, v]) => [k, String(v)])))
  const [acceptAdvance, setAcceptAdvance] = useState(edit ? unallocated(payment!) > 0 : false)
  const [reason, setReason] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }))

  // The vendor's bills that still owe something (an edited payment's own allocations put back), oldest first; plus
  // the bills this payment already pays, so they stay editable.
  const open = useMemo(
    () =>
      d.views
        .filter((v) => v.supplierId === supplierId)
        .map((v) => ({ v, left: round2(d.payOf(v).outstanding + (own.get(v.id) ?? 0)), locked: !canEditMonth(role, v.date.slice(0, 7), today, d.locks) }))
        .filter((x) => x.left > 0 || own.has(x.v.id))
        .sort((a, b) => a.v.date.localeCompare(b.v.date) || a.v.createdAt.localeCompare(b.v.createdAt)),
    [d, supplierId, role, today, own]
  )
  const total = num(f.amount)
  const percent = f.tdsPercent.trim() === "" ? NaN : Number(f.tdsPercent)
  const tdsErr = !applying && f.tdsOn ? tdsProblem(total, percent) : null
  const split = !applying && f.tdsOn && total > 0 && !tdsErr ? tyreTdsSplit(total, percent) : null
  const amount = applying ? advanceLeft : total
  const allocations = open.filter((x) => num(apply[x.v.id] ?? "") !== 0).map((x) => ({ invoiceId: x.v.id, amount: num(apply[x.v.id]) }))
  const allocated = round2(allocations.reduce((t, a) => t + a.amount, 0))
  const rest = round2(amount - allocated)
  const label = (id: string) => {
    const v = d.views.find((x) => x.id === id)
    return v ? `Bill ${v.billNo || "—"} (${formatDate(v.date)})` : id
  }
  const outstanding = (id: string) => open.find((x) => x.v.id === id)?.left
  const problem = applying
    ? allocations.length === 0
      ? "Enter the amount to apply to at least one invoice"
      : (paymentProblem({ date: payment!.date, amount: advanceLeft, mode: payment!.mode, utr: payment!.utr, allocations, acceptAdvance: true }, today, outstanding, label)?.replace("are more than the payment", "are more than the advance left") ?? null)
    : (tdsErr ?? paymentProblem({ date: f.date, amount, mode: f.mode, utr: f.utr, allocations, acceptAdvance }, today, outstanding, label))
  // An edit's financial changes need a reason (the API checks the same list).
  const allocChanged = edit && (allocations.length !== own.size || allocations.some((a) => own.get(a.invoiceId) !== round2(a.amount)))
  const financial = edit
    ? [f.date !== payment!.date, total !== settledOf(payment!), f.mode !== payment!.mode, (f.tdsOn ? percent : null) !== (payment!.tdsRate ?? null), allocChanged].some(Boolean)
    : false
  const reasonErr = financial ? deletionReasonError(reason, "correcting") : null
  const lockedMonth = !applying && f.date && !canEditMonth(role, f.date.slice(0, 7), today, d.locks) ? `${monthLabel(f.date.slice(0, 7))} is locked — only the Owner and Dev can date a payment in it.` : null
  const pending = create.isPending || allocate.isPending || update.isPending

  // Fill the outstanding bills oldest first with what is left — shown, editable, never saved without the user.
  const fillOldest = () => {
    let left = amount
    const next: Record<string, string> = {}
    for (const x of open) {
      if (x.locked || left <= 0) continue
      const a = Math.min(left, x.left)
      next[x.v.id] = String(a)
      left = round2(left - a)
    }
    setApply(next)
  }

  const submit = async () => {
    setSubmitted(true)
    if (problem || lockedMonth || reasonErr) return
    if (applying) {
      await allocate.mutateAsync({ id: payment!.id, allocations, version: payment!.updatedAt })
      toast.success(`${formatINR(allocated)} of advance applied`)
    } else {
      const body = { date: f.date, amount: total, tdsPercent: f.tdsOn ? percent : null, mode: f.mode, utr: f.utr, reference: f.reference, companyCode: f.companyCode === NONE ? null : (f.companyCode as CompanyCode), notes: f.notes, allocations, acceptAdvance: rest > 0 && acceptAdvance }
      if (edit) {
        await update.mutateAsync({ id: payment!.id, data: body, reason, version: payment!.updatedAt })
        toast.success("Payment updated")
      } else {
        await create.mutateAsync({ ...body, supplierId })
        toast.success("Payment recorded", { description: [split && `${formatINR(split.paid)} paid + ${formatINR(split.tds)} TDS`, rest > 0 && `${formatINR(rest)} kept as advance credit with ${vendor}`].filter(Boolean).join(" · ") || undefined })
      }
    }
    onClose()
  }

  const show = (e: string | null | undefined) => (submitted ? (e ?? undefined) : undefined)
  const fieldError = (re: RegExp) => (problem && re.test(problem) ? show(problem) : undefined)

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 sm:px-6">
          <DialogTitle>{applying ? "Apply advance credit" : edit ? "Edit payment" : "Add payment"}</DialogTitle>
          <DialogDescription>
            {applying
              ? `${vendor} · ${payment!.mode} · ${referenceLabel(payment!.mode)} ${payment!.utr} · ${formatDate(payment!.date)} · ${formatINR(advanceLeft)} advance left of ${formatINR(settledOf(payment!))}`
              : edit
                ? `${vendor} · recorded ${formatDate(payment!.date)} · changes are kept in the payment's history`
                : `To ${vendor}. Allocate it to the bills it pays; anything left over is advance credit with the vendor.`}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
          {!applying && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Vendor">
                <div className="flex min-h-9 items-center rounded-md border bg-muted/40 px-3 text-sm font-medium">{vendor}</div>
              </Field>
              <Field label="Payment Date" required error={show(lockedMonth) ?? fieldError(/payment date|future/)}>
                <Input type="date" value={f.date} max={today} onChange={(e) => set("date")(e.target.value)} />
              </Field>
              <Field label={f.tdsOn ? "Total Payment Amount (₹)" : "Payment Amount (₹)"} required error={fieldError(/amount must|2 decimals \(paise\)$/)} hint={f.tdsOn ? "The amount being settled, before TDS" : undefined}>
                <Input type="number" inputMode="decimal" min={0} step="0.01" value={f.amount} onChange={(e) => set("amount")(e.target.value)} className="num" placeholder="0.00" />
              </Field>
              <Field label="Payment Mode" required error={fieldError(/how it was paid/)}>
                <SimpleSelect value={f.mode} onChange={set("mode")} options={TYRE_PAYMENT_MODES.map((m) => ({ value: m, label: m }))} placeholder="Choose…" />
              </Field>
              <Field label={f.mode ? referenceLabel(f.mode) : "Payment reference"} required error={fieldError(/UTR|cheque number|receipt number/)} hint={f.mode === "Cash" ? "The cash receipt number" : f.mode === "Cheque" ? "The cheque's number" : "Bank / UPI transaction reference"}>
                <Input value={f.utr} onChange={(e) => set("utr")(e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Reference / Bill Number" hint="Optional">
                <Input value={f.reference} onChange={(e) => set("reference")(e.target.value)} />
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

          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{edit ? "Allocated to bills" : "Allocate to outstanding bills"}</h3>
              {open.length > 0 && amount > 0 && (
                <Button type="button" variant="outline" size="sm" onClick={fillOldest}>
                  Fill oldest first
                </Button>
              )}
            </div>
            {edit && <p className="text-xs text-muted-foreground">As recorded — change an amount only to re-allocate this payment; nothing moves by itself.</p>}
            {open.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No outstanding bills from {vendor}{applying ? "." : " — the whole payment will be advance credit."}</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {open.map(({ v, left, locked }) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        Bill {v.billNo || "—"} <span className="num font-normal text-muted-foreground">· {formatDate(v.date)} · {v.regNo}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Total <span className="num">{formatINR(v.totals.grandTotal)}</span> · {edit ? "Can take" : "Outstanding"} <span className="num font-medium text-foreground">{formatINR(left)}</span>
                        {own.has(v.id) && <> · this payment <span className="num">{formatINR(own.get(v.id)!)}</span></>}
                      </div>
                    </div>
                    {locked ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={`${monthLabel(v.date.slice(0, 7))} is locked`}>
                        <Lock className="size-3.5" /> {monthLabel(v.date.slice(0, 7))} locked{own.has(v.id) ? ` · ${formatINR(own.get(v.id)!)}` : ""}
                      </span>
                    ) : (
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={left}
                        step="0.01"
                        value={apply[v.id] ?? ""}
                        onChange={(e) => setApply((a) => ({ ...a, [v.id]: e.target.value }))}
                        className="num h-8 w-36"
                        placeholder="0.00"
                        aria-label={`Amount for bill ${v.billNo || "—"} of ${formatDate(v.date)}`}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm">
              <span>
                Allocated <span className="num font-medium">{formatINR(allocated)}</span>
                {!applying && split ? <span className="text-xs text-muted-foreground"> of {formatINR(split.settled)} settled</span> : null}
              </span>
              <span>
                {applying ? "Advance left after this" : "Advance credit"} <span className={`num font-semibold ${rest > 0 ? "text-sky-700 dark:text-sky-400" : ""}`}>{formatINR(Math.max(0, rest))}</span>
              </span>
            </div>
            {!applying && rest > 0 && amount > 0 && (
              <label className="flex items-start gap-2 rounded-md border border-sky-300/60 bg-sky-50 px-3 py-2 text-sm dark:border-sky-800 dark:bg-sky-950/40">
                <Checkbox checked={acceptAdvance} onCheckedChange={(c) => setAcceptAdvance(c === true)} className="mt-0.5" />
                <span>
                  Keep <span className="num font-medium">{formatINR(rest)}</span> as advance credit with {vendor}
                  <span className="block text-xs text-muted-foreground">Not on any bill yet — apply it to a later bill from the vendor page.</span>
                </span>
              </label>
            )}
            {submitted && problem && <p className="text-sm text-destructive">{problem}</p>}
          </section>

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
            {applying ? "Apply advance" : edit ? "Save changes" : "Save Payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** TDS % (editable) and the live split: total settled − TDS = net paid to the payee. */
export function TdsBreakdown({ percent, onPercent, split, error, payee }: { percent: string; onPercent: (v: string) => void; split: ReturnType<typeof tyreTdsSplit> | null; error?: string; payee: string }) {
  const p = Number(percent)
  return (
    <div className="mt-3 grid gap-3">
      <Field label="TDS Percentage (%)" required error={error} hint={`Default ${TYRE_TDS_PERCENT}% — change it if a different rate applies`} className="sm:max-w-56">
        <Input type="number" min={0} max={99.9999} step="0.0001" inputMode="decimal" value={percent} onChange={(e) => onPercent(e.target.value)} className="num" />
      </Field>
      <dl className="grid content-start gap-1.5 rounded-md bg-muted/40 p-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Total payment amount</dt>
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

/** Delete (the Owner / Dev): permanent — the payment and its allocations are removed; the audit log keeps them. */
export function DeletePaymentDialog({ payment: p, vendor, bills, pending, onConfirm, onClose }: { payment: TyrePayment; vendor: string; bills: string[]; pending: boolean; onConfirm: (reason: string) => Promise<unknown>; onClose: () => void }) {
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
          {(p.tdsAmount ?? 0) > 0 && (
            <>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">TDS ({formatNumber(p.tdsRate ?? 0, 4)}%)</dt>
                <dd className="num">{formatINR(p.tdsAmount!)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Paid to vendor</dt>
                <dd className="num">{formatINR(p.amount)}</dd>
              </div>
            </>
          )}
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Allocated to</dt>
            <dd className="text-right">{bills.length ? bills.join(", ") : "No bill (advance)"}</dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">
          The payment and its allocations are <span className="font-medium text-foreground">removed permanently</span>: vendor paid, outstanding credit, advance credit, TDS and the ledger are recalculated
          {bills.length ? ", and those bills are owed again" : ", and its advance credit is gone"}. Only the audit log keeps it, with the reason. This can&apos;t be undone — re-enter the payment if needed.
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

/** One payment, read only: amounts, TDS, reference, allocations (links to the bills), status, history. */
export function PaymentDetailsDialog({ payment: p, onClose }: { payment: TyrePayment; onClose: () => void }) {
  const d = useTyreData()
  const bill = (id: string) => d.views.find((v) => v.id === id)
  const rows: [string, React.ReactNode][] = [
    ["Vendor", <Link key="v" href={`/tyre/vendors/${p.supplierId}`} className="underline-offset-2 hover:underline">{d.name(p.supplierId)}</Link>],
    ["Payment date", formatDate(p.date)],
    ["Mode", p.mode],
    [referenceLabel(p.mode), <span key="r" className="num break-all">{p.utr}</span>],
    ["Total settled", <span key="s" className="num font-medium">{formatINR(settledOf(p))}</span>],
    ["TDS", (p.tdsAmount ?? 0) > 0 ? <span key="t" className="num">{formatINR(p.tdsAmount!)} ({formatNumber(p.tdsRate ?? 0, 4)}%)</span> : p.tdsRate === 0 ? "0%" : "Not deducted"],
    ["Paid to vendor", <span key="p" className="num">{formatINR(p.amount)}</span>],
    ["Advance left", <span key="a" className="num">{formatINR(unallocated(p))}</span>],
    ["Reference / bill", p.reference || "—"],
    ["Paid by", p.companyCode ?? "Not recorded"],
    ["Notes", p.notes || "—"],
  ]
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Payment · {formatINR(settledOf(p))} <AllocationBadge payment={p} />
          </DialogTitle>
          <DialogDescription>{`${d.name(p.supplierId)} · ${formatDate(p.date)}`}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Allocated to</h3>
          {p.allocations.length ? (
            <ul className="divide-y rounded-md border text-sm">
              {p.allocations.map((a, n) => (
                <li key={n} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <Link href={`/tyre/${a.invoiceId}?from=vendor`} className="underline-offset-2 hover:underline">
                    Bill {bill(a.invoiceId)?.billNo || "—"} · {bill(a.invoiceId) ? formatDate(bill(a.invoiceId)!.date) : ""}
                  </Link>
                  <span className="num">{formatINR(a.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No bill — the whole payment is advance credit.</p>
          )}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <HistoryButton id={p.id} />
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
