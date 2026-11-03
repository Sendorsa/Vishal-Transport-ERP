"use client"

import { EditedBadge } from "@/components/shared/audit"
import { DeleteDialog } from "@/components/shared/row-actions"
import { inEntryOrder } from "@/domain/payment-order"
import { useMemo, useState } from "react"
import Link from "next/link"
import { ArrowDownLeft, ArrowUpRight, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DataTable, type Column } from "@/components/shared/data-table"
import { DetailList, EntityDrawer } from "@/components/shared/entity-drawer"
import { ALL, FilterBar, FilterSelect, SearchBar } from "@/components/shared/filter-bar"
import { Money, NoAccess, PeriodSelect } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { StatsCard } from "@/components/shared/stats-card"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { categoryName } from "@/domain/analytics"
import { inRange, rangeForPreset, type PeriodPreset } from "@/domain/periods"
import { isStationPayment } from "@/domain/station-ledger"
import { useDataset, useDeletePayment, useMonthLock } from "@/lib/api/hooks"
import { useCan, useCompanyScope } from "@/lib/app-state"
import { formatINR, formatDate, formatDateLong } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Payment } from "@/lib/types"
import { PaymentModal } from "./payment-modal"

export function PaymentList({ openNew }: { openNew?: boolean }) {
  const can = useCan()
  const [scope] = useCompanyScope()
  const { data: ds, isLoading } = useDataset()
  const del = useDeletePayment()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [tab, setTab] = useState<"ALL" | "IN" | "OUT">("ALL")
  const [period, setPeriod] = useState<PeriodPreset>("last_3_months")
  const [q, setQ] = useState("")
  const [category, setCategory] = useState(ALL)
  const [mode, setMode] = useState(ALL)
  const [modal, setModal] = useState(Boolean(openNew))
  const [selected, setSelected] = useState<Payment | null>(null)
  // Delete only while the voucher's month is open for this role (the Owner always can).
  const monthLock = useMonthLock(selected?.date.slice(0, 7) ?? "")

  const a = useMemo(() => {
    if (!ds) return null
    const range = rangeForPreset(period)
    const inPeriod = ds.payments.filter((p) => inRange(p.date, range))
    return {
      range,
      inPeriod,
      received: inPeriod.filter((p) => p.direction === "IN").reduce((s, p) => s + p.amount, 0),
      tds: inPeriod.filter((p) => p.direction === "IN").reduce((s, p) => s + p.tdsAmount, 0),
      paid: inPeriod.filter((p) => p.direction === "OUT").reduce((s, p) => s + p.amount, 0),
      invoices: new Map(ds.invoices.map((i) => [i.id, i])),
      vehicles: new Map(ds.vehicles.map((v) => [v.id, v])),
    }
  }, [ds, period])

  const filtered = useMemo(() => {
    if (!a) return undefined
    const needle = q.trim().toLowerCase()
    // Accounting order: newest date first, same-day vouchers in the order they were entered.
    return inEntryOrder(a.inPeriod).filter((p) => {
      if (tab !== "ALL" && p.direction !== tab) return false
      if (category !== ALL && (p.categoryCode ?? "RECEIPT") !== category) return false
      if (mode !== ALL && p.mode !== mode) return false
      if (!needle) return true
      return [p.paymentNo, p.partyName, p.reference, p.notes].some((f) => f.toLowerCase().includes(needle))
    })
  }, [a, tab, category, mode, q])

  if (!can("payments")) return <NoAccess what="payments" />

  const columns: Column<Payment>[] = [
    // Date only: same-day vouchers keep their entry order (rows arrive in inEntryOrder; the sort is stable).
    { id: "date", header: "Date", sortValue: (p) => p.date, cell: (p) => (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="num">{formatDate(p.date)}</span>
                    <EditedBadge id={p.id} />
                  </span>
                ) },
    {
      id: "no",
      header: "Voucher",
      hideOnMobile: true,
      sortValue: (p) => p.paymentNo,
      cell: (p) => (
        <span className="flex items-center gap-1.5">
          {p.direction === "IN" ? <ArrowDownLeft className="size-3.5 text-success" /> : <ArrowUpRight className="size-3.5 text-destructive" />}
          <span className="font-medium">{p.paymentNo}</span>
          {scope === "GROUP" && <CompanyBadge code={p.companyCode} />}
        </span>
      ),
    },
    {
      id: "party",
      header: "Party",
      sortValue: (p) => p.partyName,
      cell: (p) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{p.partyName}</div>
          <div className="truncate text-xs text-muted-foreground">
            {p.direction === "IN"
              ? p.allocations.map((x) => a?.invoices.get(x.invoiceId)?.invoiceNo).filter(Boolean).join(", ") || "Advance"
              : [categoryName(ds!.settings, p.categoryCode), p.vehicleId ? a?.vehicles.get(p.vehicleId)?.regNo : null].filter(Boolean).join(" · ")}
          </div>
        </div>
      ),
    },
    { id: "mode", header: "Mode", hideOnMobile: true, cell: (p) => <span className="text-muted-foreground">{p.mode}</span> },
    { id: "ref", header: "Reference", hideOnMobile: true, cell: (p) => <span className="block max-w-40 truncate text-muted-foreground">{p.reference || p.notes || "—"}</span> },
    { id: "tds", header: "TDS", align: "right", hideOnMobile: true, cell: (p) => (p.tdsAmount ? <Money value={p.tdsAmount} className="text-muted-foreground" /> : "") },
    {
      id: "amount",
      header: "Amount",
      align: "right",
      sortValue: (p) => (p.direction === "IN" ? p.amount : -p.amount),
      cell: (p) => (
        <span className={cn("num font-medium", p.direction === "IN" ? "text-success" : "")}>
          {p.direction === "IN" ? "+" : "−"}
          {formatINR(p.amount)}
        </span>
      ),
    },
  ]

  const categoryOptions = [
    { value: "RECEIPT", label: "Customer receipts" },
    ...(ds?.settings.expenseCategories ?? []).map((c) => ({ value: c.code, label: c.name })),
  ]

  return (
    <div>
      <PageHeader
        title="Payments"
        description="Customer receipts and outgoing payments."
        actions={
          <>
            <PeriodSelect value={period} onChange={setPeriod} />
            {can("payments", "create") && (
              <Button onClick={() => setModal(true)}>
                <Plus /> Record payment
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatsCard label="Received" value={formatINR(a?.received ?? 0)} hint={`+ ${formatINR(a?.tds ?? 0)} TDS deducted`} tone="positive" isLoading={!a} />
        <StatsCard label="Paid out" value={formatINR(a?.paid ?? 0)} isLoading={!a} />
        <StatsCard
          label="Net cash flow"
          value={formatINR((a?.received ?? 0) - (a?.paid ?? 0))}
          tone={(a?.received ?? 0) - (a?.paid ?? 0) < 0 ? "negative" : "positive"}
          hint="Excludes cash diesel"
          isLoading={!a}
        />
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mb-3">
        <TabsList>
          <TabsTrigger value="ALL">History</TabsTrigger>
          <TabsTrigger value="IN">Incoming</TabsTrigger>
          <TabsTrigger value="OUT">Outgoing</TabsTrigger>
        </TabsList>
      </Tabs>
      <FilterBar
        canReset={q !== "" || category !== ALL || mode !== ALL}
        onReset={() => {
          setQ("")
          setCategory(ALL)
          setMode(ALL)
        }}
        right={filtered && `${filtered.length} vouchers`}
      >
        <SearchBar value={q} onChange={setQ} placeholder="Voucher, party, UTR…" />
        <FilterSelect value={category} onChange={setCategory} placeholder="Heads" allLabel="All heads" options={categoryOptions} />
        <FilterSelect value={mode} onChange={setMode} placeholder="Modes" options={["NEFT", "UPI", "CHEQUE", "CASH"].map((m) => ({ value: m, label: m }))} />
      </FilterBar>
      <DataTable
        columns={columns}
        data={filtered}
        isLoading={isLoading}
        getRowId={(p) => p.id}
        onRowClick={setSelected}
        initialSort={{ id: "date", desc: true }}
        pageSize={50}
        dense
      />

      <PaymentModal open={modal} onOpenChange={setModal} direction="IN" />

      <EntityDrawer
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
        title={selected?.paymentNo}
        description={selected && `${selected.direction === "IN" ? "Receipt" : "Payment"} · ${formatDateLong(selected.date)}`}
        footer={
          selected &&
          can("payments", "delete") &&
          (!monthLock.canEdit ? (
            <span className="text-xs text-muted-foreground">This month is locked — only the Owner can delete vouchers in it.</span>
          ) : (
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete voucher
            </Button>
          ))
        }
      >
        {selected && ds && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <StatusBadge status={selected.direction} />
              <CompanyBadge code={selected.companyCode} />
            </div>
            <div className="num text-3xl font-semibold">{formatINR(selected.amount)}</div>
            <DetailList
              items={[
                ["Party", selected.customerId ? <Link className="hover:underline" href={`/customers/${selected.customerId}`}>{selected.partyName}</Link> : selected.partyName],
                ["Head", selected.direction === "IN" ? "Customer receipt" : categoryName(ds.settings, selected.categoryCode)],
                ["Vehicle", selected.vehicleId ? a?.vehicles.get(selected.vehicleId)?.regNo : "—"],
                ["Mode", selected.mode],
                ["Reference", selected.reference || "—"],
                ["TDS deducted", selected.tdsAmount ? formatINR(selected.tdsAmount) : "—"],
                ["Notes", selected.notes || "—"],
              ]}
            />
            {selected.allocations.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">Allocated to</div>
                <ul className="divide-y rounded-lg border text-sm">
                  {selected.allocations.map((x) => (
                    <li key={x.invoiceId} className="flex justify-between px-3 py-2">
                      <Link href={`/invoices/${x.invoiceId}`} className="font-medium hover:underline">
                        {a?.invoices.get(x.invoiceId)?.invoiceNo}
                      </Link>
                      <Money value={x.amount} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </EntityDrawer>
      {selected && confirmDelete && (
        <DeleteDialog
          title={`Delete ${selected.direction === "IN" ? "this receipt" : "this payment voucher"}?`}
          submitLabel="Delete Voucher"
          record={`${selected.paymentNo} · ${selected.partyName} · ${formatINR(selected.amount)} · ${formatDateLong(selected.date)}`}
          impact={
            selected.direction === "IN"
              ? `The receipt leaves Payments${selected.allocations.length ? ", and the invoices it settled become outstanding again" : ""}.`
              : `The voucher leaves Payments and expenses${selected.vendorId && isStationPayment(selected, selected.vendorId) ? ", and the fuel station's balance goes back up by this amount" : ""}.`
          }
          pending={del.isPending}
          onConfirm={async (reason) => {
            await del.mutateAsync({ id: selected.id, version: selected.updatedAt, reason })
            toast.success(`${selected.paymentNo} deleted`)
            setSelected(null)
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}
