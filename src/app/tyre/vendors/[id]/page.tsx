import type { Metadata } from "next"
import { TyreVendorDetail } from "@/features/tyre/tyre-vendors"

export const metadata: Metadata = { title: "Tyre vendor" }

export default async function TyreVendorPage(props: PageProps<"/tyre/vendors/[id]">) {
  const { id } = await props.params
  return <TyreVendorDetail id={id} />
}
