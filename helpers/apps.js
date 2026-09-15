/* eslint-disable no-await-in-loop, no-console */
/**
 * The app directory, ranked from real usage.
 *
 * WHY THIS LIVES IN THE API AND NOT IN THE UI
 *
 * The UI is a static browser-only app. Ranking needs ~60 RPC calls and a round
 * of HTTP requests to each candidate's website - fine once every few hours on a
 * server, impossible on a signing app's homepage, and the website check cannot
 * be done from a browser at all (no CORS, and the CSP would not allow it).
 *
 * Doing it here also means the list can change without shipping the UI.
 *
 * WHAT IS RANKED
 *
 *  grants    how many of a sample of currently-active Hive accounts have given
 *            this app posting authority. This is the thing Hivesigner exists to
 *            create, so it is the ranking signal.
 *  site      whether the app's published website still resolves AND still lands
 *            on the domain it claims. This is not cosmetic: several domains in
 *            this directory lapsed and were re-registered, and now redirect to
 *            gambling spam. buildteam.io and cryptobrewmaster.io both do today,
 *            and both are in the hand-curated list this replaces.
 *
 * KNOWN GAP, deliberately not hidden: grants are CUMULATIVE and never expire,
 * so an app that shut down years ago still ranks if its domain happens to
 * resolve. The website check removes the worst of them, and `excluded` in
 * config.json removes the rest by hand. The real fix is to weight by how
 * recently the grants were MADE, which means scanning account_update ops rather
 * than account state; see the note in the README.
 */

import { Client } from '@hiveio/dhive';
import { cache } from './cache';
import { mapLimit, safeFetch } from './safe-fetch';
import { usageRanking } from './usage';
import cjson from '../config.json' assert { type: 'json' };

const { apps: config } = cjson;

/**
 * The indexer's OWN client, not the one the auth path shares.
 *
 * Its calls are bulk reads of hundreds of accounts, which routinely pass the
 * shared client's 4s timeout; dhive then rotates the node for EVERYONE, so a
 * directory refresh was moving the server that token verification runs against.
 * A longer timeout and a separate client keeps the two apart.
 */
const indexerClient = new Client(
  ['https://api.hive.blog', 'https://rpc.mahdiyari.info', 'https://api.deathwing.me'],
  { timeout: 15000, failoverThreshold: 3, consoleOnFailover: true },
);

const ORACLE = 'hivesigner';
const TOP_APPS_PERMLINK = 'top-apps';
const CACHE_KEY = 'apps:index';

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
 * The client that wrote a post, from its json_metadata `app` field.
 *
 * bridge.* returns json_metadata ALREADY PARSED while condenser_api.* returns a
 * string; parseJson accepts both, because getting that wrong silently counts
 * every post as "client not declared" and the whole signal reads as zero.
 */
const clientOf = (json_metadata) => {
  const { app } = parseJson(json_metadata);
  let raw = '';
  if (typeof app === 'string') raw = app;
  else if (app && typeof app === 'object' && typeof app.name === 'string') raw = app.name;
  return raw.split('/')[0].trim().toLowerCase();
};

/**
 * The registrable part of a host, near enough for a same-site check.
 *
 * Comparing whole hosts called `example.com` -> `app.example.com` a hijack,
 * which is a normal thing for a site to do. This keeps the last two labels, and
 * three for the handful of two-part public suffixes these apps actually use, so
 * `foo.co.uk` and `foo.com.br` are not collapsed to `co.uk`.
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
  return TWO_PART_SUFFIXES.has(lastTwo)
    ? labels.slice(-3).join('.')
    : lastTwo;
};

/**
 * Compare an app account to a client string.
 *
 * Client strings are not account names, so both sides are reduced to letters
 * and digits and the account is matched on its NAME or its website's domain.
 * That is what links "3speak" to @threespeak, "dtube" to @dtube.app via d.tube,
 * and "hiveblog" to @hive.blog. It does not link "leothreads" to @leofinance -
 * nothing automatic will - which is what `pinned` in config.json is for.
 *
 * Returns the client names matched, not a total: two accounts can match the
 * same client (@ecency.app and the legacy @esteemapp both resolve to
 * "ecency"), and without resolving that they BOTH claimed every Ecency post
 * and the legacy account was featured on the strength of it.
 */
