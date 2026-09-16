/* eslint-disable no-await-in-loop, no-console */
/**
 * The app directory: which apps use Hivesigner, ranked by how much.
 *
 * TWO THINGS, AND BOTH ARE NEEDED
 *
 * Usage ORDERS the list: helpers/usage.js counts requests made on each app's
 * behalf. Registration DECIDES who is on it: the app account must have granted
 * posting authority to the broadcaster.
 *
 * The second is not optional. `req.proxy` is `signed_message.app`, a string
 * chosen by whoever built the token - the signature proves the user signed the
 * message, not that the app is who it claims. One throwaway account calling
 * /_health three times put `ecency.app`, `peakd.app` and `totally-made-up` into
 * the usage file, and without a gate all three would have been served to the UI
 * with their profile text and had their websites probed by this server.
 *
 * Granting posting authority to the broadcaster IS the registration act - it is
 * what verifyPermissions requires before this API will broadcast for an app,
 * and no third party can perform it for an account they do not control.
 *
 * SO "APP" HERE MEANS "BROADCASTS THROUGH HIVESIGNER"
 *
 * That is narrower than "uses Hivesigner". A site that uses Hivesigner only to
 * log people in never needs the grant: /api/me and /api/oauth2/token go through
 * `authenticate`, and only /api/broadcast goes through `verifyPermissions`. Such
 * a site cannot appear here automatically, and `pinned` in config.json is the
 * only route for it.
 *
 * The obvious second signal does not work. `profile.type === 'app'` in the
 * account's own posting metadata is account-controlled, and the OAuth code flow
 * already reads it - but it is a label any account can put on itself at no cost
 * and with no reference to Hivesigner, so accepting it would reopen the hole the
 * gate closes: set the label, rotate names in tokens, get listed. The grant is
 * specifically "Hivesigner may act for me", which is why it is the one used.
 *
 * It also costs nothing measurable. Of 26 well known Hive app accounts checked
 * on chain, 5 carry `type: 'app'` and every one of those 5 has the grant too.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * An earlier version inferred the same thing from the chain: the @hivesigner
 * follow list, posting authority grants, and the `app` field on recent posts
 * matched back to account names. All three are proxies for what `req.proxy`
 * says outright, and all three are wrong in their own way - the follow list has
 * not been touched since March 2023, grants never expire so they rank services
 * that shut down in 2019, and client strings do not map onto account names
 * ("leothreads" is @leofinance). About seventy RPC calls a pass to answer worse
 * a question this server answers for free.
 *
 * There is also NO fallback list. A fresh deployment serves an empty directory
 * for a few hours until traffic fills it, and then it is right forever. A
 * fallback would be a second code path that only ever runs when nobody is
 * watching, which is where bugs live.
 *
 * WHAT IS STILL CHECKED
 *
 * The app's website, because usage cannot tell you a domain lapsed. Several in
 * this directory did: buildteam.io and cryptobrewmaster.io both redirect to
 * gambling sites today. Usage says an app is running; the site check says where
 * it sends people.
 */

import { Client } from '@hiveio/dhive';
import { cache } from './cache';
import { mapLimit, safeFetch } from './safe-fetch';
import {
  refusedNames, setTrustedApps, usageRanking, windowStart,
} from './usage';
import cjson from '../config.json' assert { type: 'json' };

const { apps: config } = cjson;

const CACHE_KEY = 'apps:index';

/**
 * The indexer's OWN client, not the one the auth path shares.
 *
 * Its reads are bulk account lookups that can pass the shared client's 4s
 * timeout, and dhive rotates the node for EVERYONE on a timeout - so a
 * directory refresh was moving the server token verification runs against.
 */
const indexerClient = new Client(
  ['https://api.hive.blog', 'https://rpc.mahdiyari.info', 'https://api.deathwing.me'],
  { timeout: 15000, failoverThreshold: 3, consoleOnFailover: true },
);

const BROADCASTER = process.env.BROADCASTER_USERNAME;
/** Defaulted here as well as in config.json: a config without it must not throw on every build. */
const ACTIVE_DAYS = Number(config.active_days) || 7;

const USERNAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const isUsername = (v) => typeof v === 'string' && USERNAME_RE.test(v);

const parseJson = (value) => {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value || '{}');
  } catch (e) {
    return {};
  }
};

/**
 * Has this account actually registered with Hivesigner?
 *
 * The same condition verifyPermissions enforces before broadcasting: the app's
 * posting authority includes the broadcaster account. An account that has not
 * done this cannot have the API act for it, so it is not an app here either -
 * whatever name its users put in their tokens.
 */
const isRegistered = (account) => {
  if (!BROADCASTER) return false;
  const auths = (account && account.posting && account.posting.account_auths) || [];
  return auths.some(([who]) => who === BROADCASTER);
};

/** Name, description, website and creator, as the account publishes them. */
const profileOf = (account) => {
  const { profile } = parseJson(account.posting_json_metadata);
  if (!profile || typeof profile !== 'object') return {};
  const out = {};
  ['name', 'about', 'website', 'creator'].forEach((key) => {
    const v = profile[key];
    // Self-authored metadata: strings only, and capped so one account cannot
    // bloat the response for everybody.
    if (typeof v === 'string' && v.trim()) out[key] = v.slice(0, 500);
  });
  return out;
};

