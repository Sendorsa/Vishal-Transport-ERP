/**
 * Fuel-type visual identity (owner, 12 Nov 2026): one mapping for every badge, card tint and heading that shows a
 * vehicle's or a fill's fuel — never scattered conditionals. Diesel keeps the existing neutral look; Petrol and EV
 * each get their own colour. Light and dark mode come from the palette's `dark:` variants.
 */
import type { FuelType } from "@/lib/types"

export interface FuelTheme {
  /** "Diesel", "Petrol", "EV". */
  label: string
  /** What a fill of this fuel is called: "diesel entry", "petrol entry", "charging entry". */
  entry: string
  unit: "L" | "kWh"
  /** Badge colours (outline badge). */
  badge: string
  /** A small dot / marker. */
  dot: string
  /** Card tint for a figure of this fuel (Diesel: none — the existing cards). */
  card: string
  /** Section heading / row title colour. */
  heading: string
}

export const FUEL_THEME: Record<FuelType, FuelTheme> = {
  DIESEL: {
    label: "Diesel",
    entry: "diesel entry",
    unit: "L",
    badge: "border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    dot: "bg-slate-500",
    card: "",
    heading: "text-muted-foreground",
  },
  PETROL: {
    label: "Petrol",
    entry: "petrol entry",
    unit: "L",
    badge: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    dot: "bg-emerald-500",
    card: "border-emerald-500/30 bg-emerald-500/[0.04]",
    heading: "text-emerald-700 dark:text-emerald-400",
  },
  EV: {
    label: "EV",
    entry: "charging entry",
    unit: "kWh",
    badge: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-400",
    dot: "bg-sky-500",
    card: "border-sky-500/30 bg-sky-500/[0.04]",
    heading: "text-sky-700 dark:text-sky-400",
  },
}

/** The theme of a fuel type (a missing one is Diesel, as a fill of an unknown vehicle counts as liquid fuel). */
export const fuelTheme = (f: FuelType | undefined | null) => FUEL_THEME[f ?? "DIESEL"]
