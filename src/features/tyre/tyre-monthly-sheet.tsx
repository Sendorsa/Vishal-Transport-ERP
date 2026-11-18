"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { CalendarDays, CircleDot, IndianRupee, Percent, Receipt, Sigma, Wrench } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, type Column } from "@/components/shared/data-table"
import { ALL, FilterSelect, SearchBar } from "@/components/shared/filter-bar"
import { EmptyState, NoAccess, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { SimpleSelect } from "@/components/shared/simple-select"
import { StatsCard } from "@/components/shared/stats-card"
import { monthLabel } from "@/domain/diesel"
import { fyName, fyStartYear } from "@/domain/financial-year"
import { companyKey, kmRun, monthLines, NO_FILTERS, OFFICE_FILTER, OFFICE_LABEL, pickSheetMonth, sheetMonths, sheetTotals, sheetYears, spendBy, type SheetBasis, type TyreFilters, type TyreLineRow, type TyreSpendRow } from "@/domain/tyre"
import { useCan, useCurrentMonth } from "@/lib/app-state"
import { formatDate, formatINR, formatNumber } from "@/lib/format"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { OfficeBadge } from "./tyre-register"
import { tyreFilterOptions, useTyreData } from "./tyre-data"

const KEY = "vt:ui:tyreSheet" // this tab only: month and filters survive opening an invoice and coming back
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

interface SheetState {
  month: string
  basis: SheetBasis
  f: TyreFilters
}

/**
 * A hand-picked month holds only for the India month it was picked in (as the Diesel pages); the basis (calendar /
 * financial year) and the filters are kept. So coming back from an invoice keeps the month, and a new month opens on it.
 */
function load(current: string): SheetState {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as (Partial<SheetState> & { pickedIn?: string }) | null
    if (s) return { month: s.pickedIn === current && s.month && s.month <= current ? s.month : current, basis: s.basis === "fy" ? "fy" : "calendar", f: { ...NO_FILTERS, ...s.f } }
  } catch {
    // no storage (server render, private window): defaults
  }
  return { month: current, basis: "calendar", f: NO_FILTERS }
}

/** A cell with secondary details under it. `wrap`: long text breaks onto lines instead of widening the table. */
const sub = (main: React.ReactNode, small?: React.ReactNode, wrap?: string) => (
  <div className={wrap ? `whitespace-normal ${wrap}` : "min-w-0"}>
    <div>{main}</div>
    {small ? <div className="text-xs text-muted-foreground">{small}</div> : null}
  </div>
)
/** CGST / SGST / IGST, one per line (lines with tax only, or all three for the totals). */
function GstSplit({ cgst, sgst, igst, all }: { cgst: number; sgst: number; igst: number; all?: boolean }) {
  const parts = ([["CGST", cgst], ["SGST", sgst], ["IGST", igst]] as const).filter(([, n]) => all || n)
  return (
    <span className="font-normal">
      {parts.map(([k, n]) => (
        <span key={k} className="block num">
          {k} {formatINR(n)}
        </span>
      ))}
    </span>
  )
}

const km = (n: number | null) => (n === null ? "—" : formatNumber(n))
const inr = (n: number) => <span className="num">{formatINR(n)}</span>

/**
 * Tyre Data → Tyre → Monthly Sheet: every repair line of the month's invoices (each saved line once, with its invoice),
 * the month's totals and spend by company, repair type, supplier and brand. A view of the invoices — nothing stored;
 * every figure follows the filters. Modelled on Diesel → Monthly Master. The historical side of Tyre: any month of any
 * calendar or financial year with tyre data (the Tyre page itself shows only the current month).
 */
