import { NextResponse, type NextRequest } from "next/server"

const NO_STORE = { "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0", Expires: "0", Pragma: "no-cache" }

/**
 * A redirect that stays on the host the browser used: a relative Location, so nothing — not `request.url`, not an
 * environment variable, not a configured Site URL — can send the browser to another host (e.g. localhost from the
 * Vercel domain). Never cacheable: it may carry new session cookies. `path` must already be a safe in-app path
 * (safeNext / gate).
 */
export function sameHostRedirect(path: string) {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`Not an in-app path: ${path}`)
  return new NextResponse(null, {
    status: 307,
    headers: { Location: path, ...NO_STORE },
  })
}

/**
 * The proxy's redirects must be absolute (Next.js rejects a relative Location there), so build the URL on the host
 * the browser actually asked for — its Host header (and the edge's x-forwarded-proto) — not `request.url`, which
 * Next.js normalises (127.0.0.1 becomes localhost). A Host header that isn't a plain host[:port] falls back to
 * `request.nextUrl`. Never cacheable.
 */
export function proxyRedirect(request: NextRequest, path: string) {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`Not an in-app path: ${path}`)
  const host = request.headers.get("host")
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || request.nextUrl.protocol.replace(":", "")
  const base = host && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) && (proto === "http" || proto === "https") ? `${proto}://${host}` : request.nextUrl.origin
  const res = NextResponse.redirect(new URL(path, base), 307)
  for (const [k, v] of Object.entries(NO_STORE)) res.headers.set(k, v)
  return res
}
