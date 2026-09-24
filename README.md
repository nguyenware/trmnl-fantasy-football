# TRMNL Fantasy Football

A [TRMNL](https://trmnl.com) plugin backend for your weekly fantasy matchup on **Sleeper** or **Yahoo**. It runs as a free Cloudflare Worker, and a **Sunday mode** combines the matchup with your NFL team's live game.

- **Scoreboard:** both teams with score, record, standing, projected total and a live win probability (Yahoo supplies its own; for Sleeper it's estimated from projections, sharpening as games finish).
- **Slot-by-slot lineups:** QB, RB, WR, TE, FLEX, SUPER_FLEX, K, DEF and IDP slots mirrored side by side. Each player shows:
  - NFL team and game status: kickoff time, live clock (`Q3 4:32`), `W 27-20`, or `BYE`;
  - points so far, or their projection before kickoff;
  - an injury tag.
  - Players on the field right now are highlighted.
- **Players left to play** for each side, how many are playing now, and your best bench player.
- **Alerts:** empty slots, starters on bye, Out/IR/Doubtful starters, and the list of Questionables.
- **Sunday mode:** your NFL team's live game (from [trmnl-team-dashboard](https://github.com/nguyenware/trmnl-team-dashboard)) next to your lineup, on one screen.

## Endpoints

| Path | What |
| --- | --- |
| `/sleeper?league=<league id>&user=<username>` | Sleeper matchup. `&roster=<id>` works instead of `user`; `&week=` looks at another week |
| `/yahoo[?league=<league id>]` | Yahoo matchup (defaults to your first NFL team) |
| `/sunday?provider=sleeper&league=…&user=…&nfl_team=sea` | matchup plus team game (`provider=yahoo` works too) |
| `/yahoo/login?key=<ACCESS_KEY>` | one-time Yahoo connection |

Add `&tz=America/New_York` to change the time zone (default `TIMEZONE`, `America/Los_Angeles`), and `&key=` when `ACCESS_KEY` is set.

Your Sleeper league id is in the league's URL on sleeper.com (`sleeper.com/leagues/<id>/…`).

## Deploy (Cloudflare Workers, free plan)

1. Deploy [trmnl-team-dashboard](https://github.com/nguyenware/trmnl-team-dashboard) first if you want Sunday mode. It's wired up through a service binding in `wrangler.jsonc`; remove the `services` block if you skip it.
2. Deploy this Worker with `npm install && npx wrangler deploy`, or import the repo under **Workers & Pages → Create → Import a repository**. `FANTASY_KV` points at the namespace `trmnl-fantasy-football-FANTASY_KV` (id `277443a9b5d14992907d9e4c1f4c581e`); on a different account, delete the `id` and Wrangler creates one on first deploy.
3. Optionally, `npx wrangler secret put ACCESS_KEY` so only your TRMNL can read your league.
4. **Player snapshot (recommended).** Names, injuries and projections come from a trimmed snapshot of Sleeper's player list. A scheduled GitHub Action ([`snapshot.yml`](.github/workflows/snapshot.yml)) refreshes it daily and around game windows. Add three repository secrets:
   - `CLOUDFLARE_API_TOKEN`: a token with **Workers KV Storage: Edit**.
   - `CLOUDFLARE_ACCOUNT_ID`.
   - `KV_NAMESPACE_ID`: `277443a9b5d14992907d9e4c1f4c581e`.

   Then run the workflow once from the Actions tab. Without a snapshot, starters' names are looked up one at a time and projections are hidden, so it works, just with less detail.

### Yahoo

Yahoo now reviews Fantasy API access by hand:

1. Create an app at [developer.yahoo.com/apps](https://developer.yahoo.com/apps/). Use **Fantasy Sports: Read** access, with redirect URI `https://<your-worker>/yahoo/callback`.
2. Apply for Fantasy API access at [sports.yahoo.com/developer/access](https://sports.yahoo.com/developer/access/), including your Client ID.
3. Once approved, run `npx wrangler secret put YAHOO_CLIENT_ID` and `npx wrangler secret put YAHOO_CLIENT_SECRET`.
4. Open `https://<your-worker>/yahoo/login?key=<ACCESS_KEY>` and approve. The refresh token is stored in KV; access tokens are refreshed automatically.

Until approval, Yahoo answers `403`, and the plugin shows that message on screen. Yahoo's per-player projections are not in its public API, so projections come from the Sleeper snapshot (players are matched by Yahoo id). Team totals and win probability come from Yahoo.

## TRMNL plugins

Create a **Private Plugin** with strategy **Polling** for each view:

| Plugin | Polling URL | Markup |
| --- | --- | --- |
| Sleeper matchup | `https://<worker>/sleeper?league=…&user=…` | [`trmnl/matchup/`](trmnl/matchup) |
| Yahoo matchup | `https://<worker>/yahoo` | [`trmnl/matchup/`](trmnl/matchup) |
| Sunday | `https://<worker>/sunday?provider=sleeper&league=…&user=…&nfl_team=sea` | [`trmnl/sunday/`](trmnl/sunday) |

Paste each folder's `full`, `half_horizontal`, `half_vertical` and `quadrant` templates into the matching layout tabs. A 15-minute refresh is plenty midweek. On game days, use the fastest rate your plan allows; live data is cached for 30-60 seconds.

## How it works

- **Sleeper:** league, users, rosters and the week's matchups come from `api.sleeper.app` (public, no auth). Live points come from the matchup's `starters_points`.
- **Yahoo:** `users;use_login=1/games;game_keys=nfl/teams` finds your team; the league's settings, standings and scoreboard give roster slots, records, points, projections and win probability; `teams;team_keys=…/roster;week=N/players/stats` gives each player's slot and points.
- **NFL games:** ESPN's weekly scoreboard, keyed by team, supplies kickoff times, live clocks, finals and byes.
- **Caching:**
  - Every upstream response is trimmed and cached with the Workers Cache API: 60 s during games, longer otherwise.
  - A cold Sleeper request makes about 7 upstream calls, well under the free plan's limit of 50.
  - The snapshot is read from KV and kept in memory for 10 minutes; parsing it takes about 3 ms of CPU.

## Development

```bash
npm install
npm test                                   # offline tests (Sleeper, Yahoo XML, OAuth, Sunday mode)
npm run dev                                # wrangler dev
npm run snapshot                           # build snapshot.json locally
npm run preview -- --screenshot payload.json                       # matchup layouts
npm run preview -- --templates=trmnl/sunday --screenshot sunday.json
node scripts/capture-fixtures.mjs <league id> <done week> <current week>   # re-record anonymized fixtures
```
