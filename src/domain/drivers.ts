/**
 * The central driver master (Operations → Drivers, owner 27 Nov 2026): where a driver works, derived — never typed in.
 *
 *   vehicle company history  — Vehicle.companyPeriods (VT / VTHPL, dated); none recorded = always its current company;
 *   driver ↔ vehicle         — Vehicle.driverPeriods (dated) and the vehicle's default driver (undated);
 *   company deployment       — each driver period split by the vehicle's company on those dates, then consecutive or
 *                              overlapping spans of the same company merged (a change of vehicle within one company is
 *                              not a new deployment). Two companies at once (driving a VT and a VTHPL vehicle on the
 *                              same days) is kept and flagged, never hidden.
 */
import { addDays, format, parseISO } from "date-fns"
import type { CompanyCode, CompanyPeriod, Driver, Vehicle } from "@/lib/types"
import { appendPeriod, dayBefore } from "./status-history"

const ISO = /^\d{4}-\d{2}-\d{2}$/
const dayAfter = (d: string) => format(addDays(parseISO(d), 1), "yyyy-MM-dd")

/** The vehicle's company on `date`: the recorded period covering it; before the first one, the first; none recorded = its company. */
export function companyOn(v: Pick<Vehicle, "companyCode" | "companyPeriods">, date: string): CompanyCode {
  const h = v.companyPeriods ?? []
  if (!h.length) return v.companyCode
  return (h.find((p) => p.startDate <= date && (p.endDate === null || date <= p.endDate)) ?? (date < h[0].startDate ? h[0] : h.at(-1)!)).companyCode
}

/**
 * History after the vehicle moves to `code` from `effective` (inclusive; may be back-dated, never in the future, never
 * before the last recorded change — history is appended, not rewritten). The first change also records the company it
 * had until then (from the day it entered the ERP, or the day before `effective` if earlier).
 */
export function withCompanyChange(v: Pick<Vehicle, "companyCode" | "companyPeriods" | "createdAt">, code: CompanyCode, effective: string, today: string, newId: () => string): CompanyPeriod[] {
  if (!ISO.test(effective)) throw new Error("Enter the date the company change takes effect")
  if (effective > today) throw new Error("A company change can't take effect in the future.")
  let h = v.companyPeriods ?? []
  if (!h.length) {
    if (code === v.companyCode) return h
    const since = v.createdAt.slice(0, 10)
    h = [{ id: newId(), companyCode: v.companyCode, startDate: since < effective ? since : dayBefore(effective), endDate: null }]
  }
  const last = h.at(-1)!
  if (effective < last.startDate) throw new Error(`The vehicle's company was last changed on ${format(parseISO(last.startDate), "dd-MM-yyyy")} — a change can't take effect before that.`)
  const next = appendPeriod<CompanyPeriod>(h, { id: "", companyCode: code }, effective, (a, b) => a.companyCode === b.companyCode)
  return next.map((p) => (p.id ? p : { ...p, id: newId() }))
}

export interface Deployment {
  companyCode: CompanyCode
  startDate: string
  /** null = still deployed. */
  endDate: string | null
  /** Registrations driven in this span. */
  vehicles: string[]
  /** Another company's deployment covers some of the same days (driving a VT and a VTHPL vehicle at once). */
  overlaps: boolean
}

/** One driver's dated vehicle periods, newest first: vehicle, from, to (null = now). */
export function driverVehicleHistory(driverId: string, vehicles: Vehicle[]) {
  return vehicles
    .flatMap((v) => (v.driverPeriods ?? []).filter((p) => p.driverId === driverId).map((p) => ({ vehicle: v, periodId: p.id, startDate: p.startDate, endDate: p.endDate })))
    .sort((a, b) => b.startDate.localeCompare(a.startDate) || (b.endDate ?? "9999").localeCompare(a.endDate ?? "9999"))
}

/**
 * Company deployment history (oldest first), from the driver's dated vehicle periods and each vehicle's dated company
 * — the default driver of a vehicle without a dated period has no dates, so it isn't history (see currentDeployment).
 */
export function driverDeployments(driverId: string, vehicles: Vehicle[], today: string): Deployment[] {
  const spans: Omit<Deployment, "overlaps">[] = []
  for (const { vehicle: v, startDate, endDate } of driverVehicleHistory(driverId, vehicles)) {
    const until = endDate ?? today
    // Split the driver period at every company change inside it.
    const cuts = [startDate, ...(v.companyPeriods ?? []).map((p) => p.startDate).filter((d) => d > startDate && d <= until)].sort()
    cuts.forEach((from, i) => {
      const to = i + 1 < cuts.length ? dayBefore(cuts[i + 1]) : endDate
      spans.push({ companyCode: companyOn(v, from), startDate: from, endDate: to, vehicles: [v.regNo] })
    })
  }
  spans.sort((a, b) => a.startDate.localeCompare(b.startDate))
  // Merge spans of one company that touch or overlap — a change of vehicle inside one company is one deployment.
  const merged: Omit<Deployment, "overlaps">[] = []
  for (const s of spans) {
    const last = [...merged].reverse().find((m) => m.companyCode === s.companyCode)
    if (last && (last.endDate === null || s.startDate <= dayAfter(last.endDate)) && merged.at(-1) === last) {
      last.endDate = last.endDate === null || s.endDate === null ? null : last.endDate > s.endDate ? last.endDate : s.endDate
      for (const r of s.vehicles) if (!last.vehicles.includes(r)) last.vehicles.push(r)
    } else merged.push({ ...s, vehicles: [...s.vehicles] })
  }
  const end = (d: Omit<Deployment, "overlaps">) => d.endDate ?? "9999-12-31"
  return merged.map((d) => ({ ...d, overlaps: merged.some((o) => o !== d && o.companyCode !== d.companyCode && o.startDate <= end(d) && d.startDate <= end(o)) }))
}

/**
 * Where the driver works today: the vehicles they drive now (an open dated period, or default driver of an active
 * vehicle) and those vehicles' companies today. No vehicle = Unassigned.
 */
export function currentDeployment(driverId: string, vehicles: Vehicle[], today: string) {
  const now = vehicles.filter(
    (v) => v.status !== "ARCHIVED" && ((v.driverPeriods ?? []).some((p) => p.driverId === driverId && p.startDate <= today && p.endDate === null) || v.defaultDriverId === driverId)
  )
  const companies = [...new Set(now.map((v) => companyOn(v, today)))].sort() as CompanyCode[]
  return { vehicles: now, companies, label: companies.length ? companies.join(" + ") : "Unassigned" }
}

/** Search a driver by name or DL number (case, spaces and punctuation ignored). */
export function driverMatches(d: Pick<Driver, "name" | "licenseNo" | "phone">, q: string) {
  const k = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
  const needle = k(q)
  return !needle || k(d.name).includes(needle) || k(d.licenseNo ?? "").includes(needle) || k(d.phone ?? "").includes(needle)
}

/** "Name · DL KA01 2020…" — how a driver is told apart in pickers and tables. */
export const driverLabel = (d: Pick<Driver, "name" | "licenseNo">) => (d.licenseNo ? `${d.name} · DL ${d.licenseNo}` : d.name)
