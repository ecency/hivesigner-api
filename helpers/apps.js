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
import { usageRanking } from './usage';
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

const build = async () => {
  const excluded = new Set(config.excluded || []);
  const pinned = (config.pinned || []).filter(isUsername);

  const usage = usageRanking({ windowDays: config.usage_window_days });
  const usageByApp = new Map(usage.map((row) => [row.username, row]));

  const candidates = [
    ...new Set([...pinned, ...usage.map((row) => row.username)]),
  ]
    .filter((name) => !excluded.has(name))
    .slice(0, config.max_apps);

  if (candidates.length === 0) {
    // Nothing has used the API yet. Say so plainly rather than inventing a
    // list: the UI renders "still building", and a few hours of traffic fixes
    // it permanently.
    publish({
      updated_at: new Date().toISOString(),
      building: true,
      apps: [],
      featured: [],
    });
    return;
  }

  const accounts = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const batch = await indexerClient.database.getAccounts(
      candidates.slice(i, i + 100),
    );
    accounts.push(...(batch || []));
  }

  // THE GATE. An account that has not granted posting authority to the
  // broadcaster is not an app, however many requests carried its name. Pinned
  // entries are not exempt: a pin decides order, not identity.
  const registered = accounts.filter(isRegistered);
  const profiles = new Map(registered.map((a) => [a.name, profileOf(a)]));
  const names = registered.map((a) => a.name);

  if (names.length === 0) {
    publish({
      updated_at: new Date().toISOString(),
      building: true,
      apps: [],
      featured: [],
    });
    return;
  }

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
      last_seen: stats ? stats.lastSeen : null,
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
    window_days: config.usage_window_days,
    apps,
    featured: ordered.slice(0, config.featured_limit).map((a) => a.username),
  });
};

const refresh = async () => {
  try {
    await build();
    console.log(new Date().toISOString(), 'apps: directory rebuilt');
    return true;
  } catch (e) {
    // Never throws to the caller: a failed refresh leaves the previous answer
    // in place, and an unhandled rejection here would take the API down.
    console.error(new Date().toISOString(), 'apps: rebuild failed', e.message);
    return false;
  }
};

export const getAppsIndex = () => cache.get(CACHE_KEY) || null;

export const startAppsIndexer = () => {
  // Two cadences. The slow one is the steady state; the fast one exists so a
  // pass that fails on a transient RPC error does not leave the directory stale
  // for the whole refresh interval.
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
