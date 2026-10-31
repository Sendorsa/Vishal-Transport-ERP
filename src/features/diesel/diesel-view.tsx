"use client"

import { EditedBadge } from "@/components/shared/audit"
import { inEntryOrder } from "@/domain/payment-order"
import { useMemo, useState } from "react"
import Link from "next/link"
import { Fuel, IndianRupee, Wallet } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DataTable, type Column } from "@/components/shared/data-table"
import { ALL, FilterBar, FilterSelect, SearchBar } from "@/components/shared/filter-bar"
import { Money, NoAccess } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { StatsCard } from "@/components/shared/stats-card"
import { StatusBadge } from "@/components/shared/status-badge"
import { dieselByVendor, payablesTotal } from "@/domain/analytics"
import { customerSlug, monthLabel, shortMonthLabel } from "@/domain/diesel"
import { useDataset } from "@/lib/api/hooks"
import { useCan } from "@/lib/app-state"
import { endOfMonthISO, formatINR, formatDate, formatNumber, monthKey, todayISO } from "@/lib/format"
import type { DieselEntry } from "@/lib/types"
import { FillPaymentBadge, MonthSelect, dieselHref, useDieselIndex, useDieselMonth, useDieselMonthOptions } from "./parts"

/**
 * Secondary page for accountants: every fill in the selected month and what is owed to each
 * diesel vendor. Reached from the dashboard's Payables card, not the main diesel navigation.
 */
