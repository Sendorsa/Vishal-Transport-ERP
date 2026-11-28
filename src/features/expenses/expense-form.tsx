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
import { driverLabel } from "@/domain/drivers"
import { canEditMonth } from "@/domain/month-lock"
import {
  blankExpense,
  BROKER_ENTRY_LABEL,
  descriptionOptions,
  EXPENSE_SECTIONS,
  expenseProblems,
  hasValidity,
  isMonthLocked,
  monthOf,
  PAYMENT_MODES,
  TAX_TYPE_STARTERS,
  textKey,
  usedValues,
  type ExpenseInput,
} from "@/domain/expenses"
import { DATA_BACKEND } from "@/lib/api/client"
import { useBrokers, useCreateBroker, useSaveExpense } from "@/lib/api/hooks"
import { useCan, useRole } from "@/lib/app-state"
import { canAddBrokers, expenseSectionAllowed } from "@/lib/permissions"
import { formatDate, todayISO } from "@/lib/format"
import type { BrokerEntryType, CompanyCode, Expense, ExpenseSection } from "@/lib/types"
import { useExpenseData, type ExpenseData } from "./expense-data"
import { VehicleDetails, VehiclePicker } from "./vehicle-picker"

const NONE = "__none"
const FORM_ID = "expense-form"
const toText = (n: number) => (n ? String(n) : "")
const toNum = (s: string) => (s.trim() === "" ? 0 : Number(s))

