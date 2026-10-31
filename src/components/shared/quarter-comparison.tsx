"use client"

import { DataTable } from "@/components/shared/data-table"
import { change, quarterOf, type Quarter } from "@/domain/quarters"
import { formatINR, formatNumber, todayISO } from "@/lib/format"
import { cn } from "@/lib/utils"

export interface QuarterFigures {
  q: Quarter
  spend: number
  /** Litres compared (e.g. diesel litres). */
  volume: number
}

const pct = (p: number | null) => (p === null ? "—" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`)
const signed = (n: number, fmt: (n: number) => string) => (n === 0 ? "0" : `${n > 0 ? "+" : "−"}${fmt(Math.abs(n))}`)
const tone = (n: number) => cn("num", n > 0 && "text-red-600 dark:text-red-400", n < 0 && "text-emerald-600 dark:text-emerald-400")

/** Q1 vs Q2, Q2 vs Q3, Q3 vs Q4 of one year: spend and volume difference with % change. */
export function QuarterComparison({ year, quarters, spendLabel, volumeLabel }: { year: string; quarters: QuarterFigures[]; spendLabel: string; volumeLabel: string }) {
  // The quarter in progress is only partly over — say so, or its drop looks like a real fall.
  const today = todayISO()
  const name = (q: Quarter) => `Q${q}${year === today.slice(0, 4) && q === quarterOf(today) ? " (to date)" : ""}`
  const rows = [1, 2, 3].map((i) => {
    const from = quarters[i - 1]
    const to = quarters[i]
    return { id: `${from.q}-${to.q}`, from, to, spend: change(from.spend, to.spend), volume: change(from.volume, to.volume) }
  })
  return (
    <DataTable
      data={rows}
      getRowId={(r) => r.id}
      dense
      columns={[
        { id: "pair", header: "Comparison", cell: (r) => <span className="font-medium">{name(r.from.q)} vs {name(r.to.q)} {year}</span> },
        { id: "sf", header: `${spendLabel} (from → to)`, align: "right", cell: (r) => <span className="num text-muted-foreground">{formatINR(r.from.spend)} → {formatINR(r.to.spend)}</span> },
        { id: "sd", header: "Spend Difference", align: "right", cell: (r) => <span className={tone(r.spend.diff)}>{signed(r.spend.diff, (n) => formatINR(n))}</span> },
        { id: "sp", header: "Spend % Change", align: "right", cell: (r) => <span className={tone(r.spend.diff)}>{pct(r.spend.pct)}</span> },
        { id: "vd", header: `${volumeLabel} Difference`, align: "right", cell: (r) => <span className="num">{signed(r.volume.diff, (n) => `${formatNumber(n)} L`)}</span> },
        { id: "vp", header: "Volume % Change", align: "right", cell: (r) => <span className="num">{pct(r.volume.pct)}</span> },
      ]}
    />
  )
}
