import type { Metadata } from "next"
import { AdBlueVendorAccount } from "@/features/adblue/adblue-vendor-account"

export const metadata: Metadata = { title: "AdBlue vendor account" }

export default async function AdBlueVendorPage(props: PageProps<"/adblue/vendors/[id]">) {
  const { id } = await props.params
  return <AdBlueVendorAccount id={id} />
}
