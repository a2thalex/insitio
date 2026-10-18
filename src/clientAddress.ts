import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

function normalize(address: string): string {
  return address.trim().replace(/^::ffff:/, "");
}

/**
 * The address of the client that made a request. X-Forwarded-For is only believed
 * when the direct peer is a trusted proxy; then the right-most hop that is not one
 * of our proxies is the client, so entries a client prepends itself are ignored.
 */
export function clientAddress(peer: string | undefined, forwardedFor: string | undefined, trusted: string[]): string {
  const direct = normalize(peer ?? "");
  if (!direct) return "unknown";
  if (!forwardedFor || !trusted.includes(direct)) return direct;
  const hops = forwardedFor.split(",").map(normalize).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trusted.includes(hops[i])) return hops[i];
  }
  return direct;
}

/** The client address of an incoming request; "unknown" when there is no socket (in-process test requests). */
export function requestAddress(c: Context, trustedProxies: string[]): string {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    // in-process requests (tests) have no socket
  }
  return clientAddress(peer, c.req.header("x-forwarded-for"), trustedProxies);
}
