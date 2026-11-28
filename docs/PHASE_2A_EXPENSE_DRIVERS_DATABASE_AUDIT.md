# Phase 2A — Expense and Drivers: database audit and architecture design

**Status: audit and design only — for the owner's review. Revised by `docs/PHASE_2B_IMPLEMENTATION_PLAN.md` (27 Nov 2026), which takes precedence where they differ (final table list, enum names, `module_resource('Drivers')`).** Nothing in this document has been applied. No Production SQL
was run, no migration was applied, no browser data was touched, the browser storage implementation is unchanged, and
nothing was deployed, committed or pushed. Phase 2B starts only after this design is approved.

Prepared 27 Nov 2026 from the repository (`prototype/`), its migrations (`supabase/migrations/`), the project rules
(`CLAUDE.md`, `.claude/rules/*.md`) and the browser data on the development machine.

---

## 0. How the audit was done — and its one limit

- **Code and migrations:** read directly (every migration file, `src/lib/server/erp/tables.ts`, `engine.ts`,
  `src/lib/api/index.ts`, `src/lib/storage/*`, `src/domain/expenses.ts`, `src/domain/drivers.ts`).
- **Browser data:** read on this computer's browser profile (read-only).
- **Production: not inspected directly.** No database connection was opened (no Production SQL without the owner's
  approval). Production's state is taken from the migration files and the application notes in the project rules —
  and those notes are **not fully consistent**: e.g. `20261118000000_adblue_supplier_payments.sql` is recorded "not yet
  applied", yet the AdBlue save failure diagnosed on 25 Nov (`22P02 … fuel.adblue_payment_mode`) proves it is live.
  **Before Phase 2B, run the read-only `supabase/scripts/production-readonly/26-phase2a-inventory.sql`** (written with
  this report; it changes nothing) and send the result. Every "Production" statement below is marked *(to confirm)*
  where it depends on it.

---

## 1. Existing database schema and relevant tables

Schemas (all created by the migrations): `public` (accounts), `private` (helper functions), `core` (master data),
`fuel`, `finance`, `billing`, `ops`, `audit`. **No Expense schema or table exists.**

| Area | Table(s) | Relevance to Phase 2 |
|---|---|---|
| Companies | `core.companies` (`code` PK — VT, VTHPL; `name`, `invoice_prefix`, `is_primary`, `parent_code`) | **Reuse** as the FK for Paying Company / Account Payable. |
| Customers | `core.customers` (+ `customer_status_periods`, `customer_pricing`, `customer_route_rates`) | **Reuse** for Customer Company. |
| Vehicles | `core.vehicles` (`company_code` → companies, `default_driver_id` → drivers, document dates, `puc_valid_till` *(20261121000000)*) | **Reuse** — every Expense record references `core.vehicles(id)`. |
| Vehicle ↔ customer | `core.vehicle_assignments` (vehicle, customer nullable, `start_date`, `end_date`, no-overlap exclusion) | **Reuse** — the customer on a transaction date. |
| Vehicle status | `core.vehicle_status_periods` | Archived-vehicle rule on new records. |
| Drivers | `core.drivers` (`id` PK `drv…`, `name`, `phone`, `company_code` NOT NULL, `status`, `license_no`, `license_valid_till`) | **Reuse** — the central master. |
| Vehicle ↔ driver (dated) | `core.vehicle_driver_periods` — *migration 20261121000000, recorded NOT applied to Production* | **Reuse** once applied. |
| DL unique | index `core.drivers_license_no_key` — *20261121000100, recorded NOT applied* | Reuse. |
| Vehicle company (dated) | `core.vehicle_company_periods` + driver father's name / DOB / address — *20261127000000, prepared, NOT applied anywhere* | Reuse (prepared in Phase 1). |
| Document alerts | `core.vehicle_document_alerts` — *20261122000000/100, recorded NOT applied* | Not Expense; a prerequisite of the current app code. |
| Monthly Sheet Lock | `core.month_locks` (one row per month: `OPEN`/`LOCKED`), `private.month_open(date)` | **Not reused for Expense** (different rule — see §8); still applied alongside. |
| Payments / vouchers | `finance.payments` (+ `payment_categories`, `payment_allocations`) — station payments, receipts, **expense vouchers** with categories incl. `ROAD_TAX`, `INSURANCE` | **Not reused** for Expense records (see §5, risk R-6). |
| Vendor ledgers (patterns) | `ops.tyre_invoices` / `tyre_payments` / `tyre_payment_allocations`; `fuel.adblue_vendors` / `adblue_payments` / `adblue_payment_allocations` | Pattern references. Both **allocate** payments to bills; Broker Charges must **not** (§6.5). |
| Audit | `audit.events` (actor, role at the time, action enum, module, record_type, record_id, before/after jsonb, reason, `txid`), `audit.reviews` | **Reuse** — every Expense write audited. |
| Accounts / roles | `public.profiles` (Google-linked accounts, `erp_role` enum OWNER/DEV/EMPLOYEE/TATA_ADBLUE/ADBLUE), `core.role_permissions` | **Reuse** — no new role. |

