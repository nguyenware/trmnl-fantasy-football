import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { handle } from '../src/index.js';
import { disambiguate, winProbability } from '../src/matchup.js';
import { gameText, remainingFraction } from '../src/nfl.js';
import { resetSnapshotMemo, shortName } from '../src/players.js';
import { clearMemoryCache } from '../src/util.js';
import { assignSlots, checkState, makeState, parseLeague, parseMyTeams, parseRosters } from '../src/yahoo.js';
import { child, parseXml, text } from '../src/xml.js';

const raw = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name) => JSON.parse(raw(`${name}.json`));
const TZ = 'America/Los_Angeles';

function kv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k, o) => {
      const v = store.get(k);
      if (v == null) return null;
      return o?.type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { store.set(k, v); },
  };
}

function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    calls.push({ url, init });
    for (const [re, body] of routes) {
      if (re.test(url)) {
        const value = typeof body === 'function' ? body(url, init) : body;
        if (value instanceof Response) return value;
        return typeof value === 'string' ? new Response(value, { headers: { 'content-type': 'application/xml' } }) : Response.json(value);
      }
    }
    return new Response('not found', { status: 404 });
  };
  return calls;
}

const sleeperRoutes = (overrides = {}) => [
  [/sleeper\.app\/v1\/state\/nfl/, fixture('sleeper-state')],
  [/sleeper\.app\/v1\/user\/manager2/, { user_id: '900000002', username: 'manager2' }],
  [/sleeper\.app\/v1\/league\/L1\/users/, fixture('sleeper-users')],
  [/sleeper\.app\/v1\/league\/L1\/rosters/, fixture('sleeper-rosters')],
  [/sleeper\.app\/v1\/league\/L1\/matchups\/2/, overrides.m2 ?? fixture('sleeper-matchups-2')],
  [/sleeper\.app\/v1\/league\/L1\/matchups\/3/, overrides.m3 ?? fixture('sleeper-matchups-3')],
  [/sleeper\.app\/v1\/league\/L1$/, fixture('sleeper-league')],
  [/scoreboard\?dates=2026&seasontype=2&week=2/, fixture('espn-scoreboard-2')],
  [/scoreboard\?dates=2026&seasontype=2&week=3/, overrides.sb3 ?? fixture('espn-scoreboard-3')],
  [/api\.sleeper\.com\/players\/nfl\//, (url) => ({ full_name: `Fallback ${url.split('/').pop()}`, position: 'WR', team: 'SEA' })],
];

const env = (extra = {}) => ({ TIMEZONE: TZ, FANTASY_KV: kv({ 'sleeper:snapshot:v1': raw('snapshot.json') }), ...extra });

async function get(path, e = env(), now = '2026-09-24T20:00:00Z') {
  const realNow = Date.now;
  Date.now = () => Date.parse(now);
  try {
    const res = await handle(new Request(`https://fantasy.test${path}`), e);
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, res, body: type.includes('json') ? await res.json() : await res.text() };
  } finally {
    Date.now = realNow;
  }
}

beforeEach(() => {
  clearMemoryCache();
  resetSnapshotMemo();
});

