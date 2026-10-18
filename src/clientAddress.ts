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

/**
 * Parses an IPv6 address into its eight 16-bit groups, or null if it is not one. A zone
 * (`%eth0`) is ignored and an embedded dotted IPv4 tail (`::ffff:1.2.3.4`) is understood.
 */
function parseIpv6(address: string): number[] | null {
  let a = address.split("%")[0].toLowerCase();
  const dotted = a.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const o = dotted.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    a = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  // Without `::` all eight groups must be written; with it, it stands for at least one.
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...(halves.length === 2 ? Array<string>(missing).fill("0") : []), ...tail];
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return numbers.some(Number.isNaN) ? null : numbers;
}

/**
 * The unit a limit counts clients in. An IPv4 address stands for itself, and so does an
 * IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) as its IPv4. Any other IPv6 address stands for its
 * whole /64 (the default; the smallest block a network hands out, so one client that holds a /64,
 * a /48 or a /32 cannot get a fresh allowance by changing the low 64 bits of its address) or, when
 * `ipv6Bits` is 48, for its whole /48 (what a site is usually given: a limit on how much one
 * source may hold at once should not be beaten by a client that spreads over its /64s).
 * Anything that is not an address ("unknown") comes back unchanged.
 */
export function addressBucket(address: string, ipv6Bits: 64 | 48 = 64): string {
  if (!address.includes(":")) return address;
  const g = parseIpv6(address);
  if (!g) return address;
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `${g.slice(0, ipv6Bits / 16).map((n) => n.toString(16)).join(":")}::/${ipv6Bits}`;
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

/** The bucket of the client that made a request (a /64 for IPv6 unless `ipv6Bits` says /48): see `addressBucket`. */
export function requestBucket(c: Context, trustedProxies: string[], ipv6Bits: 64 | 48 = 64): string {
  return addressBucket(requestAddress(c, trustedProxies), ipv6Bits);
}
