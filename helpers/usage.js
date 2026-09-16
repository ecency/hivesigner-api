/* eslint-disable no-console */
/**
 * Which apps are actually using Hivesigner, measured here rather than inferred.
 *
 * WHY THIS EXISTS
 *
 * The app directory was built from two on-chain proxies, and both are stale by
 * construction:
 *
 *  - the @hivesigner follow list has not been touched since March 2023, so
 *    @threespeak, @leofinance, @liketu and @dbuzz are simply absent from it;
 *  - posting authority grants never expire, so an app that shut down in 2019
 *    still ranks on grants alone.
 *
 * This server sees requests made on an app's behalf: `strategy` puts the app
 * name on each one as `req.proxy`.
 *
 * ⛔ THAT NAME IS NOT PROOF OF ANYTHING. It is `signed_message.app`, a string
 * chosen by whoever built the token; the signature proves the USER signed the
 * message, not that the app is who it says. Any account can sign a token naming
 * any app and hit any route. Reproduced: one throwaway account calling
 * /_health three times wrote `ecency.app`, `peakd.app` and `totally-made-up`
 * into this file.
 *
 * So these counts are a POPULARITY signal over names that anyone can assert.
 * What makes an entry real is checked where the directory is built
 * (helpers/apps.js): the account must have granted posting authority to the
 * broadcaster, which is the act of registering with Hivesigner and cannot be
 * performed by a third party. Counting here stays cheap; the gate is on the
 * output.
 *
 * WHAT IS STORED
 *
 * Counts, per app, per UTC day. NOT usernames: the file is a usage record, and
 * it has no business holding who used what. Distinct users are counted in
 * memory for the current day and folded to a number when persisted.
 *
 * WHAT THIS CANNOT TELL YOU
 *
 * Which of these names is a real app. Only the registration check in
 * helpers/apps.js answers that.
 */

