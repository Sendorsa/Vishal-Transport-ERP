# Supabase Database Architecture: Vishal Transport ERP

> **Superseded for the Diesel phase (31 Oct 2026)** by `SUPABASE_DIESEL_DATABASE_SCHEMA.md` (authoritative schema, SQL in `supabase/migrations/20261101*` — design approved 1 Nov 2026, not applied to any Supabase project) and `SUPABASE_DIESEL_MIGRATION_PLAN.md` (no data import). Kept for the full-ERP context and the D-numbered decisions it introduced; where the two differ, the Diesel documents win.

**Status:** design only (31 Oct 2026). No SQL has been run, and no table exists in the live Supabase project (Mumbai, `ap-south-1`). The ERP still reads and writes only browser localStorage.

**Companion documents:**
- `SUPABASE_ER_DIAGRAM.md`: the entity-relationship diagram.
- `SUPABASE_MIGRATION_PLAN.md`: how the localStorage data gets copied across.
- `../../SUPABASE_SETUP.md`: Phase 1 setup and the planned Google sign-in.

**How it was made:** derived from the code as it is today:
- `src/lib/types.ts`;
- `src/lib/storage/local-store.ts`;
- `src/lib/api/index.ts`;
- `src/lib/permissions.ts`;
- `src/domain/*`;
- `supabase/migrations/20261028000000_erp_accounts.sql`.

It isn't derived from `SCALABLE_DATABASE_ARCHITECTURE.md`. That document is a long-term, double-entry ERP model the prototype never implemented.

**Principle:** the database stores the **same facts** the browser stores today. Every ledger, stock figure, carry-forward and report stays **calculated from those facts** by the same `src/domain` code. No accounting rule changes.

---

## 1. What the codebase holds today (inventory)

### 1.1 localStorage keys

| Key | Type (`lib/types.ts`) | Kind | Id prefix | Notes |
|---|---|---|---|---|
| `vt:customers` | `Customer` | Master | `cus_` | Never deleted (archive). `statusHistory[]` embedded. `pricing` embedded (incl. `routes[]`). `logoDataUrl` = image data URL |
| `vt:vehicles` | `Vehicle` | Master | `veh_` | Never deleted. `statusHistory[]` embedded. `assignedCustomerId` = cache of the open assignment. `insurance` / `roadTax` embedded objects |
| `vt:drivers` | `Driver` | Master | `drv_` | Never deleted. No status history |
| `vt:vehicleAssignments` | `VehicleAssignment` | Master history | *(assignment ids)* | Append-only periods per vehicle |
| `vt:fuelStations` | `FuelStation` (= `DieselVendor`) | Master | `dv_` | Never deleted. `dv_tanker` is a **pseudo-station** (`isTanker`) = the internal tanker source. `openingBalance` / `openingBalanceDate` = pump opening Debit / Credit |
| `vt:tankers` | `Tanker` | Master | `tnk_` | Never deleted. JIO `tnk_tn70ax9480`, Office `tnk_ka53c0538`, Mini `tnk_ka51af1429`. Stock pools (no reg no): `tnk_default`, `tnk_combined_fy2627` |
| `vt:fuelEntries` | `DieselEntry` | Transaction | `dsl_` | Pump fills **and** tanker fills (`vendorId = "dv_tanker"` + `tankerId`) |
| `vt:adBlueEntries` | `AdBlueEntry` | Transaction | *(entry ids)* | `source` STOCK (draw, amount derived) / DIRECT (vendor, rate, amount stored) |
| `vt:adBluePurchases` | `AdBluePurchase` | Transaction | *(purchase ids)* | Bulk purchases. `opening: true` = legacy opening stock (creation removed 31 Oct 2026; existing records kept) |
| `vt:tankerLoads` | `TankerLoad` | Transaction | `tkl_` | A purchase from a station. `opening: true` + `stationId ""` = tanker opening stock (not a purchase) |
| `vt:tankerDispenses` | `TankerDispense` | Transaction (history) | `tkd_` | External vehicles. No new ones since 31 Oct 2026 |
| `vt:tankerTransfers` | `TankerTransfer` | Transaction | `tkt_` | Tanker → tanker |
| `vt:tankerAdjustments` | `TankerAdjustment` | Transaction | `tka_` | ± litres with a mandatory reason |
| `vt:trips` | `Trip` | Transaction | `trp_` | `tripNo` per company / FY. `invoiceId` = the billing lock |
| `vt:invoices` | `Invoice` | Document | `inv_` | `lines[]` embedded (each with `tripIds[]`). Never deleted (cancel) |
| `vt:payments` | `Payment` | Transaction | `pay_` | Receipts (IN), vouchers (OUT), **fuel station payments** (OUT + `vendorId` + category `DIESEL_SETTLEMENT`), **TDS** (mode TDS, amount 0, `tdsAmount`). `allocations[]` embedded |
| `vt:monthLocks` | `MonthLock` | System | `mlk_` | Owner override per month. Records the role, not a user |
| `vt:settings` | `Settings` | Configuration | — | `companies[]` (`CompanyProfile`), `expenseCategories[]`, `defaultTaxRate`, `tdsRate`, `sacCode`, legacy `tanker` |
| `vt:vehicleTypes` | `VehicleType[]` | Configuration | — | Split out of settings |
| `vt:auditEvents` | `AuditEvent` | Audit | `evt` ids | Append-only. Not part of the JSON backup |
| `vt:auditReviews` | `AuditReview` | Audit | — | Append-only. The Owner's deletion reviews |
| `vt:meta` | `StorageMeta` | System | — | Schema version 4, source DEMO / EMPTY / RESTORED. **Not migrated** |
| `vt:ui:role`, `vt:ui:company`, `vt:ui:dieselMonth` | — | Session | — | Mock session. **Not migrated:** replaced by real login |

