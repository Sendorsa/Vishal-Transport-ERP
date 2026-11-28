import type { Metadata } from "next"
import { ExpensePage } from "@/features/expenses/expense-page"

export const metadata: Metadata = { title: "Broker Charges" }

export default function BrokerChargesPage() {
  return <ExpensePage section="BROKER" />
}
