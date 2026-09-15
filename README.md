# Hivesigner API

Hivesigner API module handles access token creation/verification, signing, broadcasting transactions, oauth2 for dapps.

## The app directory: `GET /api/apps`

Public and unauthenticated. Returns the app directory and a featured list ranked
from real usage, so the UI does not have to ship a hand-maintained list:

```json
{
  "updated_at": "...",
  "source": "ranked",
  "featured": [{ "username": "ecency.app", "name": "Ecency", "website": "...", "grants": 341, "posts": 150 }],
  "directory": ["...", "..."],
  "rejected": [{ "username": "dtube.app", "grants": 35, "posts": 0, "reason": "no_recent_posts" }]
}
```

Rebuilt on a timer (`apps.refresh_minutes` in `config.json`); requests only ever
read the last good answer, and a failed refresh keeps serving the previous one.
Before the first refresh completes it answers from the curated
`@hivesigner/top-apps` post, marked `"source": "curated"`.

### How an app gets on the list

**What this server has served, first.** Every authenticated request carries the
app's account name as `req.proxy`, set only after the token's signature has been
verified against the chain. So a request reaching the API is an app being used
today by a user who signed for it — measured, not inferred. `helpers/usage.js`
counts that per app per UTC day (counts only; never usernames) and the directory
ranks on distinct users.

**The on-chain signals are a bootstrap, not the source of truth.** They exist so
a fresh deployment has a directory on day one instead of an empty list for a
month. Both are stale by construction and should be read that way:

- the `@hivesigner` follow list has not been touched since **March 2023**, so
  `@threespeak`, `@leofinance`, `@liketu` and `@dbuzz` are simply not in it;
- posting authority grants **never expire**, so an app that shut down in 2019
  still scores on them.

**Two gates, both necessary.** Posting authority grants are cumulative and never
expire, so ranking on them alone featured DTube, DLive, SteemHunt and DrugWars,
dead for years. And several app domains in this directory lapsed and were
re-registered: `buildteam.io` and `cryptobrewmaster.io` both redirect to
gambling sites today, and both were in the curated list. So an app is featured
only if its website still lands on the domain it claims **and** it produced
posts in the recent sample.

`rejected` says why each shortlisted app missed, which is how those hijacked
domains were found. Worth reading after a refresh.

### Known limits

- Client strings in post metadata are not account names. They are matched
  against the account name and its website domain, which links `3speak` to
  `@threespeak` and `hiveblog` to `@hive.blog` — but nothing automatic links
  `leothreads` to `@leofinance`. Use `apps.pinned` in `config.json` for those.
- A legitimate domain move reads as a redirect (`travelfeed.io` →
  `travelfeed.com`). `apps.pinned` overrides that too.
- Grants are weighted by count, not by when they were made. Weighting by recency
  would mean scanning `account_update` operations rather than account state.

`apps.excluded` drops an account outright.

### Usage storage

`helpers/usage.js` keeps 45 days in `/var/app/data/usage.json` (override with
`USAGE_FILE`), written at most once a minute and atomically. The compose file
mounts a named volume there: a task's filesystem is discarded on every deploy,
and losing this would drop the directory back onto the stale on-chain fallbacks
until it rebuilt.

It stores **counts only**. Distinct users are tallied in memory for the current
day and folded to a number when written, so the file never holds who used what.
The cost is that a restart mid-day loses that day's deduplication and the figure
undercounts for the rest of it.

An app can only appear here by presenting tokens its own users signed, so
inflating a count means controlling those accounts. That bounds the abuse rather
than removing it — the same is true of grants.

## Learn more 

Homepage: https://hivesigner.com

Documentation: https://docs.hivesigner.com

Hivesigner SDK: https://github.com/ecency/hivesigner-sdk

Hivesigner UI: https://github.com/ecency/hivesigner-ui

## Issues

To report a non-critical issue, please file an issue on this GitHub project. If you find a security issue please report details to `security@hivesigner.com` or trusted community members. We will evaluate the risk and make a patch available before filing the issue.
