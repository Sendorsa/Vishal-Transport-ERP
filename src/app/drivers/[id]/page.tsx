import { DriverDetail } from "@/features/drivers/driver-detail"

export default async function DriverPage(props: PageProps<"/drivers/[id]">) {
  const { id } = await props.params
  return <DriverDetail id={id} />
}