/**
 * The registrable part of a host, near enough for a same-site check.
 *
 * Comparing whole hosts called `example.com` -> `app.example.com` a hijack,
 * which is a normal thing for a site to do. Keeps the last two labels, and
 * three for the two-part public suffixes these apps actually use.
 */
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.pl',
  'co.jp', 'co.kr', 'co.nz', 'co.za', 'co.in',
  'com.cn', 'com.hk', 'com.sg', 'com.tw', 'com.ua',
]);

const baseDomain = (host) => {
  const bare = host.toLowerCase().split(':')[0].replace(/\.$/, '');
  const labels = bare.split('.');
  if (labels.length <= 2) return bare;
  const lastTwo = labels.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
};

/**
 * Does the site resolve, and does it still land on the domain it claims?
 *
 * An off-domain redirect is the signature of a lapsed domain someone else now
 * owns. A 4xx is NOT treated as dead: several of these sit behind a bot
 * challenge that answers 403 to anything without a browser fingerprint.
 */
const checkSite = async (website) => {
  if (!website) return { status: 'no_website' };
  const raw = String(website).trim();
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch (e) {
    return { status: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { status: 'invalid' };
  }
  try {
    // NOT a plain fetch: this URL was chosen by the app account, so every hop
    // is resolved and screened first. See helpers/safe-fetch.js.
    const res = await safeFetch(url);
    const from = baseDomain(url.host);
    const to = baseDomain(new URL(res.url).host);
    if (from !== to) return { status: 'redirected', to };
    return { status: 'ok', host: to };
  } catch (e) {
    // A blocked address is not the same as a dead site, and an operator reading
    // `rejected` should be able to tell them apart.
    if (/^blocked /.test(e.message)) return { status: 'blocked' };
    return { status: 'unreachable' };
  }
};

const publish = (payload) => {
  // stdTTL 0: this never expires on its own. The refresh replaces it, so a
  // failed refresh keeps serving the last good answer rather than nothing.
  cache.set(CACHE_KEY, payload, 0);
};

/**
 * Nothing to serve yet.
 *
 * Said plainly rather than by inventing a list: the UI renders "still
 * building", and a few hours of traffic fixes it permanently.
 *
 * Returns false so the caller re-runs on the fast cadence. The first live
 * deploy built once at boot from an empty file, answered "building", and then
 * sat on the six-hour timer while traffic piled up in the usage file behind it.
 */
const publishBuilding = () => {
  // Never over a directory that has already been served. "Nothing to list"
  // after a good answer means the usage file was lost or every app has been
  // silent for a week; the last good answer beats an empty one in both cases,
  // and that is what the README promises about failed rebuilds.
  const current = cache.get(CACHE_KEY);
  if (current && !current.building) return false;
  publish({
    updated_at: new Date().toISOString(),
    building: true,
    apps: [],
    featured: [],
  });
  return false;
};

const build = async () => {
  // No broadcaster name means nothing can pass the gate, so there is no point
  // spending RPC on a pass whose answer is known. The startup log says why.
  if (!BROADCASTER) return publishBuilding();

  const excluded = new Set(config.excluded || []);
  const pinned = (config.pinned || []).filter(isUsername);

  // Only apps seen inside the active window are candidates at all. An app
  // that has gone a week without a single request drops out of the directory
  // on the next build, and comes back the moment it is used again; nobody has
  // to curate departures.
  const usage = usageRanking({ windowDays: ACTIVE_DAYS });
  const usageByApp = new Map(usage.map((row) => [row.username, row]));
  const newCutoff = windowStart(ACTIVE_DAYS);

  /**
   * The names checked for registration, ranked, and deliberately a much wider
   * set than the directory holds.
   *
   * THE ORDER OF THESE TWO STEPS IS THE WHOLE POINT. Usage ranks names that
   * anyone can assert, so cutting to `max_apps` first and gating afterwards
   * lets junk hold the top of the list and push real apps off the end before
   * the gate ever sees them - and with hundreds of fresh buckets available per
   * day, each accruing "users" across the window, that is cheap to arrange.
   * Gating the wider pool and cutting afterwards means a junk name costs a slot
   * in an RPC batch instead of a slot in the directory. The pool is bounded
   * because the RPC cost is: 1000 names is 10 batched account reads.
   */
  //
  // Names the counter REFUSED are in the pool too, after everything ranked,
  // with room reserved so a flood of counted junk cannot crowd them out. A
  // real app that registered on a day the ceilings were full is found here,
  // verified on chain, and trusted from then on - see helpers/usage.js.
  const refused = refusedNames().filter((name) => !excluded.has(name));
  const ranked = [
    ...new Set([...pinned, ...usage.map((row) => row.username)]),
  ]
    .filter((name) => !excluded.has(name))
    .slice(0, Math.max(0, config.candidate_pool - refused.length));
  const pool = [...new Set([...ranked, ...refused])];

  if (pool.length === 0) return publishBuilding();

  const accounts = [];
  for (let i = 0; i < pool.length; i += 100) {
    const batch = await indexerClient.database.getAccounts(pool.slice(i, i + 100));
    accounts.push(...(batch || []));
  }

  // THE GATE, and it runs BEFORE the cut to max_apps. An account that has not
  // granted posting authority to the broadcaster is not an app, however many
  // requests carried its name. Pinned entries are not exempt: a pin decides
  // order, not identity.
  //
  // Re-sorted by position in the pool because getAccounts is not promised to
  // answer in the order it was asked, and after this the order IS the ranking
  // that the cut applies to.
  const rank = new Map(pool.map((name, i) => [name, i]));
  const rankOf = (name) => (rank.has(name) ? rank.get(name) : Number.MAX_SAFE_INTEGER);
  const verified = accounts.filter(isRegistered);
  // Every registered name in the pool is trusted by the counter from now on,
  // whether or not it makes the directory: the counter's ceilings are for
  // names nobody has verified, and these have been. Bounded by the pool.
  setTrustedApps(verified.map((a) => a.name));
  const registered = verified
    .sort((a, b) => rankOf(a.name) - rankOf(b.name))
    .slice(0, config.max_apps);

  const profiles = new Map(registered.map((a) => [a.name, profileOf(a)]));
  const names = registered.map((a) => a.name);

  if (names.length === 0) return publishBuilding();

  const inspect = async (username) => {
    const profile = profiles.get(username) || {};
    const site = await checkSite(profile.website);
    const stats = usageByApp.get(username) || null;
    return {
      username,
      name: profile.name || null,
      about: profile.about || null,
      website: site.status === 'ok' ? profile.website || null : null,
      site: site.status,
      ...(site.to ? { redirects_to: site.to } : {}),
      users: stats ? stats.users : 0,
      requests: stats ? stats.requests : 0,
      first_seen: stats ? stats.firstSeen : null,
      last_seen: stats ? stats.lastSeen : null,
      // First seen inside the window: a newcomer the UI can badge as such.
      new: !!(stats && stats.firstSeen >= newCutoff),
    };
  };

  // Capped, not Promise.all: forty parallel fetches tripped a
  // MaxListenersExceededWarning, which is the runtime saying the same thing.
  const apps = await mapLimit(names, config.site_check_concurrency, inspect);

  // A site that no longer lands on its own domain cannot be FEATURED. It stays
  // in the list with its reason, because an operator should see it rather than
  // have it silently disappear.
  //
  // PINNING DOES NOT EXEMPT AN APP FROM THAT. Review caught the earlier version
  // letting it, which contradicted both the comment here and the README - and
  // the point of the gate is that featuring a lapsed domain sends people to
  // whoever owns it now. `pinned` decides ORDER and rescues an app with little
  // usage; it is not an override on where users get sent.
  const featurable = apps.filter((app) => app.site === 'ok');
  const ordered = [
    ...pinned.map((n) => featurable.find((a) => a.username === n)).filter(Boolean),
    ...featurable
      .filter((a) => !pinned.includes(a.username))
      .sort((a, b) => b.users - a.users || b.requests - a.requests),
  ];

  publish({
    updated_at: new Date().toISOString(),
    building: false,
    window_days: ACTIVE_DAYS,
    apps,
    featured: ordered.slice(0, config.featured_limit).map((a) => a.username),
  });

  return true;
};

/** True when a directory was published; false when still building or failed. */
const refresh = async () => {
  try {
    const built = await build();
    console.log(new Date().toISOString(), built ? 'apps: directory rebuilt' : 'apps: still building');
    return built;
  } catch (e) {
    // Never throws to the caller: a failed refresh leaves the previous answer
    // in place, and an unhandled rejection here would take the API down.
    console.error(new Date().toISOString(), 'apps: rebuild failed', e.message);
    return false;
  }
};

export const getAppsIndex = () => cache.get(CACHE_KEY) || null;

export const startAppsIndexer = () => {
  // Without the broadcaster name there is nothing to check registration
  // against, so isRegistered answers false for everybody and the directory
  // stays `building: true` for ever. That is the right failure - listing
  // unverified names would be worse - but it is indistinguishable from "no
  // traffic yet" unless it says so once, here.
  if (!BROADCASTER) {
    console.error(
      new Date().toISOString(),
      'apps: BROADCASTER_USERNAME is not set, so no account can pass the',
      'registration gate and the directory will stay empty',
    );
  }

  // Two cadences. The slow one is the steady state; the fast one is for a pass
  // that failed on a transient RPC error, and for one that had nothing to list
  // yet, so neither leaves the directory empty or stale for the whole refresh
  // interval.
  let timer = null;

  const tick = async () => {
    const ok = await refresh();
    const minutes = ok ? config.refresh_minutes : config.retry_minutes;
    timer = setTimeout(tick, minutes * 60 * 1000);
    if (timer.unref) timer.unref();
  };

  tick();

  return () => {
    if (timer) clearTimeout(timer);
  };
};
