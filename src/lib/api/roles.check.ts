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
  const { can, RESOURCES, DEV_ONLY, ROLES, roleLabel, hasOwnerAuthority, canBypassMonthLock, canSetMonthLock, canChangeAdBluePurchases, isAdBlueProfile } = await import("@/lib/permissions")
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
      // The Employee (owner, 5 Nov 2026): exactly the Owner, except Settings.
      assert.equal(can("EMPLOYEE", r, a), can("OWNER", r, a) && r !== "settings", `EMPLOYEE ${r}:${a}`)
    }
  assert.deepEqual([...DEV_ONLY], ["accounts", "system"])
  for (const role of ["OWNER", "EMPLOYEE"] as const) for (const r of DEV_ONLY) assert.equal(can(role, r, "view"), false, `${role} never reaches ${r}`)
  assert.ok(hasOwnerAuthority("OWNER") && hasOwnerAuthority("DEV") && hasOwnerAuthority("EMPLOYEE"))
  assert.ok(can("OWNER", "audit") && can("DEV", "audit") && can("EMPLOYEE", "audit"))
  // Owner, Dev, Employee (owner, 31 Oct 2026) and the two AdBlue profiles (11 Nov 2026); the removed ones still label
  // the audit events recorded under them.
  assert.deepEqual(ROLES.map((r) => r.value), ["OWNER", "DEV", "EMPLOYEE", "TATA_ADBLUE", "ADBLUE"])
  assert.deepEqual([roleLabel("TATA_ADBLUE"), roleLabel("ADBLUE")], ["Tata Adblue", "Adblue"])
  // The AdBlue profiles (owner, 11 Nov 2026): Diesel read-only and AdBlue, nothing else — and no Owner-level control.
  for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) {
    assert.ok(isAdBlueProfile(role))
    for (const r of RESOURCES)
      for (const a of actions) assert.equal(can(role, r, a), r === "adblue" || (r === "diesel" && a === "view"), `${role} ${r}:${a}`)
    assert.ok(!hasOwnerAuthority(role) && !canSetMonthLock(role) && !canBypassMonthLock(role), `${role}: no Owner-level control`)
    assert.ok(!canChangeAdBluePurchases(role, "edit") && !canChangeAdBluePurchases(role, "delete"), `${role}: adds bulk purchases, never changes them`)
    assert.equal(canEditMonth(role, "2020-01", todayISO(), []), false, `${role} follows the month lock`)
  }
  for (const role of ["OWNER", "DEV", "EMPLOYEE"] as const) {
    assert.ok(!isAdBlueProfile(role))
    assert.ok(canChangeAdBluePurchases(role, "edit") && canChangeAdBluePurchases(role, "delete"), `${role} still edits / deletes AdBlue purchases`)
    for (const a of actions) assert.equal(can(role, "adblue", a), true, `${role} keeps AdBlue (adblue:${a})`)
  }
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
  for (const r of ["dashboard", "customers", "vehicles", "trips", "invoices", "payments", "reports", "audit"] as const) assert.ok(can("EMPLOYEE", r), `EMPLOYEE has ${r}`)
  assert.ok(!can("EMPLOYEE", "settings"), "EMPLOYEE: no Settings")

  // Phone tab bar: four of the role's own items; "More" (the drawer) holds the rest of that same list.
  const { mobileTabs, navFor, isActive } = await import("@/components/layout/nav")
  const tabs = (role: (typeof ROLES)[number]["value"]) => mobileTabs(role).map((i) => i.title)
  assert.deepEqual(tabs("DEV"), ["Dashboard", "Trips", "Diesel", "Invoices"], "Dev's tabs")
  assert.deepEqual(tabs("OWNER"), ["Fuel Stations", "Diesel", "Diesel Tankers", "AdBlue"], "Owner's tabs (Audit Log under More)")
  assert.deepEqual(tabs("EMPLOYEE"), ["Fuel Stations", "Diesel", "Diesel Tankers", "AdBlue"], "Employee's tabs")
  // The AdBlue profiles: AdBlue, then Diesel — the whole sidebar, drawer and tab bar.
  for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) {
    assert.deepEqual(navFor(role).map((i) => i.title), ["AdBlue", "Diesel"], `${role} sidebar`)
    assert.deepEqual(tabs(role), ["AdBlue", "Diesel"], `${role} tabs`)
    assert.deepEqual([...shown(role)].sort(), ["AdBlue", "Diesel"])
  }
  for (const r of ROLES) {
    assert.equal(mobileTabs(r.value).length, isAdBlueProfile(r.value) ? 2 : 4, `${r.label}: its tabs`)
    for (const t of mobileTabs(r.value)) assert.ok(can(r.value, t.resource) && navFor(r.value).includes(t), `${r.label}: tab ${t.title} is one of its own sidebar items`)
    if (!isAdBlueProfile(r.value)) assert.deepEqual(navFor(r.value).map((i) => i.title), shown(r.value), `${r.label}: the drawer behind More is the full sidebar`)
  }
  assert.ok(isActive("/diesel/minda/2026-11", "/diesel") && isActive("/fuel-stations/dv_tanker", "/fuel-stations"), "a tab stays active on its sub-pages")
  assert.ok(!isActive("/dashboard", "/diesel") && isActive("/dashboard", "/dashboard"), "…and only its own pages")
  // The Monthly Sheet Lock bypass: the Owner and Dev, never the Employee (owner, 5 Nov 2026) — who may still lock / unlock.
  assert.equal(canEditMonth("OWNER", "2020-01", todayISO(), []), true)
  assert.equal(canEditMonth("DEV", "2020-01", todayISO(), []), true)
  assert.equal(canEditMonth("EMPLOYEE", "2020-01", todayISO(), []), false)
  assert.ok(hasOwnerAuthority("EMPLOYEE") && !canBypassMonthLock("EMPLOYEE") && canBypassMonthLock("OWNER") && canBypassMonthLock("DEV"))
  // Locking / unlocking a month: the Owner and Dev only (owner, 11 Nov 2026); the Employee keeps every other Owner-level control.
  assert.ok(canSetMonthLock("OWNER") && canSetMonthLock("DEV") && !canSetMonthLock("EMPLOYEE"))

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
  assert.equal((await api.monthLocks.set(month, "LOCKED")).changedBy, "OWNER", "the Owner locks a month")
  assert.equal((await api.monthLocks.set(month, "OPEN")).changedBy, "OWNER", "…and unlocks it")
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
    // Employee (owner, 5 Nov 2026): the Owner's business access and Owner-level controls; refused Settings and (11 Nov 2026) month lock / unlock.
    const driver = await api.drivers.create({ name: "Roles Check Driver", phone: "", licenseNo: "", licenseValidTill: "", companyCode: "VT", status: "ACTIVE" })
    setRole("EMPLOYEE")
    await api.vehicles.update(vehicle.id, { notes: "Employee note" })
    const cust = (await api.customers.list())[0]
    await api.customers.archive(cust.id)
    await api.customers.restore(cust.id)
    await api.drivers.update(driver.id, { status: "INACTIVE" })
    await api.settings.update({ vehicleTypes: (await api.settings.get()).vehicleTypes }) // adding vehicle types from a vehicle form, like the Owner
    const pump = await api.fuelStations.create({ name: "Roles Check Pump" })
    assert.equal((await api.fuelStations.setOpeningBalance(pump.id, { amount: 500, date: today })).openingBalance, 500)
    const empPay = await api.fuelStationPayments.create({ stationId: pump.id, paymentDate: today, amount: 250, paymentMode: "CASH", notes: "", companyCode: "VT" })
    await api.fuelStationPayments.update(empPay.id, { paymentDate: today, amount: 300, paymentMode: "CASH", notes: "" })
    await api.fuelStationPayments.remove(empPay.id, "Employee correction")
    // Month lock / unlock — refused in the API (owner, 11 Nov 2026); the lock state stays readable.
    const locksBefore = await api.monthLocks.list()
    await assert.rejects(api.monthLocks.set(month, "LOCKED"), /Only the Owner or Dev can lock or unlock a month/)
    await assert.rejects(api.monthLocks.set(month, "OPEN"), /Only the Owner or Dev can lock or unlock a month/)
    assert.deepEqual(await api.monthLocks.list(), locksBefore, "an Employee lock / unlock saves nothing")
    // Settings — refused in the API.
    await assert.rejects(api.settings.update({ companies: [] }), refused)
    await assert.rejects(api.settings.update({ tdsRate: 3 }), refused)
    await assert.rejects(api.admin.resetDemoData(), refused)
    await assert.rejects(api.admin.clearAllData(), refused)
    await assert.rejects(api.admin.restoreBackup({}, "x.json"), refused)
    await assert.rejects(api.admin.exportBackup(), refused)
    await assert.rejects(api.admin.setupTankerMasters(), refused)
    setRole("OWNER")
    assert.deepEqual((await api.audit.history(empPay.id)).map((e) => [e.action, e.actor.role]), [["PAYMENT_RECORDED", "EMPLOYEE"], ["UPDATED", "EMPLOYEE"], ["DELETED", "EMPLOYEE"]])
  }

  /* ---------------------------------------------------------------- 9b. The AdBlue profiles: every write but AdBlue refused in the API */
  {
    const refused = /can't|Only the Owner or Dev/
    const cust = (await api.customers.list())[0]
    const pump = (await api.fuelStations.list()).find((x) => x.id !== "dv_tanker")!
    const ab = (await api.adblue.list()).find((e) => e.date.startsWith(month))
    const draw = { vehicleId: vehicle.id, customerId: vehicle.assignedCustomerId, date: today, closingKm: 9_999_999, quantityLitres: 1, invoiceNo: "", notes: "Profile check", source: "STOCK" as const }
    const bulk = { date: today, vendorName: "Profile Check Chemicals", product: "AdBlue", buckets: 1, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" }
    const tk = await checkTanker()
    for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) {
      setRole(role)
      assert.equal(currentRole(), role)
      // Diesel is read-only: every Diesel, tanker, station, payment and master write is refused before anything is saved.
      const fillsBefore = (await api.diesel.list()).length
      await assert.rejects(api.diesel.create(fill(10)), refused)
      await assert.rejects(api.diesel.update(lastMonthEntry.id, { date: lastMonthEntry.date, vendorId: lastMonthEntry.vendorId, litres: 1, rate: 1, odometerKm: lastMonthEntry.odometerKm, billNo: "", paymentMode: "CREDIT" }), refused)
      await assert.rejects(api.diesel.remove(lastMonthEntry.id, "Profile check"), refused)
      await assert.rejects(api.tankerLoads.create({ tankerId: tk, date: today, stationId: pump.id, invoiceNo: "", litres: 10, rate: 95, notes: "" }), refused)
      await assert.rejects(api.tankerLoads.createOpening({ tankerId: tk, date: today, litres: 10, value: 950, notes: "" }), refused)
      await assert.rejects(api.tankerTransfers.create({ date: today, fromTankerId: tk, toTankerId: tk, litres: 1, notes: "" }), refused)
      await assert.rejects(api.tankerAdjustments.create({ date: today, tankerId: tk, litres: 1, reason: "Profile check" }), refused)
      const tkr = (await api.tankers.list()).find((t) => t.id === tk)!
      await assert.rejects(api.tankers.update(tk, { name: tkr.name, regNo: tkr.regNo, vehicleId: tkr.vehicleId, capacityLitres: tkr.capacityLitres, notes: "x" }), refused)
      await assert.rejects(api.fuelStations.create({ name: "Profile Pump" }), refused)
      await assert.rejects(api.fuelStations.update(pump.id, { name: pump.name, location: "x", creditDays: 30 }), refused)
      await assert.rejects(api.fuelStations.setOpeningBalance(pump.id, { amount: 1, date: today }), refused)
      await assert.rejects(api.fuelStationPayments.create({ stationId: pump.id, paymentDate: today, amount: 1, paymentMode: "CASH", notes: "", companyCode: "VT" }), refused)
      await assert.rejects(api.customers.create({ ...cust, code: "PRF" } as never), refused)
      await assert.rejects(api.customers.archive(cust.id), refused)
      await assert.rejects(api.vehicles.update(vehicle.id, { notes: "x" }), refused)
      await assert.rejects(api.vehicles.transfer(vehicle.id, null, today), refused)
      await assert.rejects(api.vehicles.setOpeningOdometer(vehicle.id, { km: 1, date: today }), refused)
      await assert.rejects(api.trips.remove((await api.trips.list())[0].id, "Profile check"), refused)
      await assert.rejects(api.settings.update({ tdsRate: 3 }), refused)
      await assert.rejects(api.monthLocks.set(month, "LOCKED"), /Only the Owner or Dev/)
      await assert.rejects(api.admin.exportBackup(), refused)
      await assert.rejects(api.admin.resetDemoData(), refused)
      assert.equal((await api.diesel.list()).length, fillsBefore, "nothing saved")
      // No audit history, no deletion review, no restore, no AdBlue opening stock.
      assert.deepEqual(await api.audit.history(lastMonthEntry.id), [], `${role}: no record history`)
      assert.deepEqual(await api.audit.editedIds(), [], `${role}: no Edited badges`)
      await assert.rejects(api.audit.list(), refused)
      await assert.rejects(api.adbluePurchases.createOpening({ date: today, litres: 1, value: 1, notes: "" }), refused)
      // Bulk purchases into the shared stock: added, never edited or deleted.
      const p = await api.adbluePurchases.create(bulk)
      await assert.rejects(api.adbluePurchases.update(p.id, { ...bulk, buckets: 2 }), /can't edit AdBlue purchases/)
      await assert.rejects(api.adbluePurchases.remove(p.id, "Profile check"), /can't delete AdBlue purchases/)
      if (role === "TATA_ADBLUE") {
        // In the browser there are no grants (they live in the shared database): customer-wise entries fail closed.
        await assert.rejects(api.adblue.create(draw), /can't add or change AdBlue entries for this customer/)
        if (ab) await assert.rejects(api.adblue.remove(ab.id, "Profile check"), /for this customer/)
      } else {
        const e = await api.adblue.create(draw)
        await api.adblue.update(e.id, { ...draw, quantityLitres: 2 }, "Profile check")
        await api.adblue.remove(e.id, "Profile check cleanup")
      }
      setRole("OWNER")
      await api.adbluePurchases.remove(p.id, "Profile check cleanup") // the Owner still can
      const events = (await api.audit.list()).filter((e) => e.recordId === p.id)
      assert.deepEqual(events.map((e) => [e.action, e.actor.role]).sort(), [["CREATED", role], ["DELETED", "OWNER"]], `${role}: the purchase is audited as ${role}`)
    }
  }

  /* ---------------------------------------------------------------- The AdBlue profiles use existing master data, never manage it */
  // Owner, 11 Nov 2026: Tata Adblue and Adblue are AdBlue-entry users. A straight API call (the UI bypassed) to any write
  // but the AdBlue entries and adding a bulk purchase is refused by the API itself — customers, vehicles, drivers, fuel
  // stations, assignments, Diesel, payments, settings, openings, month locks, restore — and nothing is stored.
  // (On the shared database the method list refuses them first, and RLS again: check:erp-db 12d.)
  {
    const { isReadMethod } = await import("./reads")
    const allowed = ["adblue.create", "adblue.update", "adblue.remove", "adbluePurchases.create"]
    // Writes whose permission depends on the input: the inputs the UI's combined flows use.
    const args: Record<string, unknown[]> = {
      "payments.create": [{ direction: "OUT", vehicleId: (await api.vehicles.list())[0].id, allocations: [] }],
      "settings.update": [{ vehicleTypes: [] }],
      "fuelStations.update": [(await api.fuelStations.list())[0]?.id ?? "x", { name: "Renamed", location: "", creditDays: 30 }],
    }
    const stored = () => JSON.stringify(Object.keys(window.localStorage).filter((k) => !k.startsWith("vt:ui:")).sort().map((k) => [k, window.localStorage.getItem(k)]))
    const before = stored()
    for (const role of ["ADBLUE", "TATA_ADBLUE"] as const) {
      setRole(role)
      let refused = 0
      for (const [ns, group] of Object.entries(api))
        for (const [m, fn] of Object.entries(group as Record<string, unknown>)) {
          const name = `${ns}.${m}`
          if (typeof fn !== "function" || isReadMethod(ns, m) || allowed.includes(name)) continue
          await assert.rejects(
            async () => (fn as (...a: unknown[]) => Promise<unknown>)(...(args[name] ?? [])),
            (e: Error) => /can't|^Only (the Owner or Dev|Dev)/.test(e.message),
            `${role}: ${name} refused by the API`,
          )
          refused++
        }
      assert.ok(refused > 50, `${role}: every other write checked (${refused})`)
      for (const r of ["customers", "vehicles", "trips", "invoices", "payments", "settings"] as const) for (const a of ["create", "edit", "delete"] as const) assert.equal(can(role, r, a), false, `${role}: no ${r}:${a}`)
      for (const a of ["create", "edit", "delete"] as const) assert.equal(can(role, "diesel", a), false, `${role}: Diesel is view-only`)
      assert.ok(can(role, "diesel", "view") && can(role, "adblue", "create") && !canChangeAdBluePurchases(role, "edit") && !canChangeAdBluePurchases(role, "delete") && !hasOwnerAuthority(role), `${role}: AdBlue entries and adding purchases only`)
    }
    // AdBlue entries only for an existing vehicle and customer — the browser store has no foreign keys, so the API checks.
    const v0 = (await api.vehicles.list()).find((v) => v.status === "ACTIVE")!
    const entry = { vehicleId: "veh_nope", customerId: null, date: todayISO(), closingKm: 1, quantityLitres: 1, invoiceNo: "", notes: "", source: "STOCK" as const }
    setRole("ADBLUE")
    await assert.rejects(api.adblue.create(entry), /Vehicle veh_nope not found/, "Adblue: no AdBlue entry for a vehicle that doesn't exist")
    await assert.rejects(api.adblue.create({ ...entry, vehicleId: v0.id, customerId: "cus_nope" }), /Customer cus_nope not found|is assigned to/, "…nor for a customer that doesn't exist")
    setRole("OWNER")
    await assert.rejects(api.diesel.create({ date: todayISO(), vehicleId: "veh_nope", customerId: null, vendorId: "x", litres: 1, rate: 1, odometerKm: 1, billNo: "", paymentMode: "CREDIT" } as never), /Vehicle veh_nope not found/, "the same for every role and module")
    assert.equal(stored(), before, "nothing stored by any refused call")
  }

  /* ---------------------------------------------------------------- Regression: a data reset never changes who you are */
  // clearAll used to wipe vt:ui:role, which then fell back to Owner — a reset promoted whoever ran it.
  setRole("DEV")
  await api.admin.resetDemoData()
  assert.equal(currentRole(), "DEV")
  assert.equal(typeof (await api.audit.unreviewedDeletions()), "number") // still Dev, still Owner-level authority
  setRole("EMPLOYEE")
  assert.equal(typeof (await api.audit.unreviewedDeletions()), "number") // the Employee has Owner-level authority too
  setRole("OWNER")
  const reset = (await api.audit.list())[0]
  assert.deepEqual([reset.action, reset.actor.role], ["DATA_RESET", "DEV"])

  /* ---------------------------------------------------------------- UI Preview Mode: interface only, UI writes blocked, never authority */
  {
    const { setVerifiedSession, setPreviewRole, previewRole, currentActor, customerScope } = await import("@/lib/identity")
    const { api: uiApi, PreviewWriteBlockedError, PreviewReadBlockedError } = await import("./client")
    const { isReadMethod } = await import("./reads")
    const { profileMethods, profileCall } = await import("@/lib/server/erp/profiles")
    const { stockFor } = await import("@/domain/adblue-inventory")
    const dev = { role: "DEV" as const, email: "dev@example.com" }
    setVerifiedSession(dev)
    // AdBlue for the totals (the demo data has none): a bulk purchase, a stock draw and a direct vendor purchase.
    const abVehicle = (await api.vehicles.list()).find((v) => v.status === "ACTIVE" && v.assignedCustomerId)!
    const abEntry = { vehicleId: abVehicle.id, customerId: abVehicle.assignedCustomerId, date: todayISO(), invoiceNo: "", notes: "" }
    await api.adbluePurchases.create({ date: todayISO(), vendorName: "Preview Check Chemicals", product: "AdBlue", buckets: 2, litresPerBucket: 20, pricePerBucket: 900, invoiceNo: "", notes: "" })
    await api.adblue.create({ ...abEntry, closingKm: 9_999_990, quantityLitres: 3, source: "STOCK" })
    await api.adblue.create({ ...abEntry, closingKm: 9_999_995, quantityLitres: 2, source: "DIRECT", vendorName: "Preview Check Vendor", rate: 100, paymentMode: "CASH" })
    for (const r of ["OWNER", "EMPLOYEE", "TATA_ADBLUE", "ADBLUE"] as const) {
      setPreviewRole(r)
      assert.equal(previewRole(), r, `DEV previews ${r}`)
      // The API's identity never follows the preview: still the verified DEV account.
      assert.equal(currentRole(), "DEV")
      assert.equal(currentActor().role, "DEV")
      // Every write through the UI's api is blocked before it runs — none slips through — and reads still work. (Direct API / database requests are still authorised as DEV: a browser guard, not enforcement.)
      let writes = 0
      for (const [ns, group] of Object.entries(api))
        for (const [method, fn] of Object.entries(group as Record<string, unknown>)) {
          if (typeof fn !== "function") continue
          const call = () => (uiApi as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[ns][method]()
          if (isReadMethod(ns, method)) continue
          assert.throws(call, PreviewWriteBlockedError, `${r} preview refuses ${ns}.${method}`)
          writes++
        }
      assert.ok(writes > 50, `every write method checked (${writes})`)
      const before = (await uiApi.customers.list()).length
      assert.throws(() => uiApi.customers.create({ name: "Preview Co" } as never), PreviewWriteBlockedError)
      assert.equal((await uiApi.customers.list()).length, before, "nothing saved in preview")
    }
    // The AdBlue profiles: reads take that profile's method list and shapes (profiles.ts) — what a real account would
    // see — never DEV's data; the identity, the API's role and the customer scope stay DEV's throughout.
    setPreviewRole(null)
    const devView = { customers: await uiApi.customers.list(), vehicles: await uiApi.vehicles.list(), diesel: await uiApi.diesel.list(), adblue: await uiApi.adblue.list(), purchases: await uiApi.adbluePurchases.list(), stock: await uiApi.adblueStock.list(), totals: await uiApi.adblueTotals.get(), trips: await uiApi.trips.list(), payments: await uiApi.payments.list(), stations: await uiApi.fuelStations.list(), settings: await uiApi.settings.get() }
    assert.ok(devView.customers.length > 0 && devView.vehicles.length > 0 && devView.diesel.length > 0 && devView.trips.length > 0 && devView.payments.length > 0, "Dev's own view has data to hide")
    for (const r of ["TATA_ADBLUE", "ADBLUE"] as const) {
      setPreviewRole(r)
      assert.deepEqual([previewRole(), currentRole(), currentActor().role, customerScope()], [r, "DEV", "DEV", null], `${r} preview: the API still acts as DEV`)
      const tata = r === "TATA_ADBLUE"
      // Customer data: none for Tata Adblue (a preview has no grants); every customer for Adblue.
      assert.deepEqual(await uiApi.customers.list(), tata ? [] : devView.customers, `${r}: customers`)
      assert.deepEqual(await uiApi.vehicles.list(), tata ? [] : devView.vehicles, `${r}: vehicles`)
      assert.deepEqual(await uiApi.diesel.list(), tata ? [] : devView.diesel, `${r}: diesel entries`)
      assert.deepEqual(await uiApi.adblue.list(), tata ? [] : devView.adblue, `${r}: AdBlue entries`)
      assert.deepEqual(await uiApi.assignments.list(), tata ? [] : await api.assignments.list(), `${r}: assignments`)
      // Shared, not customer data: the one stock pool, its purchases, settings — exactly as the profiles get them.
      assert.deepEqual(await uiApi.adbluePurchases.list(), devView.purchases, `${r}: shared purchases`)
      // AdBlue page: the whole company's figures as totals only — computed by the API (on the server for the shared
      // database), never from records in the browser. Tata Adblue gets no individual draw, as for a real account.
      const totals = await uiApi.adblueTotals.get()
      assert.deepEqual(totals, devView.totals, `${r}: company-wide AdBlue totals`)
      if (tata) {
        await assert.rejects(uiApi.adblueStock.list(), PreviewReadBlockedError, "Tata Adblue preview: no individual draws")
        const json = JSON.stringify(totals)
        for (const id of [...devView.adblue.map((e) => e.id), ...devView.customers.map((c) => c.id), ...devView.vehicles.map((v) => v.id), ...devView.vehicles.map((v) => v.regNo), "Preview Check Vendor"])
          assert.ok(!json.includes(`"${id}"`), `Tata Adblue preview: the totals hold no record (${id})`)
      } else assert.deepEqual(await uiApi.adblueStock.list(), devView.stock, `${r}: shared stock`)
      assert.deepEqual(await uiApi.settings.get(), devView.settings)
      assert.ok((await uiApi.fuelStations.list()).every((x) => x.openingBalance === undefined && x.openingBalanceDate === undefined), `${r}: no station money`)
      for (const m of ["trips", "payments", "invoices", "tankerLoads", "tankerDispenses", "tankerTransfers", "tankerAdjustments"] as const)
        assert.deepEqual(await (uiApi[m] as { list: () => Promise<unknown> }).list(), [], `${r}: ${m} empty, as for the real role`)
      assert.deepEqual(await uiApi.audit.editedIds(), [], `${r}: no Edited badges`)
      assert.equal(await uiApi.audit.unreviewedDeletions(), 0, `${r}: no deletion badge`)
      // Anything off the profile's list is refused, as the server would refuse it.
      for (const read of [() => uiApi.audit.list(), () => uiApi.audit.history("x"), () => uiApi.diesel.get("x"), () => uiApi.admin.exportBackup(), () => uiApi.audit.checkRestore("x")])
        await assert.rejects(read(), PreviewReadBlockedError, `${r}: off-list read refused`)
      // Every read on the profile's list works in preview (no screen of the profile fails to load).
      for (const m of profileMethods(r).filter((m) => isReadMethod(m.split(".")[0], m.split(".")[1]))) {
        const [ns, fn] = m.split(".")
        await (uiApi as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>)[ns][fn]()
      }
      // Writes the real profile may make are blocked in preview too (UI guard): AdBlue entries and purchases.
      assert.throws(() => uiApi.adblue.create({} as never), PreviewWriteBlockedError)
      assert.throws(() => uiApi.adbluePurchases.create({} as never), PreviewWriteBlockedError)
    }
    assert.deepEqual([stockFor(devView.totals.ledger).consumed, devView.totals.direct.at(-1)], [3, { month: todayISO().slice(0, 7), litres: 2, cost: 200, count: 1 }], "the totals: the draw and the direct purchase")
    // The Diesel preview's scope rule (profileCall, the server's own): Tata Adblue sees its granted customers' fills only.
    const someone = devView.diesel[0].customerId!
    const scoped = (await profileCall("TATA_ADBLUE", "diesel.list", () => api.diesel.list(), new Set([someone]))!()) as typeof devView.diesel
    assert.ok(scoped.length > 0 && scoped.length < devView.diesel.length && scoped.every((e) => e.customerId === someone), "Diesel: only the granted customer's fills")
    // Switching straight from one profile to another, and to the Owner / Employee: each view is its own.
    setPreviewRole("TATA_ADBLUE")
    setPreviewRole("ADBLUE")
    assert.deepEqual(await uiApi.customers.list(), devView.customers, "Tata → Adblue: every customer again")
    setPreviewRole("EMPLOYEE")
    assert.deepEqual([await uiApi.trips.list(), (await uiApi.audit.list()).length > 0], [devView.trips, true], "Adblue → Employee: the Owner / Employee previews read as before")
    setPreviewRole("TATA_ADBLUE")
    setPreviewRole("OWNER")
    assert.deepEqual(await uiApi.payments.list(), devView.payments, "Tata → Owner: unchanged")
    // The preview lives in memory only: nothing is stored, so a reload starts as Dev.
    const storage = () => JSON.stringify(Object.keys(window.localStorage).sort().map((k) => [k, window.localStorage.getItem(k)]))
    setPreviewRole(null)
    const storedBefore = storage()
    setPreviewRole("TATA_ADBLUE")
    await uiApi.customers.list()
    setPreviewRole("ADBLUE")
    assert.equal(storage(), storedBefore, "starting / switching a preview writes nothing to browser storage")
    // The server never receives the preview: POST /api/erp sends method, args and versions only, and the route takes
    // the role from the verified session alone.
    const { readFileSync } = await import("node:fs")
    const clientSrc = readFileSync(new URL("./client.ts", import.meta.url), "utf8")
    const routeSrc = readFileSync(new URL("../../app/api/erp/route.ts", import.meta.url), "utf8")
    assert.ok(/JSON\.stringify\(\{ method, args, expected: expected \?\? undefined \}\)/.test(clientSrc), "the request body: method, args, expected — no role")
    assert.ok(!/previewRole|body\.role|body\.preview/.test(routeSrc) && /requestIdentity\(\)/.test(routeSrc), "the route never reads a role from the request")
    // Return to Dev (DEV or null): writes work again.
    setPreviewRole("DEV")
    assert.equal(previewRole(), null)
    assert.deepEqual(await uiApi.customers.list(), devView.customers, "Return to Dev: Dev's own data again")
    const pump = await uiApi.fuelStations.create({ name: "Preview Check Pump" })
    assert.ok(pump.id)
    // Only a verified DEV can preview — storage tampering or another role's session gets nothing.
    for (const r of ["OWNER", "EMPLOYEE"] as const) {
      setRole("DEV") // a tampered vt:ui:role…
      setVerifiedSession({ role: r, email: "someone@example.com" })
      assert.equal(currentRole(), r) // …never beats the verified account
      setPreviewRole("OWNER")
      assert.equal(previewRole(), null, `${r} can't start a preview`)
    }
    // Sign-out, an ended session or another account ends a preview; signing back in doesn't revive it.
    setVerifiedSession(dev)
    setPreviewRole("EMPLOYEE")
    setVerifiedSession(null)
    assert.equal(previewRole(), null, "signed out: no preview")
    setVerifiedSession(dev)
    assert.equal(previewRole(), null, "signed back in: Dev, not the old preview")
    setPreviewRole("OWNER")
    setVerifiedSession({ role: "DEV", email: "other-dev@example.com" })
    assert.equal(previewRole(), null, "another DEV account doesn't inherit a preview")
    setVerifiedSession(null)
    setRole("OWNER")
  }

  /* ---------------------------------------------------------------- A signed-in AdBlue profile on the browser backend */
  // The profile's own read rules apply to its real session too, not only to a DEV preview: the browser store holds every
  // customer, and Tata Adblue's grants live in the shared database, so here it sees no customer at all (fail closed);
  // Adblue sees every customer. The company-wide AdBlue totals stay whole for both. Owner / Dev / Employee unchanged.
  {
    const { setVerifiedSession } = await import("@/lib/identity")
    const { api: uiApi } = await import("./client")
    const all = { customers: await api.customers.list(), vehicles: await api.vehicles.list(), diesel: await api.diesel.list(), adblue: await api.adblue.list(), assignments: await api.assignments.list(), drivers: await api.drivers.list(), totals: await api.adblueTotals.get() }
    assert.ok(all.customers.length > 1 && all.vehicles.length > 0 && all.diesel.length > 0, "the store has customers to hide")
    setVerifiedSession({ role: "TATA_ADBLUE", email: "tata@example.com" })
    for (const m of ["customers", "vehicles", "diesel", "adblue", "assignments", "drivers"] as const)
      assert.deepEqual(await (uiApi[m] as { list: () => Promise<unknown> }).list(), [], `Tata Adblue (browser backend, no grants): no ${m}`)
    assert.deepEqual(await uiApi.adblueTotals.get(), all.totals, "Tata Adblue: the company-wide AdBlue totals, unchanged")
    for (const read of [() => uiApi.adblueStock.list(), () => uiApi.audit.list(), () => uiApi.diesel.get(all.diesel[0].id)]) await assert.rejects(read(), /can't open this/, "Tata Adblue: off-list reads refused")
    await assert.rejects(uiApi.customers.create({ name: "Sneaky Co" } as never), /can't open this/, "…and off-list writes")
    setVerifiedSession({ role: "ADBLUE", email: "adblue@example.com" })
    assert.deepEqual([await uiApi.customers.list(), await uiApi.diesel.list(), await uiApi.adblueTotals.get()], [all.customers, all.diesel, all.totals], "Adblue: every customer, as before")
    await assert.rejects(uiApi.adblueStock.list().then(() => uiApi.audit.list()), /can't open this/, "Adblue: its method list applies too")
    for (const role of ["OWNER", "DEV", "EMPLOYEE"] as const) {
      setVerifiedSession({ role, email: `${role.toLowerCase()}@example.com` })
      assert.deepEqual([await uiApi.customers.list(), await uiApi.vehicles.list(), await uiApi.diesel.list()], [all.customers, all.vehicles, all.diesel], `${role}: unchanged`)
    }
    setVerifiedSession(null)
    setRole("OWNER")
  }

  console.log("roles: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
