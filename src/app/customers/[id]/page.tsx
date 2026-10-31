import { CustomerDetail } from "@/features/customers/customer-detail"

export default async function CustomerPage(props: PageProps<"/customers/[id]">) {
  const { id } = await props.params
  return <CustomerDetail id={id} />
}