export function TyreMonthlySheet() {
  const can = useCan()
  const d = useTyreData()
  const current = useCurrentMonth() // India month (00:00 IST), as every monthly page
  const [state, setState] = useState(() => load(current))
  const { month, basis, f } = state
  const update = (patch: Partial<SheetState>) =>
    setState((s) => {
      const next = { ...s, ...patch }
      try {
        sessionStorage.setItem(KEY, JSON.stringify({ ...next, pickedIn: current }))
      } catch {
        // filters just don't persist
      }
      return next
    })
  const set = (k: keyof TyreFilters) => (v: string) => update({ f: { ...f, [k]: v === ALL ? "" : v } })

  const opts = useMemo(() => tyreFilterOptions(d), [d])
  const today = `${current}-01` // the helpers only read the month
  const years = useMemo(() => sheetYears(basis, d.views.map((v) => v.date), today), [basis, d.views, today])
  const rows = useMemo(() => monthLines(d.views, month, f).sort((a, b) => a.invoice.date.localeCompare(b.invoice.date) || a.invoice.createdAt.localeCompare(b.invoice.createdAt)), [d.views, month, f])
  const t = useMemo(() => sheetTotals(rows), [rows])
  const breakdowns = useMemo(
    () => ({
      company: spendBy(rows, companyKey),
      repair: spendBy(rows, (r) => [r.item.repairTypeId, d.name(r.item.repairTypeId)]),
      supplier: spendBy(rows, (r) => [r.invoice.supplierId, r.invoice.supplier]),
      brand: spendBy(rows, (r) => [r.item.brandId ?? "", r.item.brandId ? d.name(r.item.brandId) : "No brand"]),
    }),
    [rows, d]
  )

  if (!can("tyres")) return <NoAccess what="Tyre" />
  if (!d.ready) return <PageSkeleton />

  // The year the month belongs to: its calendar year, or its financial year (Apr–Mar, by start year).
  const year = basis === "fy" ? fyStartYear(`${month}-01`) : Number(month.slice(0, 4))
  const months = sheetMonths(basis, year, today) // future months never appear
  const setYear = (y: string) => update({ month: pickSheetMonth(sheetMonths(basis, Number(y), today), month) })
  const period = monthLabel(month) + (month === current ? " (to date)" : "")
  const filtered = [f.customerId, f.vehicleId, f.vehicleType, f.supplierId, f.repairTypeId, f.brandId, f.sizeId, f.search].some(Boolean)
  const office = breakdowns.company.find((r) => r.key === OFFICE_FILTER)?.grandTotal ?? 0

  // Secondary details sit under their main value (bill under the date; brand, size, tyre, KM run, removing number and
  // remarks under the repair type; quantity × rate under the base value; the GST split), so the amounts stay in view on a desktop.
  const columns: Column<TyreLineRow>[] = [
    {
      id: "date",
      header: "Date · Bill",
      sortValue: (r) => r.invoice.date,
      cell: (r) => sub(<span className="num">{formatDate(r.invoice.date)}</span>, r.invoice.billNo ? `Bill ${r.invoice.billNo}` : "No bill no."),
      footer: sub(`${t.lines} line${t.lines === 1 ? "" : "s"}`, `${t.invoices} invoice${t.invoices === 1 ? "" : "s"}`),
    },
    { id: "company", header: "Company", sortValue: (r) => r.invoice.company, cell: (r) => (r.invoice.office ? <OfficeBadge /> : sub(r.invoice.company, null, "min-w-20")) },
    { id: "vehicle", header: "Vehicle", sortValue: (r) => r.invoice.regNo, cell: (r) => sub(<span className="num font-medium">{r.invoice.regNo}</span>, r.invoice.vehicleType) },
    { id: "supplier", header: "Supplier", sortValue: (r) => r.invoice.supplier, cell: (r) => sub(r.invoice.supplier, null, "min-w-24") },
    {
      id: "repair",
      header: "Repair Type",
      sortValue: (r) => d.name(r.item.repairTypeId),
      cell: (r) =>
        sub(
          d.name(r.item.repairTypeId),
          (r.item.brandId || r.item.sizeId || r.item.tyreNumber || r.item.removingNumber || r.item.remarks || r.item.openingKm !== null || r.item.closingKm !== null) && (
            <>
              {[d.name(r.item.brandId), d.name(r.item.sizeId)].filter(Boolean).join(" · ")}
              {r.item.tyreNumber && <div>Tyre {r.item.tyreNumber}</div>}
              {(r.item.openingKm !== null || r.item.closingKm !== null) && (
                <div className="num">
                  KM {km(r.item.openingKm)} → {km(r.item.closingKm)}
                  {kmRun(r.item) !== null && ` · run ${formatNumber(kmRun(r.item)!)}`}
                </div>
              )}
              {r.item.removingNumber && <div>Removed {r.item.removingNumber}</div>}
              {r.item.remarks && <div className="line-clamp-2 italic">{r.item.remarks}</div>}
            </>
          ),
          "min-w-36 max-w-64"
        ),
    },
    {
      id: "base",
      header: "Base Value",
      align: "right",
      sortValue: (r) => r.item.baseValue,
      cell: (r) => sub(inr(r.item.baseValue), <span className="num whitespace-nowrap">{formatNumber(r.item.quantity, 3)} × {formatINR(r.item.rate)}</span>),
      footer: inr(t.baseValue),
    },
    {
      id: "gst",
      header: "GST",
      align: "right",
      hideOnMobile: true,
      sortValue: (r) => r.item.cgst + r.item.sgst + r.item.igst,
      cell: (r) =>
        sub(
          <>
            <span className="mr-1 text-xs text-muted-foreground">{r.item.gstRate}%</span>
            {inr(r.item.cgst + r.item.sgst + r.item.igst)}
          </>,
          <GstSplit cgst={r.item.cgst} sgst={r.item.sgst} igst={r.item.igst} />
        ),
      footer: sub(inr(t.gst), <GstSplit cgst={t.cgst} sgst={t.sgst} igst={t.igst} all />),
    },
    { id: "total", header: "Total Value", align: "right", sortValue: (r) => r.item.totalValue, cell: (r) => <span className="num font-medium">{formatINR(r.item.totalValue)}</span>, footer: inr(t.grandTotal) },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tyre Monthly Sheet"
        backHref="/tyre"
        backLabel="Tyre"
        description="Historical monthly records — every repair line of the chosen month's tyre invoices, with its totals. Calculated from the invoices, nothing stored."
        actions={
          <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
            <Tabs value={basis} onValueChange={(b) => update({ basis: b as SheetBasis })}>
              <TabsList>
                <TabsTrigger value="calendar">Calendar Year</TabsTrigger>
                <TabsTrigger value="fy">Financial Year</TabsTrigger>
              </TabsList>
            </Tabs>
            {/* Month | Year side by side, equal widths (SimpleSelect is w-full; the wrapper fills the row on phones); one per
                row only when a phone is too narrow (< 340 px). */}
            <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2 sm:w-[22rem]">
              <SimpleSelect
                value={month}
                onChange={(m) => update({ month: m })}
                options={months.map((m) => ({ value: m, label: basis === "fy" ? monthLabel(m) : MONTHS[Number(m.slice(5)) - 1] }))}
                className="text-base font-semibold"
              />
              <SimpleSelect value={String(year)} onChange={setYear} options={years.map((y) => ({ value: String(y), label: basis === "fy" ? fyName(y) : String(y) }))} className="text-base font-semibold" />
            </div>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-5">
        <StatsCard label="Total Invoices" icon={Receipt} value={t.invoices} hint={`${period}${filtered ? " · filtered" : ""}`} info="Distinct invoices with at least one line shown — an invoice with five lines counts once." />
        <StatsCard label="Total Repair Items" icon={Wrench} value={t.lines} hint={`${period}${filtered ? " · filtered" : ""}`} info="Repair lines shown — each saved line once." />
        <StatsCard label="Total Base Value" icon={IndianRupee} value={formatINR(t.baseValue)} hint={period} info="Σ quantity × rate of the lines shown." />
        <StatsCard label="Total GST" icon={Percent} value={formatINR(t.gst)} hint={`CGST ${formatINR(t.cgst)} · SGST ${formatINR(t.sgst)} · IGST ${formatINR(t.igst)}`} info="Σ CGST + SGST + IGST of the lines shown." />
        <StatsCard
          label="Total Tyre Expenditure"
          icon={Sigma}
          value={formatINR(t.grandTotal)}
          hint={office ? `Customers ${formatINR(t.grandTotal - office)} · ${OFFICE_LABEL} ${formatINR(office)}` : `${period} · base + GST`}
          info={`Base ${formatINR(t.baseValue)} + GST ${formatINR(t.gst)} = ${formatINR(t.grandTotal)}. ${OFFICE_LABEL} counts here, never in a customer's total.`}
          prominent
          className="col-span-2 lg:col-span-1"
        />
      </div>

      <section className="space-y-2">
        <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
          <SearchBar value={f.search} onChange={set("search")} placeholder="Bill no., vehicle, supplier, tyre no.…" className="col-span-2 md:w-72" />
          <FilterSelect value={f.customerId || ALL} onChange={set("customerId")} options={opts.company} placeholder="Company" allLabel="All companies" className="w-full min-w-0 md:w-auto md:min-w-36" />
          <FilterSelect value={f.vehicleId || ALL} onChange={set("vehicleId")} options={opts.vehicle} placeholder="Vehicle" allLabel="All vehicles" className="w-full min-w-0 md:w-auto md:min-w-36" />
          <FilterSelect value={f.vehicleType || ALL} onChange={set("vehicleType")} options={opts.vehicleType} placeholder="Vehicle type" allLabel="All vehicle types" className="w-full min-w-0 md:w-auto md:min-w-36" />
          <FilterSelect value={f.supplierId || ALL} onChange={set("supplierId")} options={opts.supplier} placeholder="Supplier" allLabel="All suppliers" className="w-full min-w-0 md:w-auto md:min-w-36" />
          <FilterSelect value={f.repairTypeId || ALL} onChange={set("repairTypeId")} options={opts.repairType} placeholder="Repair type" allLabel="All repair types" className="w-full min-w-0 md:w-auto md:min-w-36" />
          <FilterSelect value={f.brandId || ALL} onChange={set("brandId")} options={opts.brand} placeholder="Tyre brand" allLabel="All tyre brands" className="w-full min-w-0 md:w-auto md:min-w-36" />
          <FilterSelect value={f.sizeId || ALL} onChange={set("sizeId")} options={opts.size} placeholder="Tyre size" allLabel="All tyre sizes" className="w-full min-w-0 md:w-auto md:min-w-36" />
          {filtered && (
            <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={() => update({ f: NO_FILTERS })}>
              Reset filters
            </Button>
          )}
        </div>
      </section>

      {d.views.length === 0 ? (
        <EmptyState icon={CircleDot} title="No tyre invoices yet" description="The Monthly Sheet lists the repair lines of the invoices recorded in Tyre." action={<Button asChild variant="outline"><Link href="/tyre">Go to Tyre</Link></Button>} />
      ) : (
        <>
          <Section title={`Repair lines · ${monthLabel(month)}`}>
            <DataTable
              data={rows}
              getRowId={(r) => r.item.id}
              rowHref={(r) => `/tyre/${r.invoice.id}?from=sheet`}
              columns={columns}
              initialSort={{ id: "date", desc: false }}
              showFooter
              dense
              pageSize={100}
              mobileColumns={["vehicle", "repair", "company", "total"]}
              cardsBelow="xl"
              emptyMessage={filtered ? `No repair line in ${monthLabel(month)} matches the filters.` : <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" /> No tyre invoices in {monthLabel(month)}.</span>}
            />
          </Section>

          {rows.length > 0 && (
            <div className="grid gap-4 xl:grid-cols-2 [&>*]:min-w-0">
              <SpendTable title="Company-wise expenditure" header="Company" rows={breakdowns.company} total={t} office />
              <SpendTable title="Repair-type-wise expenditure" header="Repair type" rows={breakdowns.repair} total={t} />
              <SpendTable title="Supplier-wise expenditure" header="Supplier" rows={breakdowns.supplier} total={t} />
              <SpendTable title="Tyre-brand-wise expenditure" header="Tyre brand" rows={breakdowns.brand} total={t} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

const counts = (r: { invoices: number; lines: number }) => `${r.invoices} invoice${r.invoices === 1 ? "" : "s"} · ${r.lines} line${r.lines === 1 ? "" : "s"}`

/** One breakdown: spend per group, footer = the sheet's totals (a multi-line invoice may sit in several groups). */
function SpendTable({ title, header, rows, total, office }: { title: string; header: string; rows: TyreSpendRow[]; total: ReturnType<typeof sheetTotals>; office?: boolean }) {
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground uppercase">{title}</h3>
      <DataTable
        data={rows}
        getRowId={(r) => r.key || "none"}
        initialSort={{ id: "total", desc: true }}
        showFooter
        dense
        pageSize={50}
        columns={[
          {
            id: "name",
            header,
            sortValue: (r) => r.label,
            cell: (r) => sub(office && r.key === OFFICE_FILTER ? <OfficeBadge className="h-auto whitespace-normal" /> : <span className="font-medium">{r.label}</span>, counts(r), "min-w-28"),
            footer: sub("Total", counts(total), "min-w-28"),
          },
          { id: "base", header: "Base Value", align: "right", sortValue: (r) => r.baseValue, cell: (r) => inr(r.baseValue), footer: inr(total.baseValue) },
          { id: "gst", header: "GST", align: "right", sortValue: (r) => r.gst, cell: (r) => inr(r.gst), footer: inr(total.gst) },
          { id: "total", header: "Total", align: "right", sortValue: (r) => r.grandTotal, cell: (r) => <span className="num font-medium">{formatINR(r.grandTotal)}</span>, footer: inr(total.grandTotal) },
        ]}
      />
    </div>
  )
}
