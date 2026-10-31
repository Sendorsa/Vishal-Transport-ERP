import type { BusinessUnit, CompanyCode, FuelType } from "./types"

export const COMPANIES: { value: CompanyCode; label: string }[] = [
  { value: "VT", label: "Vishal Transport (VT)" },
  { value: "VTHPL", label: "VTHPL" },
]

export const BUSINESS_UNITS: { value: BusinessUnit; label: string; company: CompanyCode }[] = [
  { value: "STAFF_BUS", label: "Staff bus", company: "VTHPL" },
  { value: "SCHOOL_BUS", label: "School bus", company: "VTHPL" },
  { value: "TAXI", label: "Taxi / cab", company: "VTHPL" },
  { value: "MANPOWER", label: "Manpower", company: "VTHPL" },
  { value: "GOODS", label: "Goods transport", company: "VT" },
  { value: "PROPERTY", label: "Property rent", company: "VT" },
  { value: "FUEL_RETAIL", label: "Fuel retail", company: "VT" },
  { value: "INTERNAL", label: "Internal / own use", company: "VT" },
]

export const FUEL_TYPES: { value: FuelType; label: string }[] = [
  { value: "DIESEL", label: "Diesel" },
  { value: "PETROL", label: "Petrol" },
  { value: "EV", label: "EV" },
]

export const fuelLabel = (f: string) => FUEL_TYPES.find((x) => x.value === f)?.label ?? f

export const businessUnitLabel = (u: string) => BUSINESS_UNITS.find((b) => b.value === u)?.label ?? u

export const STATES: { name: string; code: string }[] = [
  { name: "Tamil Nadu", code: "33" },
  { name: "Karnataka", code: "29" },
  { name: "Andhra Pradesh", code: "37" },
  { name: "Telangana", code: "36" },
  { name: "Kerala", code: "32" },
  { name: "Maharashtra", code: "27" },
  { name: "Puducherry", code: "34" },
]

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
export const VEHICLE_REG_REGEX = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}$/
