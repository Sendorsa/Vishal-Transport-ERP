/**
 * Domain types for the prototype.
 *
 * The shapes the API returns today (browser storage). The planned Supabase tables for the Diesel module are in
 * docs/SUPABASE_DIESEL_DATABASE_SCHEMA.md; the repository adapter maps these shapes to them.
 */

export type CompanyCode = "VT" | "VTHPL"
export type CompanyScope = CompanyCode | "GROUP"

/** DEV = every module like the Owner, without the Owner-only actions (see lib/permissions.ts). */
export type Role = "OWNER" | "DEV" | "EMPLOYEE"
/**
 * Roles removed on 31 Oct 2026 (owner's instruction: only Owner, Dev and Employee). Kept only so audit events
 * recorded under them read as they were, and because the Supabase `erp_role` enum still lists them (its migration
 * needs the owner's approval). A browser still holding one acts as an Employee (src/lib/app-state.ts).
 */
export type LegacyRole = "ACCOUNTANT" | "OPS_MANAGER"

export interface BaseEntity {
  id: string
  createdAt: string
  updatedAt: string
}

/* ----------------------------------------------------------------------------- Customers */

export type BusinessUnit =
  | "STAFF_BUS"
  | "SCHOOL_BUS"
  | "TAXI"
  | "GOODS"
  | "MANPOWER"
  | "PROPERTY"
  | "FUEL_RETAIL"
  /** Not a paying customer: the company's own / the owner's personal use (cost bearer only). */
  | "INTERNAL"

export type PricingModel =
  | "FIXED_DAILY_KM_CAP" // day rate + extra km above the daily cap
  | "PER_KM_DAILY_MIN" // minimum km × rate, extra km at extra rate
  | "ROUTE_DAY_RATE" // fixed ₹ per working day, optional extra km
  | "PER_TRIP" // rate per route / trip (goods)
  | "TAXI_PACKAGE" // package (km) + extra km + driver bata

export interface RouteRate {
  route: string
  distanceKm: number
  rate: number
}

export interface PricingTerms {
  model: PricingModel
  /** Day rate, per-km rate, package rate or default trip rate depending on model. */
  rate: number
  /** Daily km cap / daily minimum km / package km. */
  includedKm: number
  extraKmRate: number
  driverBata: number
  routes: RouteRate[]
}

/**
 * Master records are never deleted. ARCHIVED = retired via "Archive": kept in every report,
 * blocked from new entries and hidden from pickers; "Restore" sets ACTIVE again.
 */
export type EntityStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED"

/** One dated period of a status (yyyy-MM-dd, inclusive; endDate null = current). See src/domain/status-history.ts. */
export interface StatusPeriod<S extends string = EntityStatus> {
  status: S
  startDate: string
  endDate: string | null
}

export type CustomerStatus = EntityStatus

export interface Customer extends BaseEntity {
  code: string
  /** Short label used on cards and charts, e.g. "Seating", "Jamna". */
  shortName: string
  /** Small logo image (data URL, ≤128px) uploaded in the prototype; null → monogram. */
  logoDataUrl?: string | null
  name: string
  legalName: string
  companyCode: CompanyCode
  businessUnit: BusinessUnit
  gstin: string
  state: string
  stateCode: string
  city: string
  contactName: string
  phone: string
  email: string
  creditDays: number
  pricing: PricingTerms
  /** Current status (cache of the open history period) — month views use statusHistory. */
  status: CustomerStatus
  statusHistory?: StatusPeriod<CustomerStatus>[]
  notes?: string
}

/* ----------------------------------------------------------------------------- Vehicles */

export type VehicleStatus = EntityStatus | "MAINTENANCE"
export type Ownership = "OWNED" | "ATTACHED"
/** Lives on the vehicle; fuel entries never store it. EV fills record kWh in `litres`. */
export type FuelType = "DIESEL" | "PETROL" | "EV"

