/* eslint-disable no-await-in-loop, no-bitwise */
/**
 * Fetching a URL that an untrusted party chose.
 *
 * The app directory checks each app's website, and that URL comes out of the
 * app account's OWN on-chain profile. Anyone who can get an account onto the
 * shortlist can therefore point this server at an address of their choosing:
 * the loopback interface, a neighbour on the private network, or a cloud
 * instance metadata endpoint. Only reachability and the final host leak back,
 * but that is still a port scanner with a Hive account as the only cost.
 *
 * So every hop is resolved and checked before it is opened:
 *
 *  - the scheme must be http or https;
 *  - the host must not be an IP literal in a special-use range;
 *  - DNS must not resolve it into one either;
 *  - redirects are followed MANUALLY, so hop two gets the same treatment as
 *    hop one. `redirect: 'follow'` would hand a redirect to 169.254.169.254
 *    straight to the socket.
 *
 * This does not close the DNS-rebinding window between the lookup and the
 * connect. Doing that properly needs a custom connect hook; it is noted rather
 * than pretended away, and the payoff for an attacker here is a boolean.
 */

import dns from 'dns';
import net from 'net';

const { lookup } = dns.promises;

/** Special-use IPv4 ranges, as [firstOctet, test] pairs. */
const isPrivateV4 = (ip) => {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable: refuse rather than guess
  }
  const [a, b] = p;
  return (
    a === 0 // this network
    || a === 10 // private
    || a === 127 // loopback
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || (a === 169 && b === 254) // link-local, incl. cloud metadata
    || (a === 172 && b >= 16 && b <= 31) // private
    || (a === 192 && b === 0) // IETF protocol assignments
    || (a === 192 && b === 168) // private
    || (a === 198 && b >= 18 && b <= 19) // benchmarking
    || a >= 224 // multicast, reserved, broadcast
  );
};

/**
 * Expand an IPv6 literal to its eight 16-bit groups.
 *
 * Needed because the address cannot be screened as TEXT. Node's URL parser
 * canonicalizes `[::ffff:127.0.0.1]` to `::ffff:7f00:1`, so a string test for
 * the dotted IPv4-mapped form never fires on anything a URL actually produces -
 * and every private IPv4 address could be reached by writing it that way.
 */
const expandV6 = (ip) => {
  const addr = ip.toLowerCase().split('%')[0];
  const [head, tail] = addr.split('::');
  const toGroups = (part) => {
    if (!part) return [];
    const bits = part.split(':').filter((x) => x !== '');
    const out = [];
    bits.forEach((bit, index) => {
      // A trailing dotted quad, as in ::ffff:127.0.0.1, is two groups.
      if (index === bits.length - 1 && bit.includes('.')) {
        const octets = bit.split('.').map(Number);
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n))) {
          out.push(Number.NaN);
          return;
        }
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        return;
      }
      out.push(Number.parseInt(bit, 16));
    });
    return out;
  };
  const left = toGroups(head);
  const right = tail === undefined ? [] : toGroups(tail);
  if (tail === undefined) {
    return left.length === 8 ? left : null;
  }
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...new Array(fill).fill(0), ...right];
};

const isPrivateV6 = (ip) => {
  const g = expandV6(ip);
  // Unparseable: refuse rather than guess.
  if (!g || g.length !== 8 || g.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) {
    return true;
  }
  const allZero = (upto) => g.slice(0, upto).every((n) => n === 0);
  // ::  and  ::1
  if (allZero(7) && (g[7] === 0 || g[7] === 1)) return true;
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-translated (::ffff:0:a.b.c.d) and the
  // deprecated IPv4-compatible (::a.b.c.d): screen the embedded IPv4.
  const allZeroFrom = (from, upto) => g.slice(from, upto).every((n) => n === 0);
  const embedded = () => {
    if (allZero(5) && g[5] === 0xffff) return [g[6], g[7]];
    if (allZero(4) && g[4] === 0xffff && g[5] === 0) return [g[6], g[7]];
    if (allZero(6)) return [g[6], g[7]];
    // NAT64 well-known prefix 64:ff9b::/96
    if (g[0] === 0x64 && g[1] === 0xff9b && allZeroFrom(2, 6)) return [g[6], g[7]];
    return null;
  };
  const v4 = embedded();
  if (v4) {
    const dotted = [v4[0] >> 8, v4[0] & 0xff, v4[1] >> 8, v4[1] & 0xff].join('.');
    return isPrivateV4(dotted);
  }
  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
};

export const isPrivateAddress = (ip) => {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true; // not an IP at all: refuse
};

/** Throws unless the hostname resolves only to addresses on the public internet. */
export const assertPublicHost = async (hostname) => {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    if (isPrivateAddress(bare)) throw new Error(`blocked address ${bare}`);
    return;
  }
  const lowered = bare.toLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.localhost')) {
    throw new Error('blocked host localhost');
  }
  const records = await lookup(bare, { all: true });
  if (!records.length) throw new Error(`no address for ${bare}`);
  const blocked = records.find(({ address }) => isPrivateAddress(address));
  if (blocked) {
    throw new Error(`blocked address ${blocked.address} for ${bare}`);
  }
};

/**
 * GET a URL chosen by someone else, following redirects by hand.
 *
 * Returns { status, url } for the final hop. The body is cancelled rather than
 * read: this only needs reachability and the landing host, and leaving bodies
 * undrained keeps sockets alive until GC.
 */
export const safeFetch = async (input, { timeoutMs = 12000, maxHops = 5 } = {}) => {
  let url = new URL(input);
  for (let hop = 0; hop <= maxHops; hop += 1) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`blocked scheme ${url.protocol}`);
    }
    await assertPublicHost(url.hostname);

    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'hivesigner-app-directory' },
    });
    // Nothing here reads a body, and an undrained one holds the socket.
    if (res.body) await res.body.cancel().catch(() => {});

    const location = res.headers.get('location');
    const redirected = res.status >= 300 && res.status < 400 && location;
    if (!redirected) return { status: res.status, url: url.toString() };
    url = new URL(location, url);
  }
  throw new Error('too many redirects');
};

/**
 * Run tasks with a ceiling on how many are in flight.
 *
 * Forty parallel fetches tripped a MaxListenersExceededWarning, which is the
 * runtime saying the same thing.
 */
export const mapLimit = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
};
