# Diesel calculations — audit

Every fuel number in the prototype, where it comes from and how it is computed.
Run `npm run check:diesel` to verify the core formulas.

## 1. KM Run discrepancy — root cause (fixed)

| | Before | After |
|---|---|---|
| KM Run in Diesel KPIs | Σ `trip.distanceKm` of **completed trips** for the vehicle / customer / month | Σ **KM since last fill** from fill odometers |
| "KM since last fill" column | odometer − previous fill odometer | unchanged — now the **same** function feeds KPIs and table |

**Root cause.** The KPI cards read trip sheets, while the table read fill odometers.

**Example:** KA05NK5115 (customer Apple).
- **Data:** three fills (500 → 1,800 → 2,700 km, ₹24,000, 240 L) and **zero trips**.
- **Before the fix:** KM Run = 0, so Diesel Cost per KM and KM/L were blank.
- **After the fix:** KM Run = 1,300 + 900 = **2,200 km**, Diesel Cost per KM = ₹24,000 ÷ 2,200 = **₹10.91**, KM/L = 2,200 ÷ 240 = **9.17**.

Trips are no longer used for any Diesel figure. They only supply the usual driver shown on a vehicle.

## 2. Building blocks

All of these are in `src/domain/diesel.ts`. They work on fuel entries (localStorage `vt:fuelEntries`), with these fields:
- `date`
- `vehicleId`
- `customerId` (the customer the fuel is costed to)
- `vendorId` (fuel station, `vt:fuelStations`)
- `litres` (kWh for EV vehicles)
- `rate`
- `amount`
- `odometerKm`

**Fuel type is not stored on entries.** It is read from the vehicle (`vt:vehicles` → `fuelType`: `DIESEL` | `PETROL` | `EV`). The entry form shows it read-only. Because the module is fuel-agnostic, it can be renamed "Fuel" without any data change.

| Value | Formula | Code |
|---|---|---|
| Fill amount | `litres × rate`, rounded to paise, recomputed on every save | `api.diesel.create` / `api.diesel.update` in `src/lib/api/index.ts` |
| Previous odometer | odometer of the same vehicle's previous fill, ordered by `date` then `odometerKm`, across **all** customers and months. `null` for the vehicle's first fill. | `buildDieselIndex` → `prevOdometer` |
| KM since last fill | `odometerKm − previous odometer` (`null` for the first fill). Negative (typing error) is shown in red and counted as 0. | `fillRow` |
| KM Run | Σ KM since last fill over the fills in scope | `statsOf` |
| Total Spend | Σ `amount` of all fills in scope (Diesel, Petrol, EV) | `statsOf` |
| Total Litres | Σ `litres` of fills by Diesel or Petrol vehicles | `statsOf` + `isLiquid` |
| EV units | Σ `litres` (kWh) of fills by EV vehicles — never mixed into litres | `statsOf` → `kwh` |
| Diesel Cost per KM | Total Spend ÷ KM Run (blank if KM Run = 0) | `statsOf` → `costPerKm` |
| KM per Litre | KM Run of Diesel/Petrol vehicles ÷ Total Litres | `statsOf` → `kmpl` |
| Avg rate ₹/L | Diesel/Petrol spend ÷ Total Litres | `statsOf` → `avgRate` |

**What "in scope" means.** Scope is fills of one vehicle (or all vehicles) costed to one customer, dated in one month.
- **Previous fill is outside the month:** its gap still counts, because the gap ends at a fill inside the month.
- **Previous fill is for another customer:** same rule. The km driven after another customer's fill is charged to the customer of the fill that closes the gap.

## 3. Where each figure appears

| Screen → KPI | Function | Notes |
|---|---|---|
| **Diesel landing** → Diesel Spend, Total Diesel Litres, Average Diesel Cost per KM; AdBlue row; Vehicle / Customer Count | `buildMaster(…, inPeriod(month))` | Same numbers as the Monthly Master. Diesel Spend delta: previous month, or same days of it while the month is in progress. |
| Diesel landing → customer card spend / change | `customerCards` → `groupMonth` | |
| **Customer page** → Total Diesel Spend, Total KM Run, Diesel Cost per KM, Average KM per Litre | `groupMonth(customer, month)` → `statsOf` over all the customer's fills | The ⓘ tooltip shows the formula with the actual numbers (`kpiExplain` in `src/features/diesel/parts.tsx`) |
| Customer page → Vehicle Count | `groupMonth` → vehicles with a fill or trip (current month: plus assigned vehicles) | |
| Customer page → vehicle cards | `vehicleMonthFrom` → `statsOf` over that vehicle's fills for the customer | |
| **Vehicle page** → Diesel Spend, Litres Filled, KM Run, Diesel Cost per KM, KM per Litre | `vehicleMonth` → `statsOf` | The tooltip shows numbers. The entries table shows previous odometer, odometer and KM since last fill for each fill (`fillRow`), the same values that are summed. |
| Vehicle page → Monthly history | `vehicleMonth` for each month | Same formulas per month |
| **Ledger** → Diesel Spend, Litres Filled | Σ `amount` / Σ `litres` of all fills dated in the month | `src/features/diesel/diesel-view.tsx` |
| Ledger → Vendor Payables | Σ credit fill `amount` − Σ payments with category `DIESEL_SETTLEMENT`, all time | `vendorPayables` in `src/domain/analytics.ts` |

