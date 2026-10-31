import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type Tone = "green" | "amber" | "red" | "blue" | "gray" | "violet"

const TONES: Record<Tone, string> = {
  green: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  amber: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  red: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
  blue: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  violet: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20",
  gray: "bg-muted text-muted-foreground border-border",
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: "Active", tone: "green" },
  INACTIVE: { label: "Inactive", tone: "gray" },
  ARCHIVED: { label: "Archived", tone: "red" },
  MAINTENANCE: { label: "In workshop", tone: "amber" },
  PLANNED: { label: "Planned", tone: "blue" },
  COMPLETED: { label: "Completed", tone: "green" },
  CANCELLED: { label: "Cancelled", tone: "gray" },
  INVOICED: { label: "Invoiced", tone: "violet" },
  UNBILLED: { label: "Unbilled", tone: "amber" },
  DRAFT: { label: "Draft", tone: "gray" },
  ISSUED: { label: "Issued", tone: "blue" },
  UNPAID: { label: "Unpaid", tone: "blue" },
  PARTIAL: { label: "Partially paid", tone: "amber" },
  PAID: { label: "Paid", tone: "green" },
  OVERDUE: { label: "Overdue", tone: "red" },
  IN: { label: "Received", tone: "green" },
  OUT: { label: "Paid out", tone: "red" },
  OWNED: { label: "Owned", tone: "gray" },
  ATTACHED: { label: "Attached", tone: "violet" },
  CREDIT: { label: "Credit", tone: "blue" },
  CASH: { label: "Cash", tone: "gray" },
  EXPIRED: { label: "Expired", tone: "red" },
  EXPIRING: { label: "Expiring", tone: "amber" },
  VALID: { label: "Valid", tone: "green" },
  VT: { label: "VT", tone: "blue" },
  VTHPL: { label: "VTHPL", tone: "violet" },
}

export function StatusBadge({
  status,
  label,
  tone,
  className,
}: {
  status: string
  label?: string
  tone?: Tone
  className?: string
}) {
  const s = STATUS[status] ?? { label: status, tone: "gray" as Tone }
  return (
    <Badge variant="outline" className={cn("font-medium", TONES[tone ?? s.tone], className)}>
      {label ?? s.label}
    </Badge>
  )
}

export function CompanyBadge({ code }: { code: string }) {
  return <StatusBadge status={code} className="h-4.5 px-1.5 text-[10px]" />
}