export interface Vehicle extends BaseEntity {
  regNo: string
  companyCode: CompanyCode
  typeCode: string
  make: string
  model: string
  year: number
  seats: number | null
  fuelType: FuelType
  mileageKmpl: number
  ownership: Ownership
  ownerName: string | null
  /** Current status (cache of the open history period) — month views use statusHistory. */
  status: VehicleStatus
  statusHistory?: StatusPeriod<VehicleStatus>[]
  odometerKm: number
  assignedCustomerId: string | null
  defaultDriverId: string | null
  insurance: { provider: string; policyNo: string; validTill: string; premium: number }
  roadTax: { validTill: string; amount: number; period: "QUARTERLY" | "ANNUAL" }
  fitnessValidTill: string
  permitValidTill: string
  emiAmount: number
  notes?: string
  /**
   * Go-live opening (Owner / Dev): the odometer at the vehicle's last diesel fill before records begin, and that fill's
   * date. The first fill on or after it measures its KM Run from this reading (src/domain/diesel.ts buildDieselIndex).
   */
  openingOdometerKm?: number | null
  openingOdometerDate?: string | null
}

export interface Driver extends BaseEntity {
  name: string
  phone: string
  licenseNo: string
  licenseValidTill: string
  companyCode: CompanyCode
  status: EntityStatus
}

/* ----------------------------------------------------------------------------- Trips */

export type TripStatus = "PLANNED" | "COMPLETED" | "CANCELLED"

export interface Trip extends BaseEntity {
  tripNo: string
  companyCode: CompanyCode
  date: string // yyyy-MM-dd
  customerId: string
  vehicleId: string
  driverId: string | null
  route: string
  startKm: number
  endKm: number
  distanceKm: number
  pricingModel: PricingModel
  baseAmount: number
  extraKmAmount: number
  bataAmount: number
  tollParking: number
  revenue: number
  status: TripStatus
  invoiceId: string | null
  notes: string
}

/* ----------------------------------------------------------------------------- Diesel */

export interface DieselEntry extends BaseEntity {
  companyCode: CompanyCode
  date: string
  vehicleId: string
  /** Customer the fuel is costed to ("using in which company"). Null = pool / unallocated. */
  customerId: string | null
  vendorId: string
  litres: number
  rate: number
  amount: number
  /** Odometer at this fill. Null = not recorded in the source (imported history); KM Run skips that gap. */
  odometerKm: number | null
  billNo: string
  paymentMode: "CREDIT" | "CASH"
  /** Optional, used by tanker dispensing. */
  notes?: string
  /**
   * Fills from the Diesel Tanker source (vendorId `dv_tanker`): which tanker it came out of. Required for
   * new tanker fills; older records are stamped with the migrated default tanker (src/domain/tanker.ts).
   */
  tankerId?: string
  /**
   * Read-only view flag set by the API (never stored): a tanker fill saved without a rate, whose `rate` /
   * `amount` shown are the tanker's weighted-average cost. Restoring such a fill stores it rate-less again.
   */
  averageCost?: boolean
}

/* ----------------------------------------------------------------------------- Invoices */

export type InvoiceDocStatus = "DRAFT" | "ISSUED" | "CANCELLED"
/** Derived from settlements — never stored. */
export type InvoicePaymentStatus = "DRAFT" | "UNPAID" | "PARTIAL" | "PAID" | "OVERDUE" | "CANCELLED"
export type TaxType = "CGST_SGST" | "IGST"

export interface InvoiceLine {
  id: string
  description: string
  sac: string
  quantity: number
  unit: string
  rate: number
  amount: number
  vehicleId: string | null
  tripIds: string[]
}

export interface Invoice extends BaseEntity {
  invoiceNo: string
  companyCode: CompanyCode
  customerId: string
  date: string
  dueDate: string
  periodFrom: string
  periodTo: string
  lines: InvoiceLine[]
  subtotal: number
  taxType: TaxType
  taxRate: number
  cgst: number
  sgst: number
  igst: number
  total: number
  status: InvoiceDocStatus
  notes: string
  /**
   * Go-live opening (Owner / Dev): an invoice still unpaid when records begin — its original number, dates and the
   * amount outstanding, no lines and no tax. Receipts settle it like any invoice; it is never revenue of the period.
   */
  opening?: boolean
}

