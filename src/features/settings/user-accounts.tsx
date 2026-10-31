"use client"

import { useCallback, useEffect, useState } from "react"
import { LogOut, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { FormModal } from "@/components/shared/form-modal"
import { Field, PageSkeleton } from "@/components/shared/misc"
import { PageHeader } from "@/components/shared/page-header"
import { SimpleSelect } from "@/components/shared/simple-select"
import { GoogleSignInButton, signOutToLogin } from "@/features/auth/sign-in-buttons"
import type { ErpRole } from "@/lib/supabase/database.types"
import { formatDate } from "@/lib/format"
import { getAccountState, addAccount, relinkAccount, setAccountRole, setAccountStatus, type Account, type AccountState, type Result } from "@/app/settings/users/actions"

const ROLE_OPTIONS: { value: ErpRole; label: string }[] = [
  { value: "OWNER", label: "Owner" },
  { value: "EMPLOYEE", label: "Employee" },
  { value: "DEV", label: "Dev" },
]
const roleLabel = (r: ErpRole) => ROLE_OPTIONS.find((o) => o.value === r)?.label ?? r
const STATUS_LABEL = { INVITED: "Approved · not signed in yet", ACTIVE: "Active", DISABLED: "Deactivated" } as const

/** Settings → User accounts: your account, and (for an active DEV) every account with its management actions. */
export function UserAccounts({ error }: { error?: string }) {
  const [state, setState] = useState<AccountState | null>(null)
  const refresh = useCallback(() => getAccountState().then(setState), [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (error) toast.error(error)
  }, [error])

  const signOut = signOutToLogin

  const header = (
    <PageHeader
      title="User accounts"
      description="Google sign-in accounts and their roles. Business data still lives in this browser until the database switch-over."
      backHref="/settings"
      backLabel="Settings"
    />
  )
  if (!state) return <PageSkeleton />

  if (state.kind === "unconfigured")
    return (
      <div>
        {header}
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Sign-in isn&apos;t set up on this installation</CardTitle>
            <CardDescription>{state.message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )

  if (state.kind === "signed-out")
    return (
      <div>
        {header}
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Sign in</CardTitle>
            <CardDescription>Sign in with the Google account the system administrator (Dev) approved for you.</CardDescription>
          </CardHeader>
          <CardContent>
            <GoogleSignInButton />
          </CardContent>
        </Card>
      </div>
    )

  if (state.kind === "no-account")
    return (
      <div>
        {header}
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">No ERP account for {state.email ?? "this Google account"}</CardTitle>
            <CardDescription>This Google account isn&apos;t an approved ERP account. Ask the system administrator (Dev).</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={signOut}>
              <LogOut className="size-4" /> Sign out
            </Button>
          </CardContent>
        </Card>
      </div>
    )

  const { me, accounts } = state
  return (
    <div className="space-y-4">
      {header}
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Signed in as {me.email}</CardTitle>
          <CardDescription>
            {roleLabel(me.role)} · {STATUS_LABEL[me.status]}
            {me.status === "DISABLED" && " — this account has been deactivated. Contact the system administrator (Dev)."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={signOut}>
            <LogOut className="size-4" /> Sign out
          </Button>
        </CardContent>
      </Card>
      {accounts ? (
        <AccountManager accounts={accounts} meId={me.id} onChanged={refresh} />
      ) : (
        me.status === "ACTIVE" && <p className="text-sm text-muted-foreground">Only Dev can manage user accounts.</p>
      )}
    </div>
  )
}

type Dialog = { kind: "add" } | { kind: "role" | "status" | "relink"; account: Account } | null

function AccountManager({ accounts, meId, onChanged }: { accounts: Account[]; meId: string; onChanged: () => Promise<void> }) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const [pending, setPending] = useState(false)
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [role, setRole] = useState<ErpRole>("EMPLOYEE")
  const [reason, setReason] = useState("")

  const open = (d: NonNullable<Dialog>) => {
    setEmail("")
    setName("")
    setReason("")
    setRole(d.kind === "role" ? d.account.role : "EMPLOYEE")
    setDialog(d)
  }
  const run = async (op: () => Promise<Result>, done: string) => {
    setPending(true)
    const r = await op()
    setPending(false)
    if (!r.ok) return toast.error(r.error)
    toast.success(done)
    setDialog(null)
    await onChanged()
  }
  const reasonOk = reason.trim().length >= 3
  const reasonField = (
    <Field label="Reason" required hint="At least 3 characters. Recorded in the audit log.">
      <Input value={reason} onChange={(e) => setReason(e.target.value)} />
    </Field>
  )

  return (
    <Card size="sm">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-sm font-semibold">Accounts ({accounts.length})</CardTitle>
          <CardDescription>Only Dev can add accounts, change roles, deactivate, reactivate or recover access. No email is sent: a person gets access by signing in with Google using the approved email. Every change is recorded in the audit log.</CardDescription>
        </div>
        <Button size="sm" onClick={() => open({ kind: "add" })}>
          <UserPlus className="size-4" /> Add account
        </Button>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Activated</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">
                  {a.email}
                  {a.id === meId && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
                </TableCell>
                <TableCell>{a.fullName ?? "—"}</TableCell>
                <TableCell>{roleLabel(a.role)}</TableCell>
                <TableCell>
                  <Badge variant={a.status === "ACTIVE" ? "default" : a.status === "INVITED" ? "secondary" : "outline"}>{STATUS_LABEL[a.status]}</Badge>
                </TableCell>
                <TableCell>{a.activatedAt ? formatDate(a.activatedAt.slice(0, 10)) : "—"}</TableCell>
                <TableCell className="space-x-1 text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => open({ kind: "role", account: a })}>
                    Change role
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => open({ kind: "status", account: a })}>
                    {a.status === "DISABLED" ? "Reactivate" : "Deactivate"}
                  </Button>
                  {a.status !== "DISABLED" && (
                    <Button size="sm" variant="ghost" onClick={() => open({ kind: "relink", account: a })}>
                      Move to new email
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      {dialog?.kind === "add" && (
        <FormModal
          open
          onOpenChange={() => setDialog(null)}
          title="Add an account"
          description="No email is sent. The person gets access by signing in with Google using exactly this email."
          submitLabel="Add account"
          pending={pending}
          submitDisabled={!email.trim()}
          onSubmit={() => run(() => addAccount(email, role, name), `Added ${email.trim().toLowerCase()}`)}
        >
          <Field label="Email" required>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Role" required>
            <SimpleSelect value={role} onChange={(v) => setRole(v as ErpRole)} options={ROLE_OPTIONS} />
          </Field>
        </FormModal>
      )}

      {dialog?.kind === "role" && (
        <FormModal
          open
          onOpenChange={() => setDialog(null)}
          title={`Change role · ${dialog.account.email}`}
          submitLabel="Change role"
          pending={pending}
          submitDisabled={!reasonOk || role === dialog.account.role}
          onSubmit={() => run(() => setAccountRole(dialog.account.id, role, reason), "Role changed")}
        >
          <Field label="Role" required>
            <SimpleSelect value={role} onChange={(v) => setRole(v as ErpRole)} options={ROLE_OPTIONS} />
          </Field>
          {reasonField}
        </FormModal>
      )}

      {dialog?.kind === "status" && (
        <FormModal
          open
          onOpenChange={() => setDialog(null)}
          title={`${dialog.account.status === "DISABLED" ? "Reactivate" : "Deactivate"} · ${dialog.account.email}`}
          description={
            dialog.account.status === "DISABLED"
              ? "The account gets its access back (one that never signed in becomes Approved · not signed in yet again)."
              : "Access stops at the person's next request. The account and its history are kept."
          }
          submitLabel={dialog.account.status === "DISABLED" ? "Reactivate" : "Deactivate"}
          destructive={dialog.account.status !== "DISABLED"}
          pending={pending}
          submitDisabled={!reasonOk}
          onSubmit={() =>
            run(
              () => setAccountStatus(dialog.account.id, dialog.account.status === "DISABLED" ? "ACTIVE" : "DISABLED", reason),
              dialog.account.status === "DISABLED" ? "Account reactivated" : "Account deactivated"
            )
          }
        >
          {reasonField}
        </FormModal>
      )}

      {dialog?.kind === "relink" && (
        <FormModal
          open
          onOpenChange={() => setDialog(null)}
          title={`Move to a new email · ${dialog.account.email}`}
          description="For a lost or changed Google account. The current Google account loses access at once; the next sign-in with the new email takes over this account, its role and its history."
          submitLabel="Move account"
          pending={pending}
          submitDisabled={!email.trim() || !reasonOk}
          onSubmit={() => run(() => relinkAccount(dialog.account.id, email, reason), "Account moved; it activates at the next sign-in with the new email")}
        >
          <Field label="New email" required>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          {reasonField}
        </FormModal>
      )}
    </Card>
  )
}
