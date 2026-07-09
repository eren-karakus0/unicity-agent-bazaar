import dns from 'node:dns';
import net from 'node:net';

/**
 * SSRF guard for outbound calls to provider-supplied URLs (health probes and job
 * invocations). Any signed-in wallet can publish a listing with an arbitrary
 * webhook URL, so before the server fetches it we resolve the host and reject
 * loopback / private / link-local / unique-local / multicast addresses - closing
 * access to cloud metadata (169.254.169.254), localhost admin ports and RFC1918
 * infrastructure.
 *
 * Residual caveat: this checks the resolved address up-front, not at socket
 * connect, so a determined DNS-rebinding attacker could still race it. Callers
 * also pass `redirect: 'manual'` so a public URL can't 3xx into an internal one.
 */

function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed - reject
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const addr = (ip.split('%')[0] ?? '').toLowerCase(); // strip zone id
  if (addr === '::1' || addr === '::') return true; // loopback, unspecified
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped?.[1]) return ipv4Blocked(mapped[1]);
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique-local
  return false;
}

/** True if `ip` (a literal address) is not safe to connect to. */
export function isBlockedAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Blocked(ip);
  if (fam === 6) return ipv6Blocked(ip);
  return true; // not a resolvable literal - reject
}

/**
 * Throws unless `urlString` is a public http(s) URL. Resolves the hostname and
 * rejects any non-public address. Returns the parsed URL on success.
 *
 * `allow` is an explicit trusted-origin allowlist (matched on `host`, i.e.
 * `hostname:port`) for first-party co-located agents that legitimately live on
 * loopback - the house agents. User-supplied URLs are never in it.
 */
export async function assertPublicUrl(urlString: string, allow?: Set<string>): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http(s) URLs are allowed');
  }
  if (allow?.has(url.host)) return url; // explicitly trusted first-party origin
  const host = url.hostname;

  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('URL host is a non-public address');
    return url;
  }

  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    throw new Error('URL host is a non-public address');
  }

  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new Error('URL host could not be resolved');
  }
  if (addrs.length === 0) throw new Error('URL host could not be resolved');
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) throw new Error('URL host resolves to a non-public address');
  }
  return url;
}
