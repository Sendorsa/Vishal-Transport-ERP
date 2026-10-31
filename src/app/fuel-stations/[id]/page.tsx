import { FuelStationDetail } from "@/features/fuel-stations/fuel-stations"

export default async function FuelStationPage(props: PageProps<"/fuel-stations/[id]">) {
  const { id } = await props.params
  return <FuelStationDetail key={id} id={id} />
}
