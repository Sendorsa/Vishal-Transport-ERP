"use client"

import { useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ReasonField } from "@/components/shared/audit"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { Field } from "@/components/shared/misc"
import { monthLabel } from "@/domain/diesel"
import { blankExpense, brokerOutstanding, isMonthLocked, textKey } from "@/domain/expenses"
import { useBrokers, useSaveExpense } from "@/lib/api/hooks"
import { PossibleDuplicateError } from "@/lib/api"
import { formatINR, round2, todayISO } from "@/lib/format"
import type { Expense } from "@/lib/types"
import type { ExpenseData } from "./expense-data"

/**
 * Add Payment — one bulk payment to a broker (owner, 27 Nov 2026): against the broker's overall outstanding, never a bill.
 * Shows the broker's total outstanding; date, amount (never more than is owed), remarks. Recorded once, in the month it
 * was paid. `payment`: edit that payment instead.
 */
export function BrokerPaymentDialog({ d, broker: initial, payment, onClose }: { d: ExpenseData; broker?: string; payment?: Expense; onClose: () => void }) {
  const save = useSaveExpense()
  const brokerList = useBrokers()
  const today = todayISO()
  const [broker, setBroker] = useState(payment?.broker ?? initial ?? "")
  const [date, setDate] = useState(payment?.date ?? today)
  const others = useMemo(() => d.expenses.filter((x) => x.id !== payment?.id), [d.expenses, payment?.id])
  const outstanding = broker ? brokerOutstanding(others, broker) : 0
  const [amount, setAmount] = useState(payment ? String(payment.paidAmount) : "")
  const [remarks, setRemarks] = useState(payment?.remarks ?? "")
  const [reason, setReason] = useState("")
  const [tried, setTried] = useState(false)
  // Idempotency (Phase 2B): one key per opening of Add Payment, re-sent on retry and with the confirmation below.
  const [requestId] = useState(() => (payment ? null : crypto.randomUUID()))
  // A payment with the same broker, date and amount already exists: the user confirms it's another payment (§5.4).
  const [twin, setTwin] = useState<string | null>(null)
  const value = Number(amount)
  const after = round2(outstanding - (Number.isFinite(value) ? value : 0))
  // Brokers in the list, those with money owed first.
  const options = useMemo(() => {
    const names = [...new Set([...(brokerList.data ?? []).map((b) => b.name), ...(payment ? [payment.broker] : [])])]
    return names
      .map((n) => ({ n, owed: brokerOutstanding(others, n) }))
      .sort((a, b) => Number(b.owed > 0) - Number(a.owed > 0) || a.n.localeCompare(b.n))
      .map(({ n, owed }) => ({ value: n, label: `${n} · ${formatINR(owed)} outstanding` }))
  }, [brokerList.data, others, payment])
  const problems = {
    broker: !broker ? "Choose the broker" : undefined,
    date: !/^\d{4}-\d{2}-\d{2}$/.test(date)
      ? "Enter the payment date"
      : date > today
        ? "The payment date can't be in the future"
        : isMonthLocked(d.monthLocks, "BROKER", date.slice(0, 7))
          ? `${monthLabel(date.slice(0, 7))} is locked in Broker Charges — choose a date in an open month`
          : undefined,
    amount: !(value > 0) || round2(value) !== value ? "Enter the amount paid (up to 2 decimals)" : value > outstanding + 0.005 ? `Only ${formatINR(outstanding)} is outstanding` : undefined,
  }
  const bad = Object.values(problems).some(Boolean)

  const submit = async (confirmSameDay = false) => {
    setTried(true)
    if (bad) return
    const data = {
      ...(payment ?? blankExpense("BROKER", date)),
      section: "BROKER" as const,
      entryType: "PAYMENT" as const,
      broker,
      date,
      paymentDate: date,
      amount: 0,
      paidAmount: value,
      remarks,
      ...(requestId ? { requestId } : {}),
    }
    try {
      await save.mutateAsync({ id: payment?.id, version: payment?.updatedAt, data, reason, confirmSameDay })
      toast.success(`${formatINR(value)} paid to ${broker} · ${formatINR(Math.max(0, after))} still outstanding`)
      onClose()
    } catch (e) {
      // Another payment with the same broker, date and amount: ask; nothing was saved. Other errors: the hook shows why.
      if (e instanceof PossibleDuplicateError) setTwin(e.duplicate.label)
    }
  }

  return (
    <>
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{payment ? "Edit payment to broker" : "Add Payment"}</DialogTitle>
          <DialogDescription>One payment to the broker, against everything owed — not tied to any single bill.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Broker" required error={tried ? problems.broker : undefined} className="sm:col-span-2">
            {payment ? (
              <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">{payment.broker || "No broker named"}</div>
            ) : (
              <CreatableSelect value={options.find((o) => textKey(o.value) === textKey(broker))?.value ?? ""} options={options} onChange={setBroker} placeholder="Search broker…" />
            )}
          </Field>
          <div className="rounded-md border bg-muted/30 px-3 py-2 sm:col-span-2">
            <div className="text-xs text-muted-foreground">Total outstanding{payment ? " (before this payment)" : ""}</div>
            <div className="num text-lg font-semibold">{formatINR(outstanding)}</div>
          </div>
          <Field label="Payment Date" required error={tried ? problems.date : undefined}>
            <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Payment Amount (₹)" required error={tried ? problems.amount : undefined} hint={broker && !problems.amount ? `Outstanding after this: ${formatINR(Math.max(0, after))}` : undefined}>
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Remarks" className="sm:col-span-2">
            <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} maxLength={500} placeholder="Optional" />
          </Field>
          {payment && <ReasonField value={reason} onChange={setReason} className="sm:col-span-2" />}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => submit()}>
            {save.isPending && <Loader2 className="animate-spin" />} Save payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {twin && (
      <Dialog open onOpenChange={(o) => !o && !save.isPending && setTwin(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record another payment?</DialogTitle>
            <DialogDescription>
              {twin.charAt(0).toUpperCase() + twin.slice(1)} is already recorded. Record this as a separate payment of the same amount? Nothing has been saved yet.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={save.isPending} onClick={() => setTwin(null)}>
              Don&apos;t record
            </Button>
            <Button disabled={save.isPending} onClick={async () => { setTwin(null); await submit(true) }}>
              {save.isPending && <Loader2 className="animate-spin" />} Record another payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}
    </>
  )
}
