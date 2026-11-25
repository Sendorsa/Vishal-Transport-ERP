"use client"

import { useMemo, useState } from "react"
import { Loader2, Lock } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ReasonField } from "@/components/shared/audit"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { Field } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { monthLabel } from "@/domain/diesel"
import { canEditMonth } from "@/domain/month-lock"
import {
  BROKER_ENTRY_LABEL,
  blankExpense,
  brokerBalanceOf,
  descriptionOptions,
  EXPENSE_SECTIONS,
  expenseProblems,
  hasValidity,
  PAYMENT_MODES,
  TAX_TYPE_STARTERS,
  textKey,
  usedValues,
  type ExpenseInput,
} from "@/domain/expenses"
import { useSaveExpense } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { formatDate, formatINR, todayISO } from "@/lib/format"
import type { BrokerEntryType, CompanyCode, Expense, ExpenseSection } from "@/lib/types"
import { useExpenseData, type ExpenseData } from "./expense-data"
import { VehicleDetails, VehiclePicker } from "./vehicle-picker"

const NONE = "__none"
const toText = (n: number) => (n ? String(n) : "")
const toNum = (s: string) => (s.trim() === "" ? 0 : Number(s))

/** Add (no `expense`) or Edit an expense of one section, as a modal over its list. */
export function ExpenseDialog({ section, expense, onClose }: { section: ExpenseSection; expense?: Expense; onClose: () => void }) {
  const can = useCan()
  const [role] = useRole()
  const d = useExpenseData()
  if (!d.ready) return null
  const blocked = !can("expenses", expense ? "edit" : "create")
    ? `Your role can't ${expense ? "edit" : "add"} expenses.`
    : expense && !canEditMonth(role, expense.date.slice(0, 7), todayISO(), d.locks)
      ? `${monthLabel(expense.date.slice(0, 7))} is locked — only the Owner can change it.`
      : null
  return <Form d={d} section={section} expense={expense} blocked={blocked} onClose={onClose} />
}

/** A searchable list that also takes a new value as typed (saved on the record, offered again next time). */
function TextPick({ value, onChange, options, placeholder, invalid }: { value: string; onChange: (v: string) => void; options: string[]; placeholder: string; invalid?: boolean }) {
  // The typed value is its own option, so a value not in the list still shows as selected.
  const all = value && !options.some((o) => textKey(o) === textKey(value)) ? [value, ...options] : options
  return (
    <CreatableSelect
      value={all.find((o) => textKey(o) === textKey(value)) ?? ""}
      options={all.map((o) => ({ value: o, label: o }))}
      onChange={onChange}
      onCreate={async (q) => {
        onChange(q)
        return q
      }}
      createLabel={(q) => `Use "${q}"`}
      placeholder={placeholder}
      invalid={invalid}
    />
  )
}

