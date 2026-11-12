/**
 * Deterministic demo data generator.
 *
 * Produces ~6 months of operations ending "today": customers, fleet, drivers,
 * daily duties (trips), diesel fills, monthly invoices, receipts and payments.
 * Dates are relative to the seeding date so the dashboard always looks current.
 * Names and rate structures follow the patterns found in the business's Excel data.
 */
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  format,
  getDay,
  parseISO,
  startOfMonth,
  subMonths,
} from "date-fns"
import { calculateTax, calculateTripRevenue, fyLabel } from "@/domain/pricing"
import { round2, toISODate, todayISO } from "@/lib/format"
import { CONFIRMED_TANKERS } from "@/domain/tanker"
import type {
  BusinessUnit,
  CompanyCode,
  IndustrialSupply,
  Customer,
  AdBlueEntry,
  VehicleAssignment,
  MonthLock,
  FuelStation,
  AdBluePurchase,
  TankerLoad,
  TankerDispense,
  Tanker,
  TankerAdjustment,
  TankerTransfer,
  DieselEntry,
  Driver,
  Invoice,
  InvoiceLine,
  Payment,
  PricingTerms,
  Settings,
  Trip,
  Vehicle,
} from "@/lib/types"

/* ------------------------------------------------------------------ PRNG (mulberry32) */

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ------------------------------------------------------------------ Static master data */

