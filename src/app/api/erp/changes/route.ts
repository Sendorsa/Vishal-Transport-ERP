import { changesSince } from "@/lib/server/erp/engine"
import { requestIdentity, serverTransact, toErpError } from "@/lib/server/erp/http"

/**
 * GET /api/erp/changes?since=<cursor> — which modules changed since the last poll (20-second polling, OD-5), as the
 * caller may see them (RLS). The first call (no cursor) only returns a cursor.
 */
export async function GET(request: Request) {
  const identity = await requestIdentity()
  if ("error" in identity) return Response.json({ error: { message: identity.error } }, { status: identity.status })
  const since = new URL(request.url).searchParams.get("since")
  try {
    return Response.json(await changesSince(serverTransact(), identity, since && !Number.isNaN(Date.parse(since)) ? since : null))
  } catch (e) {
    const { status, body, log } = toErpError(e)
    if (log) console.error("[erp] changes failed:", e)
    return Response.json({ error: body }, { status })
  }
}
