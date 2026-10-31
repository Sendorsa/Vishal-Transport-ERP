import { InvoiceDetail } from "@/features/invoices/invoice-detail"

export default async function InvoicePage(props: PageProps<"/invoices/[id]">) {
  const { id } = await props.params
  return <InvoiceDetail id={id} />
}