const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const activityOf = (username, website, clients) => {
  const keys = new Set([normalize(username)]);
  const bare = normalize(username).replace(/app$/, '');
  if (bare.length > 2) keys.add(bare);
  if (website) {
    try {
      const absolute = /^[a-z][a-z0-9+.-]*:/i.test(website) ? website : `https://${website}`;
      const { host } = new URL(absolute);
      const domain = baseDomain(host);
      keys.add(normalize(domain));
      keys.add(normalize(domain.split('.').slice(0, -1).join('')));
    } catch (e) {
      // not a URL: the account name alone has to do
    }
  }
  const matched = [];
  clients.forEach((count, name) => {
    if (keys.has(normalize(name))) matched.push({ name, count });
  });
  return matched;
};

/** Every account @hivesigner follows: the registration list. */
const readDirectory = async () => {
  const STEP = 100;
  const names = [];
  let start = '';
  // A bound only, in case a node ignores `start`; the checks below end the loop.
  for (let page = 0; page < 200; page += 1) {
    const rows = await indexerClient.call('condenser_api', 'get_following', [
      ORACLE,
      start,
      'blog',
      STEP,
    ]);
    if (!Array.isArray(rows) || rows.length === 0) break;
    names.push(...rows.map((r) => r && r.following).filter(isUsername));
    if (rows.length < STEP) break;
    const last = names[names.length - 1];
    if (!last || last === start) break;
    start = last;
  }
  // The node ECHOES the cursor row as the first row of the next page, so this
  // is what stands between the page size and a duplicate at every boundary.
  return [...new Set(names)];
};

/**
 * The most recent posts: who wrote them, and WHICH CLIENT wrote them.
 *
 * The client string is the liveness signal. Posting authority grants are
 * cumulative and never expire, so ranking on grants alone featured DTube,
 * DLive, SteemHunt and DrugWars - all dead for years, all with domains that
 * still resolve. An app that is actually alive is producing posts today.
 */
const readRecentPosts = async (pages) => {
  const authors = new Set();
  const clients = new Map();
  let author = '';
  let permlink = '';
  for (let page = 0; page < pages; page += 1) {
    // bridge.get_ranked_posts caps `limit` at 20; asking for more is an error.
    const query = {
      sort: 'created',
      tag: '',
      observer: '',
      limit: 20,
    };
    if (author) {
      query.start_author = author;
      query.start_permlink = permlink;
    }
    const posts = await indexerClient.call('bridge', 'get_ranked_posts', query);
    if (!Array.isArray(posts) || posts.length === 0) break;
    posts.forEach((post) => {
      authors.add(post.author);
      const client_name = clientOf(post.json_metadata);
      if (client_name) clients.set(client_name, (clients.get(client_name) || 0) + 1);
    });
    const last = posts[posts.length - 1];
    author = last.author;
    permlink = last.permlink;
  }
  return { authors: [...authors], clients };
};

/** Posting authority grants held across the sampled accounts. */
const readGrants = async (sample) => {
  // Fetch first, tally after: counting inside the paging loop means a callback
  // closing over a mutable counter, which airbnb rejects and which is a real
  // footgun besides.
  const accounts = [];
  for (let i = 0; i < sample.length; i += 100) {
    const batch = await indexerClient.database.getAccounts(sample.slice(i, i + 100));
    accounts.push(...(batch || []));
  }
  const grants = new Map();
  accounts.forEach((account) => {
    const auths = (account && account.posting && account.posting.account_auths) || [];
    auths.forEach(([who]) => grants.set(who, (grants.get(who) || 0) + 1));
  });
  return { grants, scanned: accounts.length };
};

/**
 * Does the site resolve, and does it still land on the domain it claims?
 *
 * An off-domain redirect is the signature of a lapsed domain someone else now
 * owns. Comparing base domains, so moving to www. or a subdomain is not flagged.
 * A 4xx is NOT treated as dead: several of these sit behind a bot challenge
 * that answers 403 to anything without a browser fingerprint.
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
    // A blocked address is not the same as a dead site, and an operator
    // reading `rejected` should be able to tell them apart.
    if (/^blocked /.test(e.message)) return { status: 'blocked' };
    return { status: 'unreachable' };
  }
};

/** The hand-curated list, as the fallback and the cold-start answer. */
const readCuratedList = async () => {
  try {
    const content = await indexerClient.database.call('get_content', [ORACLE, TOP_APPS_PERMLINK]);
    const { data } = parseJson(content.json_metadata);
    return Array.isArray(data) ? data.filter(isUsername) : [];
  } catch (e) {
    return [];
  }
};

