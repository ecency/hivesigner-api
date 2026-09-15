# Hivesigner API

Hivesigner API module handles access token creation/verification, signing, broadcasting transactions, oauth2 for dapps.

## The app directory: `GET /api/apps`

Public and unauthenticated. Which apps use Hivesigner, ranked by how many people
use them:

```json
{
  "updated_at": "...",
  "building": false,
  "window_days": 30,
  "featured": ["ecency.app", "peakd.app", "..."],
  "apps": [
    { "username": "ecency.app", "name": "Ecency", "about": "...",
      "website": "https://ecency.com", "site": "ok",
      "users": 412, "requests": 9310, "last_seen": "2026-09-15" }
  ]
}
```

### Where the list comes from

Every authenticated request carries the app's account name as `req.proxy`, set
by `strategy` only **after** the token's signature has been verified against the
chain. A request reaching this server is therefore an app being used, today, by
a user who signed for it. `helpers/usage.js` counts that per app per UTC day and
the directory ranks on distinct users.

That is the only signal. There is no follow list, no posting-authority tally, no
post-metadata scraping, and **no fallback list**. A fresh deployment answers
`"building": true` with an empty list for a few hours until traffic fills it,
and is then correct permanently. A fallback would be a second code path that
only runs when nobody is watching.

### What is still checked on-chain

The app's website, because usage cannot tell you a domain lapsed — several here
did, and `buildteam.io` and `cryptobrewmaster.io` both redirect to gambling
sites today. Usage says an app is running; the site check says where it sends
people. An app whose site no longer lands on its own domain stays in `apps` with
its `site` reason, but cannot be `featured`.

Rebuilt on a timer (`apps.refresh_minutes`); requests only ever read the last
good answer, and a failed rebuild keeps the previous one.

`apps.pinned` forces an entry to the front, `apps.excluded` drops one outright.

### Usage storage

45 days in `/var/app/data/usage.json` (override with `USAGE_FILE`), written at
most once a minute and atomically, on a named volume so a deploy does not empty
the directory.

It stores **counts only**. Distinct users are tallied in memory for the current
day and folded to a number when written, so the file never records who used
what. The cost is that a restart mid-day loses that day's deduplication.

An app can only appear by presenting tokens its own users signed, so inflating a
count means controlling those accounts.

## Learn more 

Homepage: https://hivesigner.com

Documentation: https://docs.hivesigner.com

Hivesigner SDK: https://github.com/ecency/hivesigner-sdk

Hivesigner UI: https://github.com/ecency/hivesigner-ui

## Issues

To report a non-critical issue, please file an issue on this GitHub project. If you find a security issue please report details to `security@hivesigner.com` or trusted community members. We will evaluate the risk and make a patch available before filing the issue.
