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

Two signals. Both are needed.

**Usage orders it.** Every authenticated request carries an app name as
`req.proxy`. `helpers/usage.js` counts that per app per UTC day. The
directory ranks on distinct users.

**Registration decides who is on it.** `req.proxy` is `signed_message.app`, a
string chosen by whoever built the token. The signature proves the *user*
signed the message, not that the app is who it claims. Any account can sign a
token naming any app. So a counted name is only listed if the account has
granted posting authority to the broadcaster, which is the same condition
`verifyPermissions` enforces before this API will broadcast for an app. No
third party can perform it for an account they do not control.

The gate runs on a wide ranked pool (`apps.candidate_pool`) *before* the cut to
`apps.max_apps`, so an unregistered name costs a slot in an RPC batch rather
than a slot in the directory.

There is no follow list, no post-metadata scraping and **no fallback list**. A
fresh deployment answers `"building": true` with an empty list for a few hours
until traffic fills it, then is correct permanently. A fallback would be a
second code path that only runs when nobody is watching.

### What counts as an "app"

One that **broadcasts** through Hivesigner. That is narrower than one that uses
it: a site using Hivesigner only to log people in never needs to grant posting
authority to the broadcaster, because `/api/me` and `/api/oauth2/token` go
through `authenticate` while only `/api/broadcast` goes through
`verifyPermissions`. A login-only app therefore cannot appear here
automatically. `apps.pinned` is the only route for it.

`profile.type === 'app'` in the account's own metadata is deliberately **not**
accepted as a substitute. It is account-controlled, but it is a label any
account can put on itself at no cost and with no reference to Hivesigner, so
accepting it would reopen what the gate closes. It also costs nothing
measurable: of 26 well known Hive app accounts checked on chain, 5 carry
`type: 'app'` and all 5 have the grant as well.

### What is still checked on-chain

The app's website, because usage cannot tell you a domain lapsed. Several here
did: `buildteam.io` and `cryptobrewmaster.io` both redirect to gambling sites
today. Usage says an app is running; the site check says where it sends
people. An app whose site no longer lands on its own domain stays in `apps` with
its `site` reason, but cannot be `featured`.

Rebuilt on a timer (`apps.refresh_minutes`); requests only ever read the last
good answer. A failed rebuild keeps the previous one.

`apps.pinned` forces an entry to the front of the featured list and rescues one
with little usage; `apps.excluded` drops one outright. Pinning does **not**
exempt an app from the site check. Featuring a lapsed domain would send people
to whoever owns it now, whatever the config says.

### Usage storage

45 days in `/var/app/data/usage.json` (override with `USAGE_FILE`), written at
most once a minute and atomically, on a named volume so a deploy does not empty
the directory.

It stores **counts only**. Distinct users are tallied in memory for the current
day and folded to a number when written, so the file never records who used
what. The cost is that a restart mid-day loses that day's deduplication.

Counts are cheap to inflate, since the name is caller-chosen, so they are
treated as a ranking signal over unverified names and nothing more. Two ceilings
bound the damage: at most 500 *unseen* names a day and 2000 in total. A name
already in the built directory, or seen the day before, is allowed past the
first, so filling a day cannot stop a real app from being counted.

## Learn more 

Homepage: https://hivesigner.com

Documentation: https://docs.hivesigner.com

Hivesigner SDK: https://github.com/ecency/hivesigner-sdk

Hivesigner UI: https://github.com/ecency/hivesigner-ui

## Issues

To report a non-critical issue, please file an issue on this GitHub project. If you find a security issue please report details to `security@hivesigner.com` or trusted community members. We will evaluate the risk and make a patch available before filing the issue.