/* ----------------------------------------------------------------------------- Payments */

export type PaymentDirection = "IN" | "OUT"
/** TDS = a tax deduction recorded against a fuel station bill (tdsAmount): settles the bill, no money moves. */
export type PaymentMode = "NEFT" | "UPI" | "CHEQUE" | "CASH" | "TDS"
export type PartyType = "CUSTOMER" | "VENDOR" | "EMPLOYEE" | "OTHER"

export interface Allocation {
  invoiceId: string
  amount: number
}

export interface Payment extends BaseEntity {
  paymentNo: string
  companyCode: CompanyCode
  direction: PaymentDirection
  date: string
  partyType: PartyType
  customerId: string | null
  vendorId: string | null
  vehicleId: string | null
  partyName: string
  categoryCode: string | null
  amount: number
  /**
   * TDS — never money paid or received. Receipts (IN): deducted by the customer; settles the invoice. Fuel station
   * payments (OUT, mode TDS, amount 0): deducted on the station's fuel bills; settles that much of what we owe it.
   */
  tdsAmount: number
  mode: PaymentMode
  reference: string
  allocations: Allocation[]
  notes: string
  /**
   * Fuel station payments: "yyyy-MM" — the month's purchases it was paid against ("Paid against"). Informational:
   * the ledger always uses `date`, the day the money was paid. Absent on payments recorded before 31 Oct 2026.
   */
  forMonth?: string
}

/* ----------------------------------------------------------------------------- Settings */

export interface CompanyProfile {
  code: CompanyCode
  name: string
  legalName: string
  gstin: string
  pan: string
  address: string
  city: string
  state: string
  stateCode: string
  phone: string
  email: string
  bankName: string
  bankAccount: string
  ifsc: string
  invoicePrefix: string
  isPrimary: boolean
  parentCode: CompanyCode | null
}

export type ExpenseKind = "EXPENSE" | "SETTLEMENT"

export interface ExpenseCategory {
  code: string
  name: string
  /** SETTLEMENT categories pay off an accrued liability (e.g. diesel credit) and are not P&L expense. */
  kind: ExpenseKind
  vehicleLinked: boolean
  active: boolean
}

/**
 * Fuel station (petrol pump) — a master entity like customers and vehicles, collection
 * `vt:fuelStations`. The only pump list: Diesel / AdBlue entries, Fuel Stations, reports and
 * vendor payables all read it. Never deleted — archived (src/domain/status-history.ts rules).
 */
export interface FuelStation extends BaseEntity {
  name: string
  location: string
  /** VT's own outlet (Vishal Gasoline) supplying group vehicles. */
  isInterCompany: boolean
  creditDays: number
  status: EntityStatus
  /** The company's own Diesel Tanker as a fuel source (id `dv_tanker`) — not a pump we owe; see src/domain/tanker.ts. */
  isTanker?: boolean
  /** Balance owed to the station before its first ledger month (+ = we owe, − = credit), as at `openingBalanceDate`. */
  openingBalance?: number
  /** yyyy-MM-dd: the day the opening balance applies from (the ledger starts in that month). */
  openingBalanceDate?: string
}

/** Older name for a fuel station, kept so existing code reads naturally ("diesel vendor"). */
export type DieselVendor = FuelStation

export interface VehicleType {
  code: string
  name: string
  category: "BUS" | "VAN" | "CAR" | "TRUCK" | "PICKUP"
  defaultSeats: number | null
  defaultMileage: number
}

/**
 * Legacy single-tanker settings (`settings.tanker`), from the removed setup dialog. Only read once, to
 * seed the migrated default tanker's vehicle and capacity — tankers now live in `vt:tankers`.
 */
export interface TankerConfig {
  vehicleId: string | null
  capacityLitres: number
}