test('Sleeper, before kickoff: every slot with kickoff and projection', async () => {
  stubFetch(sleeperRoutes());
  const { status, body } = await get('/sleeper?league=L1&user=manager2');
  assert.equal(status, 200);
  assert.equal(body.status, 'pre');
  assert.equal(body.week, 3);
  assert.equal(body.league.scoring, 'PPR');
  assert.equal(body.me.name, 'Team B');
  assert.equal(body.me.record, '1-1');
  assert.ok(body.opp.name.startsWith('Team '));
  assert.deepEqual(body.rows.map((r) => r.slot), ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLX', 'FLX', 'SF', 'IDP', 'IDP']);
  const qb = body.rows[0].me;
  assert.equal(qb.name, 'J. Herbert');
  assert.equal(qb.team, 'LAC');
  assert.match(qb.game, /^(Thu|Sun|Mon) \d+(:\d+)?(AM|PM)$/);
  assert.equal(qb.opp.startsWith('vs') || qb.opp.startsWith('@'), true);
  assert.ok(qb.projected > 10);
  // IDP players get no generic projection.
  assert.equal(body.rows[9].me.projected, null);
  assert.equal(body.me.to_play, 11);
  assert.ok(body.win_pct > 0 && body.win_pct < 100);
  assert.match(body.headline, /^Proj \d+\.\d-\d+\.\d · \d+% to win$/);
  assert.equal(body.projections, 'on');
  assert.equal(body.standings.find((s) => s.is_me).name, 'Team B');
});

test('Sleeper alerts: injured and questionable starters', async () => {
  stubFetch(sleeperRoutes());
  const snap = fixture('snapshot');
  const starters = fixture('sleeper-matchups-3').find((m) => m.roster_id === 1).starters;
  snap.players[starters[0]][3] = 'Out';
  snap.players[starters[1]][3] = 'Questionable';
  const { body } = await get('/sleeper?league=L1&user=manager2', env({ FANTASY_KV: kv({ 'sleeper:snapshot:v1': JSON.stringify(snap) }) }));
  assert.equal(body.rows[0].me.injury, 'O');
  assert.ok(body.alerts.includes('J. Herbert is out'));
  assert.ok(body.alerts.some((a) => a.startsWith('Questionable:') && a.includes(body.rows[1].me.name)));
});

test('Sleeper, a finished week: final scores, NFL results and no stale projections', async () => {
  stubFetch(sleeperRoutes());
  const { body } = await get('/sleeper?league=L1&roster=1&week=2');
  assert.equal(body.status, 'final');
  const mine = fixture('sleeper-matchups-2').find((m) => m.roster_id === 1);
  const theirs = fixture('sleeper-matchups-2').find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== 1);
  assert.equal(body.me.points, Math.round(mine.points * 10) / 10);
  assert.equal(body.opp.points, Math.round(theirs.points * 10) / 10);
  assert.equal(body.win_pct, null);
  assert.match(body.headline, /^(Won|Lost) \d+\.\d-\d+\.\d$/);
  assert.match(body.rows[0].me.game, /^[WL] \d+-\d+$/);
  assert.ok(body.rows.every((r) => r.me.projected == null));
  assert.equal(body.me.left, 0);
});

test('Sleeper, live: players in progress, left to play, live projection', async () => {
  const sb3 = fixture('espn-scoreboard-3');
  // Put the first two games in the third quarter and finish the next two.
  sb3.events.forEach((e, i) => {
    const c = e.competitions[0];
    if (i < 2) c.status = { period: 3, clock: 300, type: { state: 'in', shortDetail: '5:00 - 3rd' } };
    else if (i < 4) c.status = { period: 4, clock: 0, type: { state: 'post', shortDetail: 'Final' } };
    if (i < 4) c.competitors.forEach((x, j) => { x.score = String(j ? 17 : 20); });
  });
  const m3 = fixture('sleeper-matchups-3').map((m) => ({ ...m, starters_points: m.starters.map((_, i) => (i % 2 ? 8.4 : 0)), points: m.starters.length * 4.2 }));
  stubFetch(sleeperRoutes({ sb3, m3 }));
  const { body } = await get('/sleeper?league=L1&user=manager2', env(), '2026-09-27T19:00:00Z');
  assert.equal(body.status, 'live');
  assert.equal(body.is_live, true);
  const live = body.rows.map((r) => r.me).find((p) => p.state === 'in');
  if (live) assert.equal(live.game, 'Q3 5:00');
  assert.equal(body.me.left, body.me.to_play + body.me.playing);
  assert.match(body.headline, /^(Up|Down|Tied)/);
});

test('without a snapshot, starters are looked up one by one', async () => {
  const calls = stubFetch(sleeperRoutes());
  const { body } = await get('/sleeper?league=L1&user=manager2', { TIMEZONE: TZ });
  assert.equal(body.projections, 'off');
  assert.match(body.rows[0].me.name, /^F\. \d+$/); // from the per-player lookup
  assert.ok(calls.filter((c) => c.url.includes('api.sleeper.com/players')).length <= 30);
});

test('Sleeper errors are readable', async () => {
  stubFetch(sleeperRoutes());
  assert.equal((await get('/sleeper')).status, 400);
  const res = await get('/sleeper?league=L1');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /user=/);
});

test('ACCESS_KEY guards the data endpoints', async () => {
  stubFetch(sleeperRoutes());
  assert.equal((await get('/sleeper?league=L1&user=manager2', env({ ACCESS_KEY: 's3cret' }))).status, 401);
  assert.equal((await get('/sleeper?league=L1&user=manager2&key=s3cret', env({ ACCESS_KEY: 's3cret' }))).status, 200);
});

test('Sunday mode merges the team dashboard', async () => {
  stubFetch(sleeperRoutes());
  const TEAM_DASHBOARD = { fetch: async (url) => Response.json({ team: { abbr: 'SEA' }, is_live: false, requested: String(url) }) };
  const { body } = await get('/sunday?provider=sleeper&league=L1&user=manager2&nfl_team=sea', env({ TEAM_DASHBOARD }));
  assert.equal(body.has_team, true);
  assert.equal(body.team.team.abbr, 'SEA');
  assert.match(body.team.requested, /\/team\?league=nfl&team=sea/);
  assert.equal(body.me.name, 'Team B');
});