**Not present in the code:** reservations or bookings, maintenance jobs, a vendor master for non-fuel suppliers, AdBlue vendor payables, user accounts in localStorage, and bank balances (removed 31 Oct 2026).

**Storage format:** collections are column-encoded (`{ cols, rows }`). That is a storage detail only.

### 1.2 Data access

**The data path:**
- Components call `src/lib/api/hooks.ts` (TanStack Query), which calls `src/lib/api/index.ts` (`api.*`).
- `api.*` reads through `createLocalRepository(key, prefix)` and the `local-store.ts` read / write functions.
- No component touches storage directly. This is the seam to replace.

**Every write:**
- runs in `tx()`, which is serialised and all-or-nothing (`runInTransaction` restores every key on error);
- checks the permission first (`assertCan`);
- then checks the month lock (`assertMonthEditable`), archive status (`assertOpen`), assignment (`assignedCustomer`), stock (`assertStock`, `assertTankerStock`), dates (no future dates) and reasons (`assertReason`);
- then writes the record and its audit event together.

**Reads aren't permission-checked in the API**, except `api.audit.*`. The UI hides what a role can't see. See D-3 for what the database should allow.

### 1.3 Business rules the database must preserve

| Rule | Where today |
|---|---|
| **Station ledger.** Opening + Fuel Purchased − Payments Made = Closing; the closing carries forward. Opening balance + = Debit (we owe), − = Credit. **Purchased** = pump fills (credit and cash) + tanker loads (not opening loads). **Paid** = vouchers + manual cash + cash-at-pump (derived from CASH fills) + TDS | `domain/station-ledger.ts` (`stationLedger`, `isStationPayment`, `loadsAsStationPurchases`) |
| **Tanker load = the purchase; tanker fill = internal consumption.** A fill has `vendorId dv_tanker`, which every station ledger excludes, so the same litres are never bought twice | `domain/tanker.ts`, `domain/station-ledger.ts` |
| **Per-tanker stock.** Opening stock + Loaded + Transfers in ± Adjustments − Fills − Dispenses − Transfers out = Closing. Never below zero **at any point in time**. Events are ordered by date; loads and + adjustments, then transfers, then draws on the same day; then `createdAt`, then `id` | `valueTankers`, `tankerMoves`, `assertTankerStock` |
| **Tanker costing.** A fill costs litres × the rate on the fill (new fills must carry a rate). A legacy rate-0 fill and an external dispense are costed at the tanker's moving weighted average | `valueTankers`, `tankerValued` |
| **AdBlue stock.** Bulk purchases in; STOCK draws out at the moving weighted average; never below zero at any point. DIRECT purchases never touch stock. Opening records count as stock, never as a purchase | `domain/adblue-inventory.ts`, `assertStock` |
| **TDS on fuel.** 0.1% of the station's monthly purchases, dated the month's last day, one per station-month. Stored as a payment with amount 0 and `tdsAmount` | `tdsDue`, `tdsDate`, `recordTds` |
| **Payment date vs paid against.** The ledger uses `date`. `forMonth` is informational and can't be after the payment month. No future dates | `assertStationPaymentDate` |
| **Customer on the fill date.** Resolved from `vehicle_assignments`. New records only under the customer assigned that day | `domain/assignments.ts` |
| **Historical status.** `statusOn(entity, date)`. An archived vehicle or customer accepts no new records dated in an archived period | `domain/status-history.ts`, `assertOpen` |
| **Month lock.** The current IST month is open. Earlier months lock automatically. An Owner override per month. The Owner is always exempt | `domain/month-lock.ts`, `assertMonthEditable` |
| **Numbering.** Vouchers `{co}-{PAY\|RCT}-{FY}-0001`. Trips per company / FY. Invoices `{co}/{FY}/001` | `nextSeq` in `api/index.ts` |
| **Invoices.** Built from trips. Their trips are locked (`invoiceId`). Cancel releases them and is refused while receipts are allocated. Allocations ≤ outstanding, Σ ≤ amount + TDS | `invoices.*`, `createPayment` |
| **Audit.** Every write is audited in the same transaction. Deletes need a reason (≥ 3 characters). Append-only. Restore / Push Back is Owner only, once per deletion, with all its safety checks | `domain/audit.ts`, `api.audit.*` |

### 1.4 Duplicated, redundant or inconsistent structures

These are documented here; none of them is fixed silently.

