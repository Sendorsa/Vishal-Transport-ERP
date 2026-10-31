"use client"

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { inrTick } from "@/components/shared/misc"
import type { CustomerProfit, MonthPoint, VehicleProfit } from "@/domain/analytics"
import { formatINR, formatMonthKey, formatNumber } from "@/lib/format"

const money = (v: number) => formatINR(v)
const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]

const withLabels = (data: MonthPoint[]) => data.map((d) => ({ ...d, label: formatMonthKey(d.month) }))

export function RevenueTrendChart({ data, showProfit = true }: { data: MonthPoint[]; showProfit?: boolean }) {
  const config = {
    revenue: { label: "Revenue", color: "var(--chart-1)" },
    profit: { label: "Profit", color: "var(--chart-2)" },
  } satisfies ChartConfig
  return (
    <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
      <AreaChart data={withLabels(data)} margin={{ left: 4, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-revenue)" stopOpacity={0.25} />
            <stop offset="95%" stopColor="var(--color-revenue)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tickFormatter={inrTick} tickLine={false} axisLine={false} width={64} />
        <ChartTooltip content={<ChartTooltipContent valueFormatter={money} />} />
        <Area isAnimationActive={false} dataKey="revenue" type="monotone" fill="url(#fillRevenue)" stroke="var(--color-revenue)" strokeWidth={2} />
        {showProfit && <Area isAnimationActive={false} dataKey="profit" type="monotone" fill="transparent" stroke="var(--color-profit)" strokeWidth={2} strokeDasharray="4 3" />}
        <ChartLegend content={<ChartLegendContent />} />
      </AreaChart>
    </ChartContainer>
  )
}

export function ExpenseTrendChart({ data }: { data: MonthPoint[] }) {
  const config = {
    diesel: { label: "Diesel", color: "var(--chart-3)" },
    otherExpenses: { label: "Other expenses", color: "var(--chart-4)" },
  } satisfies ChartConfig
  return (
    <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
      <BarChart data={withLabels(data)} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tickFormatter={inrTick} tickLine={false} axisLine={false} width={64} />
        <ChartTooltip content={<ChartTooltipContent valueFormatter={money} />} />
        <Bar isAnimationActive={false} dataKey="diesel" stackId="a" fill="var(--color-diesel)" radius={[0, 0, 4, 4]} />
        <Bar isAnimationActive={false} dataKey="otherExpenses" stackId="a" fill="var(--color-otherExpenses)" radius={[4, 4, 0, 0]} />
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  )
}

export function CashTrendChart({ data }: { data: MonthPoint[] }) {
  const config = {
    collected: { label: "Received", color: "var(--chart-2)" },
    paidOut: { label: "Paid out", color: "var(--chart-5)" },
  } satisfies ChartConfig
  return (
    <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
      <BarChart data={withLabels(data)} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tickFormatter={inrTick} tickLine={false} axisLine={false} width={64} />
        <ChartTooltip content={<ChartTooltipContent valueFormatter={money} />} />
        <Bar isAnimationActive={false} dataKey="collected" fill="var(--color-collected)" radius={4} />
        <Bar isAnimationActive={false} dataKey="paidOut" fill="var(--color-paidOut)" radius={4} />
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  )
}

export function DieselTrendChart({ data }: { data: MonthPoint[] }) {
  const config = {
    diesel: { label: "Diesel cost", color: "var(--chart-3)" },
    litres: { label: "Litres", color: "var(--chart-1)" },
  } satisfies ChartConfig
  return (
    <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
      <BarChart data={withLabels(data)} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis yAxisId="amt" tickFormatter={inrTick} tickLine={false} axisLine={false} width={64} />
        <YAxis yAxisId="ltr" orientation="right" tickFormatter={(v) => `${formatNumber(v / 1000)}k L`} tickLine={false} axisLine={false} width={56} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name) => (
                <div className="flex w-full justify-between gap-4">
                  <span className="text-muted-foreground">{name === "litres" ? "Litres" : "Diesel cost"}</span>
                  <span className="num font-medium">
                    {name === "litres" ? `${formatNumber(Number(value))} L` : formatINR(Number(value))}
                  </span>
                </div>
              )}
            />
          }
        />
        <Bar isAnimationActive={false} yAxisId="amt" dataKey="diesel" fill="var(--color-diesel)" radius={4} />
        <Bar isAnimationActive={false} yAxisId="ltr" dataKey="litres" fill="var(--color-litres)" radius={4} opacity={0.5} />
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  )
}

