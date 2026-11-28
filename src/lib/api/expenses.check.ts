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
  const { todayISO, round2 } = await import("@/lib/format")
  const { readCollection, readAuditEvents } = await import("@/lib/storage/local-store")
  const { normReg } = await import("@/domain/tanker")
  const { blankExpense, brokerBalanceOf, textKey, monthOf, isMonthLocked, expenseMonthOptions, monthSummary, addMonthKey, monthEnd, descriptionOptions, expenseMatches, latestPayment, NO_FILTERS, sectionCards, validityOf } = await import("@/domain/expenses")
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
  await assert.rejects(api.expenses.create(base("ROAD_TAX", { vehicleIds: ["veh_nope"], description: "MV TAX", amount: 100, companyCode: "VT" })), /not found|Vehicle/i, "an unknown vehicle is refused — never created")
  assert.equal(count(), 0)

  /* 2. road tax */
  const rt = base("ROAD_TAX", { vehicleIds: [v1.id], description: "  mv   tax ", taxType: "Same state", amount: 30310, validFrom: "2026-10-01", validTill: "2026-12-31", provider: "stray", companyCode: v1.companyCode, date: "2026-11-02" })
  const r1 = await api.expenses.create(rt)
  assert.equal(r1.description, "MV TAX", "one spelling per Road Tax description: the books' MV TAX, whatever the case or spacing typed")
  assert.equal(r1.provider, "", "a field the section doesn't use is cleared")
  assert.equal(r1.customerId, v1.assignedCustomerId ?? null, "the customer is the vehicle's assignment on the date")
  await assert.rejects(api.expenses.create({ ...rt, validTill: "2026-09-01" }), /before the start/)
  await assert.rejects(api.expenses.create({ ...rt, validTill: "" }), /valid-till/, "a period needs both dates")
  await assert.rejects(api.expenses.create({ ...rt, date: "2026-11-26" }), /future/)
  await assert.rejects(api.expenses.create({ ...rt, description: " " }), /Choose the tax description/)
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

  // Fines' description is free text (owner, 25 Nov 2026): saved as typed — inner spaces and punctuation kept, ends trimmed.
  const typed = "Over-speeding  near Hosur toll (2nd notice), Rs. 500/- paid by driver!"
  const fd = await api.expenses.create(base("FINE", { vehicleIds: [v1.id], taxType: "SPEEDING", amount: 500, date: "2026-11-22", description: `  ${typed} ` }))
  assert.equal(fd.description, typed, "a fine's description is kept exactly as typed")
  const fdEdit = await api.expenses.update(fd.id, { ...fd, amount: 600 })
  assert.equal(fdEdit.description, typed, "editing another field keeps it")
  assert.equal((await api.expenses.update(fd.id, { ...fdEdit, description: "" })).description, "", "optional: may be cleared")
  await api.expenses.remove(fd.id, "Check record")
  const tidy = await api.expenses.create({ ...rt, description: "  green   tax " })
  assert.equal(tidy.description, "GREEN TAX", "Road Tax: an existing description's spelling, spacing and case ignored (no duplicate)")
  await api.expenses.remove(tidy.id, "Check record")

  /* 4. broker — every new entry is a payment to the broker (owner, 25 Nov 2026). Charges and opening balances exist only as
        older records: seeded straight into storage here, as the browser data they stand for. */
  const { writeCollection } = await import("@/lib/storage/local-store")
  let seq = 0
  const old = (x: Partial<ReturnType<typeof blankExpense>>) => {
    const at = "2026-11-01T06:00:00.000Z"
    const r = { ...base("BROKER", x), vehicleCount: x.vehicleCount ?? x.vehicleIds?.length ?? 0, customerId: null, id: `exp_old${++seq}`, createdAt: at, updatedAt: at }
    writeCollection("expenses", [...readCollection("expenses"), r])
    return r
  }
  const opening = old({ entryType: "BROUGHT_FORWARD", broker: "Manjanna", amount: 219700, date: "2026-11-01" })
  const b1 = old({ entryType: "CHARGE", broker: "Manjanna", description: "PSV BUS REGISTRATION", vehicleIds: [v1.id, v2.id, v3.id], amount: 69000, date: "2026-11-10" })
  const b2 = old({ entryType: "CHARGE", broker: "MANJANNA ", description: "Krishnagiri district variation", vehicleCount: 13, amount: 65000, paidAmount: 20000, paymentDate: "2026-11-12", paymentMode: "Cash", date: "2026-11-12" })
  const brokerRows = () => all().filter((x) => x.section === "BROKER")
  const owed = () => brokerRows().reduce((t, x) => t + brokerBalanceOf(x), 0)
  assert.equal(owed(), 333700, "before any payment: opening 2,19,700 + 69,000 + 65,000 − 20,000 paid on a charge")

  // New entries (owner, 27 Nov 2026): a bill (owed, nothing paid) or a bulk payment to the broker — never an opening balance.
  await assert.rejects(api.expenses.create(base("BROKER", { entryType: "CHARGE", broker: "Manjanna", description: "x", amount: 100, paidAmount: 1, paymentDate: today })), /Add Payment/, "a bill is never marked paid")
  await assert.rejects(api.expenses.create(base("BROKER", { entryType: "BROUGHT_FORWARD", amount: 1, date: "2026-10-31" })), /Record a bill or a payment/, "no new opening balance")
  assert.equal(base("BROKER").entryType, "CHARGE", "a new broker entry starts as a bill")
  const count0 = brokerRows().length

  // The broker list (owner, 25 Nov 2026): Add New Broker; duplicates refused, spaces and case ignored.
  const manjanna = await api.brokers.create("  Manjanna  ")
  assert.equal(manjanna.name, "Manjanna", "a new broker, tidied")
  await assert.rejects(api.brokers.create("MANJANNA"), /already in the broker list/, "no duplicate, case ignored")
  await assert.rejects(api.brokers.create(" manjanna "), /already in the broker list/, "no duplicate, spaces ignored")
  await assert.rejects(api.brokers.create("   "), /Enter the broker's name/)
  const ravi = await api.brokers.create("Ravi  RTO Agent")
  // Ravi's bill (October): a broker is never paid more than billed, so his payment below needs it.
  const raviBill = await api.expenses.create(base("BROKER", { broker: "Ravi RTO Agent", billNo: "R-17", description: "Permit renewal", amount: 20000, date: "2026-10-15" }))
  assert.deepEqual((await api.brokers.list()).map((b) => b.name).sort(), ["Manjanna", "Ravi RTO Agent"], "both available for later entries")
  // A payment names its broker — required, and from the list.
  await assert.rejects(api.expenses.create(base("BROKER", { entryType: "PAYMENT", paidAmount: 100, date: "2026-11-20", paymentDate: "2026-11-20" })), /Choose the broker/, "Broker Name is mandatory")
  await assert.rejects(api.expenses.create(base("BROKER", { entryType: "PAYMENT", broker: "Somebody New", paidAmount: 100, date: "2026-11-20", paymentDate: "2026-11-20" })), /isn't in the broker list/, "never a name that isn't in the list")

  // 1. With a vehicle (the payment is for that vehicle) — never refused for naming one.
  const p1 = await api.expenses.create(base("BROKER", { entryType: "PAYMENT", broker: "manjanna", paidAmount: 50000, paymentDate: "2026-11-20", date: "2026-11-20", vehicleIds: [v1.id], paymentMode: "NEFT", description: "FC  renewal, TN70 (Nov)" }))
  assert.deepEqual([p1.entryType, p1.amount, p1.paidAmount, p1.vehicleIds, p1.vehicleCount, p1.paymentMode, p1.broker, p1.description], ["PAYMENT", 0, 50000, [v1.id], 1, "NEFT", "Manjanna", "FC  renewal, TN70 (Nov)"], "a payment with its vehicle and broker (saved in the list's spelling): no charge, no amount owed, text as typed")
  // 2. Without a vehicle (a general payment to the broker).
  const p2 = await api.expenses.create(base("BROKER", { entryType: "PAYMENT", broker: ravi.name, paidAmount: 10000, paymentDate: "2026-11-22", date: "2026-11-22", paymentMode: "UPI" }))
  assert.deepEqual([p2.vehicleIds, p2.vehicleCount], [[], 0])
  // 3–4. More payments to the same broker, other methods.
  const p3 = await api.expenses.create(base("BROKER", { entryType: "PAYMENT", broker: "Manjanna", paidAmount: 5000, paymentDate: "2026-11-23", date: "2026-11-23", paymentMode: "Cash", vehicleIds: [v2.id] }))
  assert.deepEqual([p1, p2, p3].map((x) => x.paymentMode), ["NEFT", "UPI", "Cash"])
  await assert.rejects(api.expenses.create(base("BROKER", { entryType: "PAYMENT", broker: "Manjanna", date: "2026-11-23" })), /Enter the amount paid/, "Broker Amount is required")
  assert.equal(brokerRows().length, count0 + 4, "Ravi's bill and three payments, nothing else created")
  // 5. Each payment reduces what is owed to its broker, once (bulk, never tied to a bill — owner, 27 Nov 2026).
  assert.equal(owed(), 333700 + 20000 - 65000, "+ Ravi's bill 20,000 − the 65,000 paid")
  assert.equal(brokerRows().filter((x) => x.entryType === "CHARGE").length, 3, "no artificial bill for a payment")
  // The form no longer asks for a Payment Type (owner, 25 Nov 2026): a payment saves without one; an existing entry's
  // stored method stays through an edit that doesn't send a new one.
  const noMode = await api.expenses.create(base("BROKER", { entryType: "PAYMENT", broker: "Manjanna", paidAmount: 750, paymentDate: "2026-11-24", date: "2026-11-24" }))
  assert.deepEqual([noMode.entryType, noMode.paidAmount, noMode.paymentMode], ["PAYMENT", 750, ""], "saved with no payment method")
  assert.equal((await api.expenses.update(p1.id, { ...p1, description: "FC renewal" })).paymentMode, "NEFT", "an existing method kept")
  await api.expenses.update(p1.id, { ...p1 })
  await api.expenses.remove(noMode.id, "Check record")
  // Broker-wise: the filter shows only that broker's records; search finds a broker by name.
  const byBroker = (name: string) => brokerRows().filter((x) => expenseMatches(x, { ...NO_FILTERS, broker: textKey(name) }, [], null)).map((x) => x.id)
  assert.deepEqual(byBroker("Ravi RTO Agent").sort(), [raviBill.id, p2.id].sort(), "Ravi: only his bill and payment")
  assert.ok(byBroker("MANJANNA").includes(p1.id) && byBroker("MANJANNA").includes(p3.id) && !byBroker("MANJANNA").includes(p2.id), "Manjanna: his payments (and his older entries), never Ravi's")
  assert.deepEqual(brokerRows().filter((x) => expenseMatches(x, { ...NO_FILTERS, search: "ravi rto" }, [], null)).map((x) => x.id).sort(), [raviBill.id, p2.id].sort(), "search by broker name")
  // 6. Vehicle-wise: a payment is found under its vehicle; the broker-level total still includes it.
  const regsOf = (x: { vehicleIds: string[] }) => x.vehicleIds.map((id) => vehicles.find((v) => v.id === id)?.regNo ?? "")
  assert.deepEqual(brokerRows().filter((x) => expenseMatches(x, { ...NO_FILTERS, vehicleId: v1.id }, regsOf(x), null)).map((x) => x.id).sort(), [b1.id, p1.id].sort(), "v1: its charge and its payment")
  assert.ok(brokerRows().filter((x) => expenseMatches(x, { ...NO_FILTERS, search: v2.regNo }, regsOf(x), null)).some((x) => x.id === p3.id), "a payment is found by its vehicle's registration")
  // Editing a payment keeps it a payment; an older entry keeps its type, or becomes a payment — never a new charge.
  const p2e = await api.expenses.update(p2.id, { ...p2, paidAmount: 12000, vehicleIds: [v3.id] })
  assert.deepEqual([p2e.entryType, p2e.paidAmount, p2e.vehicleIds, p2e.paymentDate], ["PAYMENT", 12000, [v3.id], "2026-11-22"])
  await assert.rejects(api.expenses.update(p2.id, { ...p2e, entryType: "BROUGHT_FORWARD", paidAmount: 0, amount: 12000 }), /stays one/)
  await api.expenses.update(p2.id, { ...p2e, paidAmount: 10000, vehicleIds: [] })
  // 7. Older entries keep every field the simplified form doesn't show.
  const edited2 = await api.expenses.update(b2.id, { ...b2, description: "Krishnagiri district variation (13 buses)" })
  assert.deepEqual([edited2.entryType, edited2.broker, edited2.vehicleCount, edited2.paidAmount, edited2.paymentDate, edited2.paymentMode], ["CHARGE", b2.broker, 13, 20000, "2026-11-12", "Cash"], "type, broker (exactly as recorded), count, paid amount, cleared date and mode kept")
  await assert.rejects(api.expenses.update(b1.id, { ...b1, paidAmount: 70000, paymentDate: today }), /Add Payment/, "an older charge is never paid beyond its amount")
  await assert.rejects(api.expenses.update(b1.id, { ...b1, paidAmount: 100 }), /cleared date/)
  assert.equal(opening.paidAmount, 0)
  assert.equal(owed(), 333700 + 20000 - 65000, "edits left the balance as it was")

  /* 4a. summary cards: Number of Invoices and Total Amount Paid, each section from its own records, as filtered */
  const unpaidFine = await api.expenses.create(base("FINE", { vehicleIds: [v2.id], taxType: "OVERLOADING", amount: 3511, date: "2026-11-21" }))
  const cardsOf = (section: Parameters<typeof sectionCards>[0], f: Partial<typeof NO_FILTERS> = {}) =>
    sectionCards(section, all().filter((x) => x.section === section && expenseMatches(x, { ...NO_FILTERS, ...f }, [], null)))
  // Broker: opening 2,19,700, older charges 69,000 (unpaid) and 65,000 (20,000 paid on it), payments 50,000 + 10,000 + 5,000.
  assert.deepEqual(cardsOf("BROKER"), { invoices: 3, paid: 85000 }, "broker: payments never count as invoices; paid = 20,000 + 65,000 of payments, each once; the opening balance is neither")
  assert.deepEqual(cardsOf("BROKER", { from: "2026-11-11", to: "2026-11-30" }), { invoices: 1, paid: 85000 }, "the date filter narrows both cards")
  assert.deepEqual(cardsOf("BROKER", { from: "2026-11-20", to: "2026-11-20" }), { invoices: 0, paid: 50000 }, "a payment alone: paid, never an invoice")
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

  /* 4c. broker: an older one-vehicle charge, fully paid, then edited to partly paid and unpaid */
  const one = old({ entryType: "CHARGE", broker: "Manjanna", description: "FC", purpose: "Goods vehicle", vehicleIds: [v2.id], amount: 3500, paidAmount: 3500, paymentDate: "2026-11-20", paymentMode: "Cash", date: "2026-11-20" })
  const edited = await api.expenses.update(one.id, { ...one, paidAmount: 1500 }, "Only part was paid")
  assert.deepEqual([edited.paidAmount, edited.amount - edited.paidAmount, edited.vehicleIds, edited.paymentDate, edited.purpose], [1500, 2000, [v2.id], "2026-11-20", "Goods vehicle"], "edited to partly paid: balance 2,000; vehicle, cleared date and purpose kept")
  await assert.rejects(api.expenses.update(one.id, { ...edited, paidAmount: 4000 }), /Add Payment/, "an edit can't pay more than the charge")
  const unpaid = await api.expenses.update(one.id, { ...edited, paidAmount: 0 })
  assert.deepEqual([unpaid.paidAmount, unpaid.paymentDate, unpaid.paymentMode], [0, "", "Cash"], "unpaid again: no cleared date; the Payment Type stays")
  await api.expenses.remove(one.id, "Check record")

  /* 5. descriptions */
  const opts = descriptionOptions(all(), "ROAD_TAX")
  assert.equal(opts.filter((o) => o.toUpperCase() === "MV TAX").length, 1, "one entry per spelling (mv tax = MV TAX)")
  assert.equal(opts[0].toUpperCase(), "MV TAX", "the most used first")
  assert.ok(opts.includes("TN TP") && opts.includes("DIFF TAX"), "starters and saved values together")
  assert.ok(descriptionOptions(all(), "BROKER").includes("Krishnagiri district variation (13 buses)"), "a new description is offered again")

  /* 6. roles (Dev only while unreleased), delete, audit */
  const e1 = await api.expenses.create({ ...rt, description: "TN TP" })
  await api.expenses.update(e1.id, { ...e1, amount: 8205 }, "Wrong amount")
  const snapshot = JSON.stringify(all())
  for (const r of ["EMPLOYEE", "TATA_ADBLUE", "ADBLUE"] as const) {
    setRole(r)
    await assert.rejects(api.expenses.list(), /can't view expense/, `${r} reads no expense`)
    await assert.rejects(api.expenses.create(rt), /can't create expense/, `${r} adds no expense`)
    await assert.rejects(api.expenses.update(e1.id, { ...e1, amount: 1 }), /can't edit expense/, `${r} edits no expense`)
    await assert.rejects(api.expenses.remove(e1.id, "Not mine"), /can't delete expense/, `${r} deletes no expense`)
  }
  assert.equal(JSON.stringify(all()), snapshot, "the refused calls changed nothing")
  // The Owner (owner, 28 Nov 2026): every section — view, add, edit, delete (with a reason) — each audited as the Owner.
  {
    setRole("OWNER")
    assert.ok((await api.expenses.list()).some((x) => x.id === e1.id), "the Owner sees Expense records")
    await api.brokers.create("Owner Broker")
    const made = [
      await api.expenses.create({ ...rt, description: "MV TAX", amount: 101 }),
      await api.expenses.create(base("INSURANCE", { vehicleIds: [v2.id], provider: "Owner Insurer", policyNo: "O-1", amount: 102, validFrom: "2026-11-01", validTill: "2027-10-31", paymentMode: "NEFT" })),
      await api.expenses.create(base("FITNESS", { vehicleIds: [v2.id], description: "FC FEES", amount: 103 })),
      await api.expenses.create(base("FINE", { vehicleIds: [v1.id], taxType: "Signal jump", amount: 104, paymentStatus: "UNPAID" })),
      await api.expenses.create(base("BROKER", { entryType: "CHARGE", broker: "Owner Broker", description: "Owner bill", amount: 105 })),
    ]
    assert.deepEqual(made.map((x) => x.section), ["ROAD_TAX", "INSURANCE", "FITNESS", "FINE", "BROKER"], "the Owner adds in all five sections")
    for (const x of made) assert.equal((await api.expenses.update(x.id, { ...x, amount: x.amount + 1 })).amount, x.amount + 1, `the Owner edits ${x.section}`)
    for (const x of made) await api.expenses.remove(x.id, "Owner check")
    assert.ok(!all().some((x) => made.some((m) => m.id === x.id)), "…and deletes in all five")
    const evs = (readAuditEvents() as { action: string; recordId: string; reason: string | null; actor: { role: string | null } }[]).filter((e) => made.some((m) => m.id === e.recordId))
    assert.deepEqual([...new Set(evs.map((e) => e.actor.role))], ["OWNER"], "every event: the Owner")
    assert.deepEqual(made.map((m) => evs.filter((e) => e.recordId === m.id).map((e) => e.action)), made.map(() => ["CREATED", "UPDATED", "DELETED"]))
    assert.ok(evs.filter((e) => e.action === "DELETED").every((e) => e.reason === "Owner check"), "deletion reasons kept")
    await assert.rejects(api.expenses.remove(e1.id, " "), /reason/i, "the Owner's delete still needs a reason")
    await assert.rejects(api.expenseImport.importPlan({}, "x"), /Only Dev/, "imports stay Dev's")
    await assert.rejects(api.expenseImport.rollbackApply("imp_x", "x"), /Only Dev/, "…and import rollbacks")
    const history = await api.audit.history(made[1].id)
    assert.deepEqual(history.map((e) => e.action), ["CREATED", "UPDATED", "DELETED"], "the Owner sees an Insurance record's history")
  }
  setRole("DEV")
  await api.expenses.create({ ...rt, date: "2026-10-15" }) // Dev, like the Owner, may record in a closed month
  await assert.rejects(api.expenses.remove(e1.id, " "), /reason/i)
  await api.expenses.remove(e1.id, "Entered twice")
  assert.ok(!all().some((x) => x.id === e1.id))
  const ev = (readAuditEvents() as { action: string; module: string; recordType: string; recordId: string; reason: string | null }[]).filter((e) => e.recordId === e1.id)
  assert.deepEqual(ev.map((e) => [e.action, e.module, e.recordType]), [["CREATED", "Expense", "Road tax"], ["UPDATED", "Expense", "Road tax"], ["DELETED", "Expense", "Road tax"]])
  assert.equal(ev[2].reason, "Entered twice")
  await assert.rejects(api.expenses.update(r1.id, { ...r1, section: "FINE" }), /can't be moved/)

  // Phase 2B: Expense is on the shared database — a call there goes to the engine (it asks for data), never the Phase 1
  // refusal. The shared-database behaviour itself is tested in check:expense-db.
  const before = count()
  registerScopeGetter(() => ({ identity: { profileId: "p", userId: "u", role: "DEV", email: null, name: null }, cache: new Map(), written: new Set(), expected: {}, newEvents: [], newReviews: [] }))
  try {
    await assert.rejects(api.expenses.create(rt), /Data not loaded yet/)
  } finally {
    registerScopeGetter(() => undefined)
  }
  assert.equal(count(), before)
  /* 6b. EMP 1 (owner, 28 Nov 2026): the Employee + Road Tax, Fitness, Fines, Broker Charges — view, add and edit; no delete */
  {
    setRole("DEV")
    const { PermissionError } = await import("./index")
    const mk = async (section: Parameters<typeof blankExpense>[0], patch: Partial<ReturnType<typeof blankExpense>>) => api.expenses.create(base(section, { date: "2026-11-20", ...patch }))
    const road = await mk("ROAD_TAX", { vehicleIds: [v1.id], description: "MV TAX", taxType: "Same state", amount: 1111, validFrom: "2026-10-01", validTill: "2026-12-31", companyCode: v1.companyCode })
    const insur = await mk("INSURANCE", { vehicleIds: [v2.id], provider: "EMP1 Insurer", policyNo: "P-EMP1", amount: 2222, validFrom: "2026-10-01", validTill: "2027-09-30", paymentMode: "NEFT" })
    const fit = await mk("FITNESS", { vehicleIds: [v2.id], description: "FC FEES", amount: 333 })
    const fine = await mk("FINE", { vehicleIds: [v1.id], taxType: "Signal jump", amount: 444, paymentStatus: "UNPAID" })
    await api.brokers.create("EMP1 Broker")
    const bill = await mk("BROKER", { entryType: "CHARGE", broker: "EMP1 Broker", description: "EMP1 bill", amount: 5000 })
    const closed = await mk("ROAD_TAX", { vehicleIds: [v1.id], description: "MV TAX", taxType: "Same state", amount: 999, validFrom: "2026-10-01", validTill: "2026-12-31", companyCode: v1.companyCode, date: "2026-10-20" })
    const before = JSON.stringify(all())
    const locksBefore = JSON.stringify(readCollection("expense_month_locks"))
    setRole("EMP1")
    // View: the four sections, never Insurance.
    const seen = await api.expenses.list()
    assert.ok([road, fit, fine, bill].every((x) => seen.some((y) => y.id === x.id)), "EMP1 sees Road Tax, Fitness, Fines and Broker Charges")
    assert.ok(!seen.some((x) => x.section === "INSURANCE"), "EMP1 sees no Insurance record")
    assert.ok((await api.brokers.list()).some((b) => b.name === "EMP1 Broker"), "…and the broker list")
    assert.ok((await api.expenseMonths.list()).every((l) => l.section !== "INSURANCE"), "…and no Insurance month lock")
    // Edit: allowed in the four sections, refused for Insurance (whatever the request says), audited as EMP1.
    const edited = await api.expenses.update(road.id, { ...road, amount: 1112 }, "Corrected")
    assert.equal(edited.amount, 1112)
    await api.expenses.update(fit.id, { ...fit, vehicleIds: [v1.id] })
    await api.expenses.update(fine.id, { ...fine, amount: 445 })
    await api.expenses.update(bill.id, { ...bill, amount: 5100 })
    const evs = (readAuditEvents() as { action: string; recordId: string; actor: { role: string | null } }[]).filter((e) => [road.id, fit.id, fine.id, bill.id].includes(e.recordId) && e.action === "UPDATED")
    assert.deepEqual(evs.map((e) => e.actor.role), ["EMP1", "EMP1", "EMP1", "EMP1"], "each edit audited as EMP 1")
    await assert.rejects(api.expenses.update(closed.id, { ...closed, amount: 1 }), /October 2026 is locked/, "EMP1 follows the Monthly Sheet Lock, as the Employee")
    await assert.rejects(api.expenses.update(insur.id, { ...insur, amount: 1 }), (e) => e instanceof PermissionError && /Insurance/.test(e.message), "EMP1 never edits an Insurance record")
    await assert.rejects(api.expenses.update(insur.id, { ...insur, section: "ROAD_TAX", amount: 1 }), /Insurance/, "…not even by claiming another section")
    // Add (owner, 28 Nov 2026): a new record in each of the four sections, audited as EMP 1; never Insurance, never in a
    // closed month (the Monthly Sheet Lock, as the Employee).
    const added = [
      await mk("ROAD_TAX", { vehicleIds: [v1.id], description: "MV TAX", taxType: "Same state", amount: 1201, validFrom: "2026-11-01", validTill: "2027-01-31", companyCode: v1.companyCode }),
      await mk("FITNESS", { vehicleIds: [v2.id], description: "FC FEES", amount: 1202 }),
      await mk("FINE", { vehicleIds: [v1.id], taxType: "Overload", amount: 1203, paymentStatus: "PAID", paymentDate: "2026-11-21" }),
      await mk("BROKER", { entryType: "PAYMENT", broker: "EMP1 Broker", paidAmount: 1204, paymentDate: "2026-11-20" }),
    ]
    assert.deepEqual(added.map((x) => x.section), ["ROAD_TAX", "FITNESS", "FINE", "BROKER"], "EMP1 adds in the four sections")
    const created = (readAuditEvents() as { action: string; recordId: string; actor: { role: string | null } }[]).filter((e) => added.some((x) => x.id === e.recordId) && e.action === "CREATED")
    assert.deepEqual(created.map((e) => e.actor.role), ["EMP1", "EMP1", "EMP1", "EMP1"], "each addition audited as EMP 1")
    await assert.rejects(mk("INSURANCE", { vehicleIds: [v2.id], provider: "EMP1 Insurer", policyNo: "P-2", amount: 1, validFrom: "2026-11-01", validTill: "2027-10-31", paymentMode: "NEFT" }), (e) => e instanceof PermissionError && /Insurance/.test(e.message), "EMP1 adds no Insurance record")
    await assert.rejects(mk("FITNESS", { vehicleIds: [v2.id], amount: 1, date: "2026-10-20" }), /October 2026 is locked/, "…nor into a closed month")
    // No delete (any section — also its own additions), no new broker, no month lock, no import / rollback.
    for (const x of [road, insur, fit, fine, bill, ...added]) await assert.rejects(api.expenses.remove(x.id, "Not allowed"), /can't delete expense/, `EMP1 deletes no ${x.section} record`)
    await assert.rejects(api.brokers.create("Another Broker"), /can't add brokers/, "EMP1 adds no broker")
    await assert.rejects(api.expenseMonths.lock("ROAD_TAX", "2026-10"), /can't lock Expense months/, "EMP1 locks no month")
    await assert.rejects(api.expenseImport.importPlan({}, "x"), /Only Dev/, "EMP1 runs no import")
    await assert.rejects(api.expenseImport.importApply({}, "x"), /Only Dev/)
    await assert.rejects(api.expenseImport.rollbackPlan("imp_x"), /Only Dev/, "…and no import rollback")
    await assert.rejects(api.expenseImport.rollbackApply("imp_x", "x"), /Only Dev/)
    await assert.rejects(api.expenseImport.list(), /Only Dev/)
    assert.equal(JSON.stringify(readCollection("expense_month_locks")), locksBefore, "no lock written")
    // Audit: the four sections' events, never an Insurance event (record, label or amount) or an Expense month / import.
    const log = (await api.audit.list()).filter((e) => e.module === "Expense")
    assert.ok(log.some((e) => e.recordId === road.id) && log.some((e) => e.recordId === bill.id), "EMP1 sees its sections' history")
    assert.ok(!log.some((e) => e.recordType === "Insurance" || e.recordType === "Expense month" || e.recordType === "Import batch" || /EMP1 Insurer/.test(e.label)), "…and no Insurance, month-lock or import event")
    assert.deepEqual(await api.audit.history(insur.id), [], "no Insurance record history")
    // Everything else: exactly the Employee.
    setRole("EMPLOYEE")
    await assert.rejects(api.expenses.list(), /can't view expense/, "the Employee is unchanged: no Expense")
    setRole("DEV")
    const after = all()
    assert.equal(after.find((x) => x.id === insur.id)!.amount, 2222, "the Insurance record is untouched")
    assert.equal(after.length, JSON.parse(before).length + 4, "EMP1 added its four records and deleted nothing")
  }

  /* 7. accounting months and month locking — each section independent (owner, 25 Nov 2026) */
  setRole("DEV")
  // The month is the record's own transaction date — never Tax From / Valid Till, policy dates or the day it was entered.
  const oct = await api.expenses.create({ ...rt, description: "MV TAX", amount: 2000, date: "2026-10-20", validFrom: "2026-12-01", validTill: "2027-02-28" })
  const nov = await api.expenses.create({ ...rt, description: "MV TAX", amount: 3000, date: "2026-11-03", validFrom: "2026-09-01", validTill: "2026-11-30" })
  assert.deepEqual([monthOf(oct), monthOf(nov)], ["2026-10", "2026-11"], "grouped by transaction date, not by validity dates")
  assert.equal(all().filter((x) => x.id === nov.id).length, 1, "one record — switching months never copies it")
  // Each section's months: its own populated months + the current month; empty months (even between two) are left out.
  const recs = [{ date: "2026-09-04" }, { date: "2026-11-02" }, { date: "2026-09-30" }]
  assert.deepEqual(expenseMonthOptions(recs, "2026-11"), ["2026-11", "2026-09"], "October has no record: not offered")
  assert.deepEqual(expenseMonthOptions([], "2026-11"), ["2026-11"], "the current month even with no record")
  assert.deepEqual(expenseMonthOptions(recs, "2026-12"), ["2026-12", "2026-11", "2026-09"], "a new calendar month appears by itself")
  assert.deepEqual(expenseMonthOptions([{ date: "2026-12-31" }], "2027-01"), ["2027-01", "2026-12"], "across a year end")
  assert.deepEqual([addMonthKey("2026-01", -1), monthEnd("2026-02"), monthEnd("2028-02"), monthEnd("2026-11")], ["2025-12", "2026-02-28", "2028-02-29", "2026-11-30"])
  // Summaries: one section's own records only.
  const mk = (x: Partial<ReturnType<typeof blankExpense>> & { section: ReturnType<typeof blankExpense>["section"] }) => ({ ...base(x.section, { date: "2026-11-10", ...x }), customerId: null, id: `m${Math.random()}`, createdAt: "", updatedAt: "" })
  const credit6000 = mk({ section: "BROKER", entryType: "CHARGE", amount: 6000, paidAmount: 1000 })
  const sample = [
    mk({ section: "ROAD_TAX", amount: 1000 }), mk({ section: "ROAD_TAX", amount: 9, date: "2026-10-31" }), mk({ section: "INSURANCE", amount: 2000 }), mk({ section: "FITNESS", amount: 300 }),
    mk({ section: "FINE", amount: 500, paymentStatus: "PAID" }), mk({ section: "FINE", amount: 700 }),
    mk({ section: "BROKER", entryType: "BROUGHT_FORWARD", amount: 9000, date: "2026-09-01" }),
    mk({ section: "BROKER", entryType: "PAYMENT", paidAmount: 4000 }), credit6000, mk({ section: "BROKER", entryType: "PAYMENT", paidAmount: 2000, date: "2026-11-15" }),
    mk({ section: "BROKER", entryType: "PAYMENT", paidAmount: 50, date: "2026-12-01" }),
  ]
  assert.deepEqual(monthSummary("ROAD_TAX", sample, "2026-11"), { records: 1, expense: 1000, paid: 1000, outstanding: null }, "road tax: November's road tax only")
  assert.deepEqual(monthSummary("INSURANCE", sample, "2026-11"), { records: 1, expense: 2000, paid: 2000, outstanding: null })
  assert.deepEqual(monthSummary("FITNESS", sample, "2026-11"), { records: 1, expense: 300, paid: 300, outstanding: null })
  assert.deepEqual(monthSummary("FINE", sample, "2026-11"), { records: 2, expense: 1200, paid: 500, outstanding: 700 })
  // Broker (owner, 27 Nov 2026): expense = the bills (6,000; never the opening balance or a payment); paid = 4,000 + 1,000
  // + 2,000; outstanding at month end = 9,000 opening + 6,000 bill − 1,000 paid on it − 4,000 − 2,000 = 8,000 (December's not yet counted).
  assert.deepEqual(monthSummary("BROKER", sample, "2026-11"), { records: 3, expense: 6000, paid: 7000, outstanding: 8000 })
  assert.deepEqual(monthSummary("BROKER", sample, "2026-09"), { records: 1, expense: 0, paid: 0, outstanding: 9000 }, "an opening balance is owed, never a new expense")
  // Locking: explicit only, per section; read-only for every role in that section; other sections and months unaffected.
  assert.equal(isMonthLocked(readCollection("expense_month_locks"), "ROAD_TAX", "2026-10"), false, "a past month is never locked by the calendar")
  setRole("EMPLOYEE")
  await assert.rejects(api.expenseMonths.lock("ROAD_TAX", "2026-11"), /can't edit expense/, "the Employee can't lock (no Expense)")
  // The Owner locks a section-month (the month-lock authority, owner 28 Nov 2026) — audited as the Owner.
  setRole("OWNER")
  const ownerLock = await api.expenseMonths.lock("INSURANCE", "2026-07")
  assert.ok(isMonthLocked(readCollection("expense_month_locks"), "INSURANCE", "2026-07"), "the Owner locked Insurance · July 2026")
  assert.equal((readAuditEvents() as { action: string; recordId: string; actor: { role: string | null } }[]).find((e) => e.recordId === ownerLock.id && e.action === "MONTH_LOCKED")?.actor.role, "OWNER")
  setRole("DEV")
  await assert.rejects(api.expenseMonths.lock("ROAD_TAX", "2026-12"), /hasn't started yet/)
  await assert.rejects(api.expenseMonths.lock("TYRES" as "ROAD_TAX", "2026-11"), /Choose the Expense section/)
  const novLock = await api.expenseMonths.lock("ROAD_TAX", "2026-11")
  await assert.rejects(api.expenseMonths.lock("ROAD_TAX", "2026-11"), /already locked in Road Tax/)
  assert.deepEqual((await api.expenseMonths.list()).map((l) => [l.section, l.month]), [["INSURANCE", "2026-07"], ["ROAD_TAX", "2026-11"]], "the Owner's lock, then Dev's")
  for (const other of ["INSURANCE", "FITNESS", "FINE", "BROKER"] as const) assert.equal(isMonthLocked(readCollection("expense_month_locks"), other, "2026-11"), false, `${other} November stays open`)
  const snapshot2 = JSON.stringify(all())
  await assert.rejects(api.expenses.create({ ...rt, date: "2026-11-24" }), /November 2026 is locked in Road Tax/, "no new record in a locked month")
  await assert.rejects(api.expenses.update(nov.id, { ...nov, amount: 1 }), /November 2026 is locked in Road Tax/, "no edit")
  await assert.rejects(api.expenses.remove(nov.id, "Wrong entry"), /November 2026 is locked in Road Tax/, "no delete")
  await assert.rejects(api.expenses.update(nov.id, { ...nov, date: "2026-10-30" }), /November 2026 is locked/, "never moved out of a locked month")
  await assert.rejects(api.expenses.update(oct.id, { ...oct, date: "2026-11-02" }), /November 2026 is locked/, "never moved into a locked month")
  assert.equal(JSON.stringify(all()), snapshot2, "every refused change left the records exactly as they were")
  // Another section's November is still open: a broker payment saves.
  const brokerNov = await api.expenses.create(base("BROKER", { entryType: "PAYMENT", broker: "Manjanna", paidAmount: 100, date: "2026-11-24", paymentDate: "2026-11-24" }))
  assert.equal(monthOf(brokerNov), "2026-11", "Broker Charges November is open while Road Tax November is locked")
  await api.expenseMonths.lock("BROKER", "2026-11")
  await assert.rejects(api.expenses.remove(brokerNov.id, "Wrong entry"), /locked in Broker Charges/, "its own lock")
  const octEdited = await api.expenses.update(oct.id, { ...oct, amount: 2500 }, "Correct amount")
  assert.equal(octEdited.amount, 2500, "October is still open: editable")
  await api.expenses.remove(oct.id, "Check record")
  // A lock saved without a section (none exist outside this check) still locks every section.
  assert.equal(isMonthLocked([{ month: "2026-08" }], "FINE", "2026-08"), true)
  assert.ok(isMonthLocked(readCollection("expense_month_locks"), "ROAD_TAX", "2026-11"), "stored, so it survives a reload")
  const lockEvent = (readAuditEvents() as { action: string; module: string; recordId: string; label: string }[]).find((e) => e.recordId === novLock.id)
  assert.deepEqual([lockEvent?.action, lockEvent?.module, lockEvent?.label], ["MONTH_LOCKED", "Expense", "Road Tax · November 2026"], "audited, naming the section")
  /* 8. owner, 27 Nov 2026 — Road Tax paying company and descriptions; Broker credit and payments; Fines driver */
  setRole("DEV")
  const { brokerOutstanding, brokerLedger, brokerMonthAccounts } = await import("@/domain/expenses")
  // Road Tax: the paying company is required and stored on the entry, never taken from the vehicle.
  await assert.rejects(api.expenses.create({ ...rt, date: "2026-10-05", companyCode: null }), /paying company/, "no paying company: refused")
  const vt = await api.expenses.create({ ...rt, date: "2026-10-05", companyCode: "VT", description: "tn  tp" })
  const vthpl = await api.expenses.create({ ...rt, date: "2026-10-06", companyCode: "VTHPL", description: "Floor Area Tax" })
  assert.deepEqual([vt.companyCode, vt.description, vthpl.companyCode, vthpl.description], ["VT", "TN TP", "VTHPL", "Floor Area Tax"], "an existing description keeps its one spelling; a new one is saved as given")
  assert.deepEqual([vt.companyConfirmed, vthpl.companyConfirmed], [true, true], "saved with the company chosen: confirmed")
  const legacyRT = { ...vt, id: "exp_legacy_rt", companyConfirmed: undefined }
  writeCollection("expenses", [...readCollection("expenses"), legacyRT])
  assert.equal(all().find((x) => x.id === legacyRT.id)!.companyConfirmed, undefined, "an older entry is not confirmed (flagged Check in the table)")
  assert.equal((await api.expenses.update(legacyRT.id, { ...legacyRT, companyCode: "VTHPL" })).companyConfirmed, true, "opened and saved with the company chosen: confirmed")
  await api.expenses.remove(legacyRT.id, "Check record")
  assert.ok(descriptionOptions(all(), "ROAD_TAX").includes("Floor Area Tax") && descriptionOptions(all(), "ROAD_TAX").includes("DIFFERENCE TAX FLOOR AREA"), "a new description is offered later; the books' descriptions are all there")
  assert.equal(descriptionOptions(all(), "ROAD_TAX").filter((o) => textKey(o) === "FLOOR AREA TAX").length, 1, "no duplicate")
  const octRT = all().filter((x) => x.section === "ROAD_TAX" && monthOf(x) === "2026-10")
  const byCo = (c: string) => octRT.filter((x) => expenseMatches(x, { ...NO_FILTERS, company: c }, [], null)).map((x) => x.id)
  assert.deepEqual(byCo("VT"), octRT.filter((x) => x.companyCode === "VT").map((x) => x.id), "VT: only VT records")
  assert.deepEqual(byCo("VTHPL"), octRT.filter((x) => x.companyCode === "VTHPL").map((x) => x.id), "VTHPL: only VTHPL records")
  assert.ok(byCo("VT").includes(vt.id) && !byCo("VT").includes(vthpl.id) && byCo("VTHPL").includes(vthpl.id) && !byCo("VTHPL").includes(vt.id))
  assert.equal(byCo("").length, octRT.length, "All Companies: both")
  assert.deepEqual(octRT.filter((x) => expenseMatches(x, { ...NO_FILTERS, company: "VT", search: "tn tp" }, [], null)).map((x) => x.id), [vt.id], "with search too")

  // Broker Charges (owner, 27 Nov 2026): every bunk bill on its own; payments to the broker in bulk, never to a bill.
  await api.brokers.create("ABC Bunk Broker")
  const ABC = "ABC Bunk Broker"
  const bill = (billNo: string, amount: number, date: string, vehicleIds: string[] = []) => api.expenses.create(base("BROKER", { broker: ABC, billNo, description: `Bunk bill ${billNo}`, amount, date, vehicleIds }))
  const payABC = (paidAmount: number, date: string, remarks = "") => api.expenses.create(base("BROKER", { entryType: "PAYMENT", broker: ABC, paidAmount, date, paymentDate: date, remarks }))
  await assert.rejects(payABC(100, "2026-09-01"), /had ₹0.00 outstanding on 01-09-2026/, "nothing billed yet: no payment")
  const b001 = await bill("001", 10000, "2026-09-05", [v1.id])
  const b002 = await bill("002", 15000, "2026-09-12")
  const b003 = await bill("003", 20000, "2026-09-20", [v2.id])
  assert.deepEqual([b001, b002, b003].map((b) => [b.entryType, b.billNo, b.amount, b.paidAmount]), [["CHARGE", "001", 10000, 0], ["CHARGE", "002", 15000, 0], ["CHARGE", "003", 20000, 0]], "each bill on its own, owed, nothing paid")
  assert.deepEqual(brokerLedger(all(), ABC).map((r) => r.balance), [10000, 25000, 45000], "each bill raises the broker's outstanding")
  await assert.rejects(bill(" 001 ", 1, "2026-09-21"), /Bill 001 of ABC Bunk Broker is already recorded/, "one bill number once per broker")
  await api.expenseMonths.lock("BROKER", "2026-09") // September reviewed and locked
  const bills = () => JSON.stringify(all().filter((x) => [b001.id, b002.id, b003.id].includes(x.id)))
  const billsBefore = bills()
  // One bulk payment of ₹30,000 in October: once, against the broker — 45,000 − 30,000 = 15,000.
  const bulk1 = await payABC(30000, "2026-10-10", "NEFT batch")
  assert.equal(all().filter((x) => x.entryType === "PAYMENT" && x.broker === ABC).length, 1, "recorded once")
  assert.equal(brokerOutstanding(all(), ABC), 15000)
  assert.equal(bills(), billsBefore, "no bill changed or allocated — the September bills stay as they were")
  assert.equal(all().filter((x) => x.entryType === "CHARGE" && x.broker === ABC).length, 3, "no artificial bill")
  // Phase 2B (C-6): an identical payment asks for confirmation instead of a flat refusal (section 10) — this one would
  // also overpay (15,000 left), so it is refused by the ledger rule either way.
  await assert.rejects(payABC(30000, "2026-10-10"), /a payment can't be more than that/, "the same payment again: never an overpayment")
  await assert.rejects(payABC(15000.01, "2026-10-20"), /had ₹15,000.00 outstanding on 20-10-2026/, "never more than the broker's outstanding")
  await assert.rejects(api.expenses.update(bulk1.id, { ...bulk1, paidAmount: 45000.5 }), /a payment can't be more than that/, "an edit neither")
  const bulk2 = await payABC(10000, "2026-10-25")
  assert.equal(brokerOutstanding(all(), ABC), 5000, "a second, partial payment: 5,000 left")
  // Months: bills in September, payments in October; Opening + Bills − Payments = Closing.
  assert.deepEqual([monthOf(b001), monthOf(b003), monthOf(bulk1), monthOf(bulk2)], ["2026-09", "2026-09", "2026-10", "2026-10"])
  const acct = (m: string) => brokerMonthAccounts(all(), m).find((a) => a.broker === ABC)
  assert.deepEqual(acct("2026-09"), { broker: ABC, opening: 0, bills: 45000, payments: 0, closing: 45000 })
  assert.deepEqual(acct("2026-10"), { broker: ABC, opening: 45000, bills: 0, payments: 40000, closing: 5000 }, "an October payment never moves a September bill")
  for (const m of ["2026-09", "2026-10", "2026-11"]) for (const a of brokerMonthAccounts(all(), m)) assert.equal(round2(a.opening + a.bills - a.payments), a.closing, `${m} ${a.broker}: opening + bills − payments = closing`)
  assert.deepEqual([monthSummary("BROKER", all(), "2026-09").expense >= 45000, monthSummary("BROKER", all(), "2026-10").expense], [true, 20000], "expense = the month's bills (October: Ravi's bill), never a payment")
  await assert.rejects(api.expenses.update(b002.id, { ...b002, amount: 14000 }), /September 2026 is locked in Broker Charges/, "a locked month's bill stays protected")
  // A bill can't be made smaller, or deleted, so that the broker was paid more than billed.
  const b004 = await bill("004", 5000, "2026-10-26")
  await payABC(10000, "2026-10-27")
  assert.equal(brokerOutstanding(all(), ABC), 0, "settled")
  await assert.rejects(api.expenses.update(b004.id, { ...b004, amount: 4000 }), /paid ₹1,000.00 more than billed/)
  await assert.rejects(api.expenses.remove(b004.id, "Wrong bill"), /paid ₹5,000.00 more than billed/)
  await assert.rejects(payABC(1, "2026-10-12"), /a payment can't be more than that/, "a back-dated payment that would overpay a later date: refused")
  await assert.rejects(api.expenses.create(base("BROKER", { entryType: "PAYMENT", paidAmount: 10, date: "2026-10-28", paymentDate: "2026-10-28" })), /Choose the broker/)
  await assert.rejects(api.expenses.create(base("BROKER", { entryType: "PAYMENT", broker: "Nobody", paidAmount: 10, date: "2026-10-28", paymentDate: "2026-10-28" })), /isn't in the broker list/)
  await assert.rejects(api.expenses.update(bulk2.id, { ...bulk2, entryType: "CHARGE", amount: 10000, description: "x" }), /stays one/, "a payment never becomes a bill")
  assert.deepEqual(brokerLedger(all(), ABC).map((r) => [r.entry.entryType, r.entry.billNo ?? "", r.balance]), [["CHARGE", "001", 10000], ["CHARGE", "002", 25000], ["CHARGE", "003", 45000], ["PAYMENT", "", 15000], ["PAYMENT", "", 5000], ["CHARGE", "004", 10000], ["PAYMENT", "", 0]], "the full ledger: every bill and payment, in order")

  // Fines: the driver from the driver master — by id; the name shown follows the master.
  const drv = await api.drivers.create({ name: "Check Driver Fine", phone: "", licenseNo: "KA01 2020 0001234", licenseValidTill: "", companyCode: null, status: "ACTIVE" })
  const fineD = await api.expenses.create(base("FINE", { vehicleIds: [v2.id], taxType: "SIGNAL JUMP", amount: 1000, date: "2026-10-07", driverId: drv.id }))
  assert.equal(fineD.driverId, drv.id)
  await assert.rejects(api.expenses.create(base("FINE", { vehicleIds: [v2.id], taxType: "X", amount: 1, date: "2026-10-07", driverId: "drv_nobody" })), /driver list/, "never a driver outside the master")
  assert.equal((await api.expenses.create(base("ROAD_TAX", { ...rt, date: "2026-10-08", companyCode: "VT", driverId: drv.id }))).driverId, null, "only Fines record a driver")
  await api.drivers.update(drv.id, { name: "Check Driver Renamed" })
  assert.equal(readCollection("drivers").find((x) => x.id === all().find((e) => e.id === fineD.id)!.driverId)?.name, "Check Driver Renamed", "the fine still points at the same driver; the new name shows")
  await api.drivers.update(drv.id, { status: "ARCHIVED" })
  assert.equal((await api.expenses.update(fineD.id, { ...fineD, amount: 1100 })).driverId, drv.id, "an archived driver already on the fine is kept")
  await assert.rejects(api.expenses.create(base("FINE", { vehicleIds: [v2.id], taxType: "X", amount: 1, date: "2026-10-09", driverId: drv.id })), /archived/, "but not picked for a new fine")

  /* 9. Road Tax → Customer Company filter: the vehicle's customer on each record's date (owner, 27 Nov 2026) */
  {
    const { assignmentIndex, assignmentOn } = await import("@/domain/assignments")
    const custs = (await api.customers.list()).filter((c) => c.status === "ACTIVE")
    const [c1, c2] = custs
    // A spare vehicle (no customer yet), so the check controls its whole assignment history.
    const veh = vehicles.find((v) => ![v1.id, v2.id, v3.id].includes(v.id) && !v.assignedCustomerId && !readCollection("vehicle_assignments").some((a) => a.vehicleId === v.id && a.customerId))!
    assert.ok(veh, "a spare vehicle in the demo data")
    await api.vehicles.transfer(veh.id, c1.id, "2026-10-01", "Check: assignment history")
    const before = await api.expenses.create({ ...rt, vehicleIds: [veh.id], date: "2026-10-05", companyCode: "VT", description: "MV TAX" })
    await api.vehicles.transfer(veh.id, c2.id, "2026-10-15", "Check: assignment history")
    const after = await api.expenses.create({ ...rt, vehicleIds: [veh.id], date: "2026-10-20", companyCode: "VTHPL", description: "MV TAX" })
    const late = await api.expenses.create({ ...rt, vehicleIds: [veh.id], date: "2026-10-25", companyCode: "VT", description: "GREEN TAX" })
    assert.deepEqual([before.customerId, after.customerId, late.customerId], [c1.id, c2.id, c2.id], "the customer on each record's own date")
    // A back-dated transfer after the records were saved: back to c1 from 22 Oct. The page reads the assignment history.
    await api.vehicles.transfer(veh.id, c1.id, "2026-10-22", "Check: back-dated return")
    const idx = assignmentIndex(readCollection("vehicle_assignments"))
    const onRead = <T extends { vehicleIds: string[]; date: string; customerId: string | null }>(x: T) => ({ ...x, customerId: assignmentOn(idx, x.vehicleIds[0], x.date)?.customerId ?? null })
    const mine = [before, after, late].map((x) => onRead(all().find((e) => e.id === x.id)!))
    assert.equal(all().find((e) => e.id === late.id)!.customerId, c2.id, "the stored record is not changed")
    const byCust = (customer: string, company = "") => mine.filter((x) => expenseMatches(x as never, { ...NO_FILTERS, customer, company }, [], null)).map((x) => x.id)
    assert.deepEqual(byCust(c1.id), [before.id, late.id], "c1: before the move and after the back-dated return — the history, not today's customer")
    assert.deepEqual(byCust(c2.id), [after.id], "c2: only while the vehicle was with c2")
    assert.deepEqual(byCust(c1.id, "VT"), [before.id, late.id], "with the paying company VT")
    assert.deepEqual(byCust(c1.id, "VTHPL"), [], "customer c1 + paying company VTHPL: none")
    assert.deepEqual(byCust(c2.id, "VTHPL"), [after.id])
    assert.equal(byCust("").length, 3, "All Customer Companies: every record")
    // Description filter (owner, 27 Nov 2026): case and spacing ignored; together with the other filters.
    const byDesc = (description: string, f: Partial<typeof NO_FILTERS> = {}) => mine.filter((x) => expenseMatches(x as never, { ...NO_FILTERS, ...f, description }, [], null)).map((x) => x.id)
    assert.deepEqual(byDesc("MV TAX"), [before.id, after.id], "MV TAX: only MV TAX records")
    assert.deepEqual(byDesc("GREEN TAX"), [late.id], "GREEN TAX: only GREEN TAX records")
    assert.deepEqual(byDesc("MV TAX", { customer: c1.id, company: "VT" }), [before.id], "with Customer Company and Paying Company")
    assert.deepEqual(byDesc("GREEN TAX", { company: "VTHPL" }), [], "a combination nothing matches")
    assert.equal(byDesc("").length, 3, "cleared: All Descriptions")
    const fresh = await api.expenses.create({ ...rt, vehicleIds: [veh.id], date: "2026-10-26", companyCode: "VT", description: "Permit Fee " })
    assert.deepEqual(all().filter((x) => x.section === "ROAD_TAX" && expenseMatches(x, { ...NO_FILTERS, description: textKey("permit  fee") }, [], null)).map((x) => x.id), [fresh.id], "a newly added description is filterable at once")
  }

  /* 10. Phase 2B on the browser backend: request ids, the broker-payment confirmation, the audit filter, resets keep Expense */
  {
    setRole("DEV")
    const { PossibleDuplicateError } = await import("./index")
    const key = crypto.randomUUID()
    const a1 = await api.expenses.create({ ...rt, date: "2026-10-25", amount: 4321, requestId: key })
    const a2 = await api.expenses.create({ ...rt, date: "2026-10-25", amount: 4321, requestId: key })
    assert.equal(a2.id, a1.id, "same request id: the saved record, no second one")
    await assert.rejects(api.expenses.create({ ...rt, date: "2026-10-25", amount: 1, requestId: key }), /already saved with different values/)
    await assert.rejects(api.expenses.create({ ...rt, requestId: "not-a-uuid" }), /request id is not valid/)
    // Broker payments only: the same broker, date and amount asks for confirmation; Road Tax never does.
    await api.brokers.create("Conf Broker")
    await api.expenses.create(base("BROKER", { entryType: "CHARGE", broker: "Conf Broker", description: "bill", amount: 9000, date: "2026-10-01" }))
    const p = (k: string) => base("BROKER", { entryType: "PAYMENT", broker: "Conf Broker", paidAmount: 1000, date: "2026-10-05", paymentDate: "2026-10-05", requestId: k })
    await api.expenses.create(p(crypto.randomUUID()))
    const k2 = crypto.randomUUID()
    await assert.rejects(api.expenses.create(p(k2)), (e) => e instanceof PossibleDuplicateError, "an identical payment asks")
    const second = await api.expenses.create(p(k2), { confirmSameDay: true })
    assert.equal((await api.expenses.create(p(k2), { confirmSameDay: true })).id, second.id, "a consumed key never makes a third")
    await api.expenses.create({ ...rt, date: "2026-10-25", amount: 4321, requestId: crypto.randomUUID() }) // identical Road Tax: no confirmation
    // The Audit Log never shows Expense events to the Owner or the Employee (C-8).
    setRole("EMPLOYEE")
    assert.equal((await api.audit.list()).filter((e) => e.module === "Expense").length, 0, "the Employee: no Expense event in the Audit Log")
    assert.deepEqual(await api.audit.history(a1.id), [], "the Employee: no Expense history")
    setRole("OWNER")
    assert.ok((await api.audit.list()).some((e) => e.module === "Expense" && e.recordType === "Insurance"), "the Owner: every Expense event, Insurance included")
    assert.ok((await api.audit.history(a1.id)).length > 0, "the Owner: Expense record history")
    setRole("DEV")
    assert.ok((await api.audit.list()).some((e) => e.module === "Expense"), "Dev sees them")
    // Browser resets keep Expense (C-7).
    const { loadEmptyWorkspace, loadDemoData, restoreBackup, exportBackup } = await import("./bootstrap")
    const keep = () => JSON.stringify([readCollection("expenses"), readCollection("brokers"), readCollection("expense_month_locks")])
    const kept = keep()
    const file = exportBackup()
    loadEmptyWorkspace()
    assert.equal(keep(), kept, "Clear all data keeps Expense")
    loadDemoData()
    assert.equal(keep(), kept, "Load demo data keeps Expense")
    restoreBackup({ ...file, collections: { ...file.collections, expenses: [] } })
    assert.equal(keep(), kept, "Restore from a file keeps this browser's Expense (the file's Expense isn't restored)")
  }

  console.log("expenses: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
