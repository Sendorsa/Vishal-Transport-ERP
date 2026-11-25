/**
 * Expense module, Phase 1 (owner, 25 Nov 2026):  npm run check:expenses
 * Real API on in-memory demo data (browser backend), clock fixed at 25 Nov 2026 IST.
 *   1. Vehicle lookup: registration search ignores case, spaces and punctuation; vehicles only from the master.
 *   2. Road Tax / Insurance / Fitness: validity period rules, customer stamped from the assignment, unused fields
 *      cleared; status Active / Not started / Expiring / Expired / Renewed / No validity period.
 *   3. Fines: paid needs a payment date; unpaid clears it.
 *   4. Broker Charges: several / no vehicles, count derived, paid ≤ charge, payments, one opening balance per broker
 *      (first), brought forward never counted as a new charge.
 *   5. Descriptions: saved ones offered again (spelling-insensitive), starters only a starting point.
 *   6. Roles, month lock, delete reason, audit events; refused on the shared database (no table yet).
 */
import assert from "node:assert/strict"
import { setRole, loadCheckDemoData } from "./test-browser"

const FIXED = new Date("2026-11-25T04:30:00.000Z").getTime()
const RealDate = Date
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length) super(...(args as [string]))
    else super(FIXED)
  }
  static now() {
    return FIXED
  }
}
globalThis.Date = FixedDate as DateConstructor

