/**
 * Order for every financial transaction table — newest first:
 *
 *   1. date       DESC  (newest day first)
 *   2. createdAt  DESC  (within a day, the most recently entered first)
 *   3. id         DESC  (records sharing a createdAt — seeded data — use their sequential id,
 *                        which is their generation order)
 *
 * Never voucher numbers, amounts, company, or array / localStorage position.
 */
interface Ordered {
  id?: string
  date: string
  createdAt?: string
}

export function byEntryOrder(a: Ordered, b: Ordered) {
  return b.date.localeCompare(a.date) || (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || (b.id ?? "").localeCompare(a.id ?? "")
}

/** A sorted copy, newest first. */
export const inEntryOrder = <T extends Ordered>(list: readonly T[]): T[] => [...list].sort(byEntryOrder)
