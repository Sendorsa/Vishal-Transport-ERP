# Supabase ER Diagram: Vishal Transport ERP

> **Superseded for the Diesel phase (31 Oct 2026)** by `SUPABASE_DIESEL_DATABASE_SCHEMA.md` (authoritative schema, SQL in `supabase/migrations/20261101*` — design approved 1 Nov 2026, not applied to any Supabase project) and `SUPABASE_DIESEL_MIGRATION_PLAN.md` (no data import). Kept for the full-ERP context and the D-numbered decisions it introduced; where the two differ, the Diesel documents win.

**Design only.** The tables are proposed in `SUPABASE_DATABASE_ARCHITECTURE.md`; none exists in the live project.

**Cardinality notation:** `||--o{` = one to zero-or-more; `|o--o{` = optional parent.

## 1. Masters, configuration and accounts

```mermaid
erDiagram
    companies ||--o{ customers : "company_code"
    companies ||--o{ vehicles : "company_code"
    companies ||--o{ drivers : "company_code"
    companies |o--o{ companies : "parent_code"
    vehicle_types ||--o{ vehicles : "type_code"
    drivers |o--o{ vehicles : "default_driver_id"
    customers ||--o{ customer_route_rates : "pricing routes"
    customers ||--o{ customer_status_periods : "status history"
    vehicles ||--o{ vehicle_status_periods : "status history"
    vehicles ||--o{ vehicle_assignments : "assigned over time"
    customers |o--o{ vehicle_assignments : "customer_id (null = spare)"
    customers |o--o{ vehicles : "assigned_customer_id (cache)"
    vehicles |o--o| tankers : "vehicle_id (tanker vehicle)"
    profiles }o--|| role_permissions : "role"

    companies {
        text code PK
    }
    customers {
        text id PK
        text code UK
        text company_code FK
        entity_status status
    }
    vehicles {
        text id PK
        text reg_no UK
        text type_code FK
        fuel_type fuel_type
        text assigned_customer_id FK
    }
    vehicle_assignments {
        text id PK
        text vehicle_id FK
        text customer_id FK
        date start_date
        date end_date
    }
    fuel_stations {
        text id PK
        text name UK
        bool is_tanker
        numeric opening_balance
        date opening_balance_date
    }
    tankers {
        text id PK
        text name UK
        text reg_no UK "null = stock pool"
        text vehicle_id FK
    }
    profiles {
        uuid id PK
        uuid user_id FK
        erp_role role
        account_status status
    }
```

## 2. Fuel: diesel, tankers and AdBlue

```mermaid
erDiagram
    vehicles ||--o{ diesel_entries : "vehicle_id"
    customers |o--o{ diesel_entries : "customer_id (stamp)"
    fuel_stations ||--o{ diesel_entries : "station_id (pump, or dv_tanker)"
    tankers |o--o{ diesel_entries : "tanker_id (tanker fills only)"
    companies ||--o{ diesel_entries : "company_code"

    tankers ||--o{ tanker_loads : "tanker_id"
    fuel_stations |o--o{ tanker_loads : "station_id (null = opening stock)"
    tankers ||--o{ tanker_dispenses : "tanker_id (history)"
    tankers ||--o{ tanker_transfers : "from_tanker_id"
    tankers ||--o{ tanker_transfers : "to_tanker_id"
    tankers ||--o{ tanker_adjustments : "tanker_id"

    vehicles ||--o{ adblue_entries : "vehicle_id"
    customers |o--o{ adblue_entries : "customer_id"
    fuel_stations |o--o{ adblue_entries : "legacy_station_id"

    diesel_entries {
        text id PK
        date date
        text station_id FK
        text tanker_id FK
        numeric litres
        numeric rate
        numeric amount
        payment_mode payment_mode
    }
    tanker_loads {
        text id PK
        text tanker_id FK
        text station_id FK
        bool opening
        numeric litres
        numeric amount
    }
    tanker_transfers {
        text id PK
        text from_tanker_id FK
        text to_tanker_id FK
        numeric litres
    }
    tanker_adjustments {
        text id PK
        text tanker_id FK
        numeric litres
        text reason
    }
    adblue_purchases {
        text id PK
        date date
        text vendor_name
        numeric total_litres
        numeric total_cost
        bool opening
    }
    adblue_entries {
        text id PK
        adblue_source source
        text vehicle_id FK
        numeric quantity_litres
        numeric amount
    }
```

`adblue_purchases` has no foreign key: AdBlue vendors are free text (no vendor master), and stock is one pool.

**How the fuel tables relate to money:**
- **Station purchases** = `diesel_entries` at a real station + non-opening `tanker_loads`.
- **A tanker fill** (`station_id = dv_tanker`) is **never** a purchase.

## 3. Trips, invoices and payments

```mermaid
erDiagram
    customers ||--o{ trips : "customer_id"
    vehicles ||--o{ trips : "vehicle_id"
    drivers |o--o{ trips : "driver_id"
    invoices |o--o{ trips : "invoice_id (billing lock)"
    customers ||--o{ invoices : "customer_id"
    companies ||--o{ invoices : "company_code"
    invoices ||--|{ invoice_lines : "lines"
    vehicles |o--o{ invoice_lines : "vehicle_id"
    invoice_lines ||--o{ invoice_line_trips : "trips on the line"
    trips ||--o{ invoice_line_trips : "trip_id"

    companies ||--o{ payments : "company_code"
    customers |o--o{ payments : "customer_id (receipts)"
    fuel_stations |o--o{ payments : "station_id (station payments, TDS)"
    vehicles |o--o{ payments : "vehicle_id (maintenance)"
    expense_categories |o--o{ payments : "category_code"
    payments ||--o{ payment_allocations : "allocations"
    invoices ||--o{ payment_allocations : "settled by"

    trips {
        text id PK
        text trip_no UK
        date date
        numeric revenue
        text invoice_id FK
    }
    invoices {
        text id PK
        text invoice_no UK
        invoice_status status
        numeric total
    }
    payments {
        text id PK
        text payment_no UK
        direction direction
        date date
        numeric amount
        numeric tds_amount
        payment_mode mode
        char7 for_month
    }
    payment_allocations {
        text payment_id PK
        text invoice_id PK
        numeric amount
    }
```

## 4. System and audit

```mermaid
erDiagram
    profiles |o--o{ month_locks : "changed_by"
    profiles |o--o{ audit_events : "actor_user_id"
    audit_events |o--o| audit_events : "restores_event_id (one restore per deletion)"
    audit_events ||--o| audit_reviews : "event_id (Owner review)"
    profiles |o--o{ audit_reviews : "actor_user_id"

    month_locks {
        text id PK
        char7 month UK
        lock_state state
    }
    audit_events {
        text id PK
        timestamptz at
        audit_action action
        text module
        text record_id "no FK: deleted records"
        jsonb before
        jsonb after
    }
    audit_reviews {
        text event_id PK
    }
    document_sequences {
        text prefix PK
        int last_value
    }
    migration_runs {
        text id PK
        text source_sha256 UK
    }
```

**`audit_events.record_id` has no foreign key on purpose.** A DELETED event outlives its record, and the audit trail must never block or cascade a delete.