function Form({ d, section, expense, blocked, onClose }: { d: ExpenseData; section: ExpenseSection; expense?: Expense; blocked: string | null; onClose: () => void }) {
  const save = useSaveExpense()
  const today = todayISO()
  const meta = EXPENSE_SECTIONS[section]
  const [f, setF] = useState<ExpenseInput>(() => (expense ? { ...expense } : blankExpense(section, today)))
  const [amount, setAmount] = useState(toText(expense?.amount ?? 0))
  const [paid, setPaid] = useState(toText(expense?.paidAmount ?? 0))
  const [count, setCount] = useState(toText(expense?.vehicleCount ?? 0))
  // Road Tax / Fitness: does this payment cover a validity period? Insurance always does.
  const [period, setPeriod] = useState(section === "INSURANCE" || !expense || !!expense.validTill)
  const [companyTouched, setCompanyTouched] = useState(!!expense?.operatingCompany)
  const [reason, setReason] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const set = <K extends keyof ExpenseInput>(k: K) => (v: ExpenseInput[K]) => setF((s) => ({ ...s, [k]: v }))

  const broker = section === "BROKER"
  const type: BrokerEntryType = f.entryType ?? "CHARGE"
  const vehicleId = f.vehicleIds[0]

  // What will be sent: the typed numbers, the period only when chosen, the count from the vehicles when any are chosen.
  const input: ExpenseInput = {
    ...f,
    amount: broker && type === "PAYMENT" ? 0 : toNum(amount),
    paidAmount: broker && type !== "BROUGHT_FORWARD" ? toNum(paid) : 0,
    vehicleCount: broker ? (f.vehicleIds.length || Math.trunc(toNum(count))) : f.vehicleIds.length,
    validFrom: hasValidity(section) && period ? f.validFrom : "",
    validTill: hasValidity(section) && period ? f.validTill : "",
    vehicleIds: broker && type !== "CHARGE" ? [] : f.vehicleIds,
  }
  const problems = expenseProblems(input, today)
  // Ticked "covers a validity period": both dates are required (the API only knows "both or neither").
  if (hasValidity(section) && period) {
    if (!input.validFrom) problems.validFrom ??= "Enter the start of the period"
    if (!input.validTill) problems.validTill ??= "Enter the valid-till date"
  }
  const show = (k: keyof ExpenseInput) => (submitted ? problems[k] : undefined)

  const opts = useMemo(
    () => ({
      description: descriptionOptions(d.expenses, section),
      taxType: usedValues(d.expenses, section, "taxType", section === "ROAD_TAX" ? TAX_TYPE_STARTERS : []),
      provider: usedValues(d.expenses, "INSURANCE", "provider", [...new Set(d.vehicles.map((v) => v.insurance?.provider ?? "").filter(Boolean))]),
      broker: usedValues(d.expenses, "BROKER", "broker"),
      purpose: usedValues(d.expenses, "BROKER", "purpose"),
      operatingCompany: usedValues(d.expenses, "BROKER", "operatingCompany", d.customers.filter((c) => c.status !== "ARCHIVED").map((c) => c.shortName || c.name)),
      paymentMode: [...new Set([...PAYMENT_MODES, ...usedValues(d.expenses, section, "paymentMode")])],
    }),
    [d.expenses, d.vehicles, d.customers, section]
  )

  // Picking a vehicle fills what the vehicle master already knows (only empty fields, never over the user's input).
  const pickVehicles = (ids: string[]) => {
    setF((s) => {
      const v = d.vehicle.get(ids[0] ?? "")
      const next = { ...s, vehicleIds: ids }
      if (v && !broker && !s.companyCode) next.companyCode = v.companyCode
      if (v && section === "INSURANCE") {
        if (!s.provider) next.provider = v.insurance?.provider ?? ""
        if (!s.policyNo) next.policyNo = v.insurance?.policyNo ?? ""
      }
      if (broker && !companyTouched) next.operatingCompany = [...new Set(ids.map((id) => d.customerName(d.customerOn(id, s.date))).filter(Boolean))].join(" / ")
      return next
    })
  }

  const submit = async () => {
    setSubmitted(true)
    if (blocked || Object.keys(problems).length) return
    try {
      await save.mutateAsync({ id: expense?.id, version: expense?.updatedAt, data: input, reason })
      toast.success(expense ? "Changes saved" : `${meta.title}: entry saved`)
      onClose()
    } catch {
      /* the hook shows the error; the dialog keeps the input */
    }
  }

  const dateLabel = section === "FINE" ? "Fine Date" : "Transaction Date"
  const amountLabel = section === "INSURANCE" ? "Premium Amount Paid" : section === "FINE" ? "Fine Amount" : broker ? (type === "BROUGHT_FORWARD" ? "Balance brought forward" : "Total Amount") : "Amount Paid"
  const companySelect = (
    <Field label={section === "ROAD_TAX" ? "Account Payable" : "Paid by"} hint="The company paying it">
      <SimpleSelect
        value={f.companyCode ?? NONE}
        onChange={(v) => set("companyCode")(v === NONE ? null : (v as CompanyCode))}
        options={[{ value: NONE, label: "Not recorded" }, ...d.companies.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))]}
      />
    </Field>
  )
  const validity = (fromLabel: string, tillLabel: string) => (
    <>
      {section !== "INSURANCE" && (
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <Checkbox checked={period} onCheckedChange={(c) => setPeriod(c === true)} className="mt-0.5" />
          <span>
            This payment covers a validity period
            <span className="block text-xs text-muted-foreground">Untick for a one-off payment with no period (e.g. a difference tax or a fee).</span>
          </span>
        </label>
      )}
      {period && (
        <>
          <Field label={fromLabel} required error={show("validFrom")}>
            <Input type="date" value={f.validFrom} onChange={(e) => set("validFrom")(e.target.value)} aria-invalid={!!show("validFrom") || undefined} />
          </Field>
          <Field label={tillLabel} required error={show("validTill")} hint={f.validFrom && f.validTill >= f.validFrom ? `${formatDate(f.validFrom)} – ${formatDate(f.validTill)}` : undefined}>
            <Input type="date" value={f.validTill} min={f.validFrom || undefined} onChange={(e) => set("validTill")(e.target.value)} aria-invalid={!!show("validTill") || undefined} />
          </Field>
        </>
      )}
    </>
  )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{expense ? `Edit ${meta.one}` : `Add ${meta.one}`}</DialogTitle>
          <DialogDescription>{meta.title} · saved in this browser only (Phase 1 — not on the shared database yet).</DialogDescription>
        </DialogHeader>
        {blocked ? (
          <p className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <Lock className="size-4" /> {blocked}
          </p>
        ) : (
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            {broker && (
              <Field label="Entry" className="sm:col-span-2" hint={type === "CHARGE" ? "A new broker expense." : type === "PAYMENT" ? "Money paid to the broker against the running balance — not an expense." : "What was owed to the broker when records start — not a new expense. One per broker, before every other entry."}>
                <SimpleSelect value={type} onChange={(v) => set("entryType")(v as BrokerEntryType)} options={(Object.keys(BROKER_ENTRY_LABEL) as BrokerEntryType[]).map((k) => ({ value: k, label: BROKER_ENTRY_LABEL[k] }))} />
              </Field>
            )}

            {(!broker || type === "CHARGE") && (
              <Field label={broker ? "Vehicles" : "Vehicle Number"} required={!broker} error={show("vehicleIds")} className="sm:col-span-2" hint={broker ? "Optional — leave empty for a charge that is not for a vehicle." : undefined}>
                <VehiclePicker d={d} value={f.vehicleIds} onChange={pickVehicles} multiple={broker} keep={expense?.vehicleIds} invalid={!!show("vehicleIds")} />
              </Field>
            )}
            {!broker && vehicleId && (
              <div className="sm:col-span-2">
                <VehicleDetails d={d} vehicleId={vehicleId} date={f.date} section={section} today={today} />
              </div>
            )}

            <Field label={dateLabel} required error={show("date")}>
              <Input type="date" value={f.date} max={today} onChange={(e) => set("date")(e.target.value)} aria-invalid={!!show("date") || undefined} />
            </Field>

            {broker && (
              <Field label="Broker Name" required error={show("broker")}>
                <TextPick value={f.broker} onChange={set("broker")} options={opts.broker} placeholder="Select or type the broker" invalid={!!show("broker")} />
              </Field>
            )}

            {section === "ROAD_TAX" && (
              <>
                <Field label="Description" required error={show("description")} hint="e.g. MV TAX, TN TP, GREEN TAX — or type a new one">
                  <TextPick value={f.description} onChange={set("description")} options={opts.description} placeholder="Select or type" invalid={!!show("description")} />
                </Field>
                <Field label="Tax Type" hint="Same state, interstate…">
                  <TextPick value={f.taxType} onChange={set("taxType")} options={opts.taxType} placeholder="Select or type" />
                </Field>
                {validity("Tax From", "Tax Valid Till")}
              </>
            )}

            {section === "INSURANCE" && (
              <>
                <Field label="Insurance Provider" required error={show("provider")}>
                  <TextPick value={f.provider} onChange={set("provider")} options={opts.provider} placeholder="Select or type" invalid={!!show("provider")} />
                </Field>
                <Field label="Policy Number" hint="If available">
                  <Input value={f.policyNo} onChange={(e) => set("policyNo")(e.target.value)} maxLength={60} />
                </Field>
                <Field label="Description" className="sm:col-span-2">
                  <TextPick value={f.description} onChange={set("description")} options={opts.description} placeholder="Optional — select or type" />
                </Field>
                {validity("Insurance Start Date", "Insurance End Date")}
              </>
            )}

            {section === "FITNESS" && (
              <>
                <Field label="Fitness / FC Description">
                  <TextPick value={f.description} onChange={set("description")} options={opts.description} placeholder="Optional — select or type" />
                </Field>
                {validity("Fitness Start Date", "Fitness Valid Till")}
              </>
            )}

            {section === "FINE" && (
              <>
                <Field label="Fine Type" required error={show("taxType")}>
                  <TextPick value={f.taxType} onChange={set("taxType")} options={opts.taxType} placeholder="Select or type" invalid={!!show("taxType")} />
                </Field>
                <Field label="Description" className="sm:col-span-2">
                  <TextPick value={f.description} onChange={set("description")} options={opts.description} placeholder="Optional — select or type" />
                </Field>
              </>
            )}

            {broker && type === "CHARGE" && (
              <>
                <Field label="Description" required error={show("description")}>
                  <TextPick value={f.description} onChange={set("description")} options={opts.description} placeholder="Select or type" invalid={!!show("description")} />
                </Field>
                <Field label="Purpose" hint="Bus, goods, new bus…">
                  <TextPick value={f.purpose} onChange={set("purpose")} options={opts.purpose} placeholder="Optional — select or type" />
                </Field>
                <Field label="Operating Company" hint={f.vehicleIds.length ? "From the vehicles' customers on the date — change it if needed" : "Optional"}>
                  <TextPick
                    value={f.operatingCompany}
                    onChange={(v) => {
                      setCompanyTouched(true)
                      set("operatingCompany")(v)
                    }}
                    options={opts.operatingCompany}
                    placeholder="Select or type"
                  />
                </Field>
                <Field label="Vehicle Count" error={show("vehicleCount")} hint={f.vehicleIds.length ? "Counted from the vehicles chosen" : "For vehicles not listed one by one (e.g. 21 buses)"}>
                  {f.vehicleIds.length ? (
                    <div className="num flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">{f.vehicleIds.length}</div>
                  ) : (
                    <Input type="number" inputMode="numeric" min={0} step={1} value={count} onChange={(e) => setCount(e.target.value)} />
                  )}
                </Field>
              </>
            )}

            {!(broker && type === "PAYMENT") && (
              <Field label={amountLabel} required error={show("amount")} hint={section === "INSURANCE" ? "What was paid for the policy, incl. GST" : hasValidity(section) ? "What was paid on the transaction date" : undefined}>
                <Input type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!show("amount") || undefined} />
              </Field>
            )}

            {section === "FINE" && (
              <>
                <Field label="Payment Status" required error={show("paymentStatus")}>
                  <SimpleSelect value={f.paymentStatus ?? ""} onChange={(v) => set("paymentStatus")(v as "PAID" | "UNPAID")} options={[{ value: "UNPAID", label: "Unpaid" }, { value: "PAID", label: "Paid" }]} />
                </Field>
                {f.paymentStatus === "PAID" && (
                  <>
                    <Field label="Payment Date" required error={show("paymentDate")}>
                      <Input type="date" value={f.paymentDate} min={f.date || undefined} max={today} onChange={(e) => set("paymentDate")(e.target.value)} />
                    </Field>
                    <Field label="Payment Reference" hint="Challan / receipt / UTR">
                      <Input value={f.paymentReference} onChange={(e) => set("paymentReference")(e.target.value)} maxLength={60} />
                    </Field>
                  </>
                )}
              </>
            )}

            {section === "INSURANCE" && (
              <>
                <Field label="Payment Mode">
                  <SimpleSelect value={f.paymentMode || NONE} onChange={(v) => set("paymentMode")(v === NONE ? "" : v)} options={[{ value: NONE, label: "Not recorded" }, ...opts.paymentMode.map((m) => ({ value: m, label: m }))]} />
                </Field>
                <Field label="Payment Reference" hint="UTR / cheque / receipt no.">
                  <Input value={f.paymentReference} onChange={(e) => set("paymentReference")(e.target.value)} maxLength={60} />
                </Field>
              </>
            )}

            {broker && type !== "BROUGHT_FORWARD" && (
              <>
                <Field label="Amount Paid" required={type === "PAYMENT"} error={show("paidAmount")}>
                  <Input type="number" inputMode="decimal" min={0} step="0.01" value={paid} onChange={(e) => setPaid(e.target.value)} aria-invalid={!!show("paidAmount") || undefined} />
                </Field>
                {type === "CHARGE" && (
                  <Field label="Balance" hint="Total amount − amount paid">
                    <div className="num flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm font-medium">{formatINR(brokerBalanceOf(input))}</div>
                  </Field>
                )}
                {input.paidAmount > 0 && (
                  <>
                    <Field label="Cleared Date" required error={show("paymentDate")}>
                      <Input type="date" value={f.paymentDate} max={today} onChange={(e) => set("paymentDate")(e.target.value)} />
                    </Field>
                    <Field label="Payment Mode">
                      <SimpleSelect value={f.paymentMode || NONE} onChange={(v) => set("paymentMode")(v === NONE ? "" : v)} options={[{ value: NONE, label: "Not recorded" }, ...opts.paymentMode.map((m) => ({ value: m, label: m }))]} />
                    </Field>
                  </>
                )}
              </>
            )}

            {(section === "ROAD_TAX" || section === "INSURANCE" || section === "FITNESS") && companySelect}
            {section === "ROAD_TAX" && (
              <Field label="Operating Company" hint="The vehicle's customer on the transaction date">
                <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">{vehicleId ? d.customerName(d.customerOn(vehicleId, f.date)) || <span className="text-muted-foreground">No customer on this date</span> : <span className="text-muted-foreground">Choose a vehicle</span>}</div>
              </Field>
            )}

            <Field label="Remarks" className="sm:col-span-2">
              <Textarea value={f.remarks} onChange={(e) => set("remarks")(e.target.value)} rows={2} maxLength={500} placeholder={section === "ROAD_TAX" ? "e.g. Paid by Popular" : "Optional"} />
            </Field>
            {expense && <ReasonField value={reason} onChange={setReason} className="sm:col-span-2" />}

            {submitted && Object.keys(problems).length > 0 && <p className="text-xs text-destructive sm:col-span-2">Check the highlighted fields.</p>}
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />} {expense ? "Save changes" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
