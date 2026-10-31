import type { Metadata } from "next"
import { PageHeader } from "@/components/shared/page-header"
import { InvoiceForm } from "@/features/invoices/invoice-form"

export const metadata: Metadata = { title: "New invoice" }

export default async function NewInvoicePage(props: PageProps<"/invoices/new">) {
  const { customerId } = await props.searchParams
  return (
    <div>
      <PageHeader title="New invoice" description="Bill completed trips for a customer and period. Lines are grouped per vehicle." backHref="/invoices" backLabel="Invoices" />
      <InvoiceForm defaultCustomerId={typeof customerId === "string" ? customerId : undefined} />
    </div>
  )
}