/** Fuel stations of the demo data (Settings → Reset to demo data). The clean workspace keeps only `dv_tanker`. */
export const DEFAULT_FUEL_STATIONS: FuelStation[] = [
    { id: "dv_vishal", name: "Vishal Gasoline (Jio-bp)", location: "Hosur — VT outlet", isInterCompany: true, creditDays: 15, status: "ACTIVE", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" },
    { id: "dv_shankara", name: "Shree Shankara Fuels", location: "Hosur", isInterCompany: false, creditDays: 30, status: "ACTIVE", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" },
    { id: "dv_mahadeshwara", name: "Sri Mahadeshwara Petroleum", location: "Bagalur Road", isInterCompany: false, creditDays: 30, status: "ACTIVE", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" },
    { id: "dv_raghuveer", name: "Raghuveer Fuel Station", location: "Krishnagiri", isInterCompany: false, creditDays: 30, status: "ACTIVE", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" },
    { id: "dv_lakshmitha", name: "Lakshmitha Agencies", location: "Shoolagiri", isInterCompany: false, creditDays: 30, status: "ACTIVE", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" },
    { id: "dv_jpbros", name: "JP Brothers (IOC)", location: "Attibele", isInterCompany: false, creditDays: 21, status: "ACTIVE", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" },
    { id: "dv_shrudu", name: "Shrudu Petro Services", location: "Bidadi", isInterCompany: false, creditDays: 21, status: "ACTIVE", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" },
    { id: "dv_aries", name: "Aries Gemini Fuels", location: "Harohalli", isInterCompany: false, creditDays: 21, status: "ACTIVE", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" },
    { id: "dv_tanker", name: "Diesel Tanker", location: "Company tanker", isInterCompany: false, creditDays: 0, status: "ACTIVE", isTanker: true, createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" },
]

/**
 * The clean go-live workspace (owner, 1 Nov 2026) — what every new browser starts with, and what Settings → Clear
 * all data leaves. No customers, drivers, petrol pumps, entries, stock or payments. Kept:
 * - `dv_tanker`, the internal tanker source a tanker fill points to (a system row, not a petrol pump);
 * - the three company tankers — JIO (TN70AX9480), Office (KA53C0538), Mini (KA51AF1429) — each with its tanker
 *   vehicle record. Vehicle details the books don't record stay blank, as in the fuel import. Zero loads, zero stock.
 * Company configuration (VT, VTHPL) comes with DEFAULT_SETTINGS.
 */
export function cleanWorkspace(now = new Date()): { fuel_stations: FuelStation[]; vehicles: Vehicle[]; tankers: Tanker[] } {
  const at = now.toISOString()
  const today = todayISO()
  const tankerStation = DEFAULT_FUEL_STATIONS.find((s) => s.id === "dv_tanker")!
  const vehicles: Vehicle[] = CONFIRMED_TANKERS.map((t) => ({
    id: `veh_${t.regNo.toLowerCase()}`,
    regNo: t.regNo,
    companyCode: "VT",
    typeCode: "",
    make: "",
    model: "",
    year: 0,
    seats: null,
    fuelType: "DIESEL",
    mileageKmpl: 0,
    ownership: "OWNED",
    ownerName: null,
    status: "ACTIVE",
    statusHistory: [{ status: "ACTIVE", startDate: today, endDate: null }],
    odometerKm: 0,
    assignedCustomerId: null,
    defaultDriverId: null,
    insurance: { provider: "", policyNo: "", validTill: "", premium: 0 },
    roadTax: { validTill: "", amount: 0, period: "ANNUAL" },
    fitnessValidTill: "",
    permitValidTill: "",
    emiAmount: 0,
    notes: `Diesel tanker ${t.name}.`,
    createdAt: at,
    updatedAt: at,
  }))
  const tankers: Tanker[] = CONFIRMED_TANKERS.map((t) => ({
    id: t.id,
    name: t.name,
    regNo: t.regNo,
    vehicleId: `veh_${t.regNo.toLowerCase()}`,
    capacityLitres: null,
    status: "ACTIVE",
    notes: "",
    createdAt: at,
    updatedAt: at,
  }))
  return { fuel_stations: [structuredClone(tankerStation)], vehicles, tankers }
}

export const DEFAULT_SETTINGS: Settings = {
  companies: [
    {
      code: "VT",
      name: "Vishal Transport",
      legalName: "Vishal Transport",
      gstin: "33AFXPV4821M1ZQ",
      pan: "AFXPV4821M",
      address: "2/158 Denkanikottai Road, Upparapalli",
      city: "Hosur",
      state: "Tamil Nadu",
      stateCode: "33",
      phone: "+91 94433 21870",
      email: "accounts@vishaltransport.in",
      bankName: "Kotak Mahindra Bank",
      bankAccount: "XXXX XXXX 4417",
      ifsc: "KKBK0008712",
      invoicePrefix: "VT",
      isPrimary: true,
      parentCode: null,
    },
    {
      code: "VTHPL",
      name: "VTHPL",
      legalName: "Vishal Transport & HR Solutions Pvt Ltd",
      gstin: "33AAICV0267H1ZD",
      pan: "AAICV0267H",
      address: "2/158 Denkanikottai Road, Upparapalli",
      city: "Hosur",
      state: "Tamil Nadu",
      stateCode: "33",
      phone: "+91 94433 21871",
      email: "billing@vthpl.in",
      bankName: "Kotak Mahindra Bank",
      bankAccount: "XXXX XXXX 9035",
      ifsc: "KKBK0008712",
      invoicePrefix: "VTH",
      isPrimary: false,
      parentCode: "VT",
    },
  ],
  expenseCategories: [
    { code: "DRIVER_SALARY", name: "Driver salary", kind: "EXPENSE", vehicleLinked: true, active: true },
    { code: "STAFF_SALARY", name: "Office & supervisory salary", kind: "EXPENSE", vehicleLinked: false, active: true },
    { code: "EMI", name: "Vehicle EMI", kind: "EXPENSE", vehicleLinked: true, active: true },
    { code: "TYRE", name: "Tyres", kind: "EXPENSE", vehicleLinked: true, active: true },
    { code: "MAINTENANCE", name: "Maintenance & repairs", kind: "EXPENSE", vehicleLinked: true, active: true },
    { code: "INSURANCE", name: "Insurance", kind: "EXPENSE", vehicleLinked: true, active: true },
    { code: "ROAD_TAX", name: "Road tax & permits", kind: "EXPENSE", vehicleLinked: true, active: true },
    { code: "ATTACH_VEHICLE", name: "Attached vehicle hire", kind: "EXPENSE", vehicleLinked: true, active: true },
    { code: "TOLL", name: "Toll & FASTag", kind: "EXPENSE", vehicleLinked: false, active: true },
    { code: "RENT", name: "Rent", kind: "EXPENSE", vehicleLinked: false, active: true },
    { code: "OFFICE", name: "Office & admin", kind: "EXPENSE", vehicleLinked: false, active: true },
    { code: "OTHER", name: "Other expense", kind: "EXPENSE", vehicleLinked: false, active: true },
    { code: "DIESEL_SETTLEMENT", name: "Diesel vendor payment", kind: "SETTLEMENT", vehicleLinked: false, active: true },
    { code: "GST_PAYMENT", name: "GST remittance", kind: "SETTLEMENT", vehicleLinked: false, active: true },
  ],
  vehicleTypes: [
    { code: "BUS_55", name: "55-seater bus", category: "BUS", defaultSeats: 55, defaultMileage: 4.3 },
    { code: "BUS_41", name: "41-seater bus", category: "BUS", defaultSeats: 41, defaultMileage: 4.9 },
    { code: "BUS_32", name: "32-seater bus", category: "BUS", defaultSeats: 32, defaultMileage: 6.0 },
    { code: "MINI_24", name: "24-seater mini bus", category: "BUS", defaultSeats: 24, defaultMileage: 7.0 },
    { code: "TT_17", name: "Tempo Traveller (17)", category: "VAN", defaultSeats: 17, defaultMileage: 8.5 },
    { code: "SUV", name: "SUV (Innova Crysta)", category: "CAR", defaultSeats: 7, defaultMileage: 11 },
    { code: "SEDAN", name: "Sedan (Dzire / Etios)", category: "CAR", defaultSeats: 4, defaultMileage: 17 },
    { code: "TRUCK_19", name: "19 ft truck", category: "TRUCK", defaultSeats: null, defaultMileage: 6 },
    { code: "PICKUP", name: "Pickup (Bolero / Ace)", category: "PICKUP", defaultSeats: null, defaultMileage: 12 },
  ],
  defaultTaxRate: 18,
  tdsRate: 2,
  sacCode: "996601",
}

const terms = (p: Partial<PricingTerms> & Pick<PricingTerms, "model" | "rate">): PricingTerms => ({
  includedKm: 0,
  extraKmRate: 0,
  driverBata: 0,
  routes: [],
  ...p,
})

interface CustomerSpec {
  key: string
  code: string
  shortName?: string
  name: string
  legalName: string
  company: CompanyCode
  unit: BusinessUnit
  gstin: string
  state: string
  stateCode: string
  city: string
  contact: string
  phone: string
  creditDays: number
  pricing: PricingTerms
  /** Typical duty km (mean, spread). */
  km: [number, number]
  /** Days to pay beyond credit days (mean, spread). Negative = early. */
  payDelay: [number, number]
}

const CUSTOMER_SPECS: CustomerSpec[] = [
  {
    key: "TEPL", code: "TEPL", shortName: "TEPL", name: "Tata Electronics (TEPL)", legalName: "Tata Electronics Pvt Ltd",
    company: "VTHPL", unit: "STAFF_BUS", gstin: "33AAHCT8342G1ZA", state: "Tamil Nadu", stateCode: "33", city: "Hosur",
    contact: "Admin — Transport Desk", phone: "+91 80470 11200", creditDays: 45,
    pricing: terms({ model: "FIXED_DAILY_KM_CAP", rate: 9392.92, includedKm: 200, extraKmRate: 26.45 }),
    km: [206, 18], payDelay: [-2, 6],
  },
  {
    key: "AVTEC", code: "AVTEC", shortName: "AVTEC", name: "AVTEC Ltd", legalName: "AVTEC Limited",
    company: "VTHPL", unit: "STAFF_BUS", gstin: "33AAACH1925R1ZK", state: "Tamil Nadu", stateCode: "33", city: "Hosur",
    contact: "HR — Plant Admin", phone: "+91 4344 276100", creditDays: 30,
    pricing: terms({ model: "PER_KM_DAILY_MIN", rate: 52.71, includedKm: 140, extraKmRate: 34.72 }),
    km: [152, 14], payDelay: [4, 6],
  },
  {
    key: "DHOOT", code: "DHOOT-S", shortName: "Dhoot", name: "Dhoot Transmission — Staff", legalName: "Dhoot Transmission Pvt Ltd",
    company: "VTHPL", unit: "STAFF_BUS", gstin: "33AABCD4417F1Z2", state: "Tamil Nadu", stateCode: "33", city: "SIPCOT Hosur",
    contact: "Mr. Prabhu (Admin)", phone: "+91 98430 11452", creditDays: 30,
    pricing: terms({ model: "ROUTE_DAY_RATE", rate: 4699 }),
    km: [112, 12], payDelay: [38, 12],
  },
  {
    key: "TITAN", code: "TITAN", shortName: "Titan", name: "Titan Company — Hosur", legalName: "Titan Company Ltd",
    company: "VTHPL", unit: "STAFF_BUS", gstin: "33AAACT5131A1ZT", state: "Tamil Nadu", stateCode: "33", city: "Hosur",
    contact: "Facility Management", phone: "+91 4344 664000", creditDays: 30,
    pricing: terms({ model: "ROUTE_DAY_RATE", rate: 5450, includedKm: 140, extraKmRate: 28 }),
    km: [128, 14], payDelay: [2, 5],
  },
  {
    key: "LUMINOUS", code: "LUMI", shortName: "Luminous", name: "Luminous Power — Harohalli", legalName: "Luminous Power Technologies Pvt Ltd",
    company: "VTHPL", unit: "STAFF_BUS", gstin: "29AABCL2471J1ZC", state: "Karnataka", stateCode: "29", city: "Harohalli",
    contact: "Mr. Naveen (Admin)", phone: "+91 80286 33010", creditDays: 45,
    pricing: terms({ model: "ROUTE_DAY_RATE", rate: 11200, includedKm: 160, extraKmRate: 25 }),
    km: [176, 16], payDelay: [6, 8],
  },
  {
    key: "TSNMS", code: "TSNMS", shortName: "TSNMS School", name: "TSNMS School", legalName: "TSNMS Matriculation School",
    company: "VTHPL", unit: "SCHOOL_BUS", gstin: "", state: "Tamil Nadu", stateCode: "33", city: "Hosur",
    contact: "Correspondent", phone: "+91 94431 77820", creditDays: 15,
    pricing: terms({ model: "ROUTE_DAY_RATE", rate: 4600, includedKm: 90, extraKmRate: 27 }),
    km: [78, 10], payDelay: [25, 20],
  },
  {
    key: "RINDER", code: "RINDER", shortName: "Rinder", name: "Rinder India", legalName: "Rinder India Pvt Ltd",
    company: "VTHPL", unit: "STAFF_BUS", gstin: "33AACCR6620P1ZM", state: "Tamil Nadu", stateCode: "33", city: "Hosur",
    contact: "HR Department", phone: "+91 4344 401500", creditDays: 30,
    pricing: terms({ model: "ROUTE_DAY_RATE", rate: 4234 }),
    km: [96, 10], payDelay: [3, 4],
  },
  {
    key: "MINDA_TAXI", code: "MINDA-T", shortName: "Minda Taxi", name: "UNO Minda — Taxi", legalName: "UNO Minda Ltd",
    company: "VTHPL", unit: "TAXI", gstin: "33AAACM9393N1ZT", state: "Tamil Nadu", stateCode: "33", city: "Hosur",
    contact: "Travel Desk", phone: "+91 4344 405700", creditDays: 30,
    pricing: terms({ model: "TAXI_PACKAGE", rate: 2000, includedKm: 100, extraKmRate: 12, driverBata: 300 }),
    km: [118, 45], payDelay: [5, 6],
  },
  {
    key: "MINDA_GOODS", code: "MINDA-G", shortName: "Minda Goods", name: "UNO Minda — Goods", legalName: "UNO Minda Ltd",
    company: "VT", unit: "GOODS", gstin: "33AAACM9393N1ZT", state: "Tamil Nadu", stateCode: "33", city: "Hosur",
    contact: "Logistics — SD", phone: "+91 4344 405720", creditDays: 30,
    pricing: terms({
      model: "PER_TRIP", rate: 1267,
      routes: [
        { route: "Minda Hosur → Chennai", distanceKm: 620, rate: 8233 },
        { route: "Minda → MG Palli", distanceKm: 26, rate: 800 },
        { route: "Minda → TVS Hosur", distanceKm: 18, rate: 1267 },
        { route: "Minda → Bidadi", distanceKm: 210, rate: 4150 },
      ],
    }),
    km: [0, 0], payDelay: [2, 4],
  },
  {
    key: "DHOOT_GOODS", code: "DHOOT-G", shortName: "Dhoot Goods", name: "Dhoot Transmission — Goods", legalName: "Dhoot Transmission Pvt Ltd",
    company: "VT", unit: "GOODS", gstin: "33AABCD4417F1Z2", state: "Tamil Nadu", stateCode: "33", city: "SIPCOT Hosur",
    contact: "Stores — Dispatch", phone: "+91 98430 11460", creditDays: 30,
    pricing: terms({
      model: "PER_TRIP", rate: 2400,
      routes: [
        { route: "Dhoot → Pune hub (via KA)", distanceKm: 1680, rate: 38500 },
        { route: "Dhoot SIPCOT → Bengaluru", distanceKm: 92, rate: 2400 },
        { route: "Dhoot → Krishnagiri", distanceKm: 104, rate: 2650 },
      ],
    }),
    km: [0, 0], payDelay: [30, 10],
  },
  {
    key: "JAMNA", code: "JAMNA", shortName: "Jamna", name: "Jamna Auto Industries", legalName: "Jamna Auto Industries Ltd",
    company: "VT", unit: "GOODS", gstin: "33AAACJ5236Q1ZK", state: "Tamil Nadu", stateCode: "33", city: "Hosur",
    contact: "Stores — Dispatch", phone: "+91 4344 304200", creditDays: 30,
    pricing: terms({
      model: "PER_TRIP", rate: 2950,
      routes: [
        { route: "Jamna Hosur → Bengaluru (Bommasandra)", distanceKm: 46, rate: 2950 },
        { route: "Jamna Hosur → Chennai (Sriperumbudur)", distanceKm: 290, rate: 9200 },
        { route: "Jamna → Krishnagiri", distanceKm: 52, rate: 3100 },
      ],
    }),
    km: [0, 0], payDelay: [8, 8],
  },
  {
    key: "APJ", code: "APJ", shortName: "APJ", name: "APJ Technoplast", legalName: "APJ Technoplast Pvt Ltd",
    company: "VT", unit: "GOODS", gstin: "33AAHCA4410K1ZB", state: "Tamil Nadu", stateCode: "33", city: "Hosur",
    contact: "Logistics", phone: "+91 98422 61840", creditDays: 30,
    pricing: terms({
      model: "PER_TRIP", rate: 1450,
      routes: [
        { route: "APJ → Rinder (Hosur)", distanceKm: 14, rate: 1450 },
        { route: "APJ → Minda Switch (Hosur)", distanceKm: 11, rate: 1350 },
        { route: "APJ Hosur → Bidadi", distanceKm: 205, rate: 4600 },
      ],
    }),
    km: [0, 0], payDelay: [12, 8],
  },
  {
    key: "SEATING", code: "MINDA-SD", shortName: "Seating", name: "UNO Minda — Seating Division", legalName: "UNO Minda Ltd (Seating Division)",
    company: "VTHPL", unit: "STAFF_BUS", gstin: "33AAACM9393N1ZT", state: "Tamil Nadu", stateCode: "33", city: "Hosur",
    contact: "HR — Seating Division", phone: "+91 4344 405740", creditDays: 30,
    pricing: terms({ model: "PER_KM_DAILY_MIN", rate: 48.5, includedKm: 130, extraKmRate: 31 }),
    km: [138, 12], payDelay: [4, 5],
  },
  {
    key: "CASTING", code: "MJC", shortName: "Casting", name: "UNO Minda — Casting (MJ)", legalName: "MJ Casting Ltd (UNO Minda)",
    company: "VTHPL", unit: "STAFF_BUS", gstin: "33AAECM2184L1ZQ", state: "Tamil Nadu", stateCode: "33", city: "Hosur",
    contact: "Admin — MJ Casting", phone: "+91 4344 405760", creditDays: 30,
    pricing: terms({ model: "ROUTE_DAY_RATE", rate: 4380, includedKm: 120, extraKmRate: 26 }),
    km: [116, 12], payDelay: [6, 6],
  },
]

/** [company, typeCode, count, customerKey, attachedCount, regPrefix] */
const FLEET: [CompanyCode, string, number, string | null, number, string][] = [
  ["VTHPL", "BUS_55", 10, "TEPL", 2, "TN70"],
  ["VTHPL", "BUS_41", 3, "AVTEC", 0, "TN70"],
  ["VTHPL", "BUS_32", 3, "DHOOT", 1, "TN70"],
  ["VTHPL", "BUS_41", 3, "TITAN", 0, "TN70"],
  ["VTHPL", "BUS_55", 2, "LUMINOUS", 0, "KA42"],
  ["VTHPL", "BUS_32", 2, "TSNMS", 0, "TN24"],
  ["VTHPL", "MINI_24", 2, "RINDER", 0, "TN70"],
  ["VTHPL", "BUS_41", 2, "SEATING", 0, "TN70"],
  ["VTHPL", "BUS_32", 2, "CASTING", 1, "TN70"],
  ["VTHPL", "SEDAN", 2, "MINDA_TAXI", 0, "TN70"],
  ["VTHPL", "SUV", 2, "MINDA_TAXI", 0, "TN70"],
  ["VTHPL", "BUS_55", 1, null, 0, "TN70"],
  ["VTHPL", "TT_17", 1, null, 0, "TN70"],
  ["VT", "TRUCK_19", 2, "MINDA_GOODS", 0, "TN70"],
  ["VT", "PICKUP", 2, "MINDA_GOODS", 0, "TN70"],
  ["VT", "TRUCK_19", 1, "DHOOT_GOODS", 0, "TN70"],
  ["VT", "PICKUP", 1, "DHOOT_GOODS", 0, "TN24"],
  ["VT", "TRUCK_19", 2, "JAMNA", 0, "TN24"],
  ["VT", "PICKUP", 2, "APJ", 0, "TN70"],
  ["VT", "PICKUP", 1, null, 0, "TN70"],
]

const MAKES: Record<string, [string, string][]> = {
  BUS_55: [["Ashok Leyland", "Falcon 55"], ["Bharat Benz", "1624 Staff Bus"], ["Tata Motors", "Starbus 55"]],
  BUS_41: [["Ashok Leyland", "Lynx 41"], ["Tata Motors", "Starbus 41"], ["Eicher", "Skyline Pro 41"]],
  BUS_32: [["Eicher", "Skyline 32"], ["Tata Motors", "Starbus 32"]],
  MINI_24: [["Force Motors", "Traveller 26"], ["Tata Motors", "Winger 24"]],
  TT_17: [["Force Motors", "Traveller 17"]],
  SUV: [["Toyota", "Innova Crysta"]],
  SEDAN: [["Maruti Suzuki", "Dzire Tour"], ["Toyota", "Etios"]],
  TRUCK_19: [["Ashok Leyland", "Ecomet 1615"], ["Eicher", "Pro 3015"], ["Tata Motors", "LPT 1618"]],
  PICKUP: [["Mahindra", "Bolero Pik-Up"], ["Tata Motors", "Ace Gold"]],
}

const DRIVER_NAMES = [
  "Murugan S", "Ravi Kumar K", "Senthil Kumar R", "Manjunath B", "Prakash M", "Suresh Babu", "Rajesh K",
  "Venkatesh G", "Arun Kumar P", "Ganesh R", "Saravanan T", "Mahesh N", "Naveen Kumar", "Shivakumar H",
  "Karthik V", "Dinesh Kumar", "Lokesh M", "Ramesh C", "Anand Raj", "Babu S", "Chandru K", "Gopal R",
  "Harish B", "Jagadeesh M", "Kumaresan P", "Madhu K", "Nagaraj S", "Palani R", "Raghu N", "Sathish Kumar",
  "Thirumalai V", "Umesh G", "Vijay Anand", "Yuvaraj D", "Elumalai K", "Selvam M", "Basavaraj H",
]

const ATTACH_OWNERS = ["Sri Balaji Travels", "Lakshmi Bus Service", "Sai Ram Transports"]
const INSURERS = ["ICICI Lombard", "Bajaj Allianz", "New India Assurance", "Tata AIG", "HDFC ERGO"]
const FINANCIERS = ["HDFC Bank", "Tata Motors Finance", "Hinduja Leyland Finance", "Kotak Prime"]
const WORKSHOPS = [
  "Sri Murugan Auto Works", "Ashok Leyland Service — Hosur", "Bharat Benz Service — Hosur",
  "Tata Motors Service — Krishnagiri", "Eicher Service — Shoolagiri", "Balaji Diesel Works",
]
const MAINT_WORK = [
  "Periodic service", "Brake liner replacement", "Clutch overhaul", "AC repair & gas refill",
  "Battery replacement", "Suspension work", "Electrical repair", "Radiator repair", "Body denting & painting",
]

/* ------------------------------------------------------------------ Generator */

export interface SeedData {
  settings: Settings
  customers: Customer[]
  vehicles: Vehicle[]
  drivers: Driver[]
  trips: Trip[]
  diesel_entries: DieselEntry[]
  adblue_entries: AdBlueEntry[]
  vehicle_assignments: VehicleAssignment[]
  month_locks: MonthLock[]
  fuel_stations: FuelStation[]
  adblue_purchases: AdBluePurchase[]
  tanker_loads: TankerLoad[]
  tanker_dispenses: TankerDispense[]
  tankers: Tanker[]
  tanker_transfers: TankerTransfer[]
  tanker_adjustments: TankerAdjustment[]
  industrial_supplies: IndustrialSupply[]
  invoices: Invoice[]
  payments: Payment[]
}

export function generateSeedData(today = new Date(), seed = 20260405): SeedData {
  const rand = mulberry32(seed)
  const r = (min: number, max: number) => min + rand() * (max - min)
  const ri = (min: number, max: number) => Math.floor(r(min, max + 1))
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)]
  const chance = (p: number) => rand() < p
  const gauss = (mean: number, sd: number) => {
    const u = rand() || 1e-9
    const v = rand()
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }

  const todayISO = toISODate(today)
  const start = startOfMonth(subMonths(today, 6))
  const startISO = toISODate(start)
  const stamp = new Date(start.getTime()).toISOString()

  let idCounter = 0
  const id = (prefix: string) => `${prefix}_${(++idCounter).toString(36).padStart(4, "0")}`
  const base = (prefix: string, createdAt = stamp) => ({ id: id(prefix), createdAt, updatedAt: createdAt })
  const at = (iso: string) => `${iso}T09:30:00.000Z`

  /* Settings */
  const settings: Settings = structuredClone(DEFAULT_SETTINGS)
  const companyState = (code: CompanyCode) => settings.companies.find((c) => c.code === code)!.stateCode
  const vehicleType = (code: string) => settings.vehicleTypes.find((t) => t.code === code)!

  /* Customers */
  const customers: Customer[] = CUSTOMER_SPECS.map((s) => ({
    ...base("cus"),
    code: s.code,
    shortName: s.shortName ?? s.name,
    name: s.name,
    legalName: s.legalName,
    companyCode: s.company,
    businessUnit: s.unit,
    gstin: s.gstin,
    state: s.state,
    stateCode: s.stateCode,
    city: s.city,
    contactName: s.contact,
    phone: s.phone,
    email: `${s.code.toLowerCase().replace(/[^a-z]/g, "")}@client.example.in`,
    creditDays: s.creditDays,
    pricing: s.pricing,
    status: "ACTIVE",
  }))
  const customerByKey = new Map(CUSTOMER_SPECS.map((s, i) => [s.key, customers[i]]))
  const specById = new Map(CUSTOMER_SPECS.map((s, i) => [customers[i].id, s]))

  /* Drivers + vehicles */
  const drivers: Driver[] = []
  const vehicles: Vehicle[] = []
  const usedRegs = new Set<string>()
  const regNo = (prefix: string) => {
    const series = prefix.startsWith("KA") ? ["AB", "AC", "AD"] : ["AK", "AL", "AM", "AN", "AP", "AQ"]
    let reg = ""
    do reg = `${prefix}${pick(series)}${ri(1000, 9999)}`
    while (usedRegs.has(reg))
    usedRegs.add(reg)
    return reg
  }
  let driverIdx = 0
  const newDriver = (company: CompanyCode) => {
    const d: Driver = {
      ...base("drv"),
      name: DRIVER_NAMES[driverIdx++ % DRIVER_NAMES.length],
      phone: `+91 9${ri(100000000, 999999999)}`,
      licenseNo: `TN70 ${ri(2008, 2022)}000${ri(1000, 9999)}`,
      licenseValidTill: toISODate(addDays(today, ri(-20, 1600))),
      companyCode: company,
      status: "ACTIVE",
    }
    drivers.push(d)
    return d
  }
  let attachIdx = 0
  let financed = 0
  for (const [company, typeCode, count, custKey, attached, prefix] of FLEET) {
    for (let i = 0; i < count; i++) {
      const vt = vehicleType(typeCode)
      const [make, model] = pick(MAKES[typeCode])
      const isAttached = i < attached
      const spare = custKey === null
      const isBus = vt.category === "BUS" || vt.category === "VAN"
      const year = ri(2018, 2025)
      const emi = !isAttached && year >= 2022 && financed < 6 ? (financed++, vt.category === "BUS" ? ri(48, 78) * 1000 : ri(18, 34) * 1000) : 0
      const insValid = toISODate(addDays(today, ri(-12, 340)))
      const quarterEnd = endOfMonth(addMonths(startOfMonth(today), 2 - ((today.getMonth() - 3 + 12) % 3)))
      const driver = !isAttached && !spare ? newDriver(company) : null
      vehicles.push({
        ...base("veh"),
        regNo: regNo(prefix),
        companyCode: company,
        typeCode,
        make,
        model,
        year,
        seats: vt.defaultSeats,
        fuelType: "DIESEL",
        mileageKmpl: round2(vt.defaultMileage * r(0.92, 1.06)),
        ownership: isAttached ? "ATTACHED" : "OWNED",
        ownerName: isAttached ? ATTACH_OWNERS[attachIdx++ % ATTACH_OWNERS.length] : null,
        status: spare ? (typeCode === "PICKUP" ? "INACTIVE" : typeCode === "BUS_55" ? "MAINTENANCE" : "ACTIVE") : "ACTIVE",
        odometerKm: ri(40000, 380000),
        assignedCustomerId: custKey ? customerByKey.get(custKey)!.id : null,
        defaultDriverId: driver?.id ?? null,
        insurance: {
          provider: pick(INSURERS),
          policyNo: `${ri(3001, 3999)}/${ri(10000000, 99999999)}`,
          validTill: insValid,
          premium: isBus ? ri(62, 118) * 1000 : vt.category === "TRUCK" ? ri(38, 55) * 1000 : ri(16, 28) * 1000,
        },
        roadTax: isBus
          ? { validTill: toISODate(quarterEnd), amount: vt.defaultSeats! * ri(560, 640), period: "QUARTERLY" }
          : { validTill: toISODate(addDays(today, ri(10, 360))), amount: ri(9, 24) * 1000, period: "ANNUAL" },
        fitnessValidTill: toISODate(addDays(today, ri(-5, 360))),
        permitValidTill: toISODate(addDays(today, ri(20, 1500))),
        emiAmount: emi,
      })
    }
  }
  // relief drivers
  newDriver("VTHPL")
  newDriver("VTHPL")
  newDriver("VT")
  const reliefDrivers = drivers.slice(-3)

  /* Trips (one duty per vehicle per working day) + diesel fills */
  const trips: Trip[] = []
  const diesel: DieselEntry[] = []
  const tripSeq = new Map<string, number>()
  const vendorsFor = (v: Vehicle, spec: CustomerSpec | undefined) => {
    if (v.regNo.startsWith("KA") || spec?.stateCode === "29") return ["dv_shrudu", "dv_aries", "dv_jpbros"]
    if (v.companyCode === "VT") return ["dv_vishal", "dv_vishal", "dv_vishal", "dv_raghuveer", "dv_lakshmitha"]
    return ["dv_vishal", "dv_vishal", "dv_shankara", "dv_mahadeshwara", "dv_raghuveer", "dv_lakshmitha"]
  }
  const dieselRate = (iso: string, vendorId: string) => {
    const monthsIn = differenceInCalendarDays(parseISO(iso), start) / 30
    const ka = ["dv_shrudu", "dv_aries", "dv_jpbros"].includes(vendorId)
    return round2((ka ? 90.99 : 92.43) + monthsIn * 0.12 + r(-0.15, 0.15))
  }
  const dieselSeq = { n: 0 }

  for (const v of vehicles) {
    const cust = v.assignedCustomerId ? customers.find((c) => c.id === v.assignedCustomerId)! : null
    const spec = cust ? specById.get(cust.id) : undefined
    const vt = vehicleType(v.typeCode)
    let odo = v.odometerKm - ri(9000, 16000) // start-of-window odometer
    let sinceFill = 0
    const tank = vt.category === "CAR" ? 420 : vt.category === "PICKUP" ? 380 : 330
    const vendors = vendorsFor(v, spec)
    // Most vehicles run close to their rated mileage; a few burn noticeably more (driving, leaks, due service).
    const thirst = chance(0.18) ? r(1.12, 1.24) : r(0.95, 1.04)

    for (let day = start; toISODate(day) <= todayISO; day = addDays(day, 1)) {
      const iso = toISODate(day)
      const dow = getDay(day)
      if (!cust || !spec || v.status !== "ACTIVE") continue
      let works = false
      switch (spec.unit) {
        case "STAFF_BUS": works = dow !== 0 || chance(0.15); break
        case "SCHOOL_BUS": works = dow >= 1 && dow <= 5 && chance(0.97); break
        case "TAXI": works = chance(dow === 0 ? 0.3 : 0.72); break
        case "GOODS": works = dow !== 0 && chance(0.8); break
        default: works = false
      }
      if (works && chance(0.025)) works = false // breakdown / leave
      if (!works) continue

      const isToday = iso === todayISO
      const legs: { route: string; distance: number; toll: number }[] = []
      if (spec.unit === "GOODS") {
        const routes = cust.pricing.routes
        const short = routes.filter((x) => x.distanceKm <= 500)
        // long hauls are rarer
        const rt = routes.find((x) => x.distanceKm > 500 && chance(0.06)) ?? pick(short)
        const leg = (x: typeof rt) => ({
          route: x.route,
          distance: Math.round(x.distanceKm * r(0.98, 1.05)),
          toll: x.distanceKm > 150 ? Math.round((x.distanceKm * r(1.6, 2.2)) / 10) * 10 : 0,
        })
        legs.push(leg(rt))
        // short local runs often do a second trip the same day
        if (rt.distanceKm < 60 && chance(0.55)) legs.push(leg(pick(short.filter((x) => x.distanceKm < 60))))
        if (rt.distanceKm > 500) day = addDays(day, Math.ceil(rt.distanceKm / 450))
      } else {
        const route = spec.unit === "TAXI" ? pick(["Plant → Bengaluru Airport", "Plant → Electronic City", "Local — Hosur", "Plant → Krishnagiri", "Guest pickup — Hosur"]) : `${cust.code} shift route ${ri(1, 4)}`
        let distance = Math.max(20, Math.round(gauss(spec.km[0], spec.km[1])))
        let toll = 0
        if (spec.unit === "TAXI" && route.includes("Airport")) { distance = ri(150, 175); toll = 235 }
        legs.push({ route, distance, toll })
      }
      for (const { route, distance, toll } of legs) {
        const price = calculateTripRevenue(cust.pricing, { distanceKm: distance, route, tollParking: toll })
        const ym = format(day, "yyMM")
        const seq = (tripSeq.get(ym) ?? 0) + 1
        tripSeq.set(ym, seq)
        const startKm = odo
        if (!isToday) {
          odo += distance
          sinceFill += distance
        }
        const driverId = v.defaultDriverId ? (chance(0.07) ? pick(reliefDrivers).id : v.defaultDriverId) : null
        trips.push({
          ...base("trp", at(iso)),
          tripNo: `TRP-${ym}-${String(seq).padStart(4, "0")}`,
          companyCode: v.companyCode,
          date: iso,
          customerId: cust.id,
          vehicleId: v.id,
          driverId,
          route,
          startKm,
          endKm: isToday ? startKm : odo,
          distanceKm: isToday ? 0 : distance,
          pricingModel: cust.pricing.model,
          baseAmount: isToday ? 0 : price.baseAmount,
          extraKmAmount: isToday ? 0 : price.extraKmAmount,
          bataAmount: isToday ? 0 : price.bataAmount,
          tollParking: isToday ? 0 : price.tollParking,
          revenue: isToday ? 0 : price.revenue,
          status: isToday ? "PLANNED" : "COMPLETED",
          invoiceId: null,
          notes: "",
        })
      }

      if (sinceFill >= tank && !isToday) {
        const vendorId = pick(vendors)
        const litres = round2((sinceFill / v.mileageKmpl) * thirst * r(0.97, 1.05))
        const rate = dieselRate(iso, vendorId)
        diesel.push({
          ...base("dsl", at(iso)),
          companyCode: v.companyCode,
          date: iso,
          vehicleId: v.id,
          customerId: cust.id,
          vendorId,
          litres,
          rate,
          amount: round2(litres * rate),
          odometerKm: odo,
          billNo: `${vendorId.slice(3, 6).toUpperCase()}${String(++dieselSeq.n).padStart(5, "0")}`,
          paymentMode: chance(0.05) ? "CASH" : "CREDIT",
        })
        sinceFill = 0
      }
    }
    v.odometerKm = odo
  }
  trips.sort((a, b) => a.date.localeCompare(b.date) || a.tripNo.localeCompare(b.tripNo))
  diesel.sort((a, b) => a.date.localeCompare(b.date))

  /* Invoices: monthly per customer, one line per vehicle, for every completed month */
  const invoices: Invoice[] = []
  const invSeq = new Map<string, number>()
  const months: Date[] = []
  for (let m = start; m < startOfMonth(today); m = addMonths(m, 1)) months.push(m)
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]))

  for (const m of months) {
    const from = toISODate(m)
    const to = toISODate(endOfMonth(m))
    const invDate = toISODate(addDays(endOfMonth(m), ri(1, 3)))
    for (const cust of customers) {
      const ts = trips.filter((t) => t.customerId === cust.id && t.status === "COMPLETED" && t.date >= from && t.date <= to)
      if (!ts.length) continue
      const byVehicle = new Map<string, Trip[]>()
      ts.forEach((t) => byVehicle.set(t.vehicleId, [...(byVehicle.get(t.vehicleId) ?? []), t]))
      const isGoods = cust.businessUnit === "GOODS"
      const isTaxi = cust.businessUnit === "TAXI"
      const lines: InvoiceLine[] = [...byVehicle.entries()].map(([vid, vts], i) => {
        const amount = round2(vts.reduce((s, t) => s + t.revenue, 0))
        const km = vts.reduce((s, t) => s + t.distanceKm, 0)
        const qty = vts.length
        const unit = isGoods || isTaxi ? "Trips" : "Duties"
        return {
          id: `ln_${i + 1}`,
          description: `${vehicleById.get(vid)!.regNo} — ${qty} ${unit.toLowerCase()}, ${km.toLocaleString("en-IN")} km`,
          sac: settings.sacCode,
          quantity: qty,
          unit,
          rate: round2(amount / qty),
          amount,
          vehicleId: vid,
          tripIds: vts.map((t) => t.id),
        }
      })
      const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0))
      const intra = cust.stateCode === companyState(cust.companyCode)
      const tax = calculateTax(subtotal, settings.defaultTaxRate, intra)
      const company = settings.companies.find((c) => c.code === cust.companyCode)!
      const fy = fyLabel(invDate)
      const seqKey = `${company.code}:${fy}`
      const seq = (invSeq.get(seqKey) ?? 0) + 1
      invSeq.set(seqKey, seq)
      const isLatest = m.getTime() === months[months.length - 1].getTime()
      const inv: Invoice = {
        ...base("inv", at(invDate)),
        invoiceNo: `${company.invoicePrefix}/${fy}/${String(seq).padStart(3, "0")}`,
        companyCode: cust.companyCode,
        customerId: cust.id,
        date: invDate,
        dueDate: toISODate(addDays(parseISO(invDate), cust.creditDays)),
        periodFrom: from,
        periodTo: to,
        lines,
        subtotal,
        taxType: tax.taxType,
        taxRate: settings.defaultTaxRate,
        cgst: tax.cgst,
        sgst: tax.sgst,
        igst: tax.igst,
        total: tax.total,
        status: isLatest && cust.code === "RINDER" ? "DRAFT" : "ISSUED",
        notes: `Transport services for ${format(m, "MMMM yyyy")}`,
      }
      invoices.push(inv)
      ts.forEach((t) => (t.invoiceId = inv.id))
    }
  }

  /* Payments */
  const payments: Payment[] = []
  const paySeq = new Map<string, number>()
  const payNo = (company: CompanyCode, dir: "IN" | "OUT", iso: string) => {
    const prefix = settings.companies.find((c) => c.code === company)!.invoicePrefix
    const kind = dir === "IN" ? "RCT" : "PAY"
    const key = `${company}:${kind}:${fyLabel(iso)}`
    const n = (paySeq.get(key) ?? 0) + 1
    paySeq.set(key, n)
    return `${prefix}-${kind}-${fyLabel(iso).replace("-", "")}-${String(n).padStart(4, "0")}`
  }
  type PayInput = Omit<Payment, "id" | "createdAt" | "updatedAt" | "paymentNo" | "tdsAmount" | "allocations" | "notes" | "customerId" | "vendorId" | "vehicleId" | "reference" | "mode"> &
    Partial<Pick<Payment, "tdsAmount" | "allocations" | "notes" | "customerId" | "vendorId" | "vehicleId" | "reference" | "mode">>
  const pending: PayInput[] = []
  const addPay = (p: PayInput) => {
    if (p.date < startISO || p.date > todayISO) return
    pending.push(p)
  }

  // Receipts against invoices
  for (const inv of invoices) {
    if (inv.status !== "ISSUED") continue
    const cust = customers.find((c) => c.id === inv.customerId)!
    const spec = specById.get(cust.id)!
    const delay = Math.round(gauss(spec.payDelay[0], spec.payDelay[1]))
    const payDate = toISODate(addDays(parseISO(inv.dueDate), delay))
    if (payDate > todayISO) continue
    const tds = round2((inv.subtotal * settings.tdsRate) / 100)
    const partial = (spec.key === "TSNMS" || spec.key === "DHOOT") && chance(0.35)
    const settle = partial ? round2(inv.total * r(0.4, 0.7)) : inv.total
    const tdsPart = partial ? round2(tds * (settle / inv.total)) : tds
    addPay({
      companyCode: inv.companyCode, direction: "IN", date: payDate < inv.date ? inv.date : payDate,
      partyType: "CUSTOMER", customerId: cust.id, partyName: cust.name, categoryCode: null,
      amount: round2(settle - tdsPart), tdsAmount: tdsPart, mode: pick(["NEFT", "NEFT", "NEFT", "CHEQUE"]),
      reference: `UTR${ri(100000000, 999999999)}`, allocations: [{ invoiceId: inv.id, amount: settle }],
      notes: partial ? "Part payment" : "",
    })
  }

  // Monthly outgoings
  for (let m = start; m <= today; m = addMonths(m, 1)) {
    const mEnd = toISODate(endOfMonth(m))
    const mStart = toISODate(m)
    const label = format(m, "MMM yyyy")
    for (const company of ["VT", "VTHPL"] as CompanyCode[]) {
      // driver salaries — per driver, paid on month end
      for (const d of drivers.filter((x) => x.companyCode === company)) {
        const shifts = trips.filter((t) => t.driverId === d.id && t.date >= mStart && t.date <= mEnd && t.status === "COMPLETED").length
        const veh = vehicles.find((v) => v.defaultDriverId === d.id)
        const perShift = company === "VT" ? 820 : 890
        const amount = Math.max(9000, Math.round((shifts * perShift + 1500) / 10) * 10)
        addPay({ companyCode: company, direction: "OUT", date: mEnd, partyType: "EMPLOYEE", partyName: d.name, categoryCode: "DRIVER_SALARY", amount, vehicleId: veh?.id ?? null, notes: `Salary ${label} — ${shifts} shifts`, mode: "NEFT" })
      }
      addPay({ companyCode: company, direction: "OUT", date: mEnd, partyType: "EMPLOYEE", partyName: "Office & supervisory staff", categoryCode: "STAFF_SALARY", amount: company === "VT" ? ri(58, 66) * 1000 : ri(220, 240) * 1000, notes: `Payroll ${label}`, mode: "NEFT" })
      addPay({ companyCode: company, direction: "OUT", date: toISODate(addDays(m, 2)), partyType: "VENDOR", partyName: company === "VT" ? "Sri Lakshmi Estates (office)" : "Upparapalli yard — lease", categoryCode: "RENT", amount: company === "VT" ? 25000 : 65000, notes: `Rent ${label}`, mode: "NEFT" })
      addPay({ companyCode: company, direction: "OUT", date: toISODate(addDays(m, 14)), partyType: "OTHER", partyName: "Office & admin expenses", categoryCode: "OFFICE", amount: company === "VT" ? ri(15, 24) * 1000 : ri(22, 34) * 1000, notes: `Stationery, phones, internet — ${label}`, mode: "UPI" })
      addPay({ companyCode: company, direction: "OUT", date: toISODate(addDays(m, 9)), partyType: "VENDOR", partyName: "ICICI FASTag", categoryCode: "TOLL", amount: company === "VT" ? ri(12, 18) * 1000 : ri(30, 46) * 1000, notes: "FASTag recharge", mode: "UPI" })

      // diesel credit settlement for previous month, on the 12th
      const prev = subMonths(m, 1)
      if (prev >= start) {
        const pFrom = toISODate(prev)
        const pTo = toISODate(endOfMonth(prev))
        for (const vendor of DEFAULT_FUEL_STATIONS) {
          const due = diesel
            .filter((e) => e.companyCode === company && e.vendorId === vendor.id && e.paymentMode === "CREDIT" && e.date >= pFrom && e.date <= pTo)
            .reduce((s, e) => s + e.amount, 0)
          if (due > 0) addPay({ companyCode: company, direction: "OUT", date: toISODate(addDays(m, 11)), partyType: "VENDOR", vendorId: vendor.id, partyName: vendor.name, categoryCode: "DIESEL_SETTLEMENT", amount: round2(due), notes: `Diesel credit — ${format(prev, "MMM yyyy")}`, mode: "NEFT" })
        }
        // GST remittance on 20th for invoices dated in previous month
        const gst = invoices
          .filter((i) => i.companyCode === company && i.status === "ISSUED" && i.date >= pFrom && i.date <= pTo)
          .reduce((s, i) => s + i.cgst + i.sgst + i.igst, 0)
        if (gst > 0) addPay({ companyCode: company, direction: "OUT", date: toISODate(addDays(m, 19)), partyType: "OTHER", partyName: "GST — Govt of India", categoryCode: "GST_PAYMENT", amount: round2(gst * 0.92), notes: `GSTR-3B ${format(prev, "MMM yyyy")} (net of ITC)`, mode: "NEFT" })
      }
    }

    for (const v of vehicles) {
      if (v.emiAmount) addPay({ companyCode: v.companyCode, direction: "OUT", date: toISODate(addDays(m, 4)), partyType: "VENDOR", partyName: pick(FINANCIERS), vehicleId: v.id, categoryCode: "EMI", amount: v.emiAmount, notes: `EMI ${label} — ${v.regNo}`, mode: "NEFT" })
      if (v.ownership === "ATTACHED") addPay({ companyCode: v.companyCode, direction: "OUT", date: mEnd, partyType: "VENDOR", partyName: v.ownerName!, vehicleId: v.id, categoryCode: "ATTACH_VEHICLE", amount: ri(62, 70) * 1000, notes: `Attached vehicle hire ${label} (net of diesel & 1% TDS)`, mode: "NEFT" })
      if (v.status === "INACTIVE") continue
      // maintenance roughly every 5–7 weeks
      if (chance(0.7)) {
        const d = toISODate(addDays(m, ri(0, 27)))
        addPay({ companyCode: v.companyCode, direction: "OUT", date: d, partyType: "VENDOR", partyName: pick(WORKSHOPS), vehicleId: v.id, categoryCode: "MAINTENANCE", amount: Math.round(r(2.2, v.typeCode.startsWith("BUS") ? 19 : 9) * 1000 / 10) * 10, notes: pick(MAINT_WORK), mode: pick(["NEFT", "UPI", "CASH"]) })
      }
      if (chance(0.08)) {
        const d = toISODate(addDays(m, ri(0, 27)))
        const count = v.typeCode.startsWith("BUS") || v.typeCode.startsWith("TRUCK") ? 2 : 4
        addPay({ companyCode: v.companyCode, direction: "OUT", date: d, partyType: "VENDOR", partyName: pick(["Apollo Tyres — Hosur", "MRF Tyre Point", "JK Tyre Care"]), vehicleId: v.id, categoryCode: "TYRE", amount: count * (v.typeCode.startsWith("BUS") || v.typeCode.startsWith("TRUCK") ? ri(19, 24) : ri(5, 8)) * 1000, notes: `${count} tyres replaced`, mode: "NEFT" })
      }
      // quarterly road tax (buses) at quarter start
      if (v.roadTax.period === "QUARTERLY" && [3, 6, 9, 0].includes(m.getMonth())) {
        addPay({ companyCode: v.companyCode, direction: "OUT", date: toISODate(addDays(m, ri(0, 6))), partyType: "OTHER", partyName: v.regNo.startsWith("KA") ? "RTO Ramanagara" : "RTO Hosur", vehicleId: v.id, categoryCode: "ROAD_TAX", amount: v.roadTax.amount, notes: `Road tax Q — ${v.regNo}`, mode: "NEFT" })
      }
    }
  }
  // insurance renewals within the window (policy valid till − 1 year)
  for (const v of vehicles) {
    const renewed = toISODate(addDays(parseISO(v.insurance.validTill), -365))
    addPay({ companyCode: v.companyCode, direction: "OUT", date: renewed, partyType: "VENDOR", partyName: v.insurance.provider, vehicleId: v.id, categoryCode: "INSURANCE", amount: v.insurance.premium, notes: `Policy ${v.insurance.policyNo}`, mode: "NEFT" })
    if (v.roadTax.period === "ANNUAL") {
      const paid = toISODate(addDays(parseISO(v.roadTax.validTill), -365))
      addPay({ companyCode: v.companyCode, direction: "OUT", date: paid, partyType: "OTHER", partyName: "RTO Hosur", vehicleId: v.id, categoryCode: "ROAD_TAX", amount: v.roadTax.amount, notes: `Annual road tax — ${v.regNo}`, mode: "NEFT" })
    }
  }

  pending.sort((a, b) => a.date.localeCompare(b.date))
  for (const p of pending) {
    payments.push({
      ...base("pay", at(p.date)),
      paymentNo: payNo(p.companyCode, p.direction, p.date),
      tdsAmount: 0,
      allocations: [],
      notes: "",
      customerId: null,
      vendorId: null,
      vehicleId: null,
      reference: "",
      mode: "NEFT",
      ...p,
    })
  }

  return { settings, customers, vehicles, drivers, trips, diesel_entries: diesel, adblue_entries: [], vehicle_assignments: [], month_locks: [], fuel_stations: structuredClone(DEFAULT_FUEL_STATIONS), adblue_purchases: [], tanker_loads: [], tanker_dispenses: [], tankers: [], tanker_transfers: [], tanker_adjustments: [], industrial_supplies: [], invoices, payments }
}
