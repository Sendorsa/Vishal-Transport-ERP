import type { Metadata } from "next"
import { PaymentList } from "@/features/payments/payment-list"

export const metadata: Metadata = { title: "Payments" }

export default async function PaymentsPage(props: PageProps<"/payments">) {
  const { new: openNew } = await props.searchParams
  return <PaymentList key={String(openNew)} openNew={openNew === "1"} />
}
