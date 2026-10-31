import type { Metadata } from "next"
import { InvoiceList } from "@/features/invoices/invoice-list"

export const metadata: Metadata = { title: "Invoices" }

export default async function InvoicesPage(props: PageProps<"/invoices">) {
  const { status } = await props.searchParams
  const s = typeof status === "string" ? status : undefined
  return <InvoiceList key={s ?? "all"} initialStatus={s} />
}
