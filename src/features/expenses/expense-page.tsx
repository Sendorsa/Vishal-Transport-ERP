"use client"

import { useMemo, useState } from "react"
import { IndianRupee, Plus, ReceiptText, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
  brokerBalanceOf,
  brokerPayStatus,
  EXPENSE_SECTIONS,
  expenseMatches,
  hasValidity,
  NO_CUSTOMER,
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
import { useCan, useRole } from "@/lib/app-state"
import { formatDate, formatINR, round2, todayISO } from "@/lib/format"
import type { Expense, ExpenseSection } from "@/lib/types"
import { useExpenseData } from "./expense-data"
import { ExpenseDialog } from "./expense-form"

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
  const today = todayISO()
  const broker = section === "BROKER"
  const set = (k: keyof ExpenseFilters) => (v: string) => setF((s) => ({ ...s, [k]: v === ALL ? "" : v }))

  const all = useMemo(() => d.expenses.filter((x) => x.section === section), [d.expenses, section])
  const rows: Row[] = useMemo(
    () =>
      all.map((x) => ({
        ...x,
        regs: x.vehicleIds.map(d.regOf),
        company: broker ? x.operatingCompany : d.customerName(x.customerId),
        status: hasValidity(section) ? validityOf(x, all, today) : section === "FINE" ? x.paymentStatus : brokerPayStatus(x),
      })),
    [all, d, broker, section, today]
  )
  // Newest first: date, then the most recently entered (Payment History Ordering Rules).
  const shown = useMemo(() => rows.filter((r) => expenseMatches(r, f, r.regs, r.status)).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : -1)), [rows, f])
  const total = round2(shown.reduce((s, r) => s + r.amount, 0))

  const opts = useMemo(() => {
    const byKey = (vals: string[]) => [...new Map(vals.filter((v) => v.trim()).map((v) => [textKey(v), v])).entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
    const vehicleIds = [...new Set(rows.flatMap((r) => r.vehicleIds))]
    const customers = [...new Set(rows.map((r) => r.customerId).filter((c): c is string => !!c))]
    return {
      vehicle: vehicleIds.map((id) => ({ value: id, label: d.regOf(id) })).sort((a, b) => a.label.localeCompare(b.label)),
      company: broker
        ? byKey(rows.map((r) => r.operatingCompany))
        : [...customers.map((id) => ({ value: id, label: d.customerName(id) })).sort((a, b) => a.label.localeCompare(b.label)), ...(rows.some((r) => !r.customerId) ? [{ value: NO_CUSTOMER, label: "No customer" }] : [])],
      taxType: byKey(rows.map((r) => r.taxType)),
      provider: byKey(rows.map((r) => r.provider)),
      broker: byKey(rows.map((r) => r.broker)),
      status: hasValidity(section)
        ? (Object.keys(VALIDITY_LABEL) as ValidityStatus[]).map((k) => ({ value: k, label: VALIDITY_LABEL[k].label }))
        : (Object.keys(PAY_LABEL) as (keyof typeof PAY_LABEL)[]).filter((k) => broker || k !== "PARTIAL").map((k) => ({ value: k, label: PAY_LABEL[k] })),
    }
  }, [rows, d, broker, section])

  // The two summary cards: this section's records as filtered on screen (dates and every other filter).
  const cards = useMemo(() => sectionCards(section, shown), [section, shown])

  if (!can("expenses")) return <NoAccess what={meta.title} />
  if (DATA_BACKEND === "supabase")
    return (
      <div className="space-y-5">
        <PageHeader title={meta.title} />
        <EmptyState icon={ReceiptText} title="Not on the shared database yet" description="The Expense module is in Phase 1: it runs on the browser backend only. Its database tables come in Phase 2, after the local review." />
      </div>
    )
  if (!d.ready) return <PageSkeleton />

  const mayCreate = can("expenses", "create")
  const mayEdit = can("expenses", "edit")
  const mayDelete = can("expenses", "delete")
  const open = (r: Row) => canEditMonth(role, r.date.slice(0, 7), today, d.locks)
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
      <span className="text-muted-foreground">{broker && r.vehicleCount ? `${r.vehicleCount} vehicle${r.vehicleCount === 1 ? "" : "s"}` : broker ? "No vehicle" : "—"}</span>
    )
  const date = (k: "date" | "validFrom" | "validTill" | "paymentDate", header: string): Column<Row> => ({ id: k, header, sortValue: (r) => r[k] || null, cell: (r) => <span className="num">{r[k] ? formatDate(r[k]) : "—"}</span> })
  const money = (k: "amount" | "paidAmount", header: string, footer?: number): Column<Row> => ({ id: k, header, align: "right", sortValue: (r) => r[k], cell: (r) => <span className="num font-medium">{formatINR(r[k])}</span>, footer: footer === undefined ? undefined : <span className="num">{formatINR(footer)}</span> })
  const text = (k: "description" | "taxType" | "provider" | "policyNo" | "broker" | "company", header: string, hideOnMobile?: boolean): Column<Row> => ({ id: k, header, hideOnMobile, sortValue: (r) => r[k], cell: (r) => r[k] || <span className="text-muted-foreground">—</span> })
  const vehicleCol: Column<Row> = { id: "vehicle", header: broker ? "Vehicle(s)" : "Vehicle Number", sortValue: (r) => r.regs.join(","), cell: vehicleCell }
  const statusCol: Column<Row> = { id: "status", header: section === "FINE" ? "Payment Status" : "Status", sortValue: (r) => r.status, cell: statusCell }
  const companyCol: Column<Row> = {
    id: "company",
    header: broker ? "Operating Company" : "Company",
    sortValue: (r) => r.company,
    cell: (r) => (
      <span className="inline-flex items-center gap-1.5">
        {r.company || <span className="text-muted-foreground">{broker ? "—" : "No customer"}</span>}
        {!broker && r.companyCode && <CompanyBadge code={r.companyCode} />}
      </span>
    ),
  }
  const actions: Column<Row> = {
    id: "act",
    header: "",
    align: "right",
    cell: (r) => (
      <RowActions
        lockedReason={(mayEdit || mayDelete) && !open(r) ? monthLockedReason(monthLabel(r.date.slice(0, 7))) : null}
        onEdit={mayEdit && open(r) ? () => setEditor({ expense: r }) : undefined}
        onDelete={mayDelete && open(r) ? () => setDeleting(r) : undefined}
        editLabel="Edit entry"
        deleteLabel="Delete entry"
      />
    ),
  }
  const count = { ...date("date", section === "FINE" ? "Date" : "Transaction Date"), footer: `${shown.length} entr${shown.length === 1 ? "y" : "ies"}` }

  const columns: Record<ExpenseSection, Column<Row>[]> = {
    ROAD_TAX: [vehicleCol, text("taxType", "Tax Type", true), text("description", "Description"), date("validFrom", "Tax From"), date("validTill", "Tax Valid Till"), count, money("amount", "Amount", total), companyCol, statusCol, actions],
    INSURANCE: [vehicleCol, text("provider", "Insurance Provider"), text("policyNo", "Policy Number", true), date("validFrom", "Start Date"), date("validTill", "Expiry Date"), count, money("amount", "Premium Amount", total), statusCol, actions],
    FITNESS: [vehicleCol, text("description", "Description", true), date("validFrom", "Start Date"), date("validTill", "Valid Till"), count, money("amount", "Amount", total), statusCol, actions],
    FINE: [count, vehicleCol, text("taxType", "Fine Type"), text("description", "Description", true), money("amount", "Amount", total), statusCol, actions],
    BROKER: [
      count,
      text("broker", "Broker"),
      { id: "description", header: "Description", sortValue: (r) => r.description, cell: (r) => (r.entryType === "CHARGE" ? r.description : <Badge variant="outline" className="border-dashed font-normal">{BROKER_ENTRY_LABEL[r.entryType ?? "CHARGE"]}</Badge>) },
      vehicleCol,
      companyCol,
      money("amount", "Amount", total),
      money("paidAmount", "Paid Amount", round2(shown.reduce((s, r) => s + r.paidAmount, 0))),
      { id: "balance", header: "Balance", align: "right", sortValue: (r) => brokerBalanceOf(r), cell: (r) => <span className="num">{formatINR(brokerBalanceOf(r))}</span> },
      date("paymentDate", "Cleared Date"),
      { id: "mode", header: "Payment Mode", hideOnMobile: true, sortValue: (r) => r.paymentMode, cell: (r) => r.paymentMode || <span className="text-muted-foreground">—</span> },
      statusCol,
      actions,
    ],
  }
  const mobile: Record<ExpenseSection, string[]> = {
    ROAD_TAX: ["description", "validTill", "amount", "status"],
    INSURANCE: ["provider", "validTill", "amount", "status"],
    FITNESS: ["validTill", "date", "amount", "status"],
    FINE: ["vehicle", "taxType", "amount", "status"],
    BROKER: ["description", "vehicle", "amount", "balance"],
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={meta.title}
        meta={<Badge variant="secondary">Phase 1 · this browser only</Badge>}
        description={
          section === "BROKER"
            ? "Broker charges for one, several or no vehicles, payments to the broker and the balance carried forward. Saved in this browser only — not on the shared database yet."
            : `Every ${meta.one}, newest first. Vehicles come from the vehicle master. Saved in this browser only — not on the shared database yet.`
        }
        actions={
          mayCreate && (
            <Button onClick={() => setEditor({})}>
              <Plus /> Add {meta.one}
            </Button>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:max-w-3xl">
        <StatsCard
          label="Number of Invoices"
          value={cards.invoices}
          icon={ReceiptText}
          hint={scopeHint}
          info={broker ? "Count of new broker charges shown by the filters. Payments to the broker and opening balances (brought forward) are not invoices and are not counted." : `Count of ${meta.title.toLowerCase()} entries shown by the filters.`}
        />
        <StatsCard
          label="Total Amount Paid"
          value={formatINR(cards.paid)}
          icon={IndianRupee}
          hint={scopeHint}
          info={
            broker
              ? "Σ Amount Paid on the new charges shown by the filters — a partly paid charge counts only what was paid, an unpaid one ₹0.00. Separate payments to the broker (against the running balance, not a charge) are not included."
              : section === "FINE"
                ? "Σ the amounts of the fines shown by the filters that are marked Paid. An unpaid fine counts ₹0.00 until it is marked Paid (fines are paid in full; part-payments aren't recorded)."
                : `Σ the amounts of the ${meta.title.toLowerCase()} entries shown by the filters. Each entry is a payment made on its transaction date.`
          }
        />
      </div>

      <section className="space-y-2">
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <SearchBar value={f.search} onChange={set("search")} placeholder={broker ? "Description, vehicle, broker…" : "Registration, description, remarks…"} className="md:w-72" />
          <FilterSelect value={f.vehicleId || ALL} onChange={set("vehicleId")} options={opts.vehicle} placeholder="Vehicle" allLabel="All vehicles" />
          {section !== "INSURANCE" && section !== "FITNESS" && section !== "FINE" && <FilterSelect value={f.company || ALL} onChange={set("company")} options={opts.company} placeholder="Company" allLabel="All companies" />}
          {(section === "ROAD_TAX" || section === "FINE") && <FilterSelect value={f.taxType || ALL} onChange={set("taxType")} options={opts.taxType} placeholder={section === "FINE" ? "Fine type" : "Tax type"} allLabel={section === "FINE" ? "All fine types" : "All tax types"} />}
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
        {section === "ROAD_TAX" && <p className="text-xs text-muted-foreground">Status from Tax Valid Till: Expiring = within 30 days; Renewed = a later record of the same vehicle and description runs past it. Each tax keeps its own period.</p>}
      </section>

      {all.length === 0 ? (
        <EmptyState
          icon={ReceiptText}
          title={`No ${meta.title.toLowerCase()} recorded yet`}
          description={broker ? "Record a broker charge, a payment to the broker or the broker's opening balance." : `Record ${/^[aeiou]/i.test(meta.one) ? "an" : "a"} ${meta.one} against a vehicle from the vehicle master.`}
          action={
            mayCreate ? (
              <Button onClick={() => setEditor({})}>
                <Plus /> Add {meta.one}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable data={shown} getRowId={(r) => r.id} columns={columns[section]} showFooter emptyMessage="No entry matches the filters." mobileColumns={mobile[section]} cardsBelow={broker ? "xl" : "md"} />
      )}

      {editor && <ExpenseDialog key={editor.expense?.id ?? "new"} section={section} expense={editor.expense} onClose={() => setEditor(null)} />}
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
