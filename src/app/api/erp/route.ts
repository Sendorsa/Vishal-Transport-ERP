import { runInDatabase } from "@/lib/server/erp/engine"
import { cleanVersions, requestIdentity, resolveMethod, serverTransact, toErpError } from "@/lib/server/erp/http"

/**
 * POST /api/erp — one `api.*` call against the shared database: { method: "diesel.create", args: [...], expected }.
 * The caller is the verified account of the session (never a role or user id from the body). Only methods of the public
 * `api` object are callable; reset / clear / restore of the whole database never are. One transaction per call.
 */
export async function POST(request: Request) {
  const identity = await requestIdentity()
  if ("error" in identity) return Response.json({ error: { message: identity.error } }, { status: identity.status })
  let body: { method?: unknown; args?: unknown; expected?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: { message: "Bad request." } }, { status: 400 })
  }
  const target = resolveMethod(body.method)
  if (!target || !Array.isArray(body.args)) return Response.json({ error: { message: "Unknown operation." } }, { status: 400 })
  const args = body.args as unknown[]
  try {
    const result = await runInDatabase(serverTransact(), identity, target.write, cleanVersions(body.expected), () => target.fn(...args))
    return Response.json({ result: result ?? null })
  } catch (e) {
    const { status, body: error, log } = toErpError(e)
    if (log) console.error(`[erp] ${String(body.method)} failed for ${identity.role} ${identity.profileId}:`, e)
    return Response.json({ error }, { status })
  }
}
