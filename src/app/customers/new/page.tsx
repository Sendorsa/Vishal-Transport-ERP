import type { Metadata } from "next"
import { RequirePermission } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { CustomerForm } from "@/features/customers/customer-form"

export const metadata: Metadata = { title: "New customer" }

export default function NewCustomerPage() {
  return (
    <RequirePermission resource="customers" action="create" what="creating customers">
      <div className="mx-auto max-w-5xl">
        <PageHeader title="New customer" description="Add a client and its pricing terms." backHref="/customers" backLabel="Customers" />
        <CustomerForm />
      </div>
    </RequirePermission>
  )
}