async function main() {
  loadCheckDemoData()
  const { api } = await import("./index")
  const { todayISO } = await import("@/lib/format")
  const { readCollection, readAuditEvents } = await import("@/lib/storage/local-store")
  const { normReg } = await import("@/domain/tanker")
  const { blankExpense, descriptionOptions, expenseMatches, latestPayment, NO_FILTERS, sectionCards, validityOf } = await import("@/domain/expenses")
  const { registerScopeGetter } = await import("@/lib/request-scope")
  const today = todayISO()
  assert.equal(today, "2026-11-25")
  setRole("DEV") // Expense is Dev only while unreleased (owner, 25 Nov 2026)

  /* 1. lookup */
  assert.equal(normReg(" tn 70 av-2412 "), "TN70AV2412", "search key: case, spaces and punctuation ignored")
  const vehicles = (await api.vehicles.list()).filter((v) => v.status === "ACTIVE")
  const [v1, v2, v3] = vehicles
  const count = () => readCollection("expenses").length
  const base = (section: Parameters<typeof blankExpense>[0], patch: Partial<ReturnType<typeof blankExpense>> = {}) => ({ ...blankExpense(section, today), ...patch })
  await assert.rejects(api.expenses.create(base("ROAD_TAX", { vehicleIds: ["veh_nope"], description: "MV TAX", amount: 100 })), /not found|Vehicle/i, "an unknown vehicle is refused — never created")
  assert.equal(count(), 0)

  /* 2. road tax */
  const rt = base("ROAD_TAX", { vehicleIds: [v1.id], description: "  mv   tax ", taxType: "Same state", amount: 30310, validFrom: "2026-10-01", validTill: "2026-12-31", provider: "stray", companyCode: v1.companyCode, date: "2026-11-02" })
  const r1 = await api.expenses.create(rt)
  assert.equal(r1.description, "mv tax", "trimmed, single spaces")
  assert.equal(r1.provider, "", "a field the section doesn't use is cleared")
  assert.equal(r1.customerId, v1.assignedCustomerId ?? null, "the customer is the vehicle's assignment on the date")
  await assert.rejects(api.expenses.create({ ...rt, validTill: "2026-09-01" }), /before the start/)
  await assert.rejects(api.expenses.create({ ...rt, validTill: "" }), /valid-till/, "a period needs both dates")
  await assert.rejects(api.expenses.create({ ...rt, date: "2026-11-26" }), /future/)
  await assert.rejects(api.expenses.create({ ...rt, description: " " }), /Enter what was paid/)
  const oneOff = await api.expenses.create({ ...rt, description: "DIFF TAX", validFrom: "", validTill: "" })
  assert.equal(count(), 2, "refusals saved nothing")
  const all = () => readCollection("expenses")
  assert.equal(validityOf(r1, all(), today), "ACTIVE")
  assert.equal(validityOf(oneOff, all(), today), "NO_PERIOD")
  assert.equal(validityOf(r1, all(), "2026-12-10"), "EXPIRING", "within 30 days of valid till")
  assert.equal(validityOf(r1, all(), "2027-01-05"), "EXPIRED")
  const green = await api.expenses.create({ ...rt, description: "GREEN TAX", validFrom: "2026-11-01", validTill: "2027-10-31" })
  assert.equal(validityOf(r1, all(), "2027-01-05"), "EXPIRED", "another tax (GREEN TAX) doesn't renew MV TAX")
  const renewal = await api.expenses.create({ ...rt, description: "MV TAX", validFrom: "2027-01-01", validTill: "2027-03-31" })
  assert.equal(validityOf(r1, all(), "2026-12-10"), "RENEWED", "MV TAX paid for the next quarter: the old one is Renewed")
  assert.equal(validityOf(renewal, all(), today), "UPCOMING")
  assert.equal(validityOf(green, all(), today), "ACTIVE")

  // insurance & fitness
  await assert.rejects(api.expenses.create(base("INSURANCE", { vehicleIds: [v2.id], provider: "New India", amount: 52000 })), /insurance start date/, "insurance always has its dates")
  const ins = await api.expenses.create(base("INSURANCE", { vehicleIds: [v2.id], provider: "New India", policyNo: "P-1", amount: 52000, validFrom: "2026-11-01", validTill: "2027-10-31", paymentMode: "NEFT" }))
  assert.equal(ins.validTill, "2027-10-31")
  await assert.rejects(api.expenses.create(base("INSURANCE", { vehicleIds: [v2.id], amount: 1, validFrom: "2026-11-01", validTill: "2027-10-31" })), /provider/)
  const fc = await api.expenses.create(base("FITNESS", { vehicleIds: [v2.id], description: "FC FEES", amount: 1250 }))
  assert.equal(validityOf(fc, all(), today), "NO_PERIOD", "an FC fee without dates is allowed")
  await assert.rejects(api.expenses.create(base("FITNESS", { vehicleIds: [], amount: 1250 })), /Choose the vehicle/)
  await assert.rejects(api.expenses.create(base("FITNESS", { vehicleIds: [v1.id, v2.id], amount: 1250 })), /Choose the vehicle/, "one vehicle per fitness entry")

  /* 3. fines */
  await assert.rejects(api.expenses.create(base("FINE", { vehicleIds: [v1.id], taxType: "FINE AMOUNT", amount: 1000, paymentStatus: "PAID" })), /day it was paid/)
  await assert.rejects(api.expenses.create(base("FINE", { vehicleIds: [v1.id], amount: 1000 })), /fine type/)
  const fine = await api.expenses.create(base("FINE", { vehicleIds: [v1.id], taxType: "FINE AMOUNT", amount: 1000, date: "2026-11-20", paymentStatus: "UNPAID", paymentDate: "2026-11-20", paymentReference: "x" }))
  assert.deepEqual([fine.paymentDate, fine.paymentReference], ["", ""], "an unpaid fine keeps no payment details")
  const paidFine = await api.expenses.update(fine.id, { ...fine, paymentStatus: "PAID", paymentDate: "2026-11-24", paymentReference: "CH-9" })
  assert.equal(paidFine.paymentDate, "2026-11-24")

  /* 4. broker */
  const charge = base("BROKER", { broker: "Manjanna", description: "PSV BUS REGISTRATION", vehicleIds: [v1.id, v2.id, v3.id], vehicleCount: 99, amount: 69000, date: "2026-11-10" })
  const b1 = await api.expenses.create(charge)
  assert.equal(b1.vehicleCount, 3, "the count comes from the vehicles chosen")
  assert.equal(b1.customerId, null)
  const b2 = await api.expenses.create(base("BROKER", { broker: "MANJANNA ", description: "Krishnagiri district variation", vehicleCount: 13, amount: 65000, paidAmount: 20000, paymentDate: "2026-11-12", paymentMode: "Cash", date: "2026-11-12" }))
  assert.deepEqual([b2.vehicleIds, b2.vehicleCount], [[], 13], "no vehicle: the count as typed")
  await assert.rejects(api.expenses.create({ ...charge, paidAmount: 70000, paymentDate: today }), /Payment to broker/, "paid beyond the charge is a separate payment")
  await assert.rejects(api.expenses.create({ ...charge, paidAmount: 100 }), /cleared date/)
  await assert.rejects(api.expenses.create(base("BROKER", { description: "x", amount: 1 })), /Enter the broker/)
  const pay = await api.expenses.create(base("BROKER", { entryType: "PAYMENT", broker: "Manjanna", paidAmount: 50000, paymentDate: "2026-11-20", date: "2026-11-20", vehicleIds: [v1.id] }))
  assert.deepEqual([pay.amount, pay.vehicleIds], [0, []], "a payment is no expense and names no vehicle")
  await assert.rejects(api.expenses.create(base("BROKER", { entryType: "BROUGHT_FORWARD", broker: "manjanna", amount: 219700, date: "2026-11-15" })), /must come before every other entry/)
  const opening = await api.expenses.create(base("BROKER", { entryType: "BROUGHT_FORWARD", broker: "manjanna", amount: 219700, date: "2026-11-01" }))
  await assert.rejects(api.expenses.create(base("BROKER", { entryType: "BROUGHT_FORWARD", broker: "Manjanna", amount: 1, date: "2026-10-31" })), /already has an opening balance/)
  await assert.rejects(api.expenses.create({ ...charge, date: "2026-10-30" }), /can't be dated before it/)
  assert.equal(opening.paidAmount, 0)

  /* 4a. summary cards: Number of Invoices and Total Amount Paid, each section from its own records, as filtered */
  const unpaidFine = await api.expenses.create(base("FINE", { vehicleIds: [v2.id], taxType: "OVERLOADING", amount: 3511, date: "2026-11-21" }))
  const cardsOf = (section: Parameters<typeof sectionCards>[0], f: Partial<typeof NO_FILTERS> = {}) =>
    sectionCards(section, all().filter((x) => x.section === section && expenseMatches(x, { ...NO_FILTERS, ...f }, [], null)))
  // Broker: opening 2,19,700 (brought forward), charge 69,000 unpaid, charge 65,000 partly paid 20,000, payment 50,000.
  assert.deepEqual(cardsOf("BROKER"), { invoices: 2, paid: 20000 }, "broker: only new charges are invoices; paid = what was paid on them (partly paid: the part; unpaid: 0); the opening balance and the separate payment are neither")
  assert.deepEqual(cardsOf("BROKER", { from: "2026-11-11", to: "2026-11-30" }), { invoices: 1, paid: 20000 }, "the date filter narrows both cards")
  assert.deepEqual(cardsOf("BROKER", { from: "2026-11-01", to: "2026-11-01" }), { invoices: 0, paid: 0 }, "an opening balance alone: no invoice, nothing paid")
  assert.deepEqual(cardsOf("BROKER", { broker: "NOBODY" }), { invoices: 0, paid: 0 }, "empty: zero, never blank")
  assert.deepEqual(cardsOf("FINE"), { invoices: 2, paid: 1000 }, "fines: the unpaid fine counts as an invoice and adds ₹0 paid")
  assert.deepEqual(cardsOf("FINE", { vehicleId: v2.id }), { invoices: 1, paid: 0 }, "fines filtered to the unpaid one")
  await api.expenses.update(unpaidFine.id, { ...unpaidFine, paymentStatus: "PAID", paymentDate: "2026-11-24" })
  assert.deepEqual(cardsOf("FINE"), { invoices: 2, paid: 4511 }, "marked Paid: counted once, in full")
  // Road Tax, Insurance, Fitness: each entry is a payment made on its date — the paid total is the sum of their amounts.
  assert.deepEqual(cardsOf("ROAD_TAX"), { invoices: 4, paid: 121240 }, "road tax: 4 payments of ₹30,310 (MV TAX, DIFF TAX, GREEN TAX, the next MV TAX)")
  assert.deepEqual([cardsOf("INSURANCE"), cardsOf("FITNESS")], [{ invoices: 1, paid: 52000 }, { invoices: 1, paid: 1250 }], "insurance and fitness: their own records only")
  assert.deepEqual(cardsOf("ROAD_TAX", { from: "2026-12-01" }), { invoices: 0, paid: 0 }, "nothing in the range: 0 / ₹0.00")
  assert.deepEqual(cardsOf("ROAD_TAX", { search: "green" }), { invoices: 1, paid: 30310 }, "search narrows both cards")

  /* 4b. the vehicle page: each vehicle's latest payment from its own records */
  await api.expenses.create({ ...rt, vehicleIds: [v3.id], description: "MV TAX", amount: 10000, date: "2026-10-05", validFrom: "2026-10-01", validTill: "2026-12-31" })
  await api.expenses.create({ ...rt, vehicleIds: [v3.id], description: "MV TAX", amount: 12000, date: "2026-11-15", validFrom: "2027-01-01", validTill: "2027-03-31" })
  assert.equal(latestPayment(all(), v3.id, "ROAD_TAX")?.amount, 12000, "several payments: the latest transaction date")
  assert.equal(latestPayment(all(), v2.id, "INSURANCE")?.amount, 52000)
  assert.equal(latestPayment(all(), v1.id, "INSURANCE"), null, "never another vehicle's payment: none recorded = none shown")
  assert.equal(latestPayment(all(), v3.id, "FITNESS"), null)

  /* 5. descriptions */
  const opts = descriptionOptions(all(), "ROAD_TAX")
  assert.equal(opts.filter((o) => o.toUpperCase() === "MV TAX").length, 1, "one entry per spelling (mv tax = MV TAX)")
  assert.equal(opts[0].toUpperCase(), "MV TAX", "the most used first")
  assert.ok(opts.includes("TN TP") && opts.includes("DIFF TAX"), "starters and saved values together")
  assert.ok(descriptionOptions(all(), "BROKER").includes("Krishnagiri district variation"), "a new description is offered again")

  /* 6. roles (Dev only while unreleased), delete, audit */
  const e1 = await api.expenses.create({ ...rt, description: "TN TP" })
  await api.expenses.update(e1.id, { ...e1, amount: 8205 }, "Wrong amount")
  const snapshot = JSON.stringify(all())
  for (const r of ["OWNER", "EMPLOYEE", "TATA_ADBLUE", "ADBLUE"] as const) {
    setRole(r)
    await assert.rejects(api.expenses.list(), /can't view expense/, `${r} reads no expense`)
    await assert.rejects(api.expenses.create(rt), /can't create expense/, `${r} adds no expense`)
    await assert.rejects(api.expenses.update(e1.id, { ...e1, amount: 1 }), /can't edit expense/, `${r} edits no expense`)
    await assert.rejects(api.expenses.remove(e1.id, "Not mine"), /can't delete expense/, `${r} deletes no expense`)
  }
  assert.equal(JSON.stringify(all()), snapshot, "the refused calls changed nothing")
  setRole("DEV")
  await api.expenses.create({ ...rt, date: "2026-10-15" }) // Dev, like the Owner, may record in a closed month
  await assert.rejects(api.expenses.remove(e1.id, " "), /reason/i)
  await api.expenses.remove(e1.id, "Entered twice")
  assert.ok(!all().some((x) => x.id === e1.id))
  const ev = (readAuditEvents() as { action: string; module: string; recordType: string; recordId: string; reason: string | null }[]).filter((e) => e.recordId === e1.id)
  assert.deepEqual(ev.map((e) => [e.action, e.module, e.recordType]), [["CREATED", "Expense", "Road tax"], ["UPDATED", "Expense", "Road tax"], ["DELETED", "Expense", "Road tax"]])
  assert.equal(ev[2].reason, "Entered twice")
  await assert.rejects(api.expenses.update(r1.id, { ...r1, section: "FINE" }), /can't be moved/)

  // The shared database has no expense table yet: refused there, never dropped silently.
  const before = count()
  registerScopeGetter(() => ({ identity: { profileId: "p", userId: "u", role: "DEV", email: null, name: null }, cache: new Map(), written: new Set(), expected: {}, newEvents: [], newReviews: [] }))
  try {
    await assert.rejects(api.expenses.create(rt), /isn't on the shared database yet/)
  } finally {
    registerScopeGetter(() => undefined)
  }
  assert.equal(count(), before)
  console.log("expenses: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
