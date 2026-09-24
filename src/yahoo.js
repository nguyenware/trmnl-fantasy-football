// Yahoo Fantasy provider. Needs OAuth 2.0 and, since mid-2026, a Yahoo
// developer app that Yahoo has approved for Fantasy API access
// (https://sports.yahoo.com/developer/access/).
//
// Flow: visit /yahoo/login?key=… once; Yahoo redirects to /yahoo/callback,
// which stores the refresh token in KV. Access tokens (1 hour) are refreshed
// on demand and cached in KV, so a token refresh costs one KV write.
import { resolveSleeperPlayers, shortName, yahooIndex } from './players.js';
import { cached } from './util.js';
import { child, children, findAll, num, parseXml, text } from './xml.js';

const API = 'https://fantasysports.yahooapis.com/fantasy/v2';
const AUTH = 'https://api.login.yahoo.com/oauth2';
const TOKEN_KEY = 'yahoo:token';
const NON_STARTER = new Set(['BN', 'IR', 'IR+', 'NA']);

export class YahooAuthError extends Error {
  constructor(message) {
    super(message);
    this.status = 401;
  }
}

// ---- OAuth ------------------------------------------------------------------

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

// The OAuth `state` is a signed timestamp, so the callback can check the
// login started here within the last 10 minutes without storing anything.
export async function makeState(secret, now = Date.now()) {
  const ts = String(now);
  return `${ts}.${await hmac(secret, ts)}`;
}

export async function checkState(secret, state, now = Date.now()) {
  const [ts, sig] = String(state ?? '').split('.');
  if (!ts || !sig || now - Number(ts) > 10 * 60_000) return false;
  return sig === await hmac(secret, ts);
}

export function redirectUri(env, origin) {
  return env.YAHOO_REDIRECT_URI ?? `${origin}/yahoo/callback`;
}

export async function loginUrl(env, origin) {
  const params = new URLSearchParams({
    client_id: env.YAHOO_CLIENT_ID,
    redirect_uri: redirectUri(env, origin),
    response_type: 'code',
    state: await makeState(env.YAHOO_CLIENT_SECRET),
  });
  return `${AUTH}/request_auth?${params}`;
}

