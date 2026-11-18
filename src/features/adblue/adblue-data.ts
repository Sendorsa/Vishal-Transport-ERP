"use client"

import { useMemo } from "react"
import { isPayable, paidByPurchase, payablesOf, purchasePay, purchaseValue, supplierTotals, vendorAccounts, type Payable } from "@/domain/adblue-payments"
import { useAdBlueEntries, useAdBluePayments, useAdBluePurchases, useAdBlueVendors, useMonthLocks } from "@/lib/api/hooks"
import { useRole } from "@/lib/app-state"
import { canManageAdBluePayments } from "@/lib/permissions"
import type { AdBluePurchase } from "@/lib/types"

/**
 * AdBlue supplier money (owner, 18 Nov 2026): purchases, payments, everything owed to a vendor (`payables`: bulk
 * purchases and direct purchases on credit), each one's paid / outstanding and each vendor's account. `canPay` false
 * (the AdBlue profiles): no payment is read and every money figure is hidden — stock only.
 */
export function useAdBlueFinance() {
  const [role] = useRole()
  const canPay = canManageAdBluePayments(role, "view")
  const purchases = useAdBluePurchases()
  const entries = useAdBlueEntries()
  const payments = useAdBluePayments(canPay)
  const vendors = useAdBlueVendors()
  const locks = useMonthLocks()

  return useMemo(() => {
    const list = purchases.data ?? []
    const pays = canPay ? (payments.data ?? []) : []
    const paid = paidByPurchase(pays)
    const vendor = new Map((vendors.data ?? []).map((v) => [v.id, v]))
    const payables = payablesOf(list, entries.data ?? [])
    const byId = new Map(payables.map((x) => [x.id, x]))
    const accounts = vendorAccounts(payables, pays)
    return {
      ready: !!(purchases.data && vendors.data && entries.data && (!canPay || payments.data)),
      canPay,
      purchases: list,
      /** Bulk purchases owed to a vendor (stock). */
      payable: list.filter(isPayable),
      /** Everything owed to a vendor: bulk purchases and direct purchases on credit. */
      payables,
      payments: pays,
      vendors: vendors.data ?? [],
      locks: locks.data ?? [],
      accounts,
      totals: supplierTotals(accounts),
      vendorName: (id: string | null | undefined) => (id ? (vendor.get(id)?.name ?? "Unknown vendor") : "No vendor"),
      /** A bulk purchase's paid / outstanding. */
      payOf: (p: AdBluePurchase) => purchasePay(purchaseValue(p), paid.get(p.id) ?? 0),
      /** Any payable's paid / outstanding. */
      payOfPayable: (x: Payable) => purchasePay(x.value, paid.get(x.id) ?? 0),
      purchase: (id: string) => list.find((p) => p.id === id),
      /** A payable (bulk or direct) by id — what an allocation points at. */
      payableOf: (id: string) => byId.get(id),
    }
  }, [purchases.data, entries.data, payments.data, vendors.data, locks.data, canPay])
}
export type AdBlueFinance = ReturnType<typeof useAdBlueFinance>