## 4. Outside the Diesel module (company-scoped, trip-based)

These use the VT / VTHPL selector and are **not** the Diesel module's definition of km:

| Screen → KPI | Formula | Code |
|---|---|---|
| Dashboard → Diesel cost | Σ fill `amount` dated in period | `dieselInRange` in `src/domain/analytics.ts` |
| Dashboard → Diesel / km, Fleet kmpl ("Ready to bill" card) | Diesel cost ÷ **trip km**, trip km ÷ litres | `src/features/dashboard/dashboard-view.tsx` |
| Dashboard / Reports → Expenses, P&L "Diesel" line | Σ fill `amount` dated in period | `expensesInRange`, `profitAndLoss` |
| Reports → Vehicle profitability "Diesel" | Σ fill `amount` of the vehicle in period | `vehicleProfitability` |

The dashboard's Diesel / km uses trip-sheet km (accrual view, matches billing). It can differ from the Diesel module's odometer-based figure when trips aren't recorded. Change it to the odometer basis if the owner should see one number.

## 5. Known limits

- **Odometer readings are trusted as typed.** A missing or wrong reading changes KM Run; a reading lower than the previous fill is shown as an error on the vehicle page and counted as 0.
- **A vehicle's first fill ever has no previous reading**, so its km is unknown (shown as "first fill") and isn't counted.

## 6. AdBlue (inventory, separate from diesel)

AdBlue is bought in bulk into inventory (`vt:adBluePurchases`) and drawn by vehicles (`vt:adBlueEntries`). Diesel functions never read either, so diesel litres, spend, KM Run and km/L are unaffected. Formulas are in `src/domain/adblue-inventory.ts` (stock, weighted average, ledger) and `src/domain/adblue.ts` (KM Run per vehicle).

| Value | Formula |
|---|---|
| Purchase litres / cost | Buckets × Litres per Bucket / Buckets × Price per Bucket |
| Draw cost (entry `amount`) | Litres × moving weighted-average rate at the draw (derived on read; e.g. 15 L × ₹45 = ₹675) |
| Current Stock | Σ purchased litres − Σ drawn litres (never below 0 at any point in time) |
| Inventory Value | Remaining stock × weighted-average rate (= Σ purchase cost − Σ draw cost) |
| Monthly ledger | Opening + Purchased − Consumed = Closing; Closing → next Opening |
| Previous Odometer / KM Run | Same vehicle's previous AdBlue entry; KM Run = Closing − Previous (— for the first) |
| KM per Litre / Cost per KM | Σ KM Run ÷ Σ litres / Σ draw cost ÷ Σ KM Run (entries with a KM Run) |

**Where it shows.** Every figure is for the selected period, always next to diesel and never added to it, except in the clearly labelled **Running Fluid** total:
- **Vehicle, customer and master pages:** AdBlue litres and AdBlue Spend (the draw cost at the weighted average).
- **AdBlue Inventory page:** stock, value, ledger, purchases, vendors and reconciliation.
- **Dashboard:** stock, value, this month's consumption and the low-stock warning.

AdBlue never appears in fuel station figures or ledgers.

**Running Fluid** (Monthly, Quarterly and Yearly Master; `fluidOf` in `src/domain/fuel-master.ts`):

| Value | Formula |
|---|---|
| Running Fluid Cost | Diesel Spend + AdBlue Spend (AdBlue = draw cost at weighted average), for the page, each customer, each vehicle and each month |
| Running Fluid Volume | Diesel Litres + AdBlue Litres (Diesel Litres exclude EV kWh) |

The separate Diesel and AdBlue figures are always shown next to it.

## 7. Data sources per screen (AdBlue aggregation audit, Oct 2026)

| Screen | Diesel source | AdBlue source | Aggregation |
|---|---|---|---|
| Diesel landing: KPIs, Running Fluid | `vt:fuelEntries` via `useDieselIndex` | `vt:adBlueEntries` (amount = draw cost from `vt:adBluePurchases`) via `useAdBlueEntries` → `withRuns` | `buildMaster(…, inPeriod(month))` in `diesel-overview.tsx` |
| Diesel landing: customer cards | `vt:fuelEntries` | — (diesel spend only) | `customerCards` |
| Monthly Master | same | same | `buildMaster(…, inPeriod(month))` in `master-sheets.tsx` |
| Yearly Master | same | same | `buildMaster(…, inPeriod(year))`, plus one per month |
| Customer page summary and vehicle cards | `groupMonth` / `vehicleMonth` | `adBlueStats` on entries with this customer and month | `company-diesel.tsx` |
| Vehicle page summary | `vehicleMonth` | `adBlueStats` on entries with this vehicle, customer and month | `vehicle-diesel.tsx` |

Saving an AdBlue entry invalidates the `adblue_entries` query, so every screen above recomputes without a reload.
