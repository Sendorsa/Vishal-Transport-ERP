"use client"

import { Fragment, useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import Link from "next/link"
import { CalendarDays, ChevronRight, Info, Lock, LockOpen } from "lucide-react"
import { addMonths, format, parseISO } from "date-fns"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { StatusBadge } from "@/components/shared/status-badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  buildDieselIndex,
  dieselMonths,
  pickMonth,
  monthLabel,
  type DieselGroup,
  type DieselStats,
} from "@/domain/diesel"
import { useAdBlueEntries, useDataset, useMonthLock, useSetMonthLock } from "@/lib/api/hooks"
import { useCurrentMonth } from "@/lib/app-state"
import { isTankerFill } from "@/domain/tanker"
import type { DieselEntry } from "@/lib/types"

export { useMonthLock }
import { formatINR, formatDate, monthKey, todayISO } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Full dataset (all customers, never split by VT / VTHPL) + diesel index, memoised. */
export function useDieselIndex() {
  const { data: ds, isLoading } = useDataset({ allCompanies: true })
  const idx = useMemo(() => (ds ? buildDieselIndex(ds) : null), [ds])
  return { ds, idx, isLoading }
}

/** A fill's payment: Credit / Cash at a pump; "From tanker" for tanker fills (stock already bought — nothing owed). */
export function FillPaymentBadge({ entry }: { entry: Pick<DieselEntry, "vendorId" | "paymentMode"> }) {
  return isTankerFill(entry) ? <StatusBadge status="TANKER" label="From tanker" tone="gray" /> : <StatusBadge status={entry.paymentMode} />
}

/**
 * The Mileage column of a fill table: header with an ⓘ saying how it's calculated (the StatsCard tooltip), and the
 * cell — a fill's `fillMileage` (domain/diesel.ts) to 2 decimals, or "—" when there is none.
 */
export function MileageHeader({ unit }: { unit: "L" | "kWh" }) {
  const info = `This fill's mileage = KM since last fill ÷ ${unit === "kWh" ? "units charged (kWh)" : "litres filled"}. Shown as — for a first fill, a missing odometer or previous reading, no ${unit === "kWh" ? "units" : "litres"}, or a KM since last fill that isn't positive.`
  return (
    <span className="inline-flex items-center gap-1">
      Mileage (km/{unit})
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={`How Mileage is calculated: ${info}`} className="shrink-0 cursor-help rounded-sm opacity-60 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2">
            <Info className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 font-normal">{info}</TooltipContent>
      </Tooltip>
    </span>
  )
}
export const mileageText = (kmpl: number | null, unit: "L" | "kWh") => (kmpl === null ? "—" : `${kmpl.toFixed(2)} km/${unit}`)

/* ------------------------------------------------------------------ Company monogram */

const LOGO_COLORS = [
  "bg-blue-600", "bg-emerald-600", "bg-amber-500", "bg-violet-600", "bg-rose-600",
  "bg-cyan-600", "bg-orange-600", "bg-indigo-600", "bg-teal-600", "bg-fuchsia-600",
]

function hash(s: string) {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

/** Customer logo: uploaded image if present, otherwise a coloured monogram. */
export function CompanyLogo({ group, size = "md" }: { group: Pick<DieselGroup, "shortName" | "slug"> & { logo?: string | null }; size?: "sm" | "md" | "lg" }) {
  const box = cn("shrink-0 rounded-lg", size === "sm" && "size-7", size === "md" && "size-10", size === "lg" && "size-12")
  if (group.logo)
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data URL from localStorage, nothing to optimise
      <img src={group.logo} alt="" className={cn(box, "border bg-white object-contain p-0.5")} />
    )
  const words = group.shortName.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean)
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : group.shortName.slice(0, 2)).toUpperCase()
  return (
    <div
      className={cn(
        box,
        "flex items-center justify-center font-semibold tracking-tight text-white",
        group.slug === "unallocated" ? "bg-muted-foreground" : LOGO_COLORS[hash(group.slug) % LOGO_COLORS.length],
        size === "sm" && "text-[11px]",
        size === "md" && "text-sm",
        size === "lg" && "text-base"
      )}
      aria-hidden
    >
      {initials}
    </div>
  )
}