const publish = (payload) => {
  // stdTTL 0: this never expires on its own. The refresh replaces it, so a
  // failed refresh keeps serving the last good answer rather than nothing.
  cache.set(CACHE_KEY, payload, 0);
};

const excludedSet = () => new Set(config.excluded || []);

/** Fast pass, so the endpoint answers within a second of boot. */
const seedFromCuratedList = async () => {
  if (cache.get(CACHE_KEY)) return;
  // `excluded` has to bite here too. An operator who adds a compromised account
  // to it would otherwise still see a fresh process publish it, in both lists,
  // for as long as the first ranking pass takes.
  const blocked = excludedSet();
  const curated = (await readCuratedList()).filter((n) => !blocked.has(n));
  if (!curated.length) return;
  publish({
    updated_at: new Date().toISOString(),
    source: 'curated',
    featured: curated.map((username) => ({ username })),
    directory: curated,
  });
};

const rank = async () => {
  const [directory, recent] = await Promise.all([
    readDirectory(),
    readRecentPosts(config.post_pages),
  ]);
  const { grants, scanned } = await readGrants(recent.authors);

  const excluded = excludedSet();
  const pinned = (config.pinned || []).filter(isUsername);
  // The published directory is filtered too: the shortlist alone left an
  // excluded account visible in the full list.
  const published = directory.filter((name) => !excluded.has(name));

  // WHAT THIS SERVER HAS SEEN, first. Every other signal here is a proxy for
  // it: the follow list has not been touched since March 2023 (@threespeak,
  // @leofinance, @liketu and @dbuzz are all absent from it) and grants never
  // expire, so an app that shut down in 2019 still scores on them. A request
  // reaching this server is an app being used, today, by a user who signed for
  // it - measured rather than inferred.
  const usage = usageRanking({ windowDays: config.usage_window_days });
  const usageByApp = new Map(usage.map((row) => [row.username, row]));

  // Candidates: apps this server has served, plus the on-chain proxies as a
  // BOOTSTRAP. The proxies matter only until usage history builds up - on a
  // fresh deployment there is none, and the directory should not be empty for a
  // month while it accumulates.
  const granted = [...grants.keys()].filter(isUsername);
  const chainCandidates = [...new Set([...directory, ...granted])]
    .filter((name) => (grants.get(name) || 0) > 0)
    .sort((a, b) => (grants.get(b) || 0) - (grants.get(a) || 0));

  const shortlist = [
    ...new Set([...usage.map((row) => row.username), ...chainCandidates]),
  ]
    .filter((name) => !excluded.has(name))
    .slice(0, config.shortlist_size);

  // Only these get a website request: ~900 outbound requests per refresh would
  // be both rude and pointless.
  const wanted = [...new Set([...pinned, ...shortlist])];
  const accounts = [];
  for (let i = 0; i < wanted.length; i += 100) {
    const batch = await indexerClient.database.getAccounts(wanted.slice(i, i + 100));
    accounts.push(...(batch || []));
  }
  const profiles = new Map(accounts.map((a) => [a.name, profileOf(a)]));

  // Capped, not Promise.all: forty parallel fetches tripped a
  // MaxListenersExceededWarning, which is the runtime saying the same thing.
  const inspect = async (username) => {
    const profile = profiles.get(username) || {};
    const site = await checkSite(profile.website);
    return {
      username,
      profile,
      site,
      grants: grants.get(username) || 0,
      matched: activityOf(username, profile.website, recent.clients),
      usage: usageByApp.get(username) || null,
    };
  };
  const checked = await mapLimit(
    wanted,
    config.site_check_concurrency,
    inspect,
  );

  // A client string belongs to ONE account: the one with the most grants. Any
  // other account matching the same string keeps none of those posts, so a
  // legacy account cannot ride on its successor's activity.
  const ownerOf = new Map();
  checked.forEach((row) => {
    row.matched.forEach(({ name }) => {
      const held = ownerOf.get(name);
      if (!held || row.grants > held.grants) ownerOf.set(name, row);
    });
  });
  checked.forEach((row) => {
    row.posts = row.matched
      .filter(({ name }) => ownerOf.get(name) === row)
      .reduce((total, { count }) => total + count, 0);
  });

  // BOTH gates, and the activity one is the important half. A resolving domain
  // only says somebody still pays for the name; posts say the app is running.
  //
  // `postsLastPass` keeps a low-volume app steady. The sample covers roughly
  // eight hours, so an app that publishes a couple of posts a day lands on zero
  // in some passes and would otherwise appear and vanish between refreshes.
  const previous = cache.get(CACHE_KEY);
  const featuredLastPass = new Set(
    (previous && previous.source === 'ranked' ? previous.featured || [] : [])
      .filter((row) => row.posts > 0)
      .map((row) => row.username),
  );
  // An app this server has SERVED is alive by observation, so it needs no
  // liveness proxy - only a website that has not been hijacked, which is about
  // where it sends people rather than whether it is running. Everything else
  // still has to prove itself through the post sample.
  const isEligible = (row) => pinned.includes(row.username)
    || (row.site.status === 'ok'
      && (row.usage
        || row.posts > 0
        || featuredLastPass.has(row.username)));

  const eligible = checked.filter(isEligible);

  // Pinned first, in configured order; the rest by grants.
  // Pinned first, then everything this server has served, ordered by how many
  // people used it, then the chain-only candidates by grants. Measured beats
  // inferred, and an app with real usage outranks one with a big historical
  // grant count every time.
  const byUsageThenGrants = (a, b) => {
    const ua = a.usage ? a.usage.users : -1;
    const ub = b.usage ? b.usage.users : -1;
    if (ua !== ub) return ub - ua;
    return b.grants - a.grants;
  };
  const ordered = [
    ...pinned.map((name) => eligible.find((r) => r.username === name)).filter(Boolean),
    ...eligible
      .filter((r) => !pinned.includes(r.username))
      .sort(byUsageThenGrants),
  ];

  const reasonFor = (row) => {
    if (row.site.status !== 'ok') return row.site.status;
    return 'no_recent_posts';
  };

  publish({
    updated_at: new Date().toISOString(),
    source: 'ranked',
    method: {
      accounts_scanned: scanned,
      apps_with_usage: usage.length,
      posts_sampled: [...recent.clients.values()].reduce((a, b) => a + b, 0),
      directory_size: published.length,
    },
    featured: ordered.slice(0, config.featured_limit).map((row) => ({
      username: row.username,
      name: row.profile.name || null,
      website: row.site.status === 'ok' ? row.profile.website || null : null,
      grants: row.grants,
      posts: row.posts,
      // What this server actually served. null means it has not seen the app,
      // so the entry rests on the on-chain bootstrap signals.
      usage: row.usage
        ? { users: row.usage.users, requests: row.usage.requests, last_seen: row.usage.lastSeen }
        : null,
    })),
    directory: published,
    // Named WITH the reason, so a person can see why something dropped off
    // instead of guessing. This is how the hijacked domains were found.
    rejected: checked
      .filter((row) => !isEligible(row))
      .map((row) => ({
        username: row.username,
        grants: row.grants,
        posts: row.posts,
        reason: reasonFor(row),
        ...(row.site.to ? { redirects_to: row.site.to } : {}),
      })),
  });
};

const refresh = async () => {
  try {
    await seedFromCuratedList();
  } catch (e) {
    console.error(new Date().toISOString(), 'apps: seeding the curated list failed', e.message);
  }
  try {
    await rank();
    console.log(new Date().toISOString(), 'apps: directory ranked');
    return true;
  } catch (e) {
    // Never throws to the caller: a failed refresh leaves the previous answer
    // in place, and an unhandled rejection here would take the API down.
    console.error(new Date().toISOString(), 'apps: ranking failed', e.message);
    return false;
  }
};

export const getAppsIndex = () => cache.get(CACHE_KEY) || null;

export const startAppsIndexer = () => {
  // Two cadences. The slow one is the steady state. The fast one exists because
  // a pass that fails at boot would otherwise leave the endpoint answering 503
  // (or serving nothing but the curated list) for the whole refresh interval -
  // six hours - over what is often a transient RPC failure.
  let timer = null;

  const tick = async () => {
    const ranked = await refresh();
    const minutes = ranked ? config.refresh_minutes : config.retry_minutes;
    timer = setTimeout(tick, minutes * 60 * 1000);
    if (timer.unref) timer.unref();
  };

  tick();

  return () => {
    if (timer) clearTimeout(timer);
  };
};