async function tokenRequest(env, form) {
  const res = await fetch(`${AUTH}/get_token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${env.YAHOO_CLIENT_ID}:${env.YAHOO_CLIENT_SECRET}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new YahooAuthError(`Yahoo token request failed (${res.status}): ${body.error_description ?? body.error ?? 'unknown error'}`);
  }
  return body;
}

async function saveToken(env, body, previous = {}, redirect = previous.redirect_uri) {
  const token = {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? previous.refresh_token,
    expires_at: Date.now() + (Number(body.expires_in ?? 3600) - 120) * 1000,
    redirect_uri: redirect ?? 'oob',
  };
  await env.FANTASY_KV.put(TOKEN_KEY, JSON.stringify(token));
  return token;
}

export async function exchangeCode(env, origin, code) {
  const redirect = redirectUri(env, origin);
  const body = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirect });
  return saveToken(env, body, {}, redirect);
}

export async function accessToken(env) {
  if (!env.YAHOO_CLIENT_ID || !env.YAHOO_CLIENT_SECRET) throw new YahooAuthError('Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET');
  if (!env.FANTASY_KV) throw new YahooAuthError('Bind a KV namespace as FANTASY_KV to store the Yahoo token');
  const token = await env.FANTASY_KV.get(TOKEN_KEY, { type: 'json' });
  if (!token?.refresh_token) throw new YahooAuthError('Not connected to Yahoo yet: open /yahoo/login?key=<ACCESS_KEY> once');
  if (token.access_token && token.expires_at > Date.now()) return token.access_token;
  const body = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: token.refresh_token, redirect_uri: token.redirect_uri ?? 'oob' });
  return (await saveToken(env, body, token)).access_token;
}

async function yahooGet(env, path) {
  const token = await accessToken(env);
  const res = await fetch(`${API}/${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/xml' } });
  const body = await res.text();
  if (res.status === 401) throw new YahooAuthError('Yahoo rejected the token; open /yahoo/login?key=<ACCESS_KEY> again');
  if (res.status === 403) throw Object.assign(new Error('Yahoo returned 403: this app is not approved for the Fantasy API yet (sports.yahoo.com/developer/access)'), { status: 403 });
  if (!res.ok) throw Object.assign(new Error(`Yahoo API returned ${res.status}`), { status: 502 });
  return parseXml(body);
}

// ---- Parsing ----------------------------------------------------------------

export function parseMyTeams(doc) {
  return findAll(doc, 'team').map((t) => ({
    team_key: text(t, 'team_key'),
    name: text(t, 'name'),
    league_key: text(t, 'team_key')?.replace(/\.t\.\d+$/, ''),
    league_id: text(t, 'team_key')?.match(/\.l\.(\d+)\./)?.[1],
  }));
}

function teamRecord(t) {
  const o = child(t, 'team_standings/outcome_totals');
  if (!o) return '';
  const ties = num(o, 'ties');
  return `${num(o, 'wins') ?? 0}-${num(o, 'losses') ?? 0}${ties ? `-${ties}` : ''}`;
}

export function parseLeague(doc) {
  const league = child(doc, 'fantasy_content/league');
  const settings = child(league, 'settings');
  const slots = [];
  for (const rp of children(settings, 'roster_positions/roster_position')) {
    const pos = text(rp, 'position');
    if (NON_STARTER.has(pos)) continue;
    for (let i = 0; i < (num(rp, 'count') ?? 1); i += 1) slots.push(pos);
  }
  const recStat = children(settings, 'stat_modifiers/stats/stat').find((s) => text(s, 'stat_id') === '11');
  const rec = recStat ? Number(text(recStat, 'value')) : 0;

  const standings = children(league, 'standings/teams/team').map((t) => ({
    team_key: text(t, 'team_key'),
    name: text(t, 'name'),
    rank: num(t, 'team_standings/rank'),
    record: teamRecord(t),
    pf: Math.round(num(t, 'team_standings/points_for') ?? 0),
  })).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  const matchups = children(league, 'scoreboard/matchups/matchup').map((m) => ({
    week: num(m, 'week'),
    status: text(m, 'status'),
    is_playoffs: text(m, 'is_playoffs') === '1',
    teams: children(m, 'teams/team').map((t) => ({
      team_key: text(t, 'team_key'),
      name: text(t, 'name'),
      manager: text(t, 'managers/manager/nickname') ?? '',
      points: num(t, 'team_points/total'),
      projected: num(t, 'team_projected_points/total'),
      win_probability: num(t, 'win_probability'),
    })),
  }));

  return {
    key: text(league, 'league_key'),
    name: text(league, 'name'),
    season: num(league, 'season'),
    current_week: num(league, 'current_week'),
    week: num(league, 'scoreboard/week') ?? num(league, 'current_week'),
    rec,
    slots,
    standings,
    matchups,
  };
}

export function parseRosters(doc) {
  return Object.fromEntries(findAll(doc, 'team').filter((t) => child(t, 'roster')).map((t) => [
    text(t, 'team_key'),
    children(t, 'roster/players/player').map((p) => ({
      yahoo_id: text(p, 'player_id'),
      name: shortName(text(p, 'name/full') ?? ''),
      pos: text(p, 'display_position')?.split(',')[0] ?? '',
      team: text(p, 'editorial_team_abbr') ?? '',
      slot: text(p, 'selected_position/position'),
      injury: text(p, 'status') || null,
      points: num(p, 'player_points/total') ?? 0,
    })),
  ]));
}

// Fill starter slots in league order from each player's selected position.
export function assignSlots(slots, players) {
  const pool = players.filter((p) => !NON_STARTER.has(p.slot));
  return slots.map((slot) => {
    const i = pool.findIndex((p) => p.slot === slot);
    return i === -1 ? null : pool.splice(i, 1)[0];
  });
}

const scoringLabel = (rec) => (rec >= 1 ? 'PPR' : rec >= 0.5 ? 'Half PPR' : 'Standard');

export async function yahooMatchup({ env, league: leagueId, team: teamId, week, snapshot }) {
  const myTeams = await cached('yahoo:myteams', 6 * 3600, async () => parseMyTeams(await yahooGet(env, 'users;use_login=1/games;game_keys=nfl/teams')));
  if (!myTeams.length) throw Object.assign(new Error('No Yahoo NFL teams found for this account'), { status: 404 });
  const mine = myTeams.find((t) => (!leagueId || t.league_id === String(leagueId)) && (!teamId || t.team_key.endsWith(`.t.${teamId}`))) ?? (leagueId ? null : myTeams[0]);
  if (!mine) throw Object.assign(new Error(`None of your Yahoo teams is in league ${leagueId}`), { status: 404 });

  const weekPart = week ? `;week=${week}` : '';
  const [info, board] = await Promise.all([
    cached(`yahoo:league:${mine.league_key}`, 30 * 60, async () => parseLeague(await yahooGet(env, `league/${mine.league_key};out=settings,standings`))),
    yahooGet(env, `league/${mine.league_key}/scoreboard${weekPart}`).then(parseLeague),
  ]);
  const league = { ...info, matchups: board.matchups, week: board.week ?? info.current_week };
  const matchup = league.matchups.find((m) => m.teams.some((t) => t.team_key === mine.team_key));
  const meTeam = matchup?.teams.find((t) => t.team_key === mine.team_key);
  const oppTeam = matchup?.teams.find((t) => t.team_key !== mine.team_key) ?? null;
  const w = matchup?.week ?? league.week;

  const keys = [mine.team_key, oppTeam?.team_key].filter(Boolean).join(',');
  const rosters = parseRosters(await yahooGet(env, `teams;team_keys=${keys}/roster;week=${w}/players/stats;type=week;week=${w}`));

  // Per-player projections come from the Sleeper snapshot via yahoo_id.
  const index = yahooIndex(snapshot);
  const scoring = league.rec >= 1 ? 2 : league.rec >= 0.5 ? 1 : 0;
  const sleeperIds = Object.values(rosters).flat().map((p) => index[p.yahoo_id]).filter(Boolean);
  const sleeper = snapshot ? await resolveSleeperPlayers(sleeperIds, { snapshot, scoring, week: w }) : {};
  const enrich = (p) => p && ({ ...p, projected: sleeper[index[p.yahoo_id]]?.projected ?? null });

  const standingOf = (key) => league.standings.find((s) => s.team_key === key);
  const side = (t) => t && ({
    name: t.name,
    manager: t.manager,
    record: standingOf(t.team_key)?.record ?? '',
    rank: standingOf(t.team_key)?.rank ?? null,
    points: t.points ?? 0,
    projected: t.projected,
    win_probability: t.win_probability,
  });

  const mineRoster = rosters[mine.team_key] ?? [];
  const oppRoster = oppTeam ? rosters[oppTeam.team_key] ?? [] : [];
  return {
    provider: 'yahoo',
    status_hint: { postevent: 'final', midevent: 'live', preevent: 'pre' }[matchup?.status] ?? null,
    league: { id: mine.league_id, name: league.name, season: league.season, week: w, scoring: scoringLabel(league.rec), is_playoffs: Boolean(matchup?.is_playoffs) },
    season: league.season,
    season_type: 2,
    slots: league.slots,
    me: side(meTeam ?? { team_key: mine.team_key, name: mine.name, points: 0 }),
    opp: side(oppTeam),
    me_starters: assignSlots(league.slots, mineRoster).map(enrich),
    opp_starters: assignSlots(league.slots, oppRoster).map(enrich),
    me_bench: mineRoster.filter((p) => p.slot === 'BN').map(enrich),
    standings: league.standings.map((s) => ({
      rank: s.rank, name: s.name, record: s.record, pf: s.pf, is_me: s.team_key === mine.team_key, is_opp: s.team_key === oppTeam?.team_key,
    })),
  };
}
