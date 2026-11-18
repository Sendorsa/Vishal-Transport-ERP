import type { Metadata } from "next"
import { TyrePayments } from "@/features/tyre/tyre-payments"

export const metadata: Metadata = { title: "Tyre Payments" }

export default function TyrePaymentsPage() {
  return <TyrePayments />
}
