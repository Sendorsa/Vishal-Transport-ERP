"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FormModal } from "@/components/shared/form-modal"
import { Field } from "@/components/shared/misc"
import { SimpleSelect } from "@/components/shared/simple-select"
import { invoiceViews, vendorPayables, type Dataset } from "@/domain/analytics"
import { useCreatePayment, useDataset } from "@/lib/api/hooks"
import { useCompanyScope } from "@/lib/app-state"
import { formatDate, formatINR, round2, todayISO } from "@/lib/format"
import type { CompanyCode, PaymentDirection, PaymentMode } from "@/lib/types"

const NONE = "__none__"

/**
 * Records money in (customer receipt, allocated to invoices with TDS) or money out
 * (expense payment or diesel vendor settlement).
 */
interface PaymentModalProps {
  open: boolean
  onOpenChange: (o: boolean) => void
  direction?: PaymentDirection
  customerId?: string
  invoiceId?: string
  lockDirection?: boolean
}

/** Mounted only while open, so every opening starts from a fresh, pre-filled state. */
export function PaymentModal(props: PaymentModalProps) {
  return props.open ? <PaymentModalBody {...props} /> : null
}

/** Default allocation: the preset invoice (or oldest open one) in full, TDS at the configured rate. */
function prefill(ds: Dataset | undefined, customerId: string, invoiceId?: string) {
  if (!ds || !customerId) return { alloc: {} as Record<string, number>, tds: "", received: "" }
  const open = invoiceViews(ds, todayISO())
    .filter((v) => v.customerId === customerId && v.outstanding > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const targets = invoiceId ? open.filter((i) => i.id === invoiceId) : open.slice(0, 1)
  const alloc: Record<string, number> = {}
  targets.forEach((i) => (alloc[i.id] = i.outstanding))
  const tds = targets.reduce((s, i) => s + (i.settled === 0 ? round2((i.subtotal * ds.settings.tdsRate) / 100) : 0), 0)
  const total = targets.reduce((s, i) => s + i.outstanding, 0)
  return { alloc, tds: String(round2(tds)), received: total ? String(round2(total - tds)) : "" }
}

function PaymentModalBody({
  open,
  onOpenChange,
  direction: initialDirection = "IN",
  customerId: presetCustomer,
  invoiceId: presetInvoice,
  lockDirection,
}: PaymentModalProps) {
  const { data: ds } = useDataset()
  const [initial] = useState(() => prefill(ds, presetCustomer ?? "", presetInvoice))
  const [scope] = useCompanyScope()
  const create = useCreatePayment()
  const [direction, setDirection] = useState<PaymentDirection>(initialDirection)
  const [date, setDate] = useState(todayISO())
  const [mode, setMode] = useState<PaymentMode>("NEFT")
  const [reference, setReference] = useState("")
  const [notes, setNotes] = useState("")
  // IN
  const [customerId, setCustomerId] = useState(presetCustomer ?? "")
  const [received, setReceived] = useState(initial.received)
  const [tds, setTds] = useState(initial.tds)
  const [alloc, setAlloc] = useState<Record<string, number>>(initial.alloc)
  // OUT
  const [company, setCompany] = useState<CompanyCode>(scope === "VT" ? "VT" : "VTHPL")
  const [category, setCategory] = useState("MAINTENANCE")
  const [partyName, setPartyName] = useState("")
  const [vendorId, setVendorId] = useState("")
  const [vehicleId, setVehicleId] = useState(NONE)
  const [amountOut, setAmountOut] = useState("")
  // Diesel vendor settlement: the month's fuel purchases it was paid against (the ledger still uses the payment date).
  const [forMonth, setForMonth] = useState("")

  const today = todayISO()
  const openInvoices = useMemo(() => {
    if (!ds || !customerId) return []
    return invoiceViews(ds, today)
      .filter((v) => v.customerId === customerId && v.outstanding > 0)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  }, [ds, customerId, today])

  const customer = ds?.customers.find((c) => c.id === customerId)

  const pickCustomer = (id: string) => {
    setCustomerId(id)
    const p = prefill(ds, id)
    setAlloc(p.alloc)
    setTds(p.tds)
    setReceived(p.received)
  }

  const allocated = round2(Object.values(alloc).reduce((s, v) => s + (v || 0), 0))
  const settles = round2((Number(received) || 0) + (Number(tds) || 0))
  const isSettlement = category === "DIESEL_SETTLEMENT"
  const payables = useMemo(() => (ds ? vendorPayables(ds) : []), [ds])

  const submit = async () => {
    if (!ds) return
    if (direction === "IN") {
      if (!customer) return toast.error("Select a customer")
      if (!(settles > 0)) return toast.error("Enter amount received")
      if (allocated > settles + 0.5) return toast.error("Allocated more than received + TDS")
      await create.mutateAsync({
        companyCode: customer.companyCode,
        direction: "IN",
        date,
        partyType: "CUSTOMER",
        customerId: customer.id,
        vendorId: null,
        vehicleId: null,
        partyName: customer.name,
        categoryCode: null,
        amount: Number(received) || 0,
        tdsAmount: Number(tds) || 0,
        mode,
        reference,
        allocations: Object.entries(alloc)
          .filter(([, v]) => v > 0)
          .map(([invoiceId, amount]) => ({ invoiceId, amount: round2(amount) })),
        notes,
      })
      toast.success(`Receipt of ${formatINR(Number(received))} recorded`)
    } else {
      const amount = Number(amountOut)
      const vendor = ds.fuelStations.find((v) => v.id === vendorId)
      if (!(amount > 0)) return toast.error("Enter an amount")
      if (isSettlement ? !vendor : !partyName.trim()) return toast.error(isSettlement ? "Select a diesel vendor" : "Enter who was paid")
      const against = forMonth || date.slice(0, 7)
      if (isSettlement && against > date.slice(0, 7)) return toast.error("The month paid against can't be after the payment date")
      await create.mutateAsync({
        companyCode: company,
        direction: "OUT",
        date,
        partyType: isSettlement ? "VENDOR" : category.includes("SALARY") ? "EMPLOYEE" : "VENDOR",
        customerId: null,
        vendorId: isSettlement ? vendorId : null,
        vehicleId: vehicleId === NONE ? null : vehicleId,
        partyName: isSettlement ? vendor!.name : partyName.trim(),
        categoryCode: category,
        amount,
        tdsAmount: 0,
        mode,
        reference,
        allocations: [],
        notes,
        ...(isSettlement ? { forMonth: against } : {}),
      })
      toast.success(`Payment of ${formatINR(amount)} recorded`)
    }
    onOpenChange(false)
  }

  const category_ = ds?.settings.expenseCategories.find((c) => c.code === category)

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title={direction === "IN" ? "Record receipt" : "Record payment"}
      description={direction === "IN" ? "Money received from a customer, allocated against invoices." : "Money paid out — expenses or vendor settlements."}
      submitLabel={direction === "IN" ? "Save receipt" : "Save payment"}
      pending={create.isPending}
      onSubmit={submit}
      className="sm:max-w-2xl"
    >
      {!lockDirection && (
        <Tabs value={direction} onValueChange={(v) => setDirection(v as PaymentDirection)}>
          <TabsList className="w-full">
            <TabsTrigger value="IN">Money in</TabsTrigger>
            <TabsTrigger value="OUT">Money out</TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Date" required>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Mode">
          <SimpleSelect value={mode} onChange={(v) => setMode(v as PaymentMode)} options={["NEFT", "UPI", "CHEQUE", "CASH"].map((m) => ({ value: m, label: m }))} />
        </Field>
        <Field label="Reference (UTR / cheque)">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>

      {direction === "IN" ? (
        <div className="grid gap-3">
          <Field label="Customer" required>
            <SimpleSelect
              value={customerId}
              onChange={pickCustomer}
              placeholder="Select customer"
              disabled={!!presetCustomer}
              options={(ds?.customers ?? []).map((c) => ({ value: c.id, label: `${c.name} · ${c.companyCode}` }))}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Amount received (₹)" required>
              <Input type="number" step="0.01" value={received} onChange={(e) => setReceived(e.target.value)} />
            </Field>
            <Field label="TDS deducted (₹)" hint={`${ds?.settings.tdsRate ?? 2}% u/s 194C on basic`}>
              <Input type="number" step="0.01" value={tds} onChange={(e) => setTds(e.target.value)} />
            </Field>
            <Field label="Settles">
              <div className="num flex h-8 items-center rounded-lg border bg-muted/40 px-2.5 text-sm font-medium">{formatINR(settles)}</div>
            </Field>
          </div>
          {customerId && (
            <div className="rounded-lg border">
              <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5 text-xs font-medium">
                <span>Allocate to open invoices</span>
                <span className={allocated > settles + 0.5 ? "num text-destructive" : "num text-muted-foreground"}>
                  {formatINR(allocated)} / {formatINR(settles)}
                </span>
              </div>
              {openInvoices.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-muted-foreground">No open invoices — this will be recorded as an advance.</p>
              ) : (
                <ul className="max-h-56 divide-y overflow-y-auto">
                  {openInvoices.map((inv) => {
                    const on = alloc[inv.id] !== undefined
                    return (
                      <li key={inv.id} className="grid grid-cols-[auto_1fr_120px] items-center gap-3 px-3 py-2 text-sm">
                        <Checkbox
                          checked={on}
                          onCheckedChange={(c) =>
                            setAlloc((a) => {
                              const n = { ...a }
                              if (c) n[inv.id] = Math.min(inv.outstanding, Math.max(0, round2(settles - allocated)) || inv.outstanding)
                              else delete n[inv.id]
                              return n
                            })
                          }
                        />
                        <div className="min-w-0">
                          <div className="font-medium">{inv.invoiceNo}</div>
                          <div className="text-xs text-muted-foreground">
                            Due {formatDate(inv.dueDate)} · open {formatINR(inv.outstanding)}
                            {inv.daysOverdue > 0 && <span className="text-destructive"> · {inv.daysOverdue}d overdue</span>}
                          </div>
                        </div>
                        <Input
                          type="number"
                          step="0.01"
                          disabled={!on}
                          value={on ? alloc[inv.id] : ""}
                          onChange={(e) => setAlloc((a) => ({ ...a, [inv.id]: Math.min(inv.outstanding, Number(e.target.value) || 0) }))}
                          className="h-7 text-right"
                        />
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Paying company" required>
            <SimpleSelect value={company} onChange={(v) => setCompany(v as CompanyCode)} options={[{ value: "VT", label: "VT" }, { value: "VTHPL", label: "VTHPL" }]} />
          </Field>
          <Field label="Expense head" required hint={category_?.kind === "SETTLEMENT" ? "Settles a liability — not a P&L expense" : undefined}>
            <SimpleSelect
              value={category}
              onChange={setCategory}
              options={(ds?.settings.expenseCategories ?? []).filter((c) => c.active).map((c) => ({ value: c.code, label: c.name }))}
            />
          </Field>
          {isSettlement ? (
            <Field label="Diesel vendor" required className="sm:col-span-2">
              <SimpleSelect
                value={vendorId}
                onChange={(v) => {
                  setVendorId(v)
                  const due = payables.find((p) => p.vendor.id === v)?.outstanding
                  if (due) setAmountOut(String(due))
                }}
                placeholder="Select vendor"
                options={(ds?.fuelStations ?? []).map((v) => {
                  const due = payables.find((p) => p.vendor.id === v.id)?.outstanding ?? 0
                  return { value: v.id, label: `${v.name}${due ? ` — payable ${formatINR(due)}` : ""}` }
                })}
              />
            </Field>
          ) : (
            <Field label="Paid to" required className="sm:col-span-2">
              <Input value={partyName} onChange={(e) => setPartyName(e.target.value)} placeholder="Workshop, employee, landlord…" />
            </Field>
          )}
          {isSettlement && (
            <Field label="Paid against (month)" required hint="Which month's fuel purchases this payment is for — the ledger counts it on the payment date">
              <Input type="month" value={forMonth || date.slice(0, 7)} max={date.slice(0, 7)} onChange={(e) => setForMonth(e.target.value)} />
            </Field>
          )}
          <Field label="Amount (₹)" required>
            <Input type="number" step="0.01" value={amountOut} onChange={(e) => setAmountOut(e.target.value)} />
          </Field>
          {category_?.vehicleLinked && (
            <Field label="Vehicle" hint="Charges this cost to the vehicle's profitability">
              <SimpleSelect
                value={vehicleId}
                onChange={setVehicleId}
                options={[
                  { value: NONE, label: "Not vehicle specific" },
                  ...(ds?.vehicles ?? [])
                    .filter((v) => v.companyCode === company)
                    .sort((a, b) => a.regNo.localeCompare(b.regNo))
                    .map((v) => ({ value: v.id, label: v.regNo })),
                ]}
              />
            </Field>
          )}
        </div>
      )}
      <Field label="Notes">
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </FormModal>
  )
}