**Functions and triggers reused:** `private.new_id(prefix)`, `private.touch_updated_at()`, `private.erp_role()`,
`private.can(resource, action)` (refuses `accounts`/`system` to non-Dev; Dev holds `*`; the **Owner holds an explicit
list** — `dashboard, finance, customers, vehicles, trips, diesel, invoices, payments, reports, settings, audit` — so
`expenses` is Dev-only in the database simply by adding no `role_permissions` rows), `private.is_owner_or_dev()`,
`private.month_open(date)`, `private.today_ist()`, `private.require_parent_audit_event(<column>)` (deferred: no row change
without its audit event in the same transaction), `private.module_resource(module)` (who may read a module's history),
`private.changed_modules(since)` (20-second change polling), `private.edit_delete_guard()` /
`private.vehicle_driver_period_delete_guard()` (child-row delete guards).

**RLS model (existing, kept):** every business table has RLS on; `authenticated` gets only the grants it needs; policies
use `private.can(...)`; deletes need `:delete` (Owner/Dev only, 16 Nov 2026); month changes go through
`private.month_open`. The server reaches the database as `erp_server` with `SET LOCAL ROLE authenticated` and the user's
claims, so **RLS applies to every statement** — nothing uses the service role.

---

## 2. Existing application storage mechanisms (Phase 1)

Browser backend (`NEXT_PUBLIC_DATA_BACKEND=local`, the default): `localStorage`, key prefix `vt:`, each collection stored
**column-encoded** — `{ "cols": [...], "rows": [[...], ...] }`.

| Key | Collection | Holds |
|---|---|---|
| `vt:expenses` | `expenses` | All five Expense sections (one flat shape, `section` field). |
| `vt:brokers` | `brokers` | The broker list (`id` `brk_…`, `name`). |
| `vt:expenseMonthLocks` | `expense_month_locks` | Section-month locks (`id` `eml_…`, `month`, `section`). |
| `vt:drivers` | `drivers` | The driver master. |
| `vt:vehicles` | `vehicles` | Vehicles; **`driverPeriods[]` and `companyPeriods[]` are stored inside each vehicle record.** |
| `vt:vehicleAssignments` | `vehicle_assignments` | Vehicle ↔ customer periods. |
| `vt:auditEvents` | (audit) | Browser audit trail — **never copied** to the shared database (existing rule). |
| `vt:ui:expenseMonth:<SECTION>` | UI only | Each section's selected month — not data. |

- **IDs:** `newId(prefix)` = prefix + 12 random hex characters (`exp_…`, `brk_…`, `eml_…`, `drv_…`, `vdp_…`, `vcp_…`).
  Collisions between browsers are practically impossible, but the import still checks.
- **Dates:** business dates are `yyyy-MM-dd` strings in India time; `createdAt` / `updatedAt` are ISO-8601 UTC instants.
- **Money:** JavaScript numbers rounded with `round2` (exact paise, half away from zero = PostgreSQL `round(numeric, 2)`).
- **Export:** Settings → Data → **Download backup** (`exportBackup`, Owner/Dev) writes `{ format: "vishal-erp-backup",
  version, exportedAt, settings, collections }` and **already includes** `expenses`, `brokers`, `expense_month_locks`,
  `drivers`, `vehicles` and `vehicle_assignments`. This file is the import source (§9).
- **This computer's browser (27 Nov 2026, read-only):** `expenses` 5 records (3 Road Tax, 1 Fine, 1 Broker bill "GG"
  ₹2,000), `brokers` 1 (GG), `expense_month_locks` 0, `drivers` 13 (no DL numbers, phones or expiry), 267 vehicles (all
  VTHPL), 0 dated driver periods, 14 vehicles with a default driver. 8 earlier Expense records were removed by Settings →
  Clear all data on 27 Nov; their full snapshots remain in this browser's audit log (recoverable on request).

---