export function CustomerProfitChart({ rows, limit = 8 }: { rows: CustomerProfit[]; limit?: number }) {
  const data = [...rows]
    .filter((r) => r.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit)
    .map((r) => ({ name: r.customer.code, revenue: r.revenue, contribution: r.contribution }))
  const config = {
    revenue: { label: "Revenue", color: "var(--chart-1)" },
    contribution: { label: "Contribution", color: "var(--chart-2)" },
  } satisfies ChartConfig
  return (
    <ChartContainer config={config} className="aspect-auto h-[280px] w-full">
      <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" tickFormatter={inrTick} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={68} />
        <ChartTooltip content={<ChartTooltipContent valueFormatter={money} />} />
        <Bar isAnimationActive={false} dataKey="revenue" fill="var(--color-revenue)" radius={3} barSize={10} />
        <Bar isAnimationActive={false} dataKey="contribution" radius={3} barSize={10}>
          {data.map((d) => (
            <Cell key={d.name} fill={d.contribution < 0 ? "var(--destructive)" : "var(--color-contribution)"} />
          ))}
        </Bar>
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  )
}

export function VehicleProfitChart({ rows, limit = 12 }: { rows: VehicleProfit[]; limit?: number }) {
  const active = rows.filter((r) => r.trips > 0).sort((a, b) => b.contribution - a.contribution)
  const half = Math.floor(limit / 2)
  const picked = active.length > limit ? [...active.slice(0, half), ...active.slice(-half)] : active
  const data = picked.map((r) => ({ name: r.vehicle.regNo, contribution: r.contribution }))
  const config = { contribution: { label: "Contribution", color: "var(--chart-2)" } } satisfies ChartConfig
  return (
    <ChartContainer config={config} className="aspect-auto h-[280px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="name" tickLine={false} axisLine={false} interval={0} angle={-35} textAnchor="end" height={56} tick={{ fontSize: 10 }} />
        <YAxis tickFormatter={inrTick} tickLine={false} axisLine={false} width={64} />
        <ChartTooltip content={<ChartTooltipContent valueFormatter={money} />} />
        <Bar isAnimationActive={false} dataKey="contribution" radius={3}>
          {data.map((d) => (
            <Cell key={d.name} fill={d.contribution < 0 ? "var(--destructive)" : "var(--color-contribution)"} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

export function BreakdownDonut({ data, height = 220 }: { data: { name: string; value: number }[]; height?: number }) {
  const top = data.slice(0, 5)
  const rest = data.slice(5).reduce((s, d) => s + d.value, 0)
  const items = rest > 0 ? [...top, { name: "Others", value: rest }] : top
  const config = Object.fromEntries(items.map((d, i) => [d.name, { label: d.name, color: PALETTE[i % PALETTE.length] }])) satisfies ChartConfig
  const total = items.reduce((s, d) => s + d.value, 0)
  return (
    <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <ChartContainer config={config} className="mx-auto aspect-square w-full max-w-[220px]" style={{ height }}>
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="name" valueFormatter={money} />} />
          <Pie isAnimationActive={false} data={items} dataKey="value" nameKey="name" innerRadius="58%" strokeWidth={2}>
            {items.map((d, i) => (
              <Cell key={d.name} fill={i === 5 ? "var(--muted-foreground)" : PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <ul className="grid gap-1.5 text-xs">
        {items.map((d, i) => (
          <li key={d.name} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: i === 5 ? "var(--muted-foreground)" : PALETTE[i % PALETTE.length] }} />
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            <span className="num text-muted-foreground">{total ? ((d.value / total) * 100).toFixed(0) : 0}%</span>
            <span className="num w-20 text-right font-medium">{formatINR(d.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
