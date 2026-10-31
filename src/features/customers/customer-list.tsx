"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, type Column } from "@/components/shared/data-table"
import { ALL, FilterBar, FilterSelect, SearchBar } from "@/components/shared/filter-bar"
import { Money, NoAccess } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { CompanyBadge, StatusBadge } from "@/components/shared/status-badge"
import { customerProfitability, invoiceViews, type CustomerProfit } from "@/domain/analytics"
import { rangeForPreset } from "@/domain/periods"
import { PRICING_MODELS } from "@/domain/pricing"
import { useDataset } from "@/lib/api/hooks"
import { useCan, useCompanyScope } from "@/lib/app-state"
import { BUSINESS_UNITS, businessUnitLabel } from "@/lib/constants"
import { formatNumber, formatPercent, todayISO } from "@/lib/format"
import { cn, matchesSearch } from "@/lib/utils"

export function CustomerList() {
  const can = useCan()
  const [scope] = useCompanyScope()
  const { data: ds, isLoading } = useDataset()
  const [q, setQ] = useState("")
  const [unit, setUnit] = useState(ALL)
  const [status, setStatus] = useState("ACTIVE")
  const [company, setCompany] = useState(ALL)
  const finance = can("finance", "view")

  const rows = useMemo(() => {
    if (!ds) return undefined
    const range = rangeForPreset("fy_to_date")
    return customerProfitability(ds, range, invoiceViews(ds, todayISO()))
  }, [ds])

  const filtered = useMemo(() => {
    return rows?.filter(({ customer: c }) => {
      if (unit !== ALL && c.businessUnit !== unit) return false
      if (status !== ALL && c.status !== status) return false
      if (company !== ALL && c.companyCode !== company) return false
      return matchesSearch(q, c.name, c.shortName, c.code, c.legalName, c.gstin, c.city, c.contactName)
    })
  }, [rows, q, unit, status, company])

  if (!can("customers")) return <NoAccess what="customers" />

  const columns: Column<CustomerProfit>[] = [
    {
      id: "name",
      header: "Customer",
      sortValue: (r) => r.customer.name,
      cell: ({ customer: c }) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={c.status === "ARCHIVED" ? "truncate font-medium text-muted-foreground" : "truncate font-medium"}>{c.name}</span>
            {c.status === "ARCHIVED" && <span className="shrink-0 text-xs text-muted-foreground">(Archived)</span>}
            {scope === "GROUP" && <CompanyBadge code={c.companyCode} />}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {c.code} · {c.city}, {c.state}
          </div>
        </div>
      ),
    },
    { id: "unit", header: "Business", hideOnMobile: true, sortValue: (r) => r.customer.businessUnit, cell: (r) => businessUnitLabel(r.customer.businessUnit) },
    {
      id: "pricing",
      header: "Pricing",
      hideOnMobile: true,
      cell: (r) => <span className="text-muted-foreground">{PRICING_MODELS[r.customer.pricing.model].label}</span>,
    },
    { id: "trips", header: "Trips (FY)", align: "right", hideOnMobile: true, sortValue: (r) => r.trips, cell: (r) => formatNumber(r.trips) },
    ...(finance
      ? ([
          { id: "revenue", header: "Revenue (FY)", align: "right", sortValue: (r) => r.revenue, cell: (r) => <Money value={r.revenue} /> },
          {
            id: "margin",
            header: "Margin",
            align: "right",
            hideOnMobile: true,
            sortValue: (r) => r.margin,
            cell: (r) => (r.revenue ? <span className={cn(r.margin < 0 && "text-destructive")}>{formatPercent(r.margin)}</span> : "—"),
          },
          {
            id: "outstanding",
            header: "Outstanding",
            align: "right",
            sortValue: (r) => r.outstanding,
            cell: (r) => (r.outstanding ? <Money value={r.outstanding} /> : <span className="text-muted-foreground">—</span>),
          },
        ] satisfies Column<CustomerProfit>[])
      : []),
    { id: "status", header: "Status", hideOnMobile: true, cell: (r) => <StatusBadge status={r.customer.status} /> },
  ]

  const canReset = q !== "" || unit !== ALL || status !== "ACTIVE" || company !== ALL

  return (
    <div>
      <PageHeader
        title="Customers"
        description="Clients billed by VT and VTHPL, with their pricing terms and profitability."
        actions={
          can("customers", "create") && (
            <Button asChild>
              <Link href="/customers/new">
                <Plus /> New customer
              </Link>
            </Button>
          )
        }
      />
      <FilterBar
        canReset={canReset}
        onReset={() => {
          setQ("")
          setUnit(ALL)
          setStatus("ACTIVE")
          setCompany(ALL)
        }}
        right={filtered && `${filtered.length} customers`}
      >
        <SearchBar value={q} onChange={setQ} placeholder="Search customer name, code, GSTIN…" />
        {scope === "GROUP" && (
          <FilterSelect value={company} onChange={setCompany} placeholder="Companies" options={[{ value: "VT", label: "VT" }, { value: "VTHPL", label: "VTHPL" }]} />
        )}
        <FilterSelect value={unit} onChange={setUnit} placeholder="Business units" options={BUSINESS_UNITS.map((b) => ({ value: b.value, label: b.label }))} />
        <FilterSelect
          value={status}
          onChange={setStatus}
          placeholder="Statuses"
          allLabel="All"
          options={[
            { value: "ACTIVE", label: "Active" },
            { value: "INACTIVE", label: "Inactive" },
            { value: "ARCHIVED", label: "Archived" },
          ]}
        />
      </FilterBar>
      <DataTable
        columns={columns}
        data={filtered}
        isLoading={isLoading}
        getRowId={(r) => r.customer.id}
        rowHref={(r) => `/customers/${r.customer.id}`}
        initialSort={finance ? { id: "revenue", desc: true } : { id: "name", desc: false }}
        emptyMessage={q.trim() ? `No customer matches “${q.trim()}” with these filters.` : "No customers match these filters."}
      />
    </div>
  )
}
