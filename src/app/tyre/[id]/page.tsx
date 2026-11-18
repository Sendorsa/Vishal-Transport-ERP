import type { Metadata } from "next"
import { TyreInvoiceDetail } from "@/features/tyre/tyre-invoice-detail"

export const metadata: Metadata = { title: "Tyre invoice" }

export default async function TyreInvoicePage(props: PageProps<"/tyre/[id]">) {
  const { id } = await props.params
  const { from } = await props.searchParams
  return <TyreInvoiceDetail id={id} fromSheet={from === "sheet"} fromVendor={from === "vendor"} />
}
