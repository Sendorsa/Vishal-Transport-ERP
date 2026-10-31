"use client"

import { useState } from "react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SimpleSelect } from "@/components/shared/simple-select"
import { monthLabel } from "@/domain/diesel"
import { QUARTER_MONTHS, QUARTERS, inQuarter, quarterLabel, quarterMonths, quarterOf, type Quarter } from "@/domain/quarters"
import { inStationPeriod } from "@/domain/fuel-stations"
import { fyMonths, fyName, fyStartYear, inFY } from "@/domain/financial-year"
import { todayISO } from "@/lib/format"
import { MonthSelect, useDieselMonth, useDieselMonthOptions } from "./parts"

/* ------------------------------------------------------------------ Period filter */

export type PeriodMode = "month" | "quarter" | "year" | "fy" | "all"

/**
 * Monthly / Quarterly / Yearly (calendar, Jan–Dec) / Financial Year (Apr–Mar) / All time — a date predicate
 * and a label, all over the same transactions.
 */
export function usePeriod(idx: Parameters<typeof useDieselMonthOptions>[0]) {
  const months = useDieselMonthOptions(idx)
  const [month, setMonth] = useDieselMonth(months)
  const years = [...new Set([todayISO().slice(0, 4), ...months.map((m) => m.slice(0, 4))])].sort().reverse()
  const [mode, setMode] = useState<PeriodMode>("month")
  const [year, setYear] = useState(todayISO().slice(0, 4))
  const [quarter, setQuarter] = useState<Quarter>(quarterOf(todayISO()))
  const fys = [...new Set([fyStartYear(todayISO()), ...months.map((m) => fyStartYear(m))])].sort().reverse()
  const [fy, setFy] = useState(fyStartYear(todayISO()))
  const match: (t: { date: string }) => boolean =
    mode === "month" ? inStationPeriod(month) : mode === "quarter" ? inQuarter(year, quarter) : mode === "year" ? inStationPeriod(year) : mode === "fy" ? inFY(fy) : () => true
  const label = mode === "month" ? monthLabel(month) : mode === "quarter" ? quarterLabel(year, quarter) : mode === "year" ? year : mode === "fy" ? fyName(fy) : "All time"
  const yearSelect = <SimpleSelect value={year} onChange={setYear} options={years.map((y) => ({ value: y, label: y }))} className="h-8 w-28" />
  const control = (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs value={mode} onValueChange={(v) => setMode(v as PeriodMode)}>
        <TabsList>
          <TabsTrigger value="month">Monthly</TabsTrigger>
          <TabsTrigger value="quarter">Quarterly</TabsTrigger>
          <TabsTrigger value="year">Yearly</TabsTrigger>
          <TabsTrigger value="fy">Financial Year</TabsTrigger>
          <TabsTrigger value="all">All Time</TabsTrigger>
        </TabsList>
      </Tabs>
      {mode === "month" && <MonthSelect months={months} value={month} onChange={setMonth} />}
      {mode === "quarter" && (
        <SimpleSelect value={String(quarter)} onChange={(v) => setQuarter(Number(v) as Quarter)} options={QUARTERS.map((q) => ({ value: String(q), label: `Q${q} · ${QUARTER_MONTHS[q]}` }))} className="h-8 w-40" />
      )}
      {(mode === "quarter" || mode === "year") && yearSelect}
      {mode === "fy" && <SimpleSelect value={String(fy)} onChange={(v) => setFy(Number(v))} options={fys.map((y) => ({ value: String(y), label: fyName(y) }))} className="h-8 w-36" />}
    </div>
  )
  // The months a period covers — the ledger chains through them (undefined = all time).
  const periodMonths = mode === "month" ? [month] : mode === "quarter" ? quarterMonths(year, quarter) : mode === "year" ? Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`) : mode === "fy" ? fyMonths(fy) : undefined
  return { mode, year, match, label, control, periodMonths }
}
