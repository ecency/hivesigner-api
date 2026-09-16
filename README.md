# Hivesigner API

Hivesigner API module handles access token creation/verification, signing, broadcasting transactions, oauth2 for dapps.

## The app directory: `GET /api/apps`

Public and unauthenticated. Which apps use Hivesigner, ranked by how many people
use them:

```json
{
  "updated_at": "...",
  "building": false,
  "window_days": 7,
  "featured": ["ecency.app", "peakd.app", "..."],
  "apps": [
    { "username": "ecency.app", "name": "Ecency", "about": "...",
      "website": "https://ecency.com", "site": "ok",
      "users": 412, "requests": 9310,
      "first_seen": "2026-08-01", "last_seen": "2026-09-15", "new": false }
  ]
}
```

### Where the list comes from

Two signals. Both are needed.

**Usage orders it.** Every authenticated request carries an app name as
`req.proxy`. `helpers/usage.js` counts that per app per UTC day. The
directory ranks on the sum of each day's distinct-user count over the last
`apps.active_days` UTC days, today included (7 means today plus the previous
six days), so a person active on three days counts three times. An app with no
request inside that window drops off on the next build and comes back the
moment it is used again, so departures need no curating. An app first seen
inside the window, and after the record itself began, is marked `"new": true`;
on a fresh deployment nothing is new until the history is older than the app.

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
fresh deployment answers `"building": true` with an empty list and rebuilds on
the fast cadence (`apps.retry_minutes`) until traffic fills it, then is correct
permanently. A fallback would be a second code path that only runs when nobody
is watching.

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
treated as a ranking signal over unverified names and nothing more. Three
ceilings bound the damage: each user may put at most 5 names a day on record
that were not already there that day, a day takes at most 500 names from
outside the trusted set, and 2000 in total.

The **trusted set** is every name the indexer has verified on chain as
registered, from its last candidate pool. Those names are exempt from all three
ceilings, and the set is written to `trusted-apps.json` beside the usage file
and read back before the counts, so a restart does not reopen the ceilings to
known apps. Names seen the day before are *not* trusted on that basis: letting
them through let junk inherit itself day over day.

Refusal is not silent either. The first 200 names the ceilings turn away each
day are kept, and the next build runs them through the same registration check
as everything else. So a real app that registers on a day someone has filled
is verified within one build, trusted from then on, and counted from its next
request. Filling a day costs the attacker accounts and buys them at most one
build interval of delay for a newcomer, and nothing at all against a known
app.

## Learn more 

Homepage: https://hivesigner.com

Documentation: https://docs.hivesigner.com

Hivesigner SDK: https://github.com/ecency/hivesigner-sdk

Hivesigner UI: https://github.com/ecency/hivesigner-ui

## Issues

To report a non-critical issue, please file an issue on this GitHub project. If you find a security issue please report details to `security@hivesigner.com` or trusted community members. We will evaluate the risk and make a patch available before filing the issue.
