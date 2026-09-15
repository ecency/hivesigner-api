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
 * This server, meanwhile, sees the real thing. `strategy` puts the app's account
 * name on every authenticated request as `req.proxy`, AFTER verifying the
 * token's signature against the chain. So a request that reaches here is an app
 * that is being used, right now, by a real user who signed for it. No name
 * mapping, no follow list, no guessing which client string belongs to which
 * account.
 *
 * WHAT IS STORED
 *
 * Counts, per app, per UTC day. NOT usernames: the file is a usage record, and
 * it has no business holding who used what. Distinct users are counted in
 * memory for the current day and folded to a number when persisted.
 *
 * WHAT THIS CANNOT TELL YOU
 *
 * An app can only appear here by presenting tokens its own users signed, so
 * inflating the count means controlling those accounts. The same is true of
 * grants. It bounds the abuse rather than removing it.
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

const FILE = process.env.USAGE_FILE || join('/var/app/data', 'usage.json');

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
 */
const days = new Map();
let dirty = false;
let flushTimer = null;
let loaded = false;

const bucket = (day, app) => {
  if (!days.has(day)) days.set(day, new Map());
  const apps = days.get(day);
  if (!apps.has(app)) {
    apps.set(app, { requests: 0, users: new Set(), restoredUsers: 0 });
  }
  return apps.get(app);
};

const prune = () => {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  [...days.keys()].filter((d) => d < cutoff).forEach((d) => days.delete(d));
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
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    Object.entries(raw || {}).forEach(([day, apps]) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
      Object.entries(apps || {}).forEach(([app, row]) => {
        if (!isUsername(app) || !row || typeof row !== 'object') return;
        const entry = bucket(day, app);
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
  const entry = bucket(today(), app);
  entry.requests += 1;
  if (isUsername(user) && entry.users.size < MAX_USERS_PER_DAY) {
    entry.users.add(user);
  }
  scheduleFlush();
};

/**
 * Apps seen in the last `windowDays`, most used first.
 *
 * Ranked on DISTINCT USERS rather than requests: a single chatty integration
 * polling /api/me should not outrank an app a thousand people actually use.
 */
export const usageRanking = ({ windowDays = 30 } = {}) => {
  const cutoff = new Date(Date.now() - windowDays * 86400000)
    .toISOString()
    .slice(0, 10);
  const totals = new Map();
  days.forEach((apps, day) => {
    if (day < cutoff) return;
    apps.forEach((row, app) => {
      const t = totals.get(app) || {
        username: app, users: 0, requests: 0, lastSeen: '',
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

/** Express middleware. Runs after `strategy`, which is what sets req.proxy. */
export const usageRecorder = (req, res, next) => {
  // req.proxy is only set once the token's signature has been VERIFIED against
  // the chain, so this counts genuine usage rather than anything a caller can
  // assert.
  if (req.proxy) recordAppRequest(req.proxy, req.user);
  next();
};

/** Test seam, and used by the shutdown path. */
export const flushUsage = flush;
