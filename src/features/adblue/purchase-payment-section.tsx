"use client"

import { useState } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Field } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { ADBLUE_PAYMENT_MODES, ADBLUE_TDS_PERCENT, PURCHASE_PAYMENT_TYPE_LABEL, referenceLabel, tdsProblem, tdsSplit, type PurchasePaymentType } from "@/domain/adblue-payments"
import type { AdBluePurchaseInput } from "@/lib/api"
import { formatDate, formatINR, round2, todayISO } from "@/lib/format"
import type { AdBluePayment } from "@/lib/types"
import { TdsBreakdown } from "./adblue-payment-dialog"
import { PurchaseStatusBadge } from "./adblue-vendor-account"

/**
 * A purchase's Payment Details (owner, 18 Nov 2026) — the same fields and rules for a direct vendor purchase as for a
 * bulk purchase: Credit (no new payment) · Fully Paid (all that is still owed; more only as explicit advance) · Partially
 * Paid (less), mode, reference by mode, date, notes, "Deduct TDS?". On an edit the payments already recorded are listed
 * read-only and only what is still owed can be settled — a NEW payment; existing ones are corrected in AdBlue → Payments.
 */
export function usePurchasePayment(owed: number) {
  const today = todayISO()
  const [pay, setPay] = useState({ type: "CREDIT" as PurchasePaymentType, amount: "", mode: "", utr: "", date: today, notes: "", tdsOn: false, tdsPercent: String(ADBLUE_TDS_PERCENT), acceptAdvance: false })
  const paying = pay.type !== "CREDIT" && owed > 0
  const payAmount = pay.type === "FULL" && pay.amount === "" ? owed : Number(pay.amount || 0)
  const extra = pay.type === "FULL" ? Math.max(0, round2(payAmount - owed)) : 0
  const percent = pay.tdsPercent.trim() === "" ? NaN : Number(pay.tdsPercent)
  const tdsErr = paying && pay.tdsOn ? tdsProblem(payAmount, percent) : null
  const split = paying && pay.tdsOn && payAmount > 0 && !tdsErr ? tdsSplit(payAmount, percent) : null
  /** What's wrong with the details, or null (the API checks the same rules). */
  const problem = (): string | null => {
    if (!paying) return null
    if (pay.type === "PARTIAL" && !(payAmount > 0 && payAmount < owed)) return `Partially Paid: enter an amount more than ₹0 and less than ${formatINR(owed)}`
    if (pay.type === "FULL" && payAmount < owed) return `Fully Paid settles ${formatINR(owed)} — enter that amount, or choose Partially Paid`
    if (extra > 0 && !pay.acceptAdvance) return `${formatINR(extra)} is more than this purchase owes — tick "keep as advance credit", or correct the amount`
    if (!pay.mode) return "Choose the payment mode"
    if (!pay.utr.trim()) return `Enter the ${referenceLabel(pay.mode).toLowerCase()}`
    if (!pay.date) return "Enter the payment date"
    return tdsErr
  }
  /** The `payment` to send (undefined when Credit). */
  const payload = (): AdBluePurchaseInput["payment"] =>
    paying ? { type: pay.type, amount: payAmount, mode: pay.mode, utr: pay.utr.trim(), date: pay.date, tdsPercent: pay.tdsOn ? percent : null, notes: pay.notes.trim(), acceptAdvance: extra > 0 && pay.acceptAdvance } : undefined
  return { pay, setPay, paying, payAmount, extra, split, tdsErr, problem, payload }
}

