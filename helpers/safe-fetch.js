/* eslint-disable no-await-in-loop */
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

const isPrivateV6 = (ip) => {
  const addr = ip.toLowerCase().split('%')[0];
  if (addr === '::' || addr === '::1') return true; // unspecified, loopback
  // IPv4-mapped (::ffff:127.0.0.1) is the classic way round an IPv4-only check.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return (
    addr.startsWith('fc') // unique local
    || addr.startsWith('fd') // unique local
    || addr.startsWith('fe8') // link-local
    || addr.startsWith('fe9')
    || addr.startsWith('fea')
    || addr.startsWith('feb')
    || addr.startsWith('ff') // multicast
  );
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
