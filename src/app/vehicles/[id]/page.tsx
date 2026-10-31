import { VehicleDetail } from "@/features/vehicles/vehicle-detail"

export default async function VehiclePage(props: PageProps<"/vehicles/[id]">) {
  const { id } = await props.params
  return <VehicleDetail id={id} />
}