import {
  mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'fs';
import { dirname, join } from 'path';

/** Days of history kept. Long enough to survive a quiet week. */
const RETENTION_DAYS = 45;
/** At most one write per this many ms, however busy the API is. */
const FLUSH_MS = 60 * 1000;
/** A ceiling on the per-day user set, so one app cannot grow it without bound. */
const MAX_USERS_PER_DAY = 50000;
/**
 * Ceilings on DISTINCT APP NAMES per day.
 *
 * Names are caller-chosen (see above), so without a ceiling one account
 * rotating the name on every request creates a new bucket each time -
 * unbounded memory and a file that grows until the disk does not.
 *
 * But a ceiling alone is racy in the other direction: once a day is full,
 * every name not already in it is uncounted until midnight UTC, and the name
 * that loses is whichever app's first request of the day happens to arrive
 * late. An attacker can make that happen on purpose by filling the day at
 * 00:00. So the names in the directory the indexer last built are NOT subject
 * to any ceiling: every one of them has passed the registration gate, and the
 * set is bounded by max_apps, so it cannot grow a day without bound.
 *
 * Names seen the day before are deliberately NOT vouched for. An earlier
 * version let them past the low ceiling, and junk inherited itself: 500 fresh
 * names a day, each replayed the next day, reached the absolute ceiling in
 * four days and then locked real apps out of the count. Yesterday's junk is
 * still junk.
 *
 * What bounds junk at the source is the PER-USER ceiling: a user introduces at
 * most a handful of never-seen names a day. Real people use one to three apps;
 * a flood comes from a few accounts rotating names, so it is capped where it
 * originates rather than shared out over everybody.
 */
const MAX_UNKNOWN_APPS_PER_DAY = 500;
const MAX_APPS_PER_DAY = 2000;
const MAX_NEW_NAMES_PER_USER_PER_DAY = 5;
/**
 * How many REFUSED names a day are remembered for the indexer to look at.
 *
 * The ceilings above can be filled on purpose: a hundred accounts naming five
 * junk names each close the day to anything not already trusted, and a real
 * app registering that day would never be counted, so never trusted, so never
 * counted - for as long as the flood keeps up. So refusal is not silent: the
 * first few hundred refused names are kept, the indexer runs them through the
 * same on-chain registration check as everything else, and a registered one
 * is trusted from then on. Junk costs the indexer an RPC batch, not the
 * newcomer its place.
 *
 * The sample takes ONE name per presenting user, so saturating it with junk
 * costs a further couple of hundred accounts on top of the hundred that filled
 * the day, every day. That is a cost, not a proof; the operator's way past a
 * flood that sustained is `pinned`, which is verified on every build.
 */
const MAX_REFUSED_PER_DAY = 200;

const FILE = process.env.USAGE_FILE || join('/var/app/data', 'usage.json');
/**
 * The trusted names, persisted beside the counts. Without this every restart
 * opened a window from boot to the first successful build in which nothing was
 * trusted, and a day an attacker had already filled refused the real apps too.
 */
const TRUSTED_FILE = process.env.USAGE_TRUSTED_FILE
  || join(dirname(FILE), 'trusted-apps.json');

const USERNAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const isUsername = (v) => typeof v === 'string' && USERNAME_RE.test(v);

const today = () => new Date().toISOString().slice(0, 10);

/**
 * days: Map<'YYYY-MM-DD', Map<app, { requests, users:Set, restoredUsers }>>
 *
 * `restoredUsers` is the count read back from disk for a day still in progress.
 * After a restart the live Set starts empty, so the day's distinct-user figure
 * is max(restored, live): an undercount for the remainder of that day, which is
 * the price of not persisting usernames.
 *
 * meta: Map<'YYYY-MM-DD', { unknown, introduced: Map<user, count>, refused: Set }>
 *
 * Bookkeeping for the ceilings. `unknown` is how many names outside the
 * trusted set the day has taken on; `introduced` is how many names not yet on
 * record today each user has put there; `refused` is a bounded sample of the
 * names the ceilings turned away, one per presenting user (`refusedBy`). None
 * of it is written to disk, but `unknown`
 * is rebuilt from the counts at load, so a restart leaves that ceiling where
 * it was, while `introduced` genuinely starts over and gives every user a
 * fresh per-user allowance. Nobody outside can trigger a restart, so the
 * asymmetry is tolerable; it is just not "everything resets".
 */
const days = new Map();
const meta = new Map();
let dirty = false;
let flushTimer = null;
let loaded = false;

/**
 * The names the indexer has verified as registered: every name in its last
 * candidate pool whose account had granted posting authority to the
 * broadcaster, which is a superset of the directory it publishes.
 *
 * Set by helpers/apps.js after a successful build, rather than imported from
 * it: apps.js reads usageRanking from here, so a read back the other way would
 * be a cycle. Bounded by the indexer's candidate pool. Persisted, and read
 * back before the counts, so the ceilings never apply to a known app.
 */
let trustedApps = new Set();

const writeTrusted = () => {
  try {
    mkdirSync(dirname(TRUSTED_FILE), { recursive: true });
    const tmp = `${TRUSTED_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify([...trustedApps]));
    renameSync(tmp, TRUSTED_FILE);
  } catch (e) {
    console.error(new Date().toISOString(), 'usage: trusted write failed', e.message);
  }
};

export const setTrustedApps = (names) => {
  trustedApps = new Set((names || []).filter(isUsername));
  writeTrusted();
};

const loadTrusted = () => {
  try {
    const raw = JSON.parse(readFileSync(TRUSTED_FILE, 'utf8'));
    trustedApps = new Set((Array.isArray(raw) ? raw : []).filter(isUsername));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(new Date().toISOString(), 'usage: trusted load failed', e.message);
    }
  }
};

const metaOf = (day) => {
  if (!meta.has(day)) {
    meta.set(day, {
      unknown: 0, introduced: new Map(), refused: new Set(), refusedBy: new Set(),
    });
  }
  return meta.get(day);
};

const refuse = (day, app, user) => {
  const m = metaOf(day);
  if (isUsername(user) && !m.refusedBy.has(user) && m.refused.size < MAX_REFUSED_PER_DAY) {
    m.refused.add(app);
    m.refusedBy.add(user);
  }
  return null;
};

/**
 * Names the ceilings refused today and yesterday, for the indexer to check
 * against the chain. Yesterday too, because a build runs every few hours and
 * a name refused at 23:50 should not be forgotten at midnight.
 */
export const refusedNames = () => {
  const now = today();
  const before = new Date(Date.parse(`${now}T00:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
  const out = new Set();
  [now, before].forEach((day) => {
    const m = meta.get(day);
    if (m) m.refused.forEach((name) => out.add(name));
  });
  return [...out];
};

/**
 * The day's row for `app`, creating it if the ceilings allow.
 *
 * `restoring` is for names read back from disk: they were admitted once
 * already, so only the absolute ceiling applies. A live request for a name not
 * yet on record today has to clear all three, unless the name is trusted.
 */
const bucket = (day, app, { user, restoring = false } = {}) => {
  if (!days.has(day)) days.set(day, new Map());
  const apps = days.get(day);
  if (apps.has(app)) return apps.get(app);

  if (!trustedApps.has(app)) {
    // Absolute first, so nothing outside the trusted set is exempt from it.
    if (apps.size >= MAX_APPS_PER_DAY) return refuse(day, app, user);
    const m = metaOf(day);
    if (!restoring) {
      if (m.unknown >= MAX_UNKNOWN_APPS_PER_DAY) return refuse(day, app, user);
      // A name not yet on record today is only taken on the say-so of the user
      // presenting it, and each user gets a few of those a day, not a stream.
      // "Not yet on record today", not "never seen": replaying yesterday's
      // names costs the same allowance, which is the stricter reading.
      if (!isUsername(user)) return refuse(day, app, user);
      const introduced = m.introduced.get(user) || 0;
      if (introduced >= MAX_NEW_NAMES_PER_USER_PER_DAY) return refuse(day, app, user);
      m.introduced.set(user, introduced + 1);
    }
    m.unknown += 1;
  }
  apps.set(app, { requests: 0, users: new Set(), restoredUsers: 0 });
  return apps.get(app);
};

const prune = () => {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  [...days.keys()].filter((d) => d < cutoff).forEach((d) => days.delete(d));
  [...meta.keys()].filter((d) => d < cutoff).forEach((d) => meta.delete(d));
};

const serialize = () => {
  const out = {};
  days.forEach((apps, day) => {
    out[day] = {};
    apps.forEach((row, app) => {
      out[day][app] = {
        requests: row.requests,
        users: Math.max(row.users.size, row.restoredUsers),
      };
    });
  });
  return out;
};

const flush = () => {
  flushTimer = null;
  if (!dirty) return;
  dirty = false;
  // Here, not only at load. Otherwise days accumulate until the next restart
  // and every flush serializes all of them.
  prune();
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    // Write-then-rename: a crash mid-write must not leave a truncated file that
    // fails to parse on the next boot and silently zeroes the history.
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(serialize()));
    renameSync(tmp, FILE);
  } catch (e) {
    // Losing usage history must never take the API down, and an unwritable
    // volume is a deployment problem, not a request problem.
    console.error(new Date().toISOString(), 'usage: write failed', e.message);
  }
};