// ---- Yahoo ------------------------------------------------------------------

const MY_TEAMS = `<?xml version="1.0"?><fantasy_content><users><user><guid>X</guid><games><game><game_key>390</game_key>
  <teams count="1"><team><team_key>390.l.1000.t.1</team_key><team_id>1</team_id><name>marky&apos;s Bold Team</name></team></teams>
  </game></games></user></users></fantasy_content>`;

function yahooRosterWithPoints() {
  // The docs' roster example has no points; add some, plus an injury.
  let xml = raw('yahoo-roster.xml');
  let n = 0;
  xml = xml.replace(/<\/selected_position>/g, () => {
    n += 1;
    return `</selected_position><player_points><coverage_type>week</coverage_type><week>16</week><total>${(n * 1.5).toFixed(2)}</total></player_points>${n === 2 ? '<status>Q</status>' : ''}`;
  });
  // Present it as a teams collection with both sides of the matchup.
  const team = xml.replace(/^[\s\S]*?<team>/, '<team>').replace(/<\/fantasy_content>\s*$/, '');
  const opp = team.replace(/390\.l\.1000\.t\.1</g, '390.l.1000.t.8<');
  return `<?xml version="1.0"?><fantasy_content><teams count="2">${team}${opp}</teams></fantasy_content>`;
}

const yahooRoutes = () => [
  [/users;use_login=1\/games;game_keys=nfl\/teams/, MY_TEAMS],
  [/league\/390\.l\.1000;out=settings,standings/, raw('yahoo-settings.xml').replace('</settings>', `</settings>${raw('yahoo-standings.xml').match(/<standings>[\s\S]*<\/standings>/)[0]}`)],
  [/league\/390\.l\.1000\/scoreboard/, raw('yahoo-scoreboard.xml')],
  [/teams;team_keys=390\.l\.1000\.t\.1,390\.l\.1000\.t\.8\/roster;week=16/, yahooRosterWithPoints()],
  [/scoreboard\?dates=2019/, { events: [] }],
  [/oauth2\/get_token/, { access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 }],
];

const yahooEnv = (token) => env({
  YAHOO_CLIENT_ID: 'cid',
  YAHOO_CLIENT_SECRET: 'csecret',
  FANTASY_KV: kv({ 'yahoo:token': JSON.stringify(token), 'sleeper:snapshot:v1': raw('snapshot.json') }),
});

test('xml reader', () => {
  const doc = parseXml('<?xml version="1.0"?><a x="1"><b>one &amp; two</b><c/><b><![CDATA[<raw>]]></b></a>');
  assert.equal(text(doc, 'a/b'), 'one & two');
  assert.equal(child(doc, 'a').attrs.x, '1');
  assert.equal(child(doc, 'a').children.length, 3);
  assert.equal(child(doc, 'a').children[2].text, '<raw>');
});

test('Yahoo parsing: settings, standings, scoreboard, rosters', () => {
  const league = parseLeague(parseXml(raw('yahoo-settings.xml')));
  assert.deepEqual(league.slots, ['QB', 'WR', 'WR', 'RB', 'RB', 'TE', 'W/R/T', 'K', 'DEF']);
  assert.equal(league.rec, 0.5);
  const standings = parseLeague(parseXml(raw('yahoo-standings.xml'))).standings;
  assert.equal(standings[0].rank, 1);
  assert.equal(standings[0].record, '8-6');
  const board = parseLeague(parseXml(raw('yahoo-scoreboard.xml')));
  assert.equal(board.week, 16);
  assert.equal(board.matchups.length, 4);
  assert.equal(board.matchups[0].teams[0].points, 112.82);
  assert.equal(parseMyTeams(parseXml(MY_TEAMS))[0].league_key, '390.l.1000');
  const rosters = parseRosters(parseXml(yahooRosterWithPoints()));
  const mine = rosters['390.l.1000.t.1'];
  assert.equal(mine[0].name, 'K. Murray');
  assert.equal(mine[0].team, 'Ari');
  assert.equal(mine[1].injury, 'Q');
  const slots = assignSlots(league.slots, mine);
  assert.equal(slots[0].pos, 'QB');
  assert.equal(slots.filter(Boolean).length, slots.length);
  assert.equal(slots[6].slot, 'W/R/T');
});