export function PurchasePaymentSection({
  state,
  owed,
  paidSoFar,
  editing,
  applied,
  minDate,
  vendor,
}: {
  state: ReturnType<typeof usePurchasePayment>
  /** What a new payment may settle: the value (new) or value − paid so far (edit). */
  owed: number
  paidSoFar: number
  editing: boolean
  applied: { payment: AdBluePayment; amount: number }[]
  /** A payment is never dated before its purchase. */
  minDate: string
  vendor: string
}) {
  const today = todayISO()
  const { pay, setPay, paying, payAmount, extra, split, tdsErr } = state
  return (
    <section className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Payment Details</h3>
        {editing && <PurchaseStatusBadge status={owed === 0 ? "PAID" : paidSoFar > 0 ? "PARTIAL" : "UNPAID"} />}
      </div>
      {editing && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Payments already recorded</div>
          {applied.length ? (
            <ul className="divide-y rounded-md border text-sm">
              {applied.map(({ payment: x, amount }) => (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-x-3 px-3 py-1.5">
                  <span>
                    {formatDate(x.date)} · {x.mode} <span className="num text-xs break-all text-muted-foreground">{x.utr}</span>
                    {x.tdsAmount > 0 && <span className="block text-xs text-muted-foreground">incl. {formatINR(x.tdsAmount)} TDS on the payment</span>}
                  </span>
                  <span className="num font-medium">{formatINR(amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">None — on credit so far.</p>
          )}
          <p className="text-xs text-muted-foreground">These stay as they are. To correct or remove one, use AdBlue → Payments (Edit / Delete).</p>
        </div>
      )}
      {owed === 0 && editing ? (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">Fully paid — nothing is outstanding on this purchase.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={editing ? "Pay now" : "Payment Type"} required hint={pay.type === "CREDIT" ? (editing ? "Credit — no new payment; the outstanding stays owed" : "Nothing paid now — the whole amount is owed to the vendor") : undefined}>
            <SimpleSelect value={pay.type} onChange={(v) => setPay((s) => ({ ...s, type: v as PurchasePaymentType, amount: "", acceptAdvance: false, tdsOn: v === "CREDIT" ? false : s.tdsOn }))} options={(Object.keys(PURCHASE_PAYMENT_TYPE_LABEL) as PurchasePaymentType[]).map((t) => ({ value: t, label: PURCHASE_PAYMENT_TYPE_LABEL[t] }))} />
          </Field>
          {pay.type !== "CREDIT" && (
            <>
              <Field label="Amount Paid (₹)" required hint={pay.type === "FULL" ? `Settles the ${editing ? "outstanding" : "purchase amount"} ${formatINR(owed)} (with TDS: before TDS)` : `Less than ${formatINR(owed)}`}>
                <Input type="number" min={0} step="0.01" value={pay.type === "FULL" && pay.amount === "" ? (owed > 0 ? String(owed) : "") : pay.amount} onChange={(e) => setPay((s) => ({ ...s, amount: e.target.value }))} className="num" />
              </Field>
              <Field label="Payment Mode" required>
                <SimpleSelect value={pay.mode} onChange={(v) => setPay((s) => ({ ...s, mode: v }))} options={ADBLUE_PAYMENT_MODES.map((m) => ({ value: m, label: m }))} placeholder="Choose…" />
              </Field>
              <Field label={pay.mode ? referenceLabel(pay.mode) : "Reference number"} required>
                <Input value={pay.utr} onChange={(e) => setPay((s) => ({ ...s, utr: e.target.value }))} autoComplete="off" />
              </Field>
              <Field label="Payment Date" required>
                <Input type="date" value={pay.date} min={minDate} max={today} onChange={(e) => setPay((s) => ({ ...s, date: e.target.value }))} />
              </Field>
              <Field label="Payment notes">
                <Input value={pay.notes} onChange={(e) => setPay((s) => ({ ...s, notes: e.target.value }))} />
              </Field>
              <div className="rounded-lg border p-3 sm:col-span-2">
                <label className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">Deduct TDS?</span>
                  <Switch checked={pay.tdsOn} onCheckedChange={(on) => setPay((s) => ({ ...s, tdsOn: on }))} aria-label="Deduct TDS" />
                </label>
                {pay.tdsOn && <TdsBreakdown percent={pay.tdsPercent} onPercent={(v) => setPay((s) => ({ ...s, tdsPercent: v }))} split={split} error={tdsErr ?? undefined} payee={vendor || "the vendor"} />}
              </div>
              {extra > 0 && (
                <label className="flex items-start gap-2 rounded-md border border-sky-300/60 bg-sky-50 px-3 py-2 text-sm sm:col-span-2 dark:border-sky-800 dark:bg-sky-950/40">
                  <Checkbox checked={pay.acceptAdvance} onCheckedChange={(c) => setPay((s) => ({ ...s, acceptAdvance: c === true }))} className="mt-0.5" />
                  <span>
                    Keep the extra <span className="num font-medium">{formatINR(extra)}</span> as advance credit with {vendor || "the vendor"}
                    <span className="block text-xs text-muted-foreground">Not on any purchase yet — apply it later from the vendor&apos;s page.</span>
                  </span>
                </label>
              )}
            </>
          )}
        </div>
      )}
      <dl className="grid gap-1 rounded-md bg-muted/40 px-3 py-2 text-sm sm:grid-cols-3 sm:gap-x-6">
        <div className="flex justify-between gap-2 sm:block">
          <dt className="text-xs text-muted-foreground">Purchase amount</dt>
          <dd className="num font-medium">{formatINR(round2(owed + paidSoFar))}</dd>
        </div>
        <div className="flex justify-between gap-2 sm:block">
          <dt className="text-xs text-muted-foreground">{editing ? "Paid (so far + now)" : "Amount paid"}</dt>
          <dd className="num font-medium">{formatINR(round2(paidSoFar + (paying ? Math.min(payAmount, owed) : 0)))}</dd>
        </div>
        <div className="flex justify-between gap-2 sm:block">
          <dt className="text-xs text-muted-foreground">Outstanding</dt>
          <dd className="num font-semibold">{formatINR(Math.max(0, round2(owed - (paying ? payAmount : 0))))}</dd>
        </div>
        {split && (
          <div className="text-xs text-muted-foreground sm:col-span-3">
            Settles {formatINR(split.settled)} of the vendor&apos;s liability · actual amount paid {formatINR(split.paid)} after {formatINR(split.tds)} TDS
          </div>
        )}
      </dl>
      <p className="text-xs text-muted-foreground">Paying never changes the purchase, its litres or any stock — it only records a payment against it.</p>
    </section>
  )
}
