"use client"

import { useMemo, useState } from "react"
import { IndianRupee, Lock, Plus, ReceiptText, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CreatableSelect } from "@/components/shared/creatable-select"
import { DataTable, type Column } from "@/components/shared/data-table"
import { ALL, FilterSelect, SearchBar } from "@/components/shared/filter-bar"
import { EmptyState, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { DeleteDialog, RowActions, monthLockedReason } from "@/components/shared/row-actions"
import { StatsCard } from "@/components/shared/stats-card"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { monthLabel } from "@/domain/diesel"
import { canEditMonth } from "@/domain/month-lock"
import {
  BROKER_ENTRY_LABEL,
  brokerPayStatus,
  EXPENSE_SECTIONS,
  expenseMatches,
  hasValidity,
  NO_CUSTOMER,
  expenseMonthOptions,
  isMonthLocked,
  monthEnd,
  monthOf,
  NO_FILTERS,
  sectionCards,
  textKey,
  VALIDITY_LABEL,
  validityOf,
  type ExpenseFilters,
  type ValidityStatus,
} from "@/domain/expenses"
import { DATA_BACKEND } from "@/lib/api/client"
import { useDeleteExpense } from "@/lib/api/hooks"
import { useCan, useCurrentMonth, useRole } from "@/lib/app-state"
import { useStoredMonth } from "@/features/diesel/parts"
import { formatDate, formatINR, round2, todayISO } from "@/lib/format"
import type { Expense, ExpenseSection } from "@/lib/types"
import { useExpenseData } from "./expense-data"
import { ExpenseDialog } from "./expense-form"
import { ExpenseMonthBar } from "./expense-month-bar"
import { BrokerPaymentDialog } from "./broker-payment"

const PAY_LABEL = { PAID: "Paid", PARTIAL: "Partly paid", UNPAID: "Unpaid" } as const

interface Row extends Expense {
  regs: string[]
  company: string
  status: string | null
}

/** Expense → one section's list: search and filters, its entries newest first, Add / ✏️ / 🗑. */
export function ExpensePage({ section }: { section: ExpenseSection }) {
  const can = useCan()
  const [role] = useRole()
  const d = useExpenseData()
  const del = useDeleteExpense()
  const meta = EXPENSE_SECTIONS[section]
  const [f, setF] = useState<ExpenseFilters>(NO_FILTERS)
  const [editor, setEditor] = useState<{ expense?: Expense } | null>(null)
  const [deleting, setDeleting] = useState<Row | null>(null)
  const [paying, setPaying] = useState<{ broker?: string; payment?: Expense } | null>(null)
  const today = todayISO()
  const broker = section === "BROKER"
  const set = (k: keyof ExpenseFilters) => (v: string) => setF((s) => ({ ...s, [k]: v === ALL ? "" : v }))

  const all = useMemo(() => d.expenses.filter((x) => x.section === section), [d.expenses, section])
  // The section's own accounting month (owner, 25 Nov 2026): kept per section, so changing it here never moves another
  // section's month; offered = this section's populated months + the current month.
  const currentMonth = useCurrentMonth()
  const months = useMemo(() => expenseMonthOptions(all, currentMonth), [all, currentMonth])
  const [month, setMonth] = useStoredMonth(`vt:ui:expenseMonth:${section}`, months)
  // This month's records only (by their own transaction date); validity still looks at every record (a later renewal).
  const rows: Row[] = useMemo(
    () =>
      all.filter((x) => monthOf(x) === month).map((x) => {
        // Road Tax → Customer Company (owner, 27 Nov 2026): the vehicle's customer on the transaction date, read from the
        // assignment history now — so a later back-dated transfer is respected (the stored record isn't changed).
        const customerId = section === "ROAD_TAX" && x.vehicleIds[0] ? d.customerOn(x.vehicleIds[0], x.date) : x.customerId
        return {
        ...x,
        customerId,
        regs: x.vehicleIds.map(d.regOf),
        company: broker ? x.operatingCompany : d.customerName(customerId),
        status: hasValidity(section) ? validityOf(x, all, today) : section === "FINE" ? x.paymentStatus : brokerPayStatus(x),
      }
      }),
    [all, d, broker, section, today, month]
  )
  // Newest first: date, then the most recently entered (Payment History Ordering Rules).
  // Search also covers a fine's driver (name and DL number, from the driver master).
  const shown = useMemo(() => {
    const driverText = (r: Row) => {
      const x = r.driverId ? d.driver.get(r.driverId) : undefined
      return x ? [x.name, x.licenseNo] : []
    }
    return rows.filter((r) => expenseMatches(r, f, r.regs, r.status, driverText(r))).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : -1))
  }, [rows, f, d.driver])
  const total = round2(shown.reduce((s, r) => s + r.amount, 0))

  const opts = useMemo(() => {
    const byKey = (vals: string[]) => [...new Map(vals.filter((v) => v.trim()).map((v) => [textKey(v), v])).entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
    const vehicleIds = [...new Set(rows.flatMap((r) => r.vehicleIds))]
    const customers = [...new Set(rows.map((r) => r.customerId).filter((c): c is string => !!c))]
    return {
      vehicle: vehicleIds.map((id) => ({ value: id, label: d.regOf(id) })).sort((a, b) => a.label.localeCompare(b.label)),
      company: broker
        ? byKey(rows.map((r) => r.operatingCompany))
        : section === "ROAD_TAX"
          ? d.companies.map((c) => ({ value: c.code, label: c.code })) // the paying company (owner, 27 Nov 2026)
        : [...customers.map((id) => ({ value: id, label: d.customerName(id) })).sort((a, b) => a.label.localeCompare(b.label)), ...(rows.some((r) => !r.customerId) ? [{ value: NO_CUSTOMER, label: "No customer" }] : [])],
      // Every customer in the customer master (archived ones too — history), and "No customer" for a vehicle without one.
      customer: [...[...d.customers].sort((a, b) => d.customerName(a.id).localeCompare(d.customerName(b.id))).map((c) => ({ value: c.id, label: d.customerName(c.id) })), { value: NO_CUSTOMER, label: "No customer" }],
      taxType: byKey(rows.map((r) => r.taxType)),
      // Road Tax → Description: every description in the Road Tax records (all months, so a new one appears at once), one per spelling.
      description: byKey(all.map((r) => r.description)),
      provider: byKey(rows.map((r) => r.provider)),
      broker: byKey(rows.map((r) => r.broker)),
      status: hasValidity(section)
        ? (Object.keys(VALIDITY_LABEL) as ValidityStatus[]).map((k) => ({ value: k, label: VALIDITY_LABEL[k].label }))
        : (Object.keys(PAY_LABEL) as (keyof typeof PAY_LABEL)[]).filter((k) => broker || k !== "PARTIAL").map((k) => ({ value: k, label: PAY_LABEL[k] })),
    }
  }, [rows, all, d, broker, section])

  // The two summary cards: this section's records as filtered on screen (dates and every other filter).
  const cards = useMemo(() => sectionCards(section, shown), [section, shown])

  if (!can("expenses")) return <NoAccess what={meta.title} />
  if (!d.ready) return <PageSkeleton />
  // Phase 2B (C-1): the "this browser only" wording only on the browser backend — on the shared database it isn't true.
  const local = DATA_BACKEND !== "supabase"
  const where = local ? " Saved in this browser only — not on the shared database yet." : ""

  const mayCreate = can("expenses", "create")
  const mayEdit = can("expenses", "edit")
  const mayDelete = can("expenses", "delete")
  const locked = isMonthLocked(d.monthLocks, section, month)
  const expenseLocked = (r: Row) => isMonthLocked(d.monthLocks, section, monthOf(r))
  const open = (r: Row) => !expenseLocked(r) && canEditMonth(role, r.date.slice(0, 7), today, d.locks)
  // A new entry opens in the selected month: today in the current month, its last day for an earlier one.
  const defaultDate = month === currentMonth ? today : monthEnd(month)
  const filtered = Object.values(f).some(Boolean)
  const period = f.from && f.to ? `${formatDate(f.from)} – ${formatDate(f.to)}` : f.from ? `From ${formatDate(f.from)}` : f.to ? `Up to ${formatDate(f.to)}` : "All dates"
  const scopeHint = Object.entries(f).some(([k, v]) => v && k !== "from" && k !== "to") ? `${period} · matching the filters` : period

  const statusCell = (r: Row) => {
    if (!r.status) return <span className="text-muted-foreground">—</span>
    if (hasValidity(section)) {
      const s = VALIDITY_LABEL[r.status as ValidityStatus]
      return <StatusBadge status={r.status} label={s.label} tone={s.tone} />
    }
    return <StatusBadge status={r.status} label={PAY_LABEL[r.status as keyof typeof PAY_LABEL]} />
  }
  const vehicleCell = (r: Row) =>
    r.regs.length ? (
      <span className="num font-medium">{r.regs.length > 3 ? `${r.regs.slice(0, 3).join(", ")} +${r.regs.length - 3}` : r.regs.join(", ")}</span>
    ) : (
      <span className="text-muted-foreground">{broker && r.vehicleCount ? `${r.vehicleCount} vehicle${r.vehicleCount === 1 ? "" : "s"}` : "—"}</span>
    )
  const date = (k: "date" | "validFrom" | "validTill" | "paymentDate", header: string): Column<Row> => ({ id: k, header, sortValue: (r) => r[k] || null, cell: (r) => <span className="num">{r[k] ? formatDate(r[k]) : "—"}</span> })
  const money = (k: "amount" | "paidAmount", header: string, footer?: number): Column<Row> => ({ id: k, header, align: "right", sortValue: (r) => r[k], cell: (r) => <span className="num font-medium">{formatINR(r[k])}</span>, footer: footer === undefined ? undefined : <span className="num">{formatINR(footer)}</span> })
  const text = (k: "description" | "taxType" | "provider" | "policyNo" | "broker" | "paymentMode" | "paymentReference", header: string, hideOnMobile?: boolean): Column<Row> => ({ id: k, header, hideOnMobile, sortValue: (r) => r[k], cell: (r) => r[k] || <span className="text-muted-foreground">—</span> })
  const remarksCol: Column<Row> = { id: "remarks", header: "Remarks", hideOnMobile: true, sortValue: (r) => r.remarks, cell: (r) => (r.remarks ? <span className="line-clamp-2 max-w-64 text-muted-foreground">{r.remarks}</span> : <span className="text-muted-foreground">—</span>) }
  // The same first four columns on all five pages (owner, 25 Nov 2026): Date → Vehicle Number → Company → Type.
  const vehicleCol: Column<Row> = { id: "vehicle", header: "Vehicle Number", sortValue: (r) => r.regs.join(","), cell: vehicleCell }
  // Company: the vehicle's customer on the transaction date (stamped when saved); Broker: the entry's operating company.
  const companyCol: Column<Row> = { id: "company", header: section === "ROAD_TAX" ? "Customer Company" : "Company", sortValue: (r) => r.company, cell: (r) => r.company || <span className="text-muted-foreground">—</span> }
  // Type: each section's own category — Road Tax: tax type; Fines: fine type; Broker: pay type. Insurance and Fitness have
  // no type field: their Description holds the kind (e.g. FC 1 YEAR), shown here and not repeated.
  const typeOf = (r: Row) => (broker ? BROKER_ENTRY_LABEL[r.entryType ?? "CHARGE"] : section === "INSURANCE" || section === "FITNESS" ? r.description : r.taxType)
  const typeCol: Column<Row> = { id: "type", header: "Type", sortValue: typeOf, cell: (r) => typeOf(r) || <span className="text-muted-foreground">—</span> }
  // Fines → Driver (owner, 27 Nov 2026): name and DL from the driver master, so an edited driver shows here at once.
  const driverCol: Column<Row> = {
    id: "driver",
    header: "Driver",
    sortValue: (r) => (r.driverId ? (d.driver.get(r.driverId)?.name ?? "") : ""),
    cell: (r) => {
      const x = r.driverId ? d.driver.get(r.driverId) : undefined
      if (!x) return <span className="text-muted-foreground">—</span>
      return (
        <span className="block min-w-0">
          <span className="font-medium">{x.name}</span>
          {x.licenseNo && <span className="block font-mono text-[11px] text-muted-foreground">{x.licenseNo}</span>}
        </span>
      )
    },
  }
  const statusCol: Column<Row> = { id: "status", header: section === "FINE" ? "Payment Status" : "Status", sortValue: (r) => r.status, cell: statusCell }
  // Road Tax: an entry saved before the paying company had to be chosen (27 Nov 2026) may hold the vehicle's company,
  // filled in by the old form — flagged "Check" until it is opened and saved; none recorded = "Not recorded".
  const unconfirmed = (r: Row) => section === "ROAD_TAX" && !r.companyConfirmed
  const paidByCol: Column<Row> = {
    id: "paidBy",
    header: section === "ROAD_TAX" ? "Paying Company" : "Paid By",
    hideOnMobile: section !== "ROAD_TAX",
    sortValue: (r) => r.companyCode ?? "",
    cell: (r) => (
      <span className="inline-flex items-center gap-1">
        {r.companyCode ? <CompanyBadge code={r.companyCode} /> : <span className="text-muted-foreground">{section === "ROAD_TAX" ? "Not recorded" : "—"}</span>}
        {unconfirmed(r) && <StatusBadge status="CHECK" label="Check" tone="amber" className="h-4.5 px-1.5 text-[10px]" />}
      </span>
    ),
  }
  const toConfirm = section === "ROAD_TAX" ? rows.filter(unconfirmed).length : 0
  const actions: Column<Row> = {
    id: "act",
    header: "",
    align: "right",
    cell: (r) => (
      <RowActions
        lockedReason={(mayEdit || mayDelete) && !open(r) ? (expenseLocked(r) ? `${monthLabel(monthOf(r))} is locked in ${meta.title} — read-only.` : monthLockedReason(monthLabel(r.date.slice(0, 7)))) : null}
        // A payment to a broker is edited in Add Payment's form (broker-level, never a bill's).
        onEdit={mayEdit && open(r) ? () => (broker && r.entryType === "PAYMENT" ? setPaying({ payment: r }) : setEditor({ expense: r })) : undefined}
        onDelete={mayDelete && open(r) ? () => setDeleting(r) : undefined}
        editLabel="Edit entry"
        deleteLabel="Delete entry"
      />
    ),
  }
  const dateCol = { ...date("date", "Date"), footer: `${shown.length} entr${shown.length === 1 ? "y" : "ies"}` }
  const lead = [dateCol, vehicleCol, companyCol, typeCol]

  const columns: Record<ExpenseSection, Column<Row>[]> = {
    ROAD_TAX: [...lead, date("validFrom", "Tax From"), date("validTill", "Tax Valid Till"), text("description", "Description"), money("amount", "Amount", total), paidByCol, statusCol, remarksCol, actions],
    INSURANCE: [...lead, text("policyNo", "Policy Number"), text("provider", "Insurance Provider"), date("validFrom", "Start Date"), date("validTill", "Expiry Date"), money("amount", "Premium Amount", total), text("paymentMode", "Payment Mode", true), text("paymentReference", "Payment Reference", true), paidByCol, statusCol, remarksCol, actions],
    FITNESS: [...lead, date("validFrom", "Valid From"), date("validTill", "Valid Till"), money("amount", "Amount", total), paidByCol, statusCol, remarksCol, actions],
    FINE: [...lead, driverCol, money("amount", "Fine Amount", total), statusCol, date("paymentDate", "Payment Date"), text("paymentReference", "Payment Reference", true), text("description", "Description"), remarksCol, actions],
    // Broker Charges (owner, 25 Nov 2026): Date, Vehicle Number, Company, Broker Name, Type, Description, Broker Amount,
    // Payment Type, Remarks — then the other recorded details.
    BROKER: [
      dateCol,
      vehicleCol,
      companyCol,
      text("broker", "Broker Name"),
      typeCol,
      { id: "billNo", header: "Bill No.", sortValue: (r) => r.billNo ?? "", cell: (r) => r.billNo || <span className="text-muted-foreground">—</span> },
      text("description", "Description"),
      // Broker Amount: what the entry's Broker Amount was — a payment's amount paid, a charge's or opening balance's amount.
      { id: "amount", header: "Broker Amount", align: "right", sortValue: (r) => (r.entryType === "PAYMENT" ? r.paidAmount : r.amount), cell: (r) => <span className="num font-medium">{formatINR(r.entryType === "PAYMENT" ? r.paidAmount : r.amount)}</span> },
      text("paymentMode", "Payment Type"),
      remarksCol,
      money("paidAmount", "Paid Amount", round2(shown.reduce((s, r) => s + r.paidAmount, 0))),
      // Balance, Cleared Date and Status are not shown here (owner, 25 Nov 2026) — still stored and calculated.
      actions,
    ],
  }
  // Phone cards: the date is the card title; the same next lines on every page, then the section's amount.
  const mobile: Record<ExpenseSection, string[]> = {
    ROAD_TAX: ["vehicle", "company", "type", "amount", "paidBy"],
    INSURANCE: ["vehicle", "company", "type", "amount"],
    FITNESS: ["vehicle", "company", "type", "amount"],
    FINE: ["vehicle", "company", "type", "amount"],
    BROKER: ["vehicle", "company", "broker", "amount"],
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={meta.title}
        meta={local ? <Badge variant="secondary">Phase 1 · this browser only</Badge> : undefined}
        description={
          section === "BROKER"
            ? `Every bunk bill on its own, against its broker; payments made to the broker in bulk against everything owed.${where}`
            : `Every ${meta.one}, newest first. Vehicles come from the vehicle master.${where}`
        }
        actions={
          mayCreate && (
            <div className="flex flex-wrap gap-2">
              {/* Broker: one bulk payment to a broker (its own date and month — the dialog checks that month's lock). */}
              {broker && (
                <Button variant="outline" onClick={() => setPaying({})}>
                  <IndianRupee /> Add Payment
                </Button>
              )}
              {locked ? (
                <Button disabled title={`${monthLabel(month)} is locked — read-only`}>
                  <Lock /> Month locked
                </Button>
              ) : (
                <Button onClick={() => setEditor({})}>
                  <Plus /> {broker ? "Add Bill" : `Add ${meta.one}`}
                </Button>
              )}
            </div>
          )
        }
      />

      <ExpenseMonthBar d={d} section={section} month={month} months={months} onMonth={setMonth} />

      <div className="grid gap-3 sm:grid-cols-2 xl:max-w-3xl">
        <StatsCard
          label="Number of Invoices"
          value={cards.invoices}
          icon={ReceiptText}
          hint={scopeHint}
          info={broker ? "Count of bills shown by the filters. Payments and opening balances are not counted." : `Count of ${meta.title.toLowerCase()} entries shown by the filters.`}
        />
        <StatsCard
          label="Total Amount Paid"
          value={formatINR(cards.paid)}
          icon={IndianRupee}
          hint={scopeHint}
          info={
            broker
              ? "Σ payments to brokers shown by the filters + Amount Paid recorded on older bills. Each amount counted once; a bill or opening balance is never a payment."
              : section === "FINE"
                ? "Σ the amounts of the fines shown by the filters that are marked Paid. An unpaid fine counts ₹0.00 until it is marked Paid (fines are paid in full; part-payments aren't recorded)."
                : `Σ the amounts of the ${meta.title.toLowerCase()} entries shown by the filters. Each entry is a payment made on its transaction date.`
          }
        />
      </div>

      <section className="space-y-2">
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <SearchBar value={f.search} onChange={set("search")} placeholder={broker ? "Description, vehicle, broker…" : "Registration, description, remarks…"} className="md:w-72" />
          {section === "ROAD_TAX" ? (
            // Customer Company (owner, 27 Nov 2026), from the customer master — not the paying company (VT / VTHPL) next to it.
            <div className="w-full md:w-52">
              <CreatableSelect value={f.customer || ALL} onChange={set("customer")} options={[{ value: ALL, label: "All Customer Companies" }, ...opts.customer]} placeholder="All Customer Companies" />
            </div>
          ) : (
            <FilterSelect value={f.vehicleId || ALL} onChange={set("vehicleId")} options={opts.vehicle} placeholder="Vehicle" allLabel="All vehicles" />
          )}
          {section !== "INSURANCE" && section !== "FITNESS" && section !== "FINE" && <FilterSelect value={f.company || ALL} onChange={set("company")} options={opts.company} placeholder="Company" allLabel={section === "ROAD_TAX" ? "All Companies" : "All companies"} />}
          {(section === "ROAD_TAX" || section === "FINE") && <FilterSelect value={f.taxType || ALL} onChange={set("taxType")} options={opts.taxType} placeholder={section === "FINE" ? "Fine type" : "Tax type"} allLabel={section === "FINE" ? "All fine types" : "All tax types"} />}
          {section === "ROAD_TAX" && (
            <div className="w-full md:w-48">
              <CreatableSelect value={f.description || ALL} onChange={set("description")} options={[{ value: ALL, label: "All Descriptions" }, ...opts.description]} placeholder="All Descriptions" />
            </div>
          )}
          {section === "INSURANCE" && <FilterSelect value={f.provider || ALL} onChange={set("provider")} options={opts.provider} placeholder="Provider" allLabel="All providers" />}
          {broker && <FilterSelect value={f.broker || ALL} onChange={set("broker")} options={opts.broker} placeholder="Broker" allLabel="All brokers" />}
          <FilterSelect value={f.status || ALL} onChange={set("status")} options={opts.status} placeholder={hasValidity(section) ? "Validity" : "Payment status"} allLabel={hasValidity(section) ? "Any validity" : "Any payment status"} />
          <div className="flex items-center gap-1.5">
            <Input type="date" value={f.from} max={f.to || undefined} onChange={(e) => set("from")(e.target.value)} className="h-8 w-36 bg-background" aria-label="From date" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={f.to} min={f.from || undefined} onChange={(e) => set("to")(e.target.value)} className="h-8 w-36 bg-background" aria-label="To date" />
          </div>
          {filtered && (
            <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={() => setF(NO_FILTERS)}>
              <X /> Reset filters
            </Button>
          )}
        </div>
        {(section === "INSURANCE" || section === "FITNESS") && <p className="text-xs text-muted-foreground">Status from the valid-till date: Expiring = within 30 days; Renewed = a later record of the same vehicle runs past it.</p>}
        {toConfirm > 0 && (
          <p className="text-xs text-amber-800 dark:text-amber-300">
            {toConfirm} entr{toConfirm === 1 ? "y was" : "ies were"} saved before the paying company had to be chosen — the company may have been filled in from the vehicle. Marked “Check”: open ✏️, confirm VT or VTHPL and save.
          </p>
        )}
        {section === "ROAD_TAX" && <p className="text-xs text-muted-foreground">Status from Tax Valid Till: Expiring = within 30 days; Renewed = a later record of the same vehicle and description runs past it. Each tax keeps its own period.</p>}
      </section>

      {rows.length === 0 ? (
        <EmptyState
          icon={locked ? Lock : ReceiptText}
          title={`No ${meta.title.toLowerCase()} recorded in ${monthLabel(month)}`}
          description={locked ? `${monthLabel(month)} is locked — nothing can be added.` : broker ? "Record a bill against its broker, or a payment to a broker." : `Record ${/^[aeiou]/i.test(meta.one) ? "an" : "a"} ${meta.one} against a vehicle from the vehicle master.`}
          action={
            mayCreate && !locked ? (
              <Button onClick={() => setEditor({})}>
                <Plus /> Add {meta.one}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable data={shown} getRowId={(r) => r.id} columns={columns[section]} showFooter emptyMessage="No entry matches the filters." mobileColumns={mobile[section]} />
      )}

      {paying && <BrokerPaymentDialog d={d} broker={paying.broker} payment={paying.payment} onClose={() => setPaying(null)} />}
      {editor && <ExpenseDialog key={editor.expense?.id ?? "new"} section={section} expense={editor.expense} defaultDate={defaultDate} onClose={() => setEditor(null)} />}
      {deleting && (
        <DeleteDialog
          title={`Delete this ${meta.one}?`}
          record={[deleting.regs.join(", ") || deleting.broker, deleting.description || deleting.taxType || deleting.provider, formatDate(deleting.date), formatINR(deleting.entryType === "PAYMENT" ? deleting.paidAmount : deleting.amount)].filter(Boolean).join(" · ")}
          impact={`The entry is removed from ${meta.title}${broker ? " and the broker's balance recalculates" : ""}. The Audit Log keeps its full details.`}
          pending={del.isPending}
          onConfirm={(reason) => del.mutateAsync({ id: deleting.id, version: deleting.updatedAt, reason })}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