export interface Settings {
  tanker?: TankerConfig
  companies: CompanyProfile[]
  expenseCategories: ExpenseCategory[]
  vehicleTypes: VehicleType[]
  defaultTaxRate: number
  tdsRate: number
  sacCode: string
}

/* ----------------------------------------------------------------------------- AdBlue */

/**
 * A vehicle's AdBlue (DEF) entry — tracked separately from fuel, never mixed into diesel figures. A STOCK entry draws
 * from inventory (src/domain/adblue-inventory.ts); a DIRECT one is bought from a vendor for this vehicle.
 */
export interface AdBlueEntry extends BaseEntity {
  /**
   * STOCK (default, also when absent) = drawn from bulk inventory, costed at the weighted-average rate.
   * DIRECT = bought from a vendor straight into this vehicle: its own litres × rate, never touches bulk stock.
   */
  source?: "STOCK" | "DIRECT"
  /** DIRECT only: who sold it, the rate per litre and how it was paid (informational — no AdBlue payables ledger). */
  vendorName?: string
  rate?: number
  paymentMode?: PaymentMode
  vehicleId: string
  /** Customer the vehicle was serving (for customer-wise summaries). */
  customerId: string | null
  /** Legacy (entries before inventory): the station it was bought at. "" for inventory draws. */
  vendorId: string
  date: string
  /** Odometer at this top-up. Previous reading and KM Run are derived (`withRuns` in src/domain/adblue.ts). */
  closingKm: number
  quantityLitres: number
  /** STOCK: cost at the inventory's weighted-average rate, derived on every read. DIRECT: litres × rate, stored. */
  amount: number
  invoiceNo: string
  notes: string
}

/**
 * A company diesel tanker (`vt:tankers`) — a master record like a vehicle: never deleted, archived instead.
 * Each tanker keeps its own stock; every load, dispense, transfer and adjustment names one (src/domain/tanker.ts).
 */
export interface Tanker extends BaseEntity {
  name: string
  /** Registration of the tanker vehicle, unique among tankers. "" for a stock that isn't one vehicle (e.g. the combined pre-split stock). */
  regNo: string
  /** The tanker vehicle in the vehicle master, if any — its own running fuel is a pump fill, never its cargo. */
  vehicleId: string | null
  capacityLitres: number | null
  status: EntityStatus
  notes: string
}

/** Diesel moved from one tanker to another — not a purchase: litres (and their average cost) change tanker only. */
export interface TankerTransfer extends BaseEntity {
  date: string
  fromTankerId: string
  toTankerId: string
  litres: number
  notes: string
}

/** A correction of a tanker's stock (dip reading, leak, spillage): + adds litres, − removes them. Reason is mandatory. */
export interface TankerAdjustment extends BaseEntity {
  date: string
  tankerId: string
  litres: number
  reason: string
}

/** Diesel loaded into the tanker's cargo (bought from a fuel station / supplier). Amount = litres × rate. */
export interface TankerLoad extends BaseEntity {
  /** The tanker it was loaded into. */
  tankerId?: string
  date: string
  /** Supplier — a fuel station (owed to it like any credit purchase). "" for opening stock. */
  stationId: string
  /** Stock already in the tanker when records began (no supplier, owed to nobody); litres × rate is its value. */
  opening?: boolean
  invoiceNo: string
  litres: number
  rate: number
  amount: number
  notes: string
}

/** Diesel dispensed from the tanker to a vehicle NOT in the ERP (registered vehicles get a normal diesel entry). */
export interface TankerDispense extends BaseEntity {
  /** The tanker it came out of. */
  tankerId?: string
  date: string
  vehicleNo: string
  litres: number
  /** Description / notes, e.g. "Personal car". */
  notes: string
}

