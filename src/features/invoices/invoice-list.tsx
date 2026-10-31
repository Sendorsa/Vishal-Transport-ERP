"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, type Column } from "@/components/shared/data-table"
import { ALL, FilterBar, FilterSelect, SearchBar } from "@/components/shared/filter-bar"
import { Money, NoAccess, PeriodSelect } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { StatsCard } from "@/components/shared/stats-card"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { invoiceViews, type InvoiceView } from "@/domain/analytics"
import { inRange, rangeForPreset, type PeriodPreset } from "@/domain/periods"
import { useDataset } from "@/lib/api/hooks"
import { useCan, useCompanyScope } from "@/lib/app-state"
import { formatINR, formatDate, formatMonthKey, todayISO } from "@/lib/format"
import { cn } from "@/lib/utils"

const STATUS_OPTIONS = [
  { value: "DRAFT", label: "Draft" },
  { value: "UNPAID", label: "Unpaid (not due)" },
  { value: "PARTIAL", label: "Partially paid" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "PAID", label: "Paid" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "OPEN", label: "All outstanding" },
]

export function InvoiceList({ initialStatus }: { initialStatus?: string }) {
  const can = useCan()
  const [scope] = useCompanyScope()
  const { data: ds, isLoading } = useDataset()
  const [period, setPeriod] = useState<PeriodPreset>("fy_to_date")
  const [q, setQ] = useState("")
  const [status, setStatus] = useState(initialStatus && STATUS_OPTIONS.some((s) => s.value === initialStatus) ? initialStatus : ALL)
  const [customer, setCustomer] = useState(ALL)
  const today = todayISO()

  const views = useMemo(() => (ds ? invoiceViews(ds, today) : undefined), [ds, today])
  const customers = useMemo(() => new Map((ds?.customers ?? []).map((c) => [c.id, c])), [ds])

  const stats = useMemo(() => {
    const v = views ?? []
    const month = rangeForPreset("this_month")
    const lastMonth = rangeForPreset("last_month")
    return {
      outstanding: v.reduce((s, x) => s + x.outstanding, 0),
      openCount: v.filter((x) => x.outstanding > 0).length,
      overdue: v.filter((x) => x.paymentStatus === "OVERDUE").reduce((s, x) => s + x.outstanding, 0),
      overdueCount: v.filter((x) => x.paymentStatus === "OVERDUE").length,
      billedThisMonth: v.filter((x) => x.status === "ISSUED" && inRange(x.date, month)).reduce((s, x) => s + x.total, 0),
      prevBilled: v.filter((x) => x.status === "ISSUED" && inRange(x.date, lastMonth)).reduce((s, x) => s + x.total, 0),
      drafts: v.filter((x) => x.status === "DRAFT").length,
      collectedThisMonth: (ds?.payments ?? []).filter((p) => p.direction === "IN" && inRange(p.date, month)).reduce((s, p) => s + p.amount + p.tdsAmount, 0),
    }
  }, [views, ds])

  const filtered = useMemo(() => {
    if (!views) return undefined
    const range = rangeForPreset(period)
    const needle = q.trim().toLowerCase()
    return views.filter((v) => {
      // open items stay visible regardless of period
      const open = v.outstanding > 0 || v.status === "DRAFT"
      if (!(inRange(v.date, range) || (status !== ALL && open))) return false
      if (status === "OPEN" ? v.outstanding <= 0 : status !== ALL && v.paymentStatus !== status) return false
      if (customer !== ALL && v.customerId !== customer) return false
      if (!needle) return true
      return [v.invoiceNo, customers.get(v.customerId)?.name ?? "", v.notes].some((f) => f.toLowerCase().includes(needle))
    })
  }, [views, period, q, status, customer, customers])

  if (!can("invoices")) return <NoAccess what="invoices" />

  const columns: Column<InvoiceView>[] = [
    {
      id: "no",
      header: "Invoice",
      sortValue: (v) => v.date + v.invoiceNo,
      cell: (v) => (
        <div>
          <div className="flex items-center gap-1.5">
            <span className="font-medium">{v.invoiceNo}</span>
            {scope === "GROUP" && <CompanyBadge code={v.companyCode} />}
          </div>
          <div className="text-xs text-muted-foreground">{formatDate(v.date)}</div>
        </div>
      ),
    },
    { id: "customer", header: "Customer", sortValue: (v) => customers.get(v.customerId)?.name ?? "", cell: (v) => customers.get(v.customerId)?.name },
    { id: "period", header: "Period", hideOnMobile: true, cell: (v) => <span className="text-muted-foreground">{formatMonthKey(v.periodFrom.slice(0, 7))}</span> },
    { id: "subtotal", header: "Taxable", align: "right", hideOnMobile: true, sortValue: (v) => v.subtotal, cell: (v) => <Money value={v.subtotal} /> },
    { id: "total", header: "Total", align: "right", sortValue: (v) => v.total, cell: (v) => <Money value={v.total} /> },
    {
      id: "outstanding",
      header: "Outstanding",
      align: "right",
      sortValue: (v) => v.outstanding,
      cell: (v) => (v.outstanding ? <Money value={v.outstanding} className="font-medium" /> : <span className="text-muted-foreground">—</span>),
    },
    {
      id: "due",
      header: "Due",
      hideOnMobile: true,
      sortValue: (v) => v.dueDate,
      cell: (v) => (
        <span className={cn("num", v.paymentStatus === "OVERDUE" && "text-destructive")}>
          {formatDate(v.dueDate)}
          {v.paymentStatus === "OVERDUE" && <span className="ml-1 text-xs">({v.daysOverdue}d)</span>}
        </span>
      ),
    },
    { id: "status", header: "Status", cell: (v) => <StatusBadge status={v.paymentStatus} /> },
  ]

  return (
    <div>
      <PageHeader
        title="Invoices"
        description="Tax invoices raised from completed trips. Payment status is derived from receipts."
        actions={
          <>
            <PeriodSelect value={period} onChange={setPeriod} />
            {can("invoices", "create") && (
              <Button asChild>
                <Link href="/invoices/new">
                  <Plus /> New invoice
                </Link>
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatsCard label="Outstanding" value={formatINR(stats.outstanding)} hint={`${stats.openCount} open invoices`} isLoading={isLoading} />
        <StatsCard label="Overdue" value={formatINR(stats.overdue)} hint={`${stats.overdueCount} invoices`} tone={stats.overdue > 0 ? "negative" : "default"} isLoading={isLoading} />
        <StatsCard label="Billed this month" value={formatINR(stats.billedThisMonth)} hint={`Last month ${formatINR(stats.prevBilled)} · ${stats.drafts} drafts`} isLoading={isLoading} />
        <StatsCard label="Collected this month" value={formatINR(stats.collectedThisMonth)} hint="Incl. TDS" tone="positive" isLoading={isLoading} />
      </div>
      <FilterBar
        canReset={q !== "" || status !== ALL || customer !== ALL}
        onReset={() => {
          setQ("")
          setStatus(ALL)
          setCustomer(ALL)
        }}
        right={filtered && `${filtered.length} invoices`}
      >
        <SearchBar value={q} onChange={setQ} placeholder="Invoice no or customer…" />
        <FilterSelect value={status} onChange={setStatus} placeholder="Statuses" options={STATUS_OPTIONS} />
        <FilterSelect
          value={customer}
          onChange={setCustomer}
          placeholder="Customers"
          options={(ds?.customers ?? []).map((c) => ({ value: c.id, label: c.name })).sort((a, b) => a.label.localeCompare(b.label))}
        />
      </FilterBar>
      <DataTable
        columns={columns}
        data={filtered}
        isLoading={isLoading}
        getRowId={(v) => v.id}
        rowHref={(v) => `/invoices/${v.id}`}
        initialSort={{ id: "no", desc: true }}
        pageSize={50}
        emptyMessage="No invoices match these filters."
      />
    </div>
  )
}