/** Add (no `expense`) or Edit an expense of one section, as a modal over its list. */
export function ExpenseDialog({ section, expense, defaultDate, onClose }: { section: ExpenseSection; expense?: Expense; defaultDate?: string; onClose: () => void }) {
  const can = useCan()
  const [role] = useRole()
  const d = useExpenseData()
  if (!d.ready) return null
  const blocked = !can("expenses", expense ? "edit" : "create") || !expenseSectionAllowed(role, section)
    ? `Your role can't ${expense ? "edit" : "add"} ${expenseSectionAllowed(role, section) ? "expenses" : `${EXPENSE_SECTIONS[section].title} records`}.`
    : expense && isMonthLocked(d.monthLocks, section, monthOf(expense))
      ? `${monthLabel(monthOf(expense))} is locked in ${EXPENSE_SECTIONS[section].title} — its records are read-only.`
      : expense && !canEditMonth(role, expense.date.slice(0, 7), todayISO(), d.locks)
      ? `${monthLabel(expense.date.slice(0, 7))} is locked — only the Owner can change it.`
      : null
  return <Form d={d} section={section} expense={expense} defaultDate={defaultDate} blocked={blocked} onClose={onClose} />
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

function Form({ d, section, expense, defaultDate, blocked, onClose }: { d: ExpenseData; section: ExpenseSection; expense?: Expense; defaultDate?: string; blocked: string | null; onClose: () => void }) {
  const save = useSaveExpense()
  const brokerList = useBrokers()
  const createBroker = useCreateBroker()
  // Adding a broker changes the shared broker list: Dev and the Owner only (EMP 1 picks from it — owner, 28 Nov 2026).
  const mayAddBroker = canAddBrokers(useRole()[0])
  const today = todayISO()
  const meta = EXPENSE_SECTIONS[section]
  // A new entry opens on the selected month's date (today in the current month).
  const [f, setF] = useState<ExpenseInput>(() => (expense ? { ...expense } : blankExpense(section, defaultDate && defaultDate <= today ? defaultDate : today)))
  // Broker Amount: a payment's amount paid (every new entry); an older charge's or opening balance's own amount.
  const [amount, setAmount] = useState(toText((expense?.entryType === "PAYMENT" ? expense.paidAmount : expense?.amount) ?? 0))
  // Road Tax / Fitness: does this payment cover a validity period? Insurance always does.
  const [period, setPeriod] = useState(section === "INSURANCE" || !expense || !!expense.validTill)
  const [reason, setReason] = useState("")
  const [submitted, setSubmitted] = useState(false)
  // Idempotency (Phase 2B): one key per opening of an Add form, re-sent on every retry of the same submission.
  const [requestId] = useState(() => (expense ? null : crypto.randomUUID()))
  const set = <K extends keyof ExpenseInput>(k: K) => (v: ExpenseInput[K]) => setF((s) => ({ ...s, [k]: v }))

  const broker = section === "BROKER"
  const type: BrokerEntryType = f.entryType ?? "CHARGE"
  const vehicleId = f.vehicleIds[0]

  // What will be sent: the typed numbers, the period only when chosen. Broker (owner, 25 Nov 2026: seven fields only):
  // Broker Amount → amount, or paidAmount for a payment (paid on its Pay Date); what an older record holds in fields
  // the form no longer shows — broker, purpose, operating company, count, a charge's paid amount and cleared date — is
  // carried through unchanged, never cleared or invented.
  const keepPaid = broker && type === "CHARGE" && expense?.entryType === "CHARGE" ? expense.paidAmount : 0
  const input: ExpenseInput = {
    ...f,
    ...(requestId ? { requestId } : {}),
    amount: broker && type === "PAYMENT" ? 0 : toNum(amount),
    paidAmount: broker ? (type === "PAYMENT" ? toNum(amount) : keepPaid) : 0,
    paymentDate: broker ? (type === "PAYMENT" ? f.date : keepPaid > 0 ? f.paymentDate : "") : f.paymentDate,
    vehicleCount: broker ? f.vehicleIds.length || (expense && !expense.vehicleIds.length ? expense.vehicleCount : 0) : f.vehicleIds.length,
    validFrom: hasValidity(section) && period ? f.validFrom : "",
    validTill: hasValidity(section) && period ? f.validTill : "",
  }
  const problems = expenseProblems(input, today)
  // A date in a locked Expense month is refused (the API refuses it too).
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.date) && isMonthLocked(d.monthLocks, section, monthOf(input))) problems.date ??= `${monthLabel(monthOf(input))} is locked in ${EXPENSE_SECTIONS[section].title} — choose a date in an open month`
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
      paymentMode: [...new Set([...PAYMENT_MODES, ...usedValues(d.expenses, section, "paymentMode")])],
    }),
    [d.expenses, d.vehicles, section]
  )

  // Picking a vehicle fills what the vehicle master already knows (only empty fields, never over the user's input).
  const pickVehicles = (ids: string[]) => {
    setF((s) => {
      const v = d.vehicle.get(ids[0] ?? "")
      const next = { ...s, vehicleIds: ids }
      // Road Tax: the paying company is chosen on the entry, never taken from the vehicle (owner, 27 Nov 2026).
      if (v && !broker && section !== "ROAD_TAX" && !s.companyCode) next.companyCode = v.companyCode
      if (v && section === "INSURANCE") {
        if (!s.provider) next.provider = v.insurance?.provider ?? ""
        if (!s.policyNo) next.policyNo = v.insurance?.policyNo ?? ""
      }
      if (broker && !expense) next.operatingCompany = [...new Set(ids.map((id) => d.customerName(d.customerOn(id, s.date))).filter(Boolean))].join(" / ")
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
  const amountLabel = section === "INSURANCE" ? "Premium Amount Paid" : section === "FINE" ? "Fine Amount" : "Amount Paid"
  const companySelect =
    section === "ROAD_TAX" ? (
      <Field label="Paying Company (Account Payable)" required error={show("companyCode")} hint="VT or VTHPL — the company making this payment">
        <SimpleSelect value={f.companyCode ?? ""} onChange={(v) => set("companyCode")(v as CompanyCode)} options={d.companies.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))} placeholder="Choose VT or VTHPL" />
      </Field>
    ) : (
      <Field label="Paid by" hint="The company paying it">
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

  // Broker Name: the broker list (+ the name an older entry already has); Add New Broker saves a new one — a name already
  // there (spaces / case ignored) is picked instead, never duplicated.
  const brokerNames = [...new Set([...(brokerList.data ?? []).map((b) => b.name), ...(f.broker.trim() ? [f.broker] : [])])].sort((a, b) => a.localeCompare(b))
  const addBroker = async (name: string) => {
    const same = brokerNames.find((n) => textKey(n) === textKey(name))
    if (same) return same
    try {
      return (await createBroker.mutateAsync(name)).name
    } catch {
      return f.broker // the hook shows why (e.g. already in the list); nothing changes
    }
  }

  // Broker Charges → Add bill (owner, 27 Nov 2026): one bunk bill against its broker, each field full width — Broker
  // Name · Bill Number · Bill Date · Vehicle Number · Description · Bill Amount · Remarks. A bill is owed, never paid:
  // payments are made to the broker in bulk (Add Payment). An opening balance keeps its own type and fields.
  const opening = type === "BROUGHT_FORWARD"
  const brokerFields = (
    <>
      <Field label="Broker Name" required error={show("broker")} className="sm:col-span-2">
        <CreatableSelect
          value={f.broker}
          options={brokerNames.map((n) => ({ value: n, label: n }))}
          onChange={set("broker")}
          onCreate={mayAddBroker ? addBroker : undefined}
          createLabel={(q) => `Add New Broker "${q}"`}
          addLabel={mayAddBroker ? "Add New Broker" : undefined}
          placeholder="Search broker…"
          invalid={!!show("broker")}
        />
      </Field>
      {opening ? (
        <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm sm:col-span-2">{BROKER_ENTRY_LABEL.BROUGHT_FORWARD}</div>
      ) : (
        <Field label="Bill Number" hint="The bill / invoice number, if the bill has one" className="sm:col-span-2">
          <Input value={f.billNo ?? ""} onChange={(e) => set("billNo")(e.target.value)} maxLength={40} autoComplete="off" />
        </Field>
      )}
      <Field label={opening ? "Date" : "Bill Date"} required error={show("date")} className="sm:col-span-2">
        <Input type="date" value={f.date} max={today} onChange={(e) => set("date")(e.target.value)} aria-invalid={!!show("date") || undefined} />
      </Field>
      {!opening && (
        <Field label="Vehicle Number" error={show("vehicleIds")} className="sm:col-span-2">
          {/* One vehicle, or none; an older record naming several keeps them all (shown, never dropped). */}
          <VehiclePicker d={d} value={f.vehicleIds} onChange={pickVehicles} multiple={(expense?.vehicleIds.length ?? 0) > 1} keep={expense?.vehicleIds} invalid={!!show("vehicleIds")} />
        </Field>
      )}
      <Field label="Description" required={!opening} error={show("description")} className="sm:col-span-2">
        <Input value={f.description} onChange={(e) => set("description")(e.target.value)} placeholder={opening ? "Optional" : "What the bill is for"} autoComplete="off" maxLength={500} aria-invalid={!!show("description") || undefined} />
      </Field>
      <Field label={opening ? "Opening Outstanding (₹)" : "Bill Amount (₹)"} required error={show("amount") ?? show("paidAmount")} className="sm:col-span-2">
        <Input type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-invalid={!!(show("amount") ?? show("paidAmount")) || undefined} />
      </Field>
    </>
  )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* Header and footer stay put; the body scrolls on its own (as the Tyre invoice dialog). */}
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl max-sm:overflow-hidden max-sm:pb-0">
        <DialogHeader className="shrink-0 gap-1 border-b px-4 py-3 pr-12 sm:px-6">
          <DialogTitle>{expense ? `Edit ${meta.one}` : `Add ${meta.one}`}</DialogTitle>
          <DialogDescription>{DATA_BACKEND === "supabase" ? meta.title : `${meta.title} · saved in this browser only (Phase 1 — not on the shared database yet).`}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
          {blocked ? (
            <p className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <Lock className="size-4" /> {blocked}
            </p>
          ) : (
            <form
              id={FORM_ID}
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              {broker ? (
                brokerFields
              ) : (
                <>
                  <Field label="Vehicle Number" required error={show("vehicleIds")} className="sm:col-span-2">
                    <VehiclePicker d={d} value={f.vehicleIds} onChange={pickVehicles} keep={expense?.vehicleIds} invalid={!!show("vehicleIds")} />
                  </Field>
                  {vehicleId && (
                    <div className="sm:col-span-2">
                      <VehicleDetails d={d} vehicleId={vehicleId} date={f.date} section={section} today={today} />
                    </div>
                  )}
                  <Field label={dateLabel} required error={show("date")}>
                    <Input type="date" value={f.date} max={today} onChange={(e) => set("date")(e.target.value)} aria-invalid={!!show("date") || undefined} />
                  </Field>
                </>
              )}
              {!broker && (
                <>
                {section === "ROAD_TAX" && (
                  <>
                    <Field label="Tax Description" required error={show("description")} hint="Pick one, or add a new one — it's offered for later entries">
                      {/* One spelling per description (case and spaces ignored): typing one already listed picks it. */}
                      <CreatableSelect
                        value={opts.description.find((o) => textKey(o) === textKey(f.description)) ?? f.description}
                        options={[...opts.description, ...(f.description && !opts.description.some((o) => textKey(o) === textKey(f.description)) ? [f.description] : [])].map((o) => ({ value: o, label: o }))}
                        onChange={set("description")}
                        onCreate={async (q) => {
                          const v = opts.description.find((o) => textKey(o) === textKey(q)) ?? q.trim().replace(/\s+/g, " ").toUpperCase()
                          set("description")(v)
                          return v
                        }}
                        createLabel={(q) => `Add new description "${q.trim().toUpperCase()}"`}
                        addLabel="Add new description"
                        placeholder="Search tax description…"
                        invalid={!!show("description")}
                      />
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
                    {/* The driver from Operations → Drivers (owner, 27 Nov 2026): searchable by name or DL; never a typed name. */}
                    <Field label="Driver Name" hint="From Operations → Drivers — search by name or DL number" className="sm:col-span-2">
                      <CreatableSelect
                        value={f.driverId ?? NONE}
                        onChange={(v) => set("driverId")(v === NONE ? null : v)}
                        options={[
                          { value: NONE, label: "No driver" },
                          ...d.drivers.filter((x) => x.status !== "ARCHIVED" || x.id === expense?.driverId).sort((a, b) => a.name.localeCompare(b.name)).map((x) => ({ value: x.id, label: driverLabel(x) })),
                        ]}
                        placeholder="Search driver…"
                      />
                    </Field>
                    <Field label="Fine Type" required error={show("taxType")}>
                      <TextPick value={f.taxType} onChange={set("taxType")} options={opts.taxType} placeholder="Select or type" invalid={!!show("taxType")} />
                    </Field>
                    {/* Fines: plain free text (owner, 25 Nov 2026) — no suggestions, no list, no browser autocomplete. */}
                    <Field label="Description" className="sm:col-span-2">
                      <Input value={f.description} onChange={(e) => set("description")(e.target.value)} placeholder="Enter fine description (optional)" autoComplete="off" maxLength={500} />
                    </Field>
                  </>
                )}


                </>
              )}
              {!broker && (
                <Field label={amountLabel} required error={show("amount")} hint={section === "INSURANCE" ? "What was paid for the policy, incl. GST" : hasValidity(section) ? "What was paid on the transaction date" : undefined}>
                  <Input type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-invalid={!!show("amount") || undefined} />
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
            </form>
          )}
        </div>
        <DialogFooter className="mx-0 mb-0 shrink-0 flex-row items-center gap-2 rounded-b-none px-4 py-3 sm:rounded-b-xl sm:px-6 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button type="button" variant="outline" onClick={onClose} className="ml-auto">
            Cancel
          </Button>
          {!blocked && (
            <Button type="submit" form={FORM_ID} disabled={save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />} {expense ? "Save changes" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