/** Downscales an uploaded image to ≤128px and returns a compact data URL for localStorage. */
export function readLogoFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("Please choose an image file"))
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, 128 / Math.max(img.width, img.height))
      const canvas = document.createElement("canvas")
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(img.src)
      resolve(canvas.toDataURL("image/png"))
    }
    img.onerror = () => reject(new Error("Could not read that image"))
    img.src = URL.createObjectURL(file)
  })
}

/* ------------------------------------------------------------------ Global reporting month */

const MONTH_KEY = "vt:ui:dieselMonth"
const monthListeners = new Set<() => void>()

function subscribeMonth(cb: () => void) {
  monthListeners.add(cb)
  const onStorage = (e: StorageEvent) => e.key === MONTH_KEY && cb()
  window.addEventListener("storage", onStorage)
  return () => {
    monthListeners.delete(cb)
    window.removeEventListener("storage", onStorage)
  }
}

function readMonth() {
  try {
    return window.localStorage.getItem(MONTH_KEY) ?? ""
  } catch {
    return ""
  }
}

/** Stored as "picked@pickedIn" (pickMonth): a pick only lasts for the India calendar month it was made in. */
function writeMonth(m: string) {
  try {
    window.localStorage.setItem(MONTH_KEY, `${m}@${monthKey(todayISO())}`)
  } catch {
    /* storage unavailable — month just won't persist */
  }
  monthListeners.forEach((l) => l())
}

/**
 * The reporting month shared by every monthly page (Diesel, Masters, Fuel Stations, AdBlue, Diesel Tankers) so the
 * user picks it once. Opens on the latest month (the current India month) unless one was picked this month (pickMonth).
 */
export function useDieselMonth(available: string[]): [string, (m: string) => void] {
  const stored = useSyncExternalStore(subscribeMonth, readMonth, () => "")
  const current = useCurrentMonth()
  const month = pickMonth(available, stored, current)
  const set = useCallback((m: string) => writeMonth(m), [])
  return [month, set]
}

/** Pages whose URL carries a month keep the global month in step with it. */
export function useSyncDieselMonth(month: string) {
  useEffect(() => {
    if (readMonth() !== `${month}@${monthKey(todayISO())}`) writeMonth(month)
  }, [month])
}

/** Month options for the module: all months with data + the current month, newest first. */
/** Months with diesel or AdBlue entries (plus the current month), newest first. */
export function useDieselMonthOptions(idx: ReturnType<typeof buildDieselIndex> | null) {
  const adblue = useAdBlueEntries()
  return useMemo(() => {
    if (!idx) return []
    const current = monthKey(todayISO())
    const ab = (adblue.data ?? []).map((e) => e.date.slice(0, 7)).filter((m) => m <= current)
    return [...new Set([...dieselMonths(idx, todayISO()), ...ab])].sort().reverse()
  }, [idx, adblue.data])
}

/* ------------------------------------------------------------------ Month selector */