## 3. Existing Expense data model (Phase 1, `Expense` in `src/lib/types.ts`)

One flat record; the API (`checkExpense`) keeps only the fields of its section and clears the rest.

| Field | Road Tax | Insurance | Fitness | Fines | Broker |
|---|---|---|---|---|---|
| `id`, `createdAt`, `updatedAt` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `section` | ROAD_TAX | INSURANCE | FITNESS | FINE | BROKER |
| `date` (the month's date) | transaction | premium transaction | transaction | fine date | bill date / payment date |
| `vehicleIds[]` | exactly 1 | exactly 1 | exactly 1 | exactly 1 | 0, 1 (older: several) |
| `customerId` (stamped: vehicle's customer on `date`) | ✓ | ✓ | ✓ | ✓ | — |
| `companyCode` (VT/VTHPL) | **required** (Paying Company / Account Payable) | optional (Paid by) | optional | — | — |
| `companyConfirmed` | ✓ (true once saved with the company chosen) | | | | |
| `description` | **required**, one spelling per description | optional | optional | optional free text | required on a bill |
| `taxType` | tax type | | | fine type (required) | |
| `amount` | ✓ | premium | ✓ | fine amount | bill / opening amount |
| `validFrom`, `validTill` | both or neither | **required** | both or neither | | |
| `provider`, `policyNo` | | provider required | | | |
| `paymentMode`, `paymentReference` | | ✓ | | reference when paid | older entries' mode |
| `paymentStatus`, `paymentDate` | | | | PAID/UNPAID (+ date when paid) | payment date |
| `driverId` | | | | optional → driver master | |
| `entryType` | | | | | CHARGE (bill) / PAYMENT / BROUGHT_FORWARD (opening) |
| `broker`, `billNo` | | | | | broker **name**; bill number |
| `paidAmount` | | | | | a payment's amount (older bills: paid on the bill) |
| `purpose`, `operatingCompany`, `vehicleCount` | | | | | older broker entries |
| `remarks` | ✓ | ✓ | ✓ | ✓ | ✓ |

Rules enforced today in the API (to be enforced again by the database in Phase 2): future dates refused; vehicles from
the master only and not archived on the date; Road Tax company required; one Road Tax description spelling; one opening
balance per broker dated first; bill numbers unique per broker; **a broker is never paid more than billed at any date**;
a bill/payment/opening keeps its type; section-month locks; Monthly Sheet Lock; mandatory delete reason; audit event per
change. Derived on read (never stored): validity status, broker outstanding, monthly summaries, Customer Company on the
transaction date (Road Tax filter).

## 4. Existing Drivers data model

- `Driver`: `id`, `name`, `fatherName`, `dateOfBirth`, `address`, `phone`, `licenseNo` (unique, cleaned), `licenseValidTill`,
  `companyCode` (older drivers only; null on new), `status` (ACTIVE / INACTIVE / ARCHIVED).
- `Vehicle.defaultDriverId` (undated, pre-fills trips); `Vehicle.driverPeriods[]` (dated); `Vehicle.companyPeriods[]` (dated).
- References by id: trips (`driverId`), fines (`Expense.driverId`), vehicles. Diesel, AdBlue and Reports store **no**
  driver data.
- Company deployment is derived (`src/domain/drivers.ts`): driver periods × vehicle company periods; nothing stored.
- The database side is already written: `core.drivers` (+ 20261127000000 columns), `core.vehicle_driver_periods`,
  `core.vehicle_company_periods`, DL unique index — **four migrations not yet applied** (§11, step 1).

## 5. Missing database structures

1. Everything for Expense: section records, broker master, broker bills/payments/openings, section-month locks, import
   bookkeeping.
2. Drivers: nothing new beyond the four prepared migrations.
3. Function updates: `private.module_resource` must know `Expense` → `expenses` (today it falls to `audit`, so the
   Owner/Employee — who hold `audit` — would see Dev-only Expense history) and `Drivers` → `vehicles` (today `settings`,
   so the Employee, who has no `settings`, can't read driver history although the Drivers page is theirs).
4. **Decision for the owner (R-6):** `finance.payment_categories` already has `ROAD_TAX` and `INSURANCE` expense
   categories used by Payments → expense vouchers (and Reports). The Expense module is a **separate record** of the same
   kind of spending. This design keeps them separate (Expense records are not vouchers: they carry validity periods, tax
   types, bills and broker ledgers, and must stay Dev-only). If road tax is also entered as a Payments voucher, Reports
   would count it once, the Expense module once more. Recommended: until Expense is released, record road tax /
   insurance / fitness / fines / broker money **only** in Expense; decide at release whether Reports should read Expense.

---

## 6. Proposed table and relationship design

New schema **`expense`** (comment: "Expense module: Road Tax, Insurance, Fitness, Fines, Broker Charges"). All money
`numeric(14,2)`, all business dates `date`, all instants `timestamptz`, ids `text` with `private.new_id(prefix)` defaults
**and the Phase 1 ids accepted as given** (so imported records keep their ids). Every table: `created_at`, `updated_at`
(`touch_updated_at`), RLS on, audit trigger.

### 6.1 Types

```sql
create type expense.section as enum ('ROAD_TAX', 'INSURANCE', 'FITNESS', 'FINE', 'BROKER');
create type expense.fine_status as enum ('PAID', 'UNPAID');
create type expense.broker_entry_type as enum ('BILL', 'PAYMENT', 'OPENING');
```

### 6.2 `expense.records` — Road Tax, Insurance, Fitness, Fines

One table, one row per entry, `section` in ('ROAD_TAX','INSURANCE','FITNESS','FINE'); section-specific CHECK constraints
mirror `expenseProblems`. Purpose: the four vehicle-document / fine expense registers.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK default `new_id('exp')` | Phase 1 id kept on import |
| `section` | `expense.section` | not BROKER (check) |
| `date` | date not null | the month's date (transaction / premium / fine date) |
| `vehicle_id` | text not null → `core.vehicles(id)` | exactly one vehicle |
| `customer_id` | text null → `core.customers(id)` | the vehicle's customer on `date`, stamped on save (snapshot; Road Tax's Customer Company filter also re-reads the assignment history) |
| `company_code` | text null → `core.companies(code)` | Road Tax: NOT NULL (check); Insurance / Fitness: optional |
| `company_confirmed` | boolean not null default false | Road Tax: true when saved with the company chosen |
| `description` | text not null default '' | Road Tax: not blank (check) |
| `description_key` | text generated always as (`upper(btrim(regexp_replace(description,'\s+',' ','g')))`) stored | spelling-insensitive key (filters, one spelling) |
| `tax_type` | text not null default '' | Road Tax tax type; Fines fine type (not blank for FINE) |
| `amount` | numeric(14,2) not null check (> 0) | |
| `valid_from`, `valid_till` | date null | both or neither; till ≥ from; INSURANCE: both NOT NULL |
| `provider`, `policy_no` | text not null default '' | INSURANCE (provider not blank) |
| `payment_mode`, `payment_reference` | text not null default '' | INSURANCE; FINE reference |
| `fine_status` | `expense.fine_status` null | FINE: NOT NULL |
| `paid_on` | date null | FINE: required when PAID, ≥ `date`; null otherwise |
| `driver_id` | text null → `core.drivers(id)` | FINE only (check: null for other sections) |
| `remarks` | text not null default '' | |
| `import_batch_id` | text null → `expense.import_batches(id)` | set on imported rows (provenance) |

Indexes: `(section, date)`, `(vehicle_id, section, date)`, `(section, description_key)`, `(driver_id)` where not null,
`(customer_id, date)` where not null. Checks: `date <= today_ist()` is enforced by policy/trigger (not a CHECK — CHECKs
can't use the clock safely); fields of other sections must be empty/null (one CHECK per section).

*Why one table, not four:* the four share 80% of their columns and every rule except a few per-section checks; the app
already treats them as one collection; one table keeps one RLS / lock / audit implementation. (Alternative — four tables
— is cleaner in isolation but quadruples policies and triggers; not recommended.)

### 6.3 `expense.brokers` — broker master

| Column | Type | Notes |
|---|---|---|
| `id` | text PK default `new_id('brk')` | Phase 1 id kept |
| `name` | text not null, not blank | display spelling |
| `name_key` | text generated (`upper(btrim(regexp_replace(name,'\s+',' ','g')))`) stored, **unique** | no duplicate brokers (case / spaces ignored) |
| `status` | `core.entity_status` default ACTIVE | archive, never delete |

### 6.4 `expense.broker_entries` — bills, bulk payments, opening balances

| Column | Type | Notes |
|---|---|---|
| `id` | text PK default `new_id('exp')` | Phase 1 id kept |
| `broker_id` | text not null → `expense.brokers(id)` | |
| `entry_type` | `expense.broker_entry_type` | BILL / PAYMENT / OPENING |
| `date` | date not null | bill date / payment date / opening date |
| `bill_no` | text not null default '' | BILL only |
| `bill_no_key` | text generated (normalised) stored | unique per broker for non-blank bills: `unique (broker_id, bill_no_key) where entry_type='BILL' and bill_no_key <> ''` |
| `description` | text not null default '' | BILL: not blank |
| `amount` | numeric(14,2) not null default 0 | BILL / OPENING: > 0; PAYMENT: 0 |
| `paid_amount` | numeric(14,2) not null default 0 | PAYMENT: > 0 (the bulk payment); BILL: older records only (paid on the bill, ≤ amount); OPENING: 0 |
| `payment_mode`, `paid_on` | text / date | older bills' recorded mode and cleared date (kept, never asked) |
| `purpose`, `operating_company` | text not null default '' | older entries (kept) |
| `vehicle_count` | integer not null default 0 | older entries with a count but no registrations |
| `remarks` | text not null default '' | |
| `import_batch_id` | text null → `expense.import_batches(id)` | |

Plus `expense.broker_entry_vehicles (entry_id → broker_entries, line_no, vehicle_id → core.vehicles, PK (entry_id, line_no))`
— a bill names none, one, or (older entries) several vehicles; real FKs instead of an id array.

One opening balance per broker: `unique (broker_id) where entry_type='OPENING'`; dated before every other entry of that
broker (deferred trigger).

### 6.5 Broker accounting (no allocation)

**There is no allocation table** — unlike Tyre and AdBlue, a payment belongs to the broker, never to a bill. Outstanding
is calculated, never stored:

```
effect(e) = OPENING: amount − paid_amount   BILL: amount − paid_amount   PAYMENT: −paid_amount
Closing Outstanding(broker, date) = Σ effect(e) for the broker's entries dated ≤ date
Opening(month) + Bills(month) − Payments(month) = Closing(month)
```

**Database backstop** — `private.broker_ledger_guard()`, a deferred constraint trigger on `broker_entries` (insert,
update, delete): for each touched broker, walk its entries in ledger order (date; OPENING, BILL, PAYMENT; created_at; id)
and raise if the running balance ever falls below zero — exactly `firstOverpayment` in the app. So an over-payment, a
back-dated payment that overpays a later date, or a bill shrunk / deleted after payment is refused by the database too.
A read-only view `expense.broker_balances` (broker, outstanding today) can serve reports; it is not required by the app.

### 6.6 `expense.month_locks` — independent section-month locks

| Column | Type | Notes |
|---|---|---|
| `section` | `expense.section` | |
| `month` | text check `^\d{4}-(0[1-9]|1[0-2])$` | |
| `locked_at` | timestamptz default now | |
| `locked_by` | uuid → `public.profiles(id)` | |
| `locked_by_role` | `public.erp_role` | the role at the time |
| `id` | text unique default `new_id('eml')` | Phase 1 id kept; audit record id |
| PK | `(section, month)` | one lock per section-month |

Append-only: no UPDATE / DELETE grant (unlocking is a separate decision — §8).

### 6.7 Import bookkeeping (§9)

- `expense.import_batches` — `id` (`imp…`), `source_label` (e.g. "Office PC — Chrome"), `source_fingerprint` (sha256 of
  the file's canonical Expense collections; **unique** → the same file can't be applied twice), `exported_at`,
  `status` (DRY_RUN / APPLIED / FAILED), counts and totals per section (jsonb), `source_snapshot` jsonb (the file's
  Expense collections as received — full provenance), `created_by`, `created_at`.
- `expense.import_items` — `batch_id`, `source_collection`, `source_id`, `outcome` (IMPORTED / ALREADY_PRESENT /
  CONFLICT / REJECTED / POSSIBLE_DUPLICATE_SKIPPED), `target_id`, `reason`. PK `(batch_id, source_collection, source_id)`.

### 6.8 Relationships

```
core.companies ◄─ company_code ─ expense.records ─ vehicle_id ─► core.vehicles ◄─ vehicle_id ─ core.vehicle_assignments ─► core.customers
                                     │  customer_id ──────────────────────────────────────────────────────────────────► core.customers
                                     │  driver_id ─► core.drivers ◄─ driver_id ─ core.vehicle_driver_periods ─► core.vehicles
                                     └  import_batch_id ─► expense.import_batches ◄─ expense.import_items
expense.brokers ◄─ broker_id ─ expense.broker_entries ◄─ entry_id ─ expense.broker_entry_vehicles ─► core.vehicles
expense.month_locks (section, month) — checked by every write to records / broker_entries
core.vehicles ◄─ vehicle_id ─ core.vehicle_company_periods ─► core.companies      (driver deployment = driver periods × company periods)
audit.events (module 'Expense', record_id = any of the above ids)
```

---

## 7. Proposed RLS policies

Permission resource **`expenses`** (Dev holds `*`; **no `role_permissions` rows for OWNER / EMPLOYEE** → Dev-only, as
today's `UNRELEASED`). Release later = add `('OWNER','expenses:*')`, `('EMPLOYEE','expenses:*')` in one migration.

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `expense.records` | `can('expenses','view')` | `can('expenses','create')` and `expense_month_open(section, date)` and `month_open(date)` and `date <= today_ist()` | USING `can('expenses','edit')` and open(old section, old date); WITH CHECK open(new section, new date) and not future | `can('expenses','delete')` and open(section, date) |
| `expense.broker_entries` (+ `_vehicles` via parent) | same, section BROKER | same | same | same (+ ledger guard at COMMIT) |
| `expense.brokers` | `can('expenses','view')` | `can('expenses','create')` | `can('expenses','edit')` | none (archive) |
| `expense.month_locks` | `can('expenses','view')` | `can('expenses','edit')`, `month <= current IST month`, `locked_by_role = erp_role()` | none | none |
| `expense.import_batches` / `import_items` | `private.is_dev()` | `private.is_dev()` | `private.is_dev()` (status only) | none |
| `core.drivers` (existing) | unchanged (`vehicles` / `trips` / `diesel` view) | unchanged: `settings:edit` **or** `vehicles:edit` | unchanged | none (archive) |
| `core.vehicle_driver_periods`, `core.vehicle_company_periods` | as written in 20261121000000 / 20261127000000 | `vehicles:edit` | close / same-day correction | Owner/Dev, or same-day undo inside the vehicle's audited edit |

Grants: `select, insert, update, delete` to `authenticated` only where a policy exists; `service_role` all; no `anon`.
Nothing existing is weakened: no current policy, grant or function changes, except the two `module_resource` mappings
(§5.3) and a new `module_resource('Expense') = 'expenses'`.

## 8. Monthly locking enforcement design

- `private.expense_month_open(p_section expense.section, p_date date) returns boolean` (security definer, stable):
  `not exists (select 1 from expense.month_locks where section = p_section and month = to_char(p_date,'YYYY-MM'))`.
  **No calendar auto-lock**, no role exemption — a locked section-month is read-only for everyone (Phase 1 rule).
- Every INSERT / UPDATE (old and new row) / DELETE policy on `records` and `broker_entries` requires it, **and** the
  existing Monthly Sheet Lock `private.month_open(date)` (as the Phase 1 API does — both apply).
- Months by transaction date only: `records.date` (transaction / premium transaction / fine date) and
  `broker_entries.date` (bill date for bills, payment date for payments). Validity dates and `created_at` never decide
  the month.
- Locking another section's month never affects this one (lock key = section + month).
- Locking: insert into `expense.month_locks` + a `MONTH_LOCKED` audit event (existing enum value) in the same transaction
  (`require_parent_audit_event('id')`).
- **Adjustments to a locked month — decision for the owner.** Phase 1 has no unlock. Options: (a) none (records in a
  locked month can never change); (b) Dev-only **unlock with a mandatory reason**, audited `MONTH_UNLOCKED` (existing enum
  value) — implemented as deleting the lock row inside a security-definer function that writes the event, so the table
  itself stays append-only for sessions. Recommended: (b), Dev only.
- Reads are never restricted by locks.

## 9. Browser data migration strategy

**Principle:** each browser's data is imported as its own **batch**, from that browser's backup file, by Dev, through the
application server (RLS applies; no SQL by hand). Nothing is deleted anywhere; the browser keeps working until the
switch-over.

1. **Export** — in each browser holding Phase 1 data: Settings → Data → Download backup (existing). Name the file by
   computer / browser.
2. **Dry run** (Settings → Data → *Import Expense data*, Dev only, new in 2B): upload → the server parses
   (`parseBackup`), computes the fingerprint, and reports — without writing:
   - per section and month: records, Σ amounts, Σ paid; broker outstanding per broker;
   - each record's outcome: **new** · **already present** (same id, identical content → skipped) · **conflict** (same id,
     different content → never overwritten; listed) · **rejected** (vehicle / customer / driver not in the shared master;
     broker name blank; a rule the database would refuse) · **possible duplicate** (different id but same section, vehicle,
     date, amount and description — or same broker, bill number / date+amount — as a record already central, typically
     the same bill entered in two browsers; **not skipped automatically** — Dev ticks include / exclude);
   - brokers: matched to an existing broker by `name_key` (one master across browsers — the batch's ids are remapped);
     same name for two different real brokers is shown for review;
   - locks: union — a lock in any browser locks centrally; a record whose section-month is already locked centrally is
     shown (see step 3);
   - Customer Company: recomputed from the central assignment history; differences from the browser's stamp listed.
3. **Apply** — one database transaction per batch: brokers → records / broker entries (ids preserved, `import_batch_id`
   set) → broker entry vehicles → locks; one `CREATED` audit event per record with note "Imported from browser backup
   '<label>' (batch <id>)"; the broker ledger guard and every CHECK run at COMMIT. Records into a section-month locked
   centrally are imported only if Dev ticks them, through the import function that allows it for that batch alone
   (`private.expense_import_allowed(batch)` in the policies, true only inside an APPLYING batch run by Dev), audited.
   **Any error → nothing is written**; fix and retry.
4. **Retry safety** — `source_fingerprint` unique (the same file twice is refused); per-record ids make a second, newer
   file from the same browser import only what's new; identical records are skipped, changed ones reported as
   conflicts.
5. **Reconciliation report** (after apply; also `28-expense-import-reconciliation.sql`, read-only): file vs imported vs
   skipped vs rejected — counts and Σ amounts per section × month, broker outstanding per broker; the batch row keeps it.
6. **Drivers and vehicles are not imported wholesale.** The browser's master data came from shared-database exports
   (same ids). The dry run diffs them: a driver id missing centrally can be imported (DL uniqueness checked); a changed
   name / DL / phone / father's name / DOB / address is **listed for review, never overwritten**; dated driver and company
   periods that exist only in the browser are listed and imported only on Dev's confirmation (no overlap; audited as
   the vehicle's edit). Drivers are never matched by name.
7. **Browser audit history** is not copied (existing rule); the full file is kept in `import_batches.source_snapshot`.
8. **The 8 records removed on 27 Nov** can be rebuilt from this browser's audit snapshots into a backup file and
   imported as their own batch — only if the owner asks.

## 10. Duplicate and reconciliation risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Production state differs from the migration notes (stale "applied" notes found). | Run `26-phase2a-inventory.sql` first; finalise 2B against its result. |
| R-2 | The same bill entered in two browsers (different ids). | "Possible duplicate" in the dry run; Dev decides; never auto-merged. |
| R-3 | Same broker spelled differently / two brokers with one name. | `name_key` matching (case / spaces); the review list; brokers editable before apply. |
| R-4 | Records referencing vehicles / drivers created only in one browser. | Rejected with reason; create them centrally (Drivers page / vehicles), re-run the dry run. |
| R-5 | A browser's section-month lock vs another browser's records in that month. | Lock union + explicit per-record tick; audited. |
| R-6 | Road tax / insurance also entered as Payments expense vouchers → counted twice in Reports. | Owner decision (§5.4). |
| R-7 | Stamped customer differs from the central assignment history. | Recomputed on import; differences listed. |
| R-8 | Imported broker entries would overpay a broker at some date (bills missing from the file). | Ledger guard refuses the batch; report names the broker and date. |
| R-9 | Older broker entries with no broker name. | Rejected until a broker is chosen (none remain in this browser; the deleted ones had none). |
| R-10 | The same file applied twice. | Unique fingerprint; per-record identity. |
| R-11 | Phase 1 columns no longer used (`creditId` from 27 Nov) present in old files. | Ignored on import (never used by any stored record). |
| R-12 | Money precision. | `numeric(14,2)`; the import refuses a value with more than 2 decimals. |
| R-13 | Driver data edited both in a browser and centrally. | Diff only; never overwritten. |

## 11. Exact migration sequence (Phase 2B onward — none of this is done yet)

0. **Inventory (read-only):** `production-readonly/26-phase2a-inventory.sql` → confirm which of the migrations below are
   live; send the output. *(Owner runs it, or approves running it.)*
1. **Drivers prerequisites (already written, not applied):** per their own preflights — `20-vehicle-documents-preflight.sql`
   → `20261121000000_vehicle_puc_and_drivers.sql` → `19-driver-licence-duplicates.sql` → `20261121000100` →
   `20261122000000` (→ `21-…post-apply`) → later stage 4 `20261122000100`; then `24-driver-master-preflight.sql` →
   `20261127000000_driver_master_company_periods.sql` → `25-driver-master-post-apply.sql`. Additive; no row changed.
2. **New `2026120x000000_expense_schema.sql`** (to write in 2B): schema `expense`, types, the tables of §6 (seven were listed — "eight" was an error; **superseded by the six-table design in `PHASE_2B_IMPLEMENTATION_PLAN.md` §1**), generated
   keys and unique indexes, CHECKs, `private.expense_month_open`, `private.broker_ledger_guard`, opening-first trigger,
   audit triggers (`require_parent_audit_event`), RLS and grants (§7), `module_resource` update (`Expense` → `expenses`,
   `Drivers` → `vehicles`), `changed_modules` unchanged (it already uses `module_resource`). **Additive only**: creates
   new objects; the only replaced function is `module_resource` (two mapping rows). No existing row is touched. Guards:
   stops if `expense` exists or a prerequisite is missing. Rollback: `drop schema expense cascade` + previous
   `module_resource`.
3. **Optional `2026120x000100_expense_month_unlock.sql`** — only if the owner chooses §8 (b).
4. **App (2B, local first):** `tables.ts` specs for `expenses` (two tables), `brokers`, `expense_month_locks`; engine
   collection mapping; remove `assertLocalExpenses` and the "Not on the shared database yet" notice; `brokerId` on broker
   entries; the Dev-only import screen (§9); checks: `check:erp-db` (every Expense rule, as Dev / Owner / Employee /
   AdBlue profiles), `check:erp-fields` (round trip of every Expense field), `check:supabase-diesel` (RLS per role),
   `check:expenses` on the database backend. All offline in PGlite first.
5. **Apply 2 (and 3) on Production** — only with the owner's go-ahead: preflight → apply in the SQL Editor (never
   `db push`) → post-apply.
6. **Deploy the matching app** (owner's go-ahead).
7. **Import:** dry run per browser → review → apply → reconciliation. Browsers keep their data.
8. **Release** (later, owner's decision): `role_permissions` rows for `expenses`, remove `expenses` from `UNRELEASED`.

## 12. Proposed preflight and post-apply verification scripts

- **`26-phase2a-inventory.sql`** (written with this report; read-only): schemas, the expected tables / functions /
  indexes of every migration since 20261117, role permissions, Expense permission rows (must be none), drivers /
  vehicles / assignments counts, whether `expense` exists.
- **`27-expense-preflight.sql`** (2B): CHECK rows — prerequisites present (core tables, `require_parent_audit_event`,
  `can`, `month_open`, `today_ist`, `new_id`, `btree_gist`), `expense` schema absent, no `role_permissions` row for
  `expenses`, companies VT and VTHPL present; INFO — counts to compare after.
- **`28-expense-post-apply.sql`** (2B): tables, columns and types; every policy by name and command; grants to
  `authenticated`; triggers (touch, audit, ledger guard, opening-first); unique indexes (`name_key`, bill number,
  one opening, lock PK); RLS on everywhere; function fingerprints (md5 of `expense_month_open`, `broker_ledger_guard`,
  `module_resource`); `role_permissions` unchanged; all new tables empty; existing table counts unchanged vs preflight;
  `10-adblue-vendors-post-apply.sql` row 10/11 still OK (it classifies every deletable table — the new tables must be
  "owner/dev" only, since `expenses:delete` is Dev's).
- **`29-expense-import-reconciliation.sql`** (2B, read-only): per batch — counts and Σ amounts per section × month,
  broker outstanding per broker, items by outcome.
- Backup / inventory / reset scripts (`02`, `03`, `04`, `05`) extended with the new tables (as done for
  `vehicle_company_periods`).

## 13. Decisions needed before Phase 2B

1. Run (or approve running) `26-phase2a-inventory.sql` on Production.
2. Locked-month adjustments: none, or Dev-only unlock with reason (§8) — recommended: Dev-only unlock.
3. Road tax / insurance in Payments vouchers vs Expense — keep separate and avoid double entry (§5.4).
4. Approve the single `expense.records` table for the four register sections + separate broker tables (§6).
5. Driver history reading: `module_resource('Drivers')` → `vehicles` (Employee may read driver history) (§5.3).
6. Which browsers / computers hold Phase 1 data (each becomes an import batch), and whether to rebuild the 8 records
   removed on 27 Nov.

*Phase 2 is not complete — this is the audit and design only.*