const scheduleFlush = () => {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();
};

export const loadUsage = () => {
  if (loaded) return;
  loaded = true;
  // Before the counts, so rows for trusted apps are not tallied as unknown.
  loadTrusted();
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    Object.entries(raw || {}).forEach(([day, apps]) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
      Object.entries(apps || {}).forEach(([app, row]) => {
        if (!isUsername(app) || !row || typeof row !== 'object') return;
        const entry = bucket(day, app, { restoring: true });
        // A file with more names in a day than the absolute ceiling allows -
        // hand-edited, or written by a build with a higher ceiling. Skipping
        // the overflow keeps the rest of the history; dereferencing null here
        // would be caught by the catch below and discard ALL of it.
        if (!entry) return;
        entry.requests = Number(row.requests) || 0;
        entry.restoredUsers = Number(row.users) || 0;
      });
    });
    prune();
    console.log(new Date().toISOString(), `usage: loaded ${days.size} day(s)`);
  } catch (e) {
    // No file yet is the normal first-boot case, not an error worth shouting.
    if (e.code !== 'ENOENT') {
      console.error(new Date().toISOString(), 'usage: load failed', e.message);
    }
  }
};

/** Record one authenticated request made on behalf of `user` by `app`. */
export const recordAppRequest = (app, user) => {
  if (!isUsername(app)) return;
  const entry = bucket(today(), app, { user });
  // Refused by a ceiling: see the note above them.
  if (!entry) return;
  entry.requests += 1;
  if (isUsername(user) && entry.users.size < MAX_USERS_PER_DAY) {
    entry.users.add(user);
  }
  scheduleFlush();
};

/** The first UTC day inside a window of `windowDays` ending today. */
export const windowStart = (windowDays) => new Date(
  Date.now() - (Math.max(1, windowDays) - 1) * 86400000,
)
  .toISOString()
  .slice(0, 10);

/**
 * Apps seen in the last `windowDays` UTC days, today included, most used first.
 *
 * An app with no request inside the window is simply absent: that is how the
 * directory drops an app that has gone quiet, without anybody curating it.
 *
 * Ranked on DISTINCT USERS rather than requests: a single chatty integration
 * polling /api/me should not outrank an app a thousand people actually use.
 *
 * `firstSeen` looks at the whole retained history, not just the window, so a
 * name that has been around for a month is not reported as new merely because
 * the window is a week.
 */
export const usageRanking = ({ windowDays = 7 } = {}) => {
  const cutoff = windowStart(windowDays);
  const firstSeen = new Map();
  days.forEach((apps, day) => {
    apps.forEach((row, app) => {
      const seen = firstSeen.get(app);
      if (!seen || day < seen) firstSeen.set(app, day);
    });
  });
  const totals = new Map();
  days.forEach((apps, day) => {
    if (day < cutoff) return;
    apps.forEach((row, app) => {
      const t = totals.get(app) || {
        username: app,
        users: 0,
        requests: 0,
        lastSeen: '',
        firstSeen: firstSeen.get(app),
      };
      // Summed across days: the same person on two days counts twice, which is
      // "active users" rather than "unique people". Storing enough to do better
      // means storing usernames, which this deliberately does not.
      t.users += Math.max(row.users.size, row.restoredUsers);
      t.requests += row.requests;
      if (day > t.lastSeen) t.lastSeen = day;
      totals.set(app, t);
    });
  });
  return [...totals.values()].sort(
    (a, b) => b.users - a.users || b.requests - a.requests,
  );
};

/**
 * Express middleware. Mounted on the /api router, NOT globally.
 *
 * Globally it counted /_health too, which is how a caller could register a name
 * without touching a single API route. And it counts on `finish` with a
 * successful status, so a request that was rejected does not count as usage.
 */
export const usageRecorder = (req, res, next) => {
  if (req.proxy) {
    res.on('finish', () => {
      if (res.statusCode < 400) recordAppRequest(req.proxy, req.user);
    });
  }
  next();
};

/** Test seam, and used by the shutdown path. */
export const flushUsage = flush;