export function MonthSelect({ months, value, onChange, prominent }: { months: string[]; value: string; onChange: (m: string) => void; prominent?: boolean }) {
  const current = monthKey(todayISO())
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        size={prominent ? "default" : "sm"}
        aria-label="Reporting month"
        className={cn("bg-background", prominent ? "min-w-52 gap-2 px-3 text-base font-semibold shadow-sm data-[size=default]:h-10" : "h-8 min-w-44")}
      >
        {prominent && <CalendarDays className="size-4 text-muted-foreground" />}
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {months.map((m) => (
          <SelectItem key={m} value={m}>
            {monthLabel(m)}
            {m === current && <span className="text-muted-foreground"> · to date</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/* ------------------------------------------------------------------ Month lock */

/**
 * Lock badge for the selected month. Everyone sees the state and whether they can still enter data; the
 * Owner and Dev also get Lock / Unlock-for-users (canSetMonthLock).
 */
export function MonthLockControl({ month }: { month: string }) {
  const { info, isOwner, canEdit } = useMonthLock(month)
  const setLock = useSetMonthLock()
  const label = monthLabel(month)
  const by = info.override ? ` by Owner · ${formatDate(info.override.updatedAt.slice(0, 10))}` : ""
  const text =
    info.state === "OPEN"
      ? info.override
        ? `Unlocked for users${by}`
        : `Open · locks automatically on ${format(addMonths(parseISO(`${month}-01`), 1), "d MMM")}`
      : `Locked for users${info.override ? by : " · month closed"}`
  const toggle = async () => {
    const state = info.state === "OPEN" ? "LOCKED" : "OPEN"
    await setLock.mutateAsync({ month, state })
    toast.success(state === "LOCKED" ? `${label} locked for users` : `${label} unlocked for users`)
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <StatusBadge status={info.state} tone={info.state === "OPEN" ? "green" : "gray"} label={info.state === "OPEN" ? "Open" : "Locked"} />
      <span className="text-muted-foreground">
        {text}
        {!canEdit && " — only the Owner or Dev can change this month"}
      </span>
      {isOwner && (
        <Button variant="outline" size="sm" onClick={toggle} disabled={setLock.isPending}>
          {info.state === "OPEN" ? <Lock /> : <LockOpen />}
          {info.state === "OPEN" ? "Lock month" : "Unlock for users"}
        </Button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ Breadcrumb */

export function DieselBreadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {items.map((it, i) => (
        <Fragment key={i}>
          {i > 0 && <ChevronRight className="size-3" />}
          {it.href ? (
            <Link href={it.href} className="hover:text-foreground">
              {it.label}
            </Link>
          ) : (
            <span className="font-medium text-foreground">{it.label}</span>
          )}
        </Fragment>
      ))}
    </nav>
  )
}

/* ------------------------------------------------------------------ Change chip */

/** Arrow shows the real direction; colour shows good/bad (by default a rise in diesel is bad). */
export function ChangeChip({ pct, className, upIsGood = false }: { pct: number | null; className?: string; upIsGood?: boolean }) {
  if (pct === null || !Number.isFinite(pct)) return <span className={cn("text-xs text-muted-foreground", className)}>—</span>
  const up = pct > 0.5
  const down = pct < -0.5
  const bad = upIsGood ? down : up
  const good = upIsGood ? up : down
  return (
    <span
      className={cn(
        "num inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium",
        bad && "bg-red-500/10 text-red-700 dark:text-red-400",
        good && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        !up && !down && "bg-muted text-muted-foreground",
        className
      )}
    >
      {up ? "▲" : down ? "▼" : "•"} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

export function dieselHref(slug?: string, month?: string, vehicleReg?: string) {
  if (!slug) return month ? `/diesel?month=${month}` : "/diesel"
  if (!month) return `/diesel/${slug}`
  if (!vehicleReg) return `/diesel/${slug}/${month}`
  return `/diesel/${slug}/${month}/${vehicleReg}`
}

/**
 * Plain-language formula + the actual numbers behind each KPI, for the ⓘ tooltips.
 * Mirrors the definitions in docs/DIESEL_CALCULATIONS.md.
 */
export function kpiExplain(s: DieselStats) {
  const inr = (n: number) => formatINR(n)
  const num = (n: number) => Math.round(n).toLocaleString("en-IN")
  return {
    spend: `Σ amount of ${s.fills} fill${s.fills === 1 ? "" : "s"} (litres × rate) = ${inr(s.spend)}.`,
    litres: `Σ litres of ${s.fills} fill${s.fills === 1 ? "" : "s"} = ${s.litres.toLocaleString("en-IN")} L${s.kwh ? ` (EV charges, ${s.kwh} kWh, counted separately)` : ""}.`,
    km: `Σ "KM since last fill" for these fills, i.e. each fill's odometer − the previous fill's odometer = ${num(s.km)} km.`,
    costPerKm: s.costPerKm ? `${inr(s.spend)} Total Spend ÷ ${num(s.km)} KM Run = ${formatINR(s.costPerKm)} per km.` : "Needs KM Run > 0: add fills with odometer readings.",
    kmpl: s.kmpl ? `${num(s.km)} KM Run ÷ ${s.litres.toLocaleString("en-IN")} litres = ${s.kmpl} km per litre.` : "Needs KM Run and litres > 0.",
  }
}
