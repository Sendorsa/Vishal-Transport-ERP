import type { Metadata } from "next"
import { AdBluePaymentsPage } from "@/features/adblue/adblue-payments"

export const metadata: Metadata = { title: "AdBlue Payments" }

export default function AdBluePaymentsRoute() {
  return <AdBluePaymentsPage />
}