test('Yahoo matchup end to end with a cached token', async () => {
  const calls = stubFetch(yahooRoutes());
  const { status, body } = await get('/yahoo', yahooEnv({ access_token: 'tok', refresh_token: 'r1', expires_at: Date.parse('2030-01-01') }));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.provider, 'yahoo');
  assert.equal(body.league.scoring, 'Half PPR');
  assert.equal(body.me.name, "marky's Bold Team");
  assert.equal(body.me.points, 112.8);
  assert.equal(body.status, 'final'); // from Yahoo's matchup status, since no NFL scoreboard
  assert.equal(body.headline, "Won 112.8-95.8");
  assert.equal(body.rows[0].slot, 'QB');
  assert.equal(body.rows[6].slot, 'FLX');
  assert.ok(calls.every((c) => !c.url.includes('get_token')));
  assert.ok(calls.filter((c) => c.url.includes('yahooapis')).every((c) => c.init.headers.authorization === 'Bearer tok'));
});

test('Yahoo refreshes an expired token and stores the new one', async () => {
  const calls = stubFetch(yahooRoutes());
  const e = yahooEnv({ access_token: 'old', refresh_token: 'r1', expires_at: 0, redirect_uri: 'https://fantasy.test/yahoo/callback' });
  const { status } = await get('/yahoo', e);
  assert.equal(status, 200);
  const refresh = calls.find((c) => c.url.includes('get_token'));
  assert.match(String(refresh.init.body), /grant_type=refresh_token/);
  assert.match(String(refresh.init.body), /refresh_token=r1/);
  const saved = JSON.parse(e.FANTASY_KV.store.get('yahoo:token'));
  assert.equal(saved.access_token, 'fresh');
  assert.equal(saved.refresh_token, 'r2');
});

test('Yahoo not connected yet', async () => {
  stubFetch(yahooRoutes());
  const { status, body } = await get('/yahoo', env({ YAHOO_CLIENT_ID: 'cid', YAHOO_CLIENT_SECRET: 'x' }));
  assert.equal(status, 401);
  assert.match(body.error, /yahoo\/login/);
});

test('Yahoo login and callback', async () => {
  stubFetch(yahooRoutes());
  const e = yahooEnv({});
  const login = await get('/yahoo/login', e);
  assert.equal(login.status, 302);
  const location = new URL(login.res.headers.get('location'));
  assert.equal(location.host, 'api.login.yahoo.com');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://fantasy.test/yahoo/callback');
  const state = location.searchParams.get('state');

  const bad = await get('/yahoo/callback?code=abc&state=123.nope', e);
  assert.equal(bad.status, 400);
  const ok = await get(`/yahoo/callback?code=abc&state=${encodeURIComponent(state)}`, e);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(e.FANTASY_KV.store.get('yahoo:token')).refresh_token, 'r2');
});

test('OAuth state expires', async () => {
  const s = await makeState('k', 1000);
  assert.equal(await checkState('k', s, 2000), true);
  assert.equal(await checkState('k', s, 1000 + 11 * 60_000), false);
  assert.equal(await checkState('other', s, 2000), false);
});

// ---- Helpers ----------------------------------------------------------------

test('game text and remaining fraction', () => {
  const pre = { state: 'pre', date: '2026-09-27T17:00:00Z' };
  assert.equal(gameText(pre, TZ), 'Sun 10AM');
  assert.equal(gameText({ state: 'in', detail: '4:12 - 3rd' }, TZ), 'Q3 4:12');
  assert.equal(gameText({ state: 'in', detail: 'Halftime' }, TZ), 'Half');
  assert.equal(gameText({ state: 'post', score: 20, opp_score: 17 }, TZ), 'W 20-17');
  assert.equal(gameText(null, TZ), 'BYE');
  assert.equal(remainingFraction(pre), 1);
  assert.equal(remainingFraction({ state: 'in', period: 3, clock_seconds: 450 }), 0.375);
});

test('win probability', () => {
  const rows = (n, k = 9) => Array.from({ length: k }, () => ({ remaining_projection: n }));
  assert.equal(winProbability({ points: 100 }, { points: 90 }, rows(0), rows(0)), 100);
  assert.equal(winProbability({ points: 0 }, { points: 0 }, rows(12), rows(12)), 50);
  assert.ok(winProbability({ points: 0 }, { points: 0 }, rows(13), rows(11)) > 50);
});

test('shortName', () => {
  assert.equal(shortName('Amon-Ra St. Brown'), 'A. St. Brown');
  assert.equal(shortName('Kenneth Walker III'), 'K. Walker III');
});

test('colliding short names get full first names', () => {
  const out = disambiguate([
    { name: 'B. Robinson', full_name: 'Bijan Robinson' },
    { name: 'B. Robinson', full_name: 'Brian Robinson' },
    { name: 'L. Jackson', full_name: 'Lamar Jackson' },
    null,
  ]);
  assert.deepEqual(out.map((p) => p?.name), ['Bijan Robinson', 'Brian Robinson', 'L. Jackson', undefined]);
});
