import type { Metadata } from "next"
import { ExpensePage } from "@/features/expenses/expense-page"

export const metadata: Metadata = { title: "Fitness" }

export default function FitnessPage() {
  return <ExpensePage section="FITNESS" />
}
