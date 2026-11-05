/**
 * Runnable check for roles and permission boundaries:  npm run check:roles
 * Dev = every Owner permission, including the Owner-level controls (month lock, locked-month edits, deletion review,
 * restore), plus the Dev-only resources (accounts, system) that no other role can ever reach (owner, 3 Nov 2026).
 * Existing roles' permissions are pinned so a change to one role can't silently move another. Real API, in-memory data.
 */
import assert from "node:assert/strict"
import { checkTanker, setRole, storage } from "./test-browser"

async function main() {
  const { api } = await import("./index")
  const { can, RESOURCES, DEV_ONLY, ROLES, roleLabel, hasOwnerAuthority } = await import("@/lib/permissions")
  const { currentRole } = await import("@/lib/app-state")
  const { canEditMonth } = await import("@/domain/month-lock")
  const { actorLabel } = await import("@/domain/audit")
  const { todayISO } = await import("@/lib/format")
  const actions = ["view", "create", "edit", "delete", "finance"] as const

  /* ---------------------------------------------------------------- 1–4. Permission matrix */
  for (const r of RESOURCES)
    for (const a of actions) {
      assert.ok(can("DEV", r, a), `DEV has ${r}:${a}`) // Dev: everything
      // The Owner: every business module, never a Dev-only resource (account / system administration).
      assert.equal(can("OWNER", r, a), !DEV_ONLY.includes(r), `OWNER ${r}:${a}`)
    }
  assert.deepEqual([...DEV_ONLY], ["accounts", "system"])
  for (const role of ["OWNER", "EMPLOYEE"] as const) for (const r of DEV_ONLY) assert.equal(can(role, r, "view"), false, `${role} never reaches ${r}`)
  assert.ok(hasOwnerAuthority("OWNER") && hasOwnerAuthority("DEV") && !hasOwnerAuthority("EMPLOYEE"))
  assert.ok(can("OWNER", "audit") && can("DEV", "audit"))
  // Employee pinned; it gained nothing when Accountant and Operations Manager were removed, and audit:view (read-only,
  // its own modules' events) at the owner's instruction, 5 Nov 2026.
  const before: Record<string, string[]> = {
    EMPLOYEE: ["dashboard:view", "vehicles:view", "trips:view", "trips:create", "trips:edit", "diesel:view", "diesel:create", "diesel:edit", "audit:view"],
  }
  for (const [role, perms] of Object.entries(before))
    for (const r of RESOURCES)
      for (const a of actions) assert.equal(can(role as never, r, a), perms.includes(`${r}:*`) || perms.includes(`${r}:${a}`), `${role} ${r}:${a} changed`)
  // Only three roles (owner, 31 Oct 2026); the removed ones still label the audit events recorded under them.
  assert.deepEqual(ROLES.map((r) => r.value), ["OWNER", "DEV", "EMPLOYEE"])
  assert.equal(roleLabel("DEV"), "Dev")
  assert.equal(roleLabel("ACCOUNTANT"), "Accountant (former role)")
  // A browser still holding a removed role acts as an Employee — never the unknown-role fallback to Owner.
  for (const legacy of ["ACCOUNTANT", "OPS_MANAGER"] as const) {
    setRole(legacy)
    assert.equal(currentRole(), "EMPLOYEE")
    assert.equal(storage.getItem("vt:ui:role"), legacy) // the stored value is left as it was
  }
  setRole("OWNER")
  // Sidebar (owner, 4 Nov 2026): Dev sees everything; the Owner and the Employee only Fuel + the Audit Log (with permission).
  const { NAV_ITEMS, showInNav } = await import("@/components/layout/nav")
  const shown = (role: (typeof ROLES)[number]["value"]) => NAV_ITEMS.filter((i) => can(role, i.resource) && showInNav(role, i)).map((i) => i.title)
  const fuel = NAV_ITEMS.filter((i) => i.group === "Fuel").map((i) => i.title)
  assert.deepEqual(shown("DEV"), NAV_ITEMS.map((i) => i.title))
  assert.deepEqual(shown("OWNER"), [...fuel, "Audit Log"], "OWNER sidebar: Fuel + Audit Log; no Settings, no other section")
  assert.deepEqual(shown("OWNER"), ["Fuel Stations", "Diesel", "Diesel Tankers", "AdBlue", "Audit Log"])
  assert.deepEqual(shown("EMPLOYEE"), [...fuel, "Audit Log"], "EMPLOYEE sidebar: Fuel + Audit Log (read-only); no Settings, no other section")
  assert.deepEqual(shown("EMPLOYEE"), ["Fuel Stations", "Diesel", "Diesel Tankers", "AdBlue", "Audit Log"])
  // Visibility only: the hidden modules keep every permission (direct URLs and the API behave as before).
  for (const r of ["dashboard", "customers", "vehicles", "trips", "invoices", "payments", "reports", "settings", "audit"] as const) assert.ok(can("OWNER", r), `OWNER keeps ${r}`)
  assert.ok(can("EMPLOYEE", "audit") && !can("EMPLOYEE", "audit", "edit") && !can("EMPLOYEE", "settings") && can("EMPLOYEE", "trips") && can("EMPLOYEE", "dashboard"), "EMPLOYEE permissions unchanged")

  // Phone tab bar: four of the role's own items; "More" (the drawer) holds the rest of that same list.
  const { mobileTabs, navFor, isActive } = await import("@/components/layout/nav")
  const tabs = (role: (typeof ROLES)[number]["value"]) => mobileTabs(role).map((i) => i.title)
  assert.deepEqual(tabs("DEV"), ["Dashboard", "Trips", "Diesel", "Invoices"], "Dev's tabs")
  assert.deepEqual(tabs("OWNER"), ["Fuel Stations", "Diesel", "Diesel Tankers", "AdBlue"], "Owner's tabs (Audit Log under More)")
  assert.deepEqual(tabs("EMPLOYEE"), ["Fuel Stations", "Diesel", "Diesel Tankers", "AdBlue"], "Employee's tabs")
  for (const r of ROLES) {
    assert.equal(mobileTabs(r.value).length, 4, `${r.label}: four tabs`)
    for (const t of mobileTabs(r.value)) assert.ok(can(r.value, t.resource) && navFor(r.value).includes(t), `${r.label}: tab ${t.title} is one of its own sidebar items`)
    assert.deepEqual(navFor(r.value).map((i) => i.title), shown(r.value), `${r.label}: the drawer behind More is the full sidebar`)
  }
  assert.ok(isActive("/diesel/minda/2026-11", "/diesel") && isActive("/fuel-stations/dv_tanker", "/fuel-stations"), "a tab stays active on its sub-pages")
  assert.ok(!isActive("/dashboard", "/diesel") && isActive("/dashboard", "/dashboard"), "…and only its own pages")
  // The Monthly Sheet Lock bypass: the Owner and Dev, never the Employee.
  assert.equal(canEditMonth("OWNER", "2020-01", todayISO(), []), true)
  assert.equal(canEditMonth("DEV", "2020-01", todayISO(), []), true)
  assert.equal(canEditMonth("EMPLOYEE", "2020-01", todayISO(), []), false)

  /* ---------------------------------------------------------------- 6. Role persistence (mock session) */
  setRole("DEV")
  assert.equal(currentRole(), "DEV")
  assert.equal(storage.getItem("vt:ui:role"), "DEV") // survives refreshes: it lives in vt:ui:role

  /* ---------------------------------------------------------------- 1 / 8. Dev does every full-access action, attributed to Dev */
  const today = todayISO()
  const month = today.slice(0, 7)
  const vehicle = (await api.vehicles.list()).find((v) => v.status === "ACTIVE" && v.fuelType === "DIESEL" && v.assignedCustomerId)!
  const odo = Math.max(vehicle.odometerKm, ...(await api.diesel.list()).filter((e) => e.vehicleId === vehicle.id).map((e) => e.odometerKm ?? 0)) + 500
  const fill = (litres: number) => ({ date: today, vehicleId: vehicle.id, customerId: vehicle.assignedCustomerId, vendorId: "dv_raghuveer", litres, rate: 95, odometerKm: odo, billNo: "DEV", paymentMode: "CREDIT" as const })
  const ids: string[] = []
  const track = <T extends { id: string }>(x: T) => (ids.push(x.id), x)

  const entry = track(await api.diesel.create(fill(100)))
  await api.diesel.update(entry.id, fill(110), "Incorrect litres entered")
  const TK = await checkTanker()
  const load = track(await api.tankerLoads.create({ tankerId: TK, date: today, stationId: "dv_lakshmitha", invoiceNo: "DEV-L", litres: 500, rate: 95, notes: "" }))
  const disp = track(await api.tankerDispenses.create({ tankerId: TK, date: today, vehicleNo: "KA01AB1234", litres: 50, notes: "Dev check" }))
  const purchase = track(await api.adbluePurchases.create({ date: today, vendorName: "Dev Check Chemicals", product: "AdBlue", buckets: 2, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" }))
  const pay = track(await api.fuelStationPayments.create({ stationId: "dv_raghuveer", paymentDate: today, amount: 1000, paymentMode: "NEFT", notes: "", companyCode: "VT" }))
  await api.fuelStationPayments.update(pay.id, { paymentDate: today, amount: 1200, paymentMode: "NEFT", notes: "" }, "Wrong amount")
  const trip = (await api.trips.list()).find((t) => !t.invoiceId && t.date.startsWith(month))!
  await api.trips.update(trip.id, { date: trip.date, customerId: trip.customerId, vehicleId: trip.vehicleId, driverId: trip.driverId, route: trip.route, startKm: trip.startKm, endKm: trip.endKm, tollParking: trip.tollParking, status: trip.status, notes: "Dev edit" })
  const customer = (await api.customers.list()).find((c) => c.status === "ACTIVE")!
  await api.customers.archive(customer.id)
  await api.customers.restore(customer.id)
  const st = track(await api.fuelStations.create({ name: "Dev Check Fuels" }))
  await api.settings.update({ tdsRate: (await api.settings.get()).tdsRate })
  // Deletes — Dev has the delete permission everywhere (mandatory reason, month lock as usual).
  await api.tankerDispenses.remove(disp.id, "Dev check cleanup")
  await api.tankerLoads.remove(load.id, "Dev check cleanup")
  await api.adbluePurchases.remove(purchase.id, "Dev check cleanup")
  await api.fuelStationPayments.remove(pay.id, "Dev check cleanup")
  await api.diesel.remove(entry.id, "Dev check cleanup")
  await api.trips.remove(trip.id, "Dev check cleanup")
  assert.ok(st.id)

  /* ---------------------------------------------------------------- 2 / 7. Dev holds every Owner-level control, recorded as DEV */
  const lastMonthEntry = (await api.diesel.list()).find((e) => e.date < `${month}-01` && e.vendorId !== "dv_tanker")!
  assert.equal(typeof (await api.audit.unreviewedDeletions()), "number") // the deletion badge
  const lock = await api.monthLocks.set(month, "LOCKED")
  assert.equal(lock.changedBy, "DEV", "a Dev lock is recorded as Dev, never Owner")
  await api.monthLocks.set(month, "OPEN")
  // Dev changes data in a locked (past) month, like the Owner.
  await api.diesel.update(lastMonthEntry.id, { date: lastMonthEntry.date, vendorId: lastMonthEntry.vendorId, litres: lastMonthEntry.litres + 1, rate: lastMonthEntry.rate, odometerKm: lastMonthEntry.odometerKm, billNo: lastMonthEntry.billNo, paymentMode: lastMonthEntry.paymentMode }, "Dev correcting a closed month")
  assert.equal((await api.diesel.get(lastMonthEntry.id))!.litres, lastMonthEntry.litres + 1)
  await api.diesel.update(lastMonthEntry.id, { date: lastMonthEntry.date, vendorId: lastMonthEntry.vendorId, litres: lastMonthEntry.litres, rate: lastMonthEntry.rate, odometerKm: lastMonthEntry.odometerKm, billNo: lastMonthEntry.billNo, paymentMode: lastMonthEntry.paymentMode }, "Dev undoing the check")
  assert.ok((await api.audit.history(entry.id)).length >= 3)
  // Dev reviews and restores a deletion (the same Owner-level control the Owner has).
  const devLog = await api.audit.list()
  assert.ok(new Set(devLog.map((e) => e.module)).size >= 5)
  const devDel = devLog.find((e) => e.recordId === entry.id && e.action === "DELETED")!
  assert.deepEqual([devDel.reason, devDel.actor.role], ["Dev check cleanup", "DEV"])
  assert.ok((await api.audit.checkRestore(devDel.id)).ok)
  assert.equal(await api.audit.markReviewed([devDel.id]), 1)
  const devReview = (await api.audit.list()).find((e) => e.id === devDel.id)!.review!
  assert.equal(devReview.actor.role, "DEV", "the review is recorded as Dev")
  await api.audit.restoreDeleted(devDel.id, "Dev restoring the deletion")
  assert.ok(await api.diesel.get(entry.id))
  const restoredEv = (await api.audit.list()).find((e) => e.restoresEventId === devDel.id)!
  assert.equal(restoredEv.actor.role, "DEV")
  await api.diesel.remove(entry.id, "Dev check cleanup again")

  /* ---------------------------------------------------------------- 8. Audit events name Dev — never Owner or another role */
  setRole("OWNER")
  const log = await api.audit.list()
  const devEvents = log.filter((e) => ids.includes(e.recordId) || e.recordId === trip.id || e.recordId === customer.id || e.recordId === "settings")
  assert.ok(devEvents.length >= 15)
  assert.ok(devEvents.filter((e) => e.actor.kind === "SESSION").every((e) => e.actor.role === "DEV"), "every Dev action is recorded as DEV")
  assert.equal(actorLabel(devEvents[0].actor), "Dev (unverified session)")
  assert.deepEqual([...new Set(devEvents.map((e) => e.action))].sort(), ["ARCHIVED", "CREATED", "DELETED", "PAYMENT_RECORDED", "RESTORED", "UPDATED"])
  // The Owner keeps every Owner-level control too.
  assert.ok(typeof (await api.audit.unreviewedDeletions()) === "number")
  const delEntry = log.filter((e) => e.recordId === entry.id && e.action === "DELETED").at(0)!
  assert.equal(delEntry.actor.role, "DEV")
  await api.audit.restoreDeleted(delEntry.id, "Owner restoring the Dev deletion")
  assert.ok(await api.diesel.get(entry.id))
  await api.monthLocks.set(month, "OPEN")
  // Earlier events keep their recorded role.
  assert.ok((await api.audit.list()).some((e) => e.action === "DATA_RESET" && e.actor.kind === "SYSTEM"))

  /* ---------------------------------------------------------------- 9. Every write is permission-checked in the API, not only hidden */
  {
    const refused = /can't|Only the Owner or Dev/
    // Employee (the only non-Owner, non-Dev role since 31 Oct 2026): logs trips and diesel, and may add a pump while doing
    // so; no master data, money, settings, drivers, invoices, payments, or workspace reset / clear / restore.
    const driver = await api.drivers.create({ name: "Roles Check Driver", phone: "", licenseNo: "", licenseValidTill: "", companyCode: "VT", status: "ACTIVE" })
    setRole("EMPLOYEE")
    await assert.rejects(api.vehicles.create({} as never), refused)
    await assert.rejects(api.vehicles.archive(vehicle.id), refused)
    await assert.rejects(api.vehicles.update(vehicle.id, { notes: "x" }), refused)
    await assert.rejects(api.customers.create({} as never), refused)
    await assert.rejects(api.customers.archive((await api.customers.list())[0].id), refused)
    await assert.rejects(api.invoices.create({} as never), refused)
    await assert.rejects(api.payments.create({ direction: "IN", vehicleId: null } as never), refused)
    await assert.rejects(api.fuelStationPayments.recordTds({} as never), refused)
    await assert.rejects(api.drivers.update(driver.id, { status: "INACTIVE" }), refused)
    await assert.rejects(api.settings.update({ companies: [] }), refused)
    await assert.rejects(api.settings.update({ vehicleTypes: (await api.settings.get()).vehicleTypes }), refused)
    await assert.rejects(api.admin.resetDemoData(), refused)
    await assert.rejects(api.admin.clearAllData(), refused)
    await assert.rejects(api.admin.restoreBackup({}, "x.json"), refused)
    const pump = await api.fuelStations.create({ name: "Roles Check Pump" })
    // Fuel Stations → station → Add Payment and Opening Balance (owner, 5 Nov 2026) — not TDS, edits or deletes.
    const empPay = await api.fuelStationPayments.create({ stationId: pump.id, paymentDate: today, amount: 250, paymentMode: "CASH", notes: "", companyCode: "VT" })
    await assert.rejects(api.fuelStationPayments.update(empPay.id, { paymentDate: today, amount: 300, paymentMode: "CASH", notes: "" }), refused)
    await assert.rejects(api.fuelStationPayments.remove(empPay.id, "Employee attempt"), refused)
    assert.equal((await api.fuelStations.setOpeningBalance(pump.id, { amount: 500, date: today })).openingBalance, 500)
    setRole("OWNER")
    assert.equal((await api.audit.list()).find((e) => e.recordId === empPay.id)?.actor.role, "EMPLOYEE")
  }

  /* ---------------------------------------------------------------- Regression: a data reset never changes who you are */
  // clearAll used to wipe vt:ui:role, which then fell back to Owner — a reset promoted whoever ran it.
  setRole("DEV")
  await api.admin.resetDemoData()
  assert.equal(currentRole(), "DEV")
  assert.equal(typeof (await api.audit.unreviewedDeletions()), "number") // still Dev, still Owner-level authority
  setRole("EMPLOYEE")
  await assert.rejects(api.audit.unreviewedDeletions(), /Only the Owner or Dev/)
  await assert.rejects(api.monthLocks.set(month, "LOCKED"), /Only the Owner or Dev/)
  await assert.rejects(api.audit.restoreDeleted("x", "Employee attempt"), /Only the Owner or Dev/)
  setRole("OWNER")
  const reset = (await api.audit.list())[0]
  assert.deepEqual([reset.action, reset.actor.role], ["DATA_RESET", "DEV"])

  console.log("roles: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