export function DieselView() {
  const can = useCan()
  const finance = can("finance", "view")
  const { data: ds, isLoading } = useDataset({ allCompanies: true })
  const { idx } = useDieselIndex()
  const months = useDieselMonthOptions(idx)
  const [month, setMonth] = useDieselMonth(months)
  const [q, setQ] = useState("")
  const [vendor, setVendor] = useState(ALL)
  const [mode, setMode] = useState(ALL)

  const a = useMemo(() => {
    if (!ds || !month) return null
    const range = { from: `${month}-01`, to: endOfMonthISO(month) }
    const entries = ds.diesel.filter((e) => monthKey(e.date) === month)
    return {
      entries,
      spend: entries.reduce((t, e) => t + e.amount, 0),
      litres: entries.reduce((t, e) => t + e.litres, 0),
      vendors: dieselByVendor(ds, range),
      payables: payablesTotal(ds),
      vehicles: new Map(ds.vehicles.map((v) => [v.id, v])),
      vendorMap: new Map(ds.fuelStations.map((v) => [v.id, v])),
      customers: new Map(ds.customers.map((c) => [c.id, c])),
    }
  }, [ds, month])

  const filtered = useMemo(() => {
    if (!a) return undefined
    const needle = q.trim().toLowerCase()
    return inEntryOrder(a.entries).filter((e) => {
      if (vendor !== ALL && e.vendorId !== vendor) return false
      if (mode !== ALL && e.paymentMode !== mode) return false
      if (!needle) return true
      return [a.vehicles.get(e.vehicleId)?.regNo ?? "", e.billNo].some((f) => f.toLowerCase().includes(needle))
    })
  }, [a, q, vendor, mode])

  if (!can("diesel")) return <NoAccess what="diesel" />

  const period = month ? shortMonthLabel(month) + (month === monthKey(todayISO()) ? " (to date)" : "") : ""

  const columns: Column<DieselEntry>[] = [
    { id: "date", header: "Date", sortValue: (e) => e.date, cell: (e) => (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="num">{formatDate(e.date)}</span>
                    <EditedBadge id={e.id} />
                  </span>
                ) },
    {
      id: "veh",
      header: "Vehicle",
      sortValue: (e) => a?.vehicles.get(e.vehicleId)?.regNo ?? "",
      cell: (e) => {
        const reg = a?.vehicles.get(e.vehicleId)?.regNo
        const cust = e.customerId ? a?.customers.get(e.customerId) : null
        return cust && reg ? (
          <Link href={dieselHref(customerSlug(cust), month, reg)} onClick={(ev) => ev.stopPropagation()} className="font-medium hover:underline">
            {reg}
          </Link>
        ) : (
          <span className="font-medium">{reg}</span>
        )
      },
    },
    {
      id: "cust",
      header: "Costed to",
      sortValue: (e) => a?.customers.get(e.customerId ?? "")?.shortName ?? "",
      cell: (e) => <span className="text-muted-foreground">{e.customerId ? a?.customers.get(e.customerId)?.shortName : "Unallocated"}</span>,
    },
    {
      id: "vendor",
      header: "Vendor",
      hideOnMobile: true,
      sortValue: (e) => a?.vendorMap.get(e.vendorId)?.name ?? "",
      cell: (e) => {
        const v = a?.vendorMap.get(e.vendorId)
        return (
          <span className="flex items-center gap-1.5">
            <span className="truncate">{v?.name}</span>
            {v?.isInterCompany && <StatusBadge status="IC" label="VT outlet" tone="violet" className="h-4.5 px-1.5 text-[10px]" />}
          </span>
        )
      },
    },
    { id: "bill", header: "Bill", hideOnMobile: true, cell: (e) => <span className="text-muted-foreground">{e.billNo}</span> },
    { id: "litres", header: "Litres", align: "right", sortValue: (e) => e.litres, cell: (e) => formatNumber(e.litres, 2) },
    { id: "rate", header: "₹/L", align: "right", hideOnMobile: true, sortValue: (e) => e.rate, cell: (e) => e.rate.toFixed(2) },
    { id: "amount", header: "Amount", align: "right", sortValue: (e) => e.amount, cell: (e) => <Money value={e.amount} /> },
    { id: "mode", header: "Payment", hideOnMobile: true, cell: (e) => <FillPaymentBadge entry={e} /> },
  ]

  return (
    <div>
      <PageHeader
        title="Diesel ledger & vendors"
        backHref="/diesel"
        backLabel="Diesel"
        description="All fills in the month and what is owed to each diesel vendor."
        actions={month && <MonthSelect months={months} value={month} onChange={setMonth} />}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatsCard label="Diesel Spend" icon={IndianRupee} value={formatINR(a?.spend ?? 0)} hint={`${period} · ${a?.entries.length ?? 0} fills`} isLoading={!a} info="Sum of all diesel fills in the selected month: pump fills at litres × rate, tanker fills at the tanker's weighted-average load cost." />
        <StatsCard label="Litres Filled" icon={Fuel} value={formatNumber(a?.litres ?? 0)} hint={period} isLoading={!a} info="Total litres across all fills in the selected month." />
        {finance && (
          <StatsCard
            label="Vendor Payables"
            icon={Wallet}
            value={formatINR(a?.payables ?? 0)}
            hint="Outstanding today, all months"
            isLoading={!a}
            info="Σ Debit closing balances of the fuel station ledgers, as of today: purchases (pump fills, credit and cash, + Diesel Tanker loads) − payments (vouchers, manual cash, cash at pump)."
          />
        )}
      </div>

      <Tabs defaultValue="entries">
        <TabsList>
          <TabsTrigger value="entries">Entries</TabsTrigger>
          <TabsTrigger value="vendors">Vendors</TabsTrigger>
        </TabsList>

        <TabsContent value="entries" className="mt-3">
          <FilterBar
            canReset={q !== "" || vendor !== ALL || mode !== ALL}
            onReset={() => {
              setQ("")
              setVendor(ALL)
              setMode(ALL)
            }}
            right={filtered && `${filtered.length} entries`}
          >
            <SearchBar value={q} onChange={setQ} placeholder="Vehicle or bill no…" />
            <FilterSelect value={vendor} onChange={setVendor} placeholder="Vendors" options={(ds?.fuelStations ?? []).map((v) => ({ value: v.id, label: v.name }))} />
            <FilterSelect value={mode} onChange={setMode} placeholder="Modes" allLabel="Credit + cash" options={[{ value: "CREDIT", label: "Credit" }, { value: "CASH", label: "Cash" }]} />
          </FilterBar>
          <DataTable columns={columns} data={filtered} isLoading={isLoading} getRowId={(e) => e.id} initialSort={{ id: "date", desc: true }} pageSize={50} dense />
        </TabsContent>

        <TabsContent value="vendors" className="mt-3">
          <DataTable
            data={a?.vendors}
            getRowId={(r) => r.vendor.id}
            columns={[
              {
                id: "v",
                header: "Vendor",
                cell: (r) => (
                  <div>
                    <div className="flex items-center gap-1.5 font-medium">
                      {r.vendor.name}
                      {r.vendor.isInterCompany && <StatusBadge status="IC" label="VT outlet" tone="violet" className="h-4.5 px-1.5 text-[10px]" />}
                    </div>
                    <div className="text-xs text-muted-foreground">{r.vendor.location}</div>
                  </div>
                ),
              },
              { id: "f", header: `Fills (${period})`, align: "right", hideOnMobile: true, cell: (r) => r.fills },
              { id: "l", header: "Litres", align: "right", hideOnMobile: true, cell: (r) => formatNumber(r.litres) },
              { id: "rate", header: "Avg ₹/L", align: "right", cell: (r) => (r.avgRate ? r.avgRate.toFixed(2) : "—") },
              { id: "a", header: `Purchases (${period})`, align: "right", cell: (r) => <Money value={r.amount} /> },
              ...(finance
                ? [{ id: "o", header: "Payable today", align: "right" as const, cell: (r: { outstanding: number }) => (r.outstanding ? <Money value={r.outstanding} className="font-medium" /> : "—") }]
                : []),
            ]}
            emptyMessage={`No vendor activity in ${month ? monthLabel(month) : "this month"}.`}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
