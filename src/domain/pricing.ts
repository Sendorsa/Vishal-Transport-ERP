import type { PricingModel, PricingTerms } from "@/lib/types"
import { round2 } from "@/lib/format"

/**
 * Trip / duty revenue calculation. Pure — the backend will run the same rules
 * (pricing engine in the architecture doc). Pooled monthly caps (e.g. TEPL pools
 * km across all buses of a seater) are approximated per duty in the prototype.
 */

export const PRICING_MODELS: Record<
  PricingModel,
  { label: string; rateLabel: string; includedKmLabel: string | null; hint: string }
> = {
  FIXED_DAILY_KM_CAP: {
    label: "Fixed day rate + km cap",
    rateLabel: "Day rate (₹)",
    includedKmLabel: "Km cap / day",
    hint: "Day rate per duty; km above the daily cap billed at the extra-km rate.",
  },
  PER_KM_DAILY_MIN: {
    label: "Per km, daily minimum",
    rateLabel: "Rate / km (₹)",
    includedKmLabel: "Minimum km / day",
    hint: "Minimum km × rate per duty; km above the minimum billed at the extra-km rate.",
  },
  ROUTE_DAY_RATE: {
    label: "Route day rate",
    rateLabel: "Day rate (₹)",
    includedKmLabel: "Included km (0 = unlimited)",
    hint: "Flat ₹ per working day on a fixed route.",
  },
  PER_TRIP: {
    label: "Per trip (route rate card)",
    rateLabel: "Default trip rate (₹)",
    includedKmLabel: null,
    hint: "Rate per trip from the route rate card (goods).",
  },
  TAXI_PACKAGE: {
    label: "Taxi package",
    rateLabel: "Package rate (₹)",
    includedKmLabel: "Package km",
    hint: "Package rate covers the package km; extra km and driver bata added.",
  },
}

export interface TripPricingInput {
  distanceKm: number
  route?: string
  tollParking?: number
}

export interface TripPricingResult {
  baseAmount: number
  extraKmAmount: number
  bataAmount: number
  tollParking: number
  revenue: number
  extraKm: number
}

export function calculateTripRevenue(
  terms: PricingTerms,
  input: TripPricingInput
): TripPricingResult {
  const d = Math.max(0, input.distanceKm || 0)
  const toll = Math.max(0, input.tollParking || 0)
  let base = 0
  let extraKm = 0
  let extraRate = terms.extraKmRate
  let bata = 0

  switch (terms.model) {
    case "FIXED_DAILY_KM_CAP":
      base = terms.rate
      extraKm = Math.max(0, d - terms.includedKm)
      break
    case "PER_KM_DAILY_MIN":
      base = terms.includedKm * terms.rate
      extraKm = Math.max(0, d - terms.includedKm)
      if (!extraRate) extraRate = terms.rate
      break
    case "ROUTE_DAY_RATE":
      base = terms.rate
      extraKm = terms.includedKm > 0 ? Math.max(0, d - terms.includedKm) : 0
      break
    case "PER_TRIP": {
      const r = terms.routes.find((x) => x.route === input.route)
      base = r ? r.rate : terms.rate
      extraRate = 0
      break
    }
    case "TAXI_PACKAGE":
      base = terms.rate
      extraKm = Math.max(0, d - terms.includedKm)
      bata = terms.driverBata
      break
  }

  const extraKmAmount = round2(extraKm * extraRate)
  const baseAmount = round2(base)
  return {
    baseAmount,
    extraKmAmount,
    bataAmount: bata,
    tollParking: toll,
    extraKm,
    revenue: round2(baseAmount + extraKmAmount + bata + toll),
  }
}

/** GST split: intra-state → CGST + SGST, inter-state → IGST. */
export function calculateTax(subtotal: number, taxRate: number, intraState: boolean) {
  const tax = round2((subtotal * taxRate) / 100)
  if (intraState) {
    const half = round2(tax / 2)
    return { taxType: "CGST_SGST" as const, cgst: half, sgst: round2(tax - half), igst: 0, total: round2(subtotal + tax) }
  }
  return { taxType: "IGST" as const, cgst: 0, sgst: 0, igst: tax, total: round2(subtotal + tax) }
}

/** Financial-year helpers live in ./financial-year (the one shared FY utility); re-exported for existing imports. */
export { fyLabel, fyStart } from "./financial-year"
