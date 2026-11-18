"use client"

import { useMemo } from "react"
import { isPayable, paidByPurchase, purchasePay, purchaseValue, supplierTotals, vendorAccounts } from "@/domain/adblue-payments"
import { useAdBluePayments, useAdBluePurchases, useAdBlueVendors, useMonthLocks } from "@/lib/api/hooks"
import { useRole } from "@/lib/app-state"
import { canManageAdBluePayments } from "@/lib/permissions"
import type { AdBluePurchase } from "@/lib/types"

/**
 * AdBlue supplier money (owner, 18 Nov 2026): purchases, payments, each purchase's paid / outstanding and each vendor's
 * account. `canPay` false (the AdBlue profiles): no payment is read and every money figure is hidden — stock only.
 */
export function useAdBlueFinance() {
  const [role] = useRole()
  const canPay = canManageAdBluePayments(role, "view")
  const purchases = useAdBluePurchases()
  const payments = useAdBluePayments(canPay)
  const vendors = useAdBlueVendors()
  const locks = useMonthLocks()

  return useMemo(() => {
    const list = purchases.data ?? []
    const pays = canPay ? (payments.data ?? []) : []
    const paid = paidByPurchase(pays)
    const vendor = new Map((vendors.data ?? []).map((v) => [v.id, v]))
    const accounts = vendorAccounts(list, pays)
    return {
      ready: !!(purchases.data && vendors.data && (!canPay || payments.data)),
      canPay,
      purchases: list,
      payable: list.filter(isPayable),
      payments: pays,
      vendors: vendors.data ?? [],
      locks: locks.data ?? [],
      accounts,
      totals: supplierTotals(accounts),
      vendorName: (id: string | null | undefined) => (id ? (vendor.get(id)?.name ?? "Unknown vendor") : "No vendor"),
      payOf: (p: AdBluePurchase) => purchasePay(purchaseValue(p), paid.get(p.id) ?? 0),
      purchase: (id: string) => list.find((p) => p.id === id),
    }
  }, [purchases.data, payments.data, vendors.data, locks.data, canPay])
}
export type AdBlueFinance = ReturnType<typeof useAdBlueFinance>