| # | Finding | Design decision |
|---|---|---|
| I-1 | `dv_tanker` is stored as a fuel **station** row, although it's the internal tanker source | Keep it as a `fuel_stations` row with `is_tanker = true` for a 1:1 copy, and enforce the tanker-fill rule with checks (D-6) |
| I-2 | Empty strings mean "none": `TankerLoad.stationId ""` (opening), `AdBlueEntry.vendorId ""`, `Tanker.regNo ""` (pool) | Store `NULL` in the database. The migration maps `""` → `NULL` |
| I-3 | `tankerId` is optional on loads, dispenses and fills. Missing = `tnk_default` (`tankerOf`) | `NOT NULL` for loads and dispenses, and for tanker fills. The migration stamps `tnk_default` exactly as `tankerOf` reads it |
| I-4 | `Vehicle.assignedCustomerId` and `Customer.status` / `Vehicle.status` are caches of the history | Keep them as cache columns updated in the same transaction (as today), so pickers stay simple (D-15) |
| I-5 | `DieselEntry.customerId` / `AdBlueEntry.customerId` are stored stamps, but reports re-resolve them from assignments | Keep the stamp column. Reports keep resolving from `vehicle_assignments` |
| I-6 | `InvoiceLine.tripIds[]` and `Trip.invoiceId` both link trips to invoices | Both are needed: the line detail is kept after a cancel, while `trips.invoice_id` is the live billing lock. Two structures: `invoice_line_trips` and `trips.invoice_id` |
| I-7 | Station payments are general `payments` rows, identified by `direction OUT + vendorId + categoryCode DIESEL_SETTLEMENT` | Same in the database (`station_id` FK). The partial unique index for TDS uses that predicate |
| I-8 | `Payment.tdsAmount` means **customer** TDS on receipts (IN) and **fuel** TDS on station payments (OUT, mode TDS) | Keep one column, documented. A check stops it being negative |
| I-9 | AdBlue STOCK draws store `amount` 0; the real cost is derived on read. Legacy tanker fills store `rate` 0 | Stored as they are. Derived on read by the same domain code. Never "fixed" in the copy |
| I-10 | `AdBlueEntry.paymentMode` reuses `PaymentMode` (which includes TDS) | Same enum. A check refuses TDS on AdBlue |
| I-11 | No uniqueness on customer `code` or vehicle `regNo` (the API doesn't check either) | Unique indexes proposed, **after** the dry run shows no duplicates (D-5) |
| I-12 | `MonthLock.changedBy` and `AuditActor` hold a role only (no login exists) | New `changed_by` / `actor_user_id` columns referencing `profiles`. Migrated rows keep `NULL` user and their role |
| I-13 | Supabase `erp_role` still lists ACCOUNTANT / OPS_MANAGER | New enum with only OWNER / DEV / EMPLOYEE (D-2). Audit history keeps old role names as text |
| I-14 | `Settings.tanker` (legacy single tanker) is only read by a one-off migration | Not migrated |
| I-15 | `vendorName` on AdBlue purchases and direct entries is free text (no vendor master) | Kept as text. A vendor master would be a new feature |
| I-16 | Audit events from before the last DATA_RESET refer to reused demo ids | Migrated as history (if D-8 approves), flagged `before_last_reset`. Restore stays refused for them, as today |

---

## 2. Conventions

- **Schema `public`** for the tables, with RLS enabled on every one. Helper functions go in a non-exposed schema `private`.
- **Primary keys: `text`, keeping the existing ids** (`dsl_…`, `dv_tanker`, deterministic import ids). New ids get `prefix || '_' || encode(gen_random_bytes(8), 'hex')`. This makes the copy idempotent and keeps every link, audit `recordId` and import id valid (D-4).
- **Business dates** use `date`. **Months** use `char(7)` with check `~ '^\d{4}-(0[1-9]|1[0-2])$'`. **Instants** use `timestamptz` (`created_at`, `updated_at`, audit `at`). "Today" and "this month" are computed **in Asia/Kolkata on the server**: `(now() at time zone 'Asia/Kolkata')::date`. That replaces the device clock (closes the CLAUDE.md limitation).
- **Numbers.** `numeric`, never `float`. Every value is checked by the migration dry run; nothing is rounded silently (D-12).

  | Kind | Type |
  |---|---|
  | Money | `numeric(14,2)` (up to ₹999,999,999,999.99) |
  | Litres / kWh | `numeric(12,3)` |
  | Rates per litre / bucket | `numeric(12,4)` |
  | Odometer / km | `numeric(12,1)` |
  | Percentages | `numeric(5,2)` |
- **Every table** has `created_at timestamptz not null default now()` and `updated_at timestamptz not null default now()`, with a touch trigger (like `profiles`).
- **Foreign keys** are `on delete restrict` everywhere (history is never cascaded away). Master tables have **no DELETE** at all (archive).
- **Enums.** Postgres enums for closed sets that mirror TypeScript unions. Codes that are data (vehicle types, expense categories) are FK tables.

## 3. Tables

Notation: **PK** primary key, **FK** foreign key, **U** unique, **C** check, **IX** index.

### 3.1 Accounts and configuration

| Table | Columns | Constraints and indexes |
|---|---|---|
| `profiles` *(exists)* | `id uuid`, `user_id uuid → auth.users`, `email`, `full_name`, `role erp_role`, `status account_status`, `invited_by`, `activated_at`, timestamps | As in migration `20261028…`. Change: `erp_role` = OWNER / DEV / EMPLOYEE (D-2) |
| `role_permissions` | `role erp_role`, `permission text` | PK (role, permission). Seeded **exactly** from `MAP` in `lib/permissions.ts`: OWNER `*`; DEV every `resource:*`; EMPLOYEE `dashboard:view, vehicles:view, trips:view, trips:create, trips:edit, diesel:view, diesel:create, diesel:edit`. `check:supabase` should pin it equal to `MAP` |
| `companies` | `code text` PK (`VT`, `VTHPL`), `name`, `legal_name`, `gstin`, `pan`, `address`, `city`, `state`, `state_code`, `phone`, `email`, `bank_name`, `bank_account`, `ifsc`, `invoice_prefix`, `is_primary bool`, `parent_code` → companies | U `invoice_prefix`. No bank balance (owner, 31 Oct 2026) |
| `app_settings` | `id smallint` PK C (= 1), `default_tax_rate numeric(5,2)`, `tds_rate numeric(5,2)`, `sac_code text` | Singleton |
| `expense_categories` | `code text` PK, `name`, `kind` (`EXPENSE` / `SETTLEMENT`), `vehicle_linked bool`, `active bool` | `DIESEL_SETTLEMENT` must exist (station payments) |
| `vehicle_types` | `code text` PK, `name`, `category` (`BUS VAN CAR TRUCK PICKUP`), `default_seats int null`, `default_mileage numeric(6,2)` | |

### 3.2 Masters (never deleted)

| Table | Columns | Constraints and indexes |
|---|---|---|
| `customers` | `id` PK; `code`; `short_name`; `name`; `legal_name`; `logo_data_url text null` (D-11); `company_code` → companies; `business_unit` enum (8 values incl. `INTERNAL`); `gstin`; `state`; `state_code`; `city`; `contact_name`; `phone`; `email`; `credit_days int`; `pricing_model` enum (5); `pricing_rate numeric(14,2)`; `included_km numeric(12,1)`; `extra_km_rate numeric(12,4)`; `driver_bata numeric(14,2)`; `status entity_status` (cache); `notes` | C `credit_days >= 0`. U `lower(code)` (D-5). IX `company_code`, `status` |
| `customer_route_rates` | `id` PK, `customer_id` → customers, `position int`, `route text`, `distance_km numeric(12,1)`, `rate numeric(14,2)` | U (customer_id, position). From `pricing.routes[]` |
| `customer_status_periods` | `id` PK, `customer_id` →, `status entity_status`, `start_date date`, `end_date date null` | C `end_date >= start_date`. No overlap: `exclude using gist (customer_id with =, daterange(start_date, end_date, '[]') with &&)`. U one open period (`where end_date is null`) |
| `drivers` | `id` PK, `name`, `phone`, `license_no`, `license_valid_till date null`, `company_code` →, `status entity_status` | IX `status` |
| `vehicles` | `id` PK; `reg_no`; `company_code` →; `type_code` → vehicle_types; `make`; `model`; `year int`; `seats int null`; `fuel_type` (`DIESEL PETROL EV`); `mileage_kmpl numeric(6,2)`; `ownership` (`OWNED ATTACHED`); `owner_name null`; `status vehicle_status` (cache, + `MAINTENANCE`); `odometer_km numeric(12,1)`; `assigned_customer_id` → customers null (cache); `default_driver_id` → drivers null; `insurance_provider`; `insurance_policy_no`; `insurance_valid_till date null`; `insurance_premium numeric(14,2)`; `road_tax_valid_till date null`; `road_tax_amount numeric(14,2)`; `road_tax_period` (`QUARTERLY ANNUAL`); `fitness_valid_till date null`; `permit_valid_till date null`; `emi_amount numeric(14,2)`; `notes` | U `upper(regexp_replace(reg_no, '[\s-]', '', 'g'))` (D-5). IX `assigned_customer_id`, `status` |
| `vehicle_status_periods` | as `customer_status_periods`, for `vehicle_id` (status incl. `MAINTENANCE`) | same exclusion and open-period rules |
| `vehicle_assignments` | `id` PK, `vehicle_id` →, `customer_id` → null (spare), `start_date`, `end_date null`, `status` (`ACTIVE` / `ENDED`) | No overlap per vehicle (gist exclusion). U one open per vehicle. C `status = 'ACTIVE'` ⇔ `end_date is null`. IX (customer_id, start_date) |
| `fuel_stations` | `id` PK, `name`, `location`, `is_inter_company bool`, `credit_days int`, `status entity_status`, `is_tanker bool default false`, `opening_balance numeric(14,2) null`, `opening_balance_date date null` | U `lower(btrim(name))` (the API returns the existing station for a repeated name). C both opening fields set or both null. C `is_tanker` ⇒ `id = 'dv_tanker'` and no opening balance. U one `is_tanker` row |
| `tankers` | `id` PK, `name`, `reg_no text null` (null = stock pool), `vehicle_id` → vehicles null, `capacity_litres numeric(12,3) null`, `status entity_status`, `notes` | U `lower(name)`. U normalised `reg_no` where not null. U `vehicle_id` where not null. C `capacity_litres > 0` |

### 3.3 Fuel transactions

| Table | Columns | Constraints and indexes |
|---|---|---|
| `diesel_entries` | `id` PK, `company_code` →, `date`, `vehicle_id` →, `customer_id` → null (stamp), `station_id` → fuel_stations (incl. `dv_tanker`), `tanker_id` → tankers null, `litres numeric(12,3)`, `rate numeric(12,4)`, `amount numeric(14,2)`, `odometer_km numeric(12,1) null`, `bill_no`, `payment_mode` (`CREDIT CASH`), `notes` | C `litres >= 0`, `rate >= 0`. C tanker fill ⇔ `tanker_id is not null`, written as `(station_id = 'dv_tanker') = (tanker_id is not null)`. C `amount = round(litres * rate, 2)` **only where rate > 0** (legacy rate-0 tanker fills keep amount 0). IX (vehicle_id, date), (station_id, date), (tanker_id, date), (date) |
| `tanker_loads` | `id` PK, `tanker_id` → (not null), `date`, `station_id` → null, `opening bool default false`, `invoice_no`, `litres numeric(12,3)`, `rate numeric(12,4)`, `amount numeric(14,2)`, `notes` | C `litres > 0`. C `opening` ⇔ `station_id is null`. U one opening per tanker (`where opening`). IX (tanker_id, date), (station_id, date) |
| `tanker_dispenses` | `id` PK, `tanker_id` →, `date`, `vehicle_no text`, `litres numeric(12,3)`, `notes` | C `litres > 0`. History only (no new rows, see §5) |
| `tanker_transfers` | `id` PK, `date`, `from_tanker_id` →, `to_tanker_id` →, `litres numeric(12,3)`, `notes` | C `from <> to`, `litres > 0`. IX each tanker |
| `tanker_adjustments` | `id` PK, `date`, `tanker_id` →, `litres numeric(12,3)`, `reason text` | C `litres <> 0`, `length(btrim(reason)) >= 3` |
| `adblue_purchases` | `id` PK, `date`, `vendor_name`, `product`, `buckets numeric(10,3)`, `litres_per_bucket numeric(10,3)`, `total_litres numeric(12,3)`, `price_per_bucket numeric(14,2)`, `total_cost numeric(14,2)`, `invoice_no`, `notes`, `opening bool default false` | C `buckets > 0`, `litres_per_bucket > 0`, `price_per_bucket >= 0`. C (not opening) `total_litres = buckets * litres_per_bucket`. U one opening (`where opening`). No new openings (§5) |
| `adblue_entries` | `id` PK, `source` (`STOCK` / `DIRECT`), `vehicle_id` →, `customer_id` → null, `legacy_station_id` → fuel_stations null (old `vendorId`), `date`, `closing_km numeric(12,1)`, `quantity_litres numeric(12,3)`, `amount numeric(14,2)`, `vendor_name null`, `rate numeric(12,4) null`, `payment_mode payment_mode null`, `invoice_no`, `notes` | C `quantity_litres > 0`. C DIRECT ⇒ vendor_name and rate set, `amount = round(quantity_litres * rate, 2)`. C STOCK ⇒ vendor_name null. C `payment_mode <> 'TDS'`. IX (vehicle_id, date) |

### 3.4 Operations and money

| Table | Columns | Constraints and indexes |
|---|---|---|
| `trips` | `id` PK, `trip_no`, `company_code` →, `date`, `customer_id` →, `vehicle_id` →, `driver_id` → null, `route`, `start_km`, `end_km`, `distance_km numeric(12,1)`, `pricing_model`, `base_amount`, `extra_km_amount`, `bata_amount`, `toll_parking`, `revenue numeric(14,2)`, `status` (`PLANNED COMPLETED CANCELLED`), `invoice_id` → invoices null, `notes` | U `trip_no`. C `end_km >= start_km`. IX (customer_id, date), (vehicle_id, date), `invoice_id` |
| `invoices` | `id` PK, `invoice_no`, `company_code` →, `customer_id` →, `date`, `due_date`, `period_from`, `period_to`, `subtotal`, `tax_type` (`CGST_SGST IGST`), `tax_rate numeric(5,2)`, `cgst`, `sgst`, `igst`, `total numeric(14,2)`, `status` (`DRAFT ISSUED CANCELLED`), `notes` | U `invoice_no`. C `total = subtotal + cgst + sgst + igst`. No DELETE (cancel only) |
| `invoice_lines` | `id` PK (existing line id), `invoice_id` →, `position int`, `description`, `sac`, `quantity numeric(12,3)`, `unit`, `rate numeric(14,4)`, `amount numeric(14,2)`, `vehicle_id` → null | U (invoice_id, position) |
| `invoice_line_trips` | `line_id` → invoice_lines, `trip_id` → trips | PK (line_id, trip_id) |
| `payments` | `id` PK, `payment_no`, `company_code` →, `direction` (`IN OUT`), `date`, `party_type` (`CUSTOMER VENDOR EMPLOYEE OTHER`), `customer_id` → null, `station_id` → fuel_stations null (today's `vendorId`), `vehicle_id` → null, `party_name`, `category_code` → expense_categories null, `amount numeric(14,2)`, `tds_amount numeric(14,2) default 0`, `mode` (`NEFT UPI CHEQUE CASH TDS`), `reference`, `notes`, `for_month char(7) null` | U `payment_no`. C `amount >= 0`, `tds_amount >= 0`, `amount > 0 or tds_amount > 0`. C `for_month <= to_char(date, 'YYYY-MM')`. C `mode = 'TDS'` ⇒ `amount = 0` and `date` = month end. **U one TDS per station-month:** `(station_id, date_trunc('month', date::timestamp)) where mode = 'TDS' and category_code = 'DIESEL_SETTLEMENT'`. IX (station_id, date), (customer_id, date), (date) |
| `payment_allocations` | `payment_id` → payments, `invoice_id` → invoices, `amount numeric(14,2)` | PK (payment_id, invoice_id). C `amount > 0` |

**Money from the old bank-balance feature:** none. Company bank *details* stay on `companies` because they print on invoices.

### 3.5 System and audit

| Table | Columns | Constraints and indexes |
|---|---|---|
| `month_locks` | `id` PK, `month char(7)`, `state` (`OPEN LOCKED`), `changed_by_role text`, `changed_by uuid` → profiles null, timestamps | U `month`. Owner only (§6) |
| `document_sequences` | `prefix text` PK (e.g. `VT-PAY-202627-`, `VT/2026-27/`), `last_value int` | Replaces the "scan for max" in `nextSeq`. Incremented with `update … returning` inside the write transaction (row lock), so two users can never get the same number. Seeded from the migrated maxima |
| `audit_events` | `id` PK; `at timestamptz`; `actor_kind` (`SESSION SYSTEM`); `actor_user_id uuid` → profiles null; `actor_name null`; `actor_role text null` (C in OWNER, DEV, EMPLOYEE, ACCOUNTANT, OPS_MANAGER — historical names allowed **only here**); `action audit_action` (10 values); `module`; `record_type`; `record_id text` (no FK: deleted records); `label`; `record_date date null`; `before jsonb`; `after jsonb`; `changes jsonb`; `reason null`; `restores_event_id` → audit_events null; `note null`; `before_last_reset bool default false` | U `restores_event_id` where not null (a deletion is restored once). C DELETED ⇒ `length(btrim(reason)) >= 3`. IX (record_id, at), (module, at), (action, at), `at`. **Append-only:** no UPDATE / DELETE grant + a trigger that raises on UPDATE / DELETE / TRUNCATE for every role |
| `audit_reviews` | `event_id` → audit_events PK, `at`, `actor_user_id` → profiles null, `actor_role` | C the event is DELETED (trigger). Append-only like events |
| `migration_runs` | `id` PK, `started_at`, `finished_at`, `source_sha256`, `source_kind`, `counts jsonb`, `totals jsonb`, `status` | U `source_sha256` where status = 'COMMITTED' (see the migration plan) |

**Supporting views** (read-only, `security_invoker`):
- `v_station_payments`: payments where `direction = 'OUT' and category_code = 'DIESEL_SETTLEMENT'`.
- `v_vehicle_current_customer`: from `vehicle_assignments`.

Ledgers and stock are **not** materialised; they stay calculated (§4).

## 4. Accounting rules in the database

**Facts are stored; figures are calculated.** There is no balance, stock or closing column anywhere. Station ledgers, tanker stock and cost, AdBlue stock and cost, and diesel KPIs are calculated by the existing `src/domain` functions from the rows. Nothing to drift, and the reconciliation checks (`check:diesel` …) keep applying unchanged.

### 4.1 Diesel and tankers

| Operation | Rows written | Effect on the station ledger | Effect on tanker stock |
|---|---|---|---|
| Direct pump fill | 1 `diesel_entries` (station = the pump, tanker null) | + Fuel Purchased. CASH also adds cash-at-pump to Payments Made | none |
| Tanker load | 1 `tanker_loads` (station = supplier) | + Fuel Purchased of the supplier (`loadsAsStationPurchases`) | + that tanker |
| Opening stock | 1 `tanker_loads` (opening, station null) | none (not a purchase) | + that tanker |
| Vehicle fill from JIO / Office / Mini | 1 `diesel_entries` (station = `dv_tanker`, tanker = that tanker, rate > 0 for new rows) | **none.** `dv_tanker` is excluded from every station ledger and vendor table, so the litres are never bought twice | − that tanker only |
| Edit fill (litres, rate, tanker, pump ↔ tanker) | 1 UPDATE | recalculated | recalculated: each tanker on its own, checked after the change |
| Delete fill | 1 DELETE + DELETED event with reason | recalculated | litres return to that tanker |
| Transfer | 1 `tanker_transfers` | none | − from, + to |
| Adjustment | 1 `tanker_adjustments` | none | ± |

**Insufficient stock.** Inside the write transaction, the server takes a lock on each affected tanker. It then recomputes that tanker's event sequence with the change applied (`valueTankers`) and refuses the write if the running stock goes below zero at any point. The message stays the same: "Insufficient tanker inventory in {tanker}. Available: X L".
- **The lock:** `select … from tankers where id = any($1) order by id for update`. Ordering by id avoids deadlocks on transfers.
- **Why it's safe:** two users filling from the same tanker at once are serialised by the lock, so neither can overdraw.

**Database-level guards** (independent of the app):
- the tanker-fill check (`dv_tanker` ⇔ tanker id);
- FK to an existing tanker;
- `litres > 0` on loads, transfers and dispenses;
- one opening per tanker.

The **running-stock** invariant needs the event order and stays in the transaction (§7). An optional nightly SQL report re-checks it with a window function.

### 4.2 Fuel station ledger

**Closing = Opening + Fuel Purchased − Payments Made**, per month, carried forward. The opening is `fuel_stations.opening_balance` (+ Debit / − Credit) as of `opening_balance_date`. The parts:
- **Fuel Purchased** = Σ `diesel_entries.amount` for that `station_id` + Σ non-opening `tanker_loads.amount` for that station.
- **Payments Made** = Σ station payments (`amount` + `tds_amount`) + Σ CASH pump fills (cash at pump, derived).

All calculated by `stationLedger`; nothing is stored. Debit and Credit openings are both supported: the column is signed.

**`setOpeningBalance`'s refusal is kept:** it refuses when the station has records in an earlier month. Payments: payment date drives the ledger, `for_month` is informational, no future dates, and the month lock applies (no grace period).

### 4.3 AdBlue

**Stock and cost:**
- **In:** `adblue_purchases`.
- **Out:** STOCK `adblue_entries`, at the weighted average (`valueInventory`).
- **DIRECT entries** never touch stock.

**Writes:** an AdBlue write takes an AdBlue lock (`pg_advisory_xact_lock` on a fixed key) and re-runs `assertStock`. The odometer rule (between the vehicle's neighbouring entries) runs in the same transaction.

**Legacy openings:** `opening` purchases are stock, never "AdBlue Purchased". New opening stock can't be recorded (removed 31 Oct 2026).

## 5. Roles and permissions (derived from the code, nothing new)

| Role | Permissions (`role_permissions`) | Owner-only actions (checked by name, never via a shared permission) |
|---|---|---|
| OWNER | `*` | deletion review and badge; Restore / Push Back; lock / unlock a month; change data in a locked month |
| DEV | every `resource:*` (dashboard, finance, customers, vehicles, trips, diesel, invoices, payments, reports, settings, audit) | refused all four |
| EMPLOYEE | `dashboard:view`, `vehicles:view`, `trips:view/create/edit`, `diesel:view/create/edit` | refused all four |

**Combined rules kept from the API:**
- **Drivers:** `settings:edit` **or** `vehicles:edit`.
- **Vehicle maintenance voucher** (OUT with a vehicle): `payments:create` **or** `vehicles:edit`.
- **Adding vehicle types only:** `settings:edit` **or** `vehicles:edit`.
- **Fuel stations:** created with `diesel:create`, edited / archived with `diesel:edit`.
- **Station payments and TDS:** `payments:create`.
- **Opening balances** (station opening balance, tanker opening stock), **Reset**, **Clear** and **Restore from file:** Owner or Dev (`assertWorkspaceAdmin`).
- **Tankers master:** `vehicles:edit`.
- **Adjustments:** `diesel:edit`.

**Removed functions:** no new tanker dispense, and no AdBlue opening stock. Their tables keep the history.

## 6. Row Level Security design

### 6.1 Helpers (schema `private`, `security definer`, `stable`, `search_path = ''`)

```sql
-- The caller's role: only for an ACTIVE account linked to the signed-in user. NULL = no ERP access.
create function private.erp_role() returns public.erp_role language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.user_id = (select auth.uid()) and p.status = 'ACTIVE'
$$;

-- Mirrors can(role, resource, action) in lib/permissions.ts.
create function private.can(resource text, action text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.role_permissions rp where rp.role = private.erp_role()
                 and rp.permission in ('*', resource || ':*', resource || ':' || action))
$$;

-- Mirrors canEditMonth: Owner always; others only if the month (in India time) is open after any override.
create function private.month_open(d date) returns boolean language sql stable security definer set search_path = '' as $$
  select private.erp_role() = 'OWNER' or coalesce(
    (select ml.state = 'OPEN' from public.month_locks ml where ml.month = to_char(d, 'YYYY-MM')),
    to_char(d, 'YYYY-MM') >= to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM'))
$$;
```

### 6.2 Defaults

- **RLS on every table.** `revoke all … from public, anon, authenticated`, then grant only what the policies below need. `anon` (signed-out) gets **nothing** on any business table: only authorised users access the ERP.
- **Every policy starts with `private.erp_role() is not null`**, through `private.can`. A Google account without an ACTIVE invitation sees nothing.
- **Never `user_metadata`** in a policy (users can edit it). The role always comes from `profiles`, which the browser can't change (existing `profiles_guard`).

### 6.3 Policies per table

| Table(s) | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `companies`, `app_settings`, `expense_categories`, `vehicle_types`, `role_permissions` | any ERP role | `settings:edit` (vehicle types: also `vehicles:edit`) | `settings:edit` | none |
| `customers` (+ route rates, status periods) | `customers:view` **or** `diesel:view` **or** `trips:view` (D-3) | `customers:create` | `customers:edit` (archive / restore = edit) | none |
| `vehicles` (+ status periods), `vehicle_assignments` | `vehicles:view` or `diesel:view` or `trips:view` | `vehicles:create` / assignments: `vehicles:edit` and `month_open(start_date)` | `vehicles:edit`; transfers: `month_open(effective date)` | none |
| `drivers` | `vehicles:view` or `settings:view` or `trips:view` | `settings:edit` or `vehicles:edit` | same | none |
| `fuel_stations`, `tankers` | `diesel:view` | stations `diesel:create`; tankers `vehicles:edit` | stations `diesel:edit`; tankers `vehicles:edit`; opening balance Owner / Dev and `month_open(opening_balance_date)` | none |
| `diesel_entries`, `adblue_entries`, `adblue_purchases`, `tanker_loads`, `tanker_transfers`, `tanker_adjustments` | `diesel:view` | `diesel:create` and `month_open(date)`. Opening loads: Owner / Dev. Adjustments: `diesel:edit` | `diesel:edit` and `month_open(old.date)` (USING) and `month_open(new.date)` (WITH CHECK). Not opening rows | `diesel:delete` and `month_open(date)` |
| `tanker_dispenses` | `diesel:view` | **none** (no new dispenses) | none | `diesel:delete` and `month_open(date)` |
| `trips` | `trips:view` | `trips:create` and `month_open(date)` | `trips:edit`, `month_open` old and new, `invoice_id is null` | `trips:delete`, `month_open(date)`, `invoice_id is null` |
| `invoices`, `invoice_lines`, `invoice_line_trips` | `invoices:view` | `invoices:create` | `invoices:edit` (issue / cancel) | none |
| `payments`, `payment_allocations` | `payments:view`; **station payments** also `diesel:view` (the Fuel Stations ledger and payment list show them to Employee today, D-3) | `payments:create` (maintenance voucher: or `vehicles:edit`) and `month_open(date)`. No future date | `payments:edit` (station payments) and `month_open` old and new | `payments:delete` and `month_open(date)` |
| `month_locks` | any ERP role | Owner only | Owner only | none |
| `audit_events` | OWNER / DEV: all rows. Others: rows whose module needs a resource they can view (`MODULE_RESOURCE`: Diesel / AdBlue / Diesel Tanker / Fuel Stations → diesel; Trips → trips; Vehicles → vehicles; …), for record history | any ERP role, `with check (actor_user_id = auth.uid())`. `RESTORED` with `restores_event_id`: Owner only | **none** (plus a trigger that refuses it) | **none** (plus a trigger that refuses it) |
| `audit_reviews` | OWNER and DEV (Dev sees each deletion's status) | Owner only, only for unreviewed DELETED events | none | none |
| `document_sequences`, `migration_runs` | none | none (server role only) | none | none |

**Locked months are enforced in the database:** Dev and Employee can't insert, update or delete any dated row in a locked month, whatever the app does. Only the Owner passes `month_open` for a locked month.

**Restore is Owner-only in the database:** only the Owner can write the RESTORED event. The restore itself runs the same checks as `planRestore` on the server.

**Performance:** wrap helper calls as `(select private.can(...))` so Postgres evaluates them once per statement. Index every column a policy filters on (`date`, `module`, `station_id`).

## 7. Transaction safety: where business writes run

**The problem:** a business write touches several rows in one go: a fill + its stock check + its audit event; a receipt + allocations + numbering; a restore. The browser client (`supabase-js`) can't run a multi-statement transaction, so writes can't come from the browser.

**Recommended (D-1, option B):** writes run **on the Next.js server** (Server Actions / Route Handlers), in one Postgres transaction per operation, reusing the existing TypeScript API logic and `src/domain` unchanged.
1. **The user is verified first:** `supabase.auth.getClaims()` from the request cookies, never `getSession()`.
2. **One transaction per operation.** The server opens a transaction on a dedicated low-privilege database role, then runs `set local role authenticated` and `set local request.jwt.claims = '<verified claims>'`. That makes **RLS apply with the user's identity** inside the transaction, so the permission and month-lock policies are a second, independent guard.
3. **The existing `api.*` logic runs unchanged:** permission, month lock, archive, assignment, stock, numbering. It runs against the database instead of localStorage, then inserts the audit event, and commits. Any error rolls back everything: no change without its audit event (today's `runInTransaction` guarantee, now real).
4. **Concurrency:**
   - `for update` row locks on the affected tankers;
   - an advisory lock for AdBlue stock;
   - `document_sequences` row locks for numbers;
   - the unique indexes (TDS per station-month, voucher, trip and invoice numbers, one opening per tanker, one restore per deletion) as the final backstop.
5. **What it needs:** a **server-only** database connection string (e.g. `SUPABASE_DB_URL`, never `NEXT_PUBLIC_`) and a Postgres driver. **Not added yet:** it waits for approval of D-1.
6. **Not needed: the Supabase secret key** (`sb_secret_…`). Nothing in this design calls the Admin API, so it isn't required and is not added.

**Alternative (option A):** port each write to a `security definer` Postgres function called through `supabase.rpc()`. Atomic, with no extra secret, but every validation, weighted-average costing and restore check would be rewritten in PL/pgSQL. That's the risk of silently changing accounting rules this design avoids.

**Reads:**
- **With option B:** reads go through the same server layer, as the `api.*` reads do today.
- **The Data API:** RLS SELECT policies make direct reads safe if ever used.

**Time:** all "today" / "this month" checks use the database clock in Asia/Kolkata, never the device.

## 8. Audit history

- **Written in the same transaction** as the change, by the server. Actor = the verified user (`actor_user_id`, name from `profiles.full_name`) and their role at that moment. This replaces "(unverified session)".
- **Snapshots** (`before` / `after` jsonb) are built by the existing `snapshot` / `diff` (`domain/audit.ts`): images become `[image]`, secrets are dropped, and tanker fills and AdBlue draws are shown at their as-reported ₹.
- **Tamper resistance** (the CLAUDE.md "planned backend"): no UPDATE / DELETE grant for any role, plus a trigger refusing UPDATE / DELETE / TRUNCATE. Only the database owner could bypass it. One company-wide trail instead of one per browser.
- **Deletion review** (`audit_reviews`) and **Restore** are shared across devices and Owners.

## 9. Decisions needing the owner's approval

| # | Decision | Recommendation |
|---|---|---|
| D-1 | Where business writes run: server TypeScript with a server-only DB connection (B) or Postgres RPC functions (A) | **B**: reuses the tested rules; adds a server-only `SUPABASE_DB_URL` when approved |
| D-2 | Replace `erp_role` with OWNER / DEV / EMPLOYEE only. It needs a new migration that recreates the type. Today's migration lists ACCOUNTANT and OPS_MANAGER; no account exists, so nothing is lost. `check:supabase` and `LegacyRole` need updating with it | Approve. History keeps old names in `audit_events.actor_role` (text) |
| D-3 | Reads for Employee: the prototype doesn't check reads, and the Diesel / Fuel Stations pages show customers, vehicles, stations and **station payments** to Employee. RLS above allows exactly what those pages show (customers via `diesel:view`, station payments via `diesel:view`), not other payments, receipts, invoices or reports | Approve as written, or restrict customers to non-financial columns through a view |
| D-4 | Keep the existing text ids as primary keys (idempotent copy, every link and audit `recordId` intact) vs new UUIDs + `legacy_id` | **Keep text ids** |
| D-5 | Make customer `code` and normalised vehicle `reg_no` unique (not enforced today) | Approve, if the dry run finds no duplicates; otherwise list them for you |
| D-6 | Keep `dv_tanker` as a `fuel_stations` row (1:1) vs replace it with a `source` column | **Keep** for the migration. Revisit later |
| D-7 | *(Only if D-1 = A)* re-implement weighted-average costing and snapshots in SQL | n/a with B |
| D-8 | Migrate the audit log (it isn't in the JSON backup; it's per browser) — which browser is the source of truth? | Migrate the Owner's browser log via a separate export; keep reviews |
| D-9 | Reset to demo data, Clear all data and Restore from file in production | **Don't offer them against the shared database.** The import becomes a one-off, audited migration run |
| D-10 | Timing relative to the November 2026 fresh start | Do the fresh start (or decide against it) first, then migrate one settled dataset |
| D-11 | Customer logos: keep the ≤128 px data URL in a text column vs Supabase Storage | Keep in the column for now |
| D-12 | Numeric precision: money (14,2), litres (12,3), rates (12,4), km (12,1) | Approve. The dry run refuses any value that wouldn't fit |
| D-13 | Supabase plan: daily backups / point-in-time recovery for the rollback strategy | Pro plan with PITR before go-live |
| D-14 | Cache columns (`vehicles.assigned_customer_id`, `status`) kept and maintained in the same transaction | Keep (as today) |