/** Bulk AdBlue purchase into inventory (buckets). Totals are always Buckets × per-bucket values. */
export interface AdBluePurchase extends BaseEntity {
  date: string
  vendorName: string
  /** Product / grade / quality. */
  product: string
  buckets: number
  litresPerBucket: number
  totalLitres: number
  pricePerBucket: number
  totalCost: number
  invoiceNo: string
  notes: string
  /** Legacy opening stock (recording it was removed on 31 Oct 2026): records saved earlier count as stock, never as a purchase. */
  opening?: boolean
}

/**
 * Which customer a vehicle works for, and when. The vehicle is the permanent asset; this is
 * the temporary assignment. Periods are never rewritten — a transfer ends one and starts the
 * next. Entries are reported under the customer assigned on their date (src/domain/assignments.ts).
 */
export interface VehicleAssignment extends BaseEntity {
  vehicleId: string
  /** null = spare / unassigned for this period. */
  customerId: string | null
  startDate: string
  /** Inclusive; null = current assignment. */
  endDate: string | null
  status: "ACTIVE" | "ENDED"
}

/** Owner's override of a month's automatic lock (src/domain/month-lock.ts). One record per month. */
export interface MonthLock extends BaseEntity {
  month: string // yyyy-MM
  state: "OPEN" | "LOCKED"
  changedBy: Role
}

/* ----------------------------------------------------------------------------- Audit trail */

/** What happened to a record. See CLAUDE.md → "Audit Trail and Edit History Rules". */
export type AuditAction =
  | "CREATED"
  | "UPDATED"
  | "DELETED"
  | "ARCHIVED"
  | "RESTORED"
  | "TRANSFERRED"
  | "PAYMENT_RECORDED"
  | "MONTH_LOCKED"
  | "MONTH_UNLOCKED"
  | "DATA_RESET"

/**
 * Who did it. The prototype has no login: `role` comes from the mock session and `userId` / `name`
 * stay null (never invented). Real auth fills them. SYSTEM = done by the app itself (e.g. re-seeding).
 */
export interface AuditActor {
  kind: "SESSION" | "SYSTEM"
  userId: string | null
  name: string | null
  /** The role at the time of the event — a removed role (LegacyRole) on events recorded before 31 Oct 2026. */
  role: Role | LegacyRole | null
}

export interface AuditChange {
  field: string
  before: unknown
  after: unknown
}

/** One append-only audit event (vt:auditEvents). Never edited or deleted by the app. */
export interface AuditEvent {
  id: string
  /** When it happened (ISO, UTC). Displayed in IST. */
  at: string
  actor: AuditActor
  action: AuditAction
  module: string
  recordType: string
  recordId: string
  /** Human description of the record at the time, e.g. "TN70AK2525 · 05-10-2026 · 100 L". */
  label: string
  /** The transaction's own date (yyyy-MM-dd), for dated records. */
  recordDate: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  changes: AuditChange[]
  reason: string | null
  /** RESTORED from a deletion: the DELETED event this restore reverses. Absent on every other event. */
  restoresEventId?: string | null
  /** What else the change did, e.g. "Adds ₹9,006.88 back to Raghuveer's purchases". */
  note?: string | null
}

/**
 * The Owner has reviewed one deletion event (vt:auditReviews). Append-only and separate from the
 * event itself: reviewing never changes or hides the event.
 */
export interface AuditReview {
  eventId: string
  at: string
  actor: AuditActor
}

export interface CollectionMap {
  customers: Customer
  vehicles: Vehicle
  drivers: Driver
  trips: Trip
  diesel_entries: DieselEntry
  adblue_entries: AdBlueEntry
  vehicle_assignments: VehicleAssignment
  fuel_stations: FuelStation
  adblue_purchases: AdBluePurchase
  tanker_loads: TankerLoad
  tanker_dispenses: TankerDispense
  tankers: Tanker
  tanker_transfers: TankerTransfer
  tanker_adjustments: TankerAdjustment
  month_locks: MonthLock
  invoices: Invoice
  payments: Payment
}

export type CollectionKey = keyof CollectionMap

/** Input type for create — server (or repository) assigns id + timestamps. */
export type NewEntity<T extends BaseEntity> = Omit<T, keyof BaseEntity>
