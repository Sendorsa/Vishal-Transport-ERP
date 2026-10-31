import { notFound } from "next/navigation"
import { isMonthKey } from "@/domain/diesel"
import { MonthRedirect } from "@/features/diesel/month-redirect"

export default async function DieselMonthPage(props: PageProps<"/diesel/[company]/[month]">) {
  const { company, month } = await props.params
  if (!isMonthKey(month)) notFound()
  return <MonthRedirect slug={company} month={month} />
}
