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
