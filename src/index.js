// Cloudflare Worker entry point.
//   GET /sleeper?league=<id>&user=<username>      Sleeper matchup JSON
//   GET /yahoo[?league=<id>]                      Yahoo matchup JSON
//   GET /sunday?provider=sleeper&league=…&user=…&nfl_team=sea
//                                                 fantasy matchup + your NFL team's game
//   GET /yahoo/login?key=…, /yahoo/callback       one-time Yahoo connection
import { buildMatchup } from './matchup.js';
import { loadWeekGames } from './nfl.js';
import { loadSnapshot } from './players.js';
import { sleeperMatchup } from './sleeper.js';
import { formatTime } from './util.js';
import { checkState, exchangeCode, loginUrl, yahooMatchup } from './yahoo.js';

const json = (body, status = 200, cacheSeconds = 0) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
  },
});

const html = (body, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><title>TRMNL Fantasy</title><body style="font:16px system-ui;max-width:40em;margin:3em auto">${body}</body>`, {
  status,
  headers: { 'content-type': 'text/html; charset=utf-8' },
});

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function fantasyPayload(provider, params, env, now = Date.now()) {
  const tz = params.get('tz') ?? env.TIMEZONE ?? 'America/Los_Angeles';
  if (!validTimeZone(tz)) throw Object.assign(new Error(`Unknown time zone "${tz}"`), { status: 400 });
  const snapshot = await loadSnapshot(env).catch(() => null);
  const week = params.get('week');
  let input;
  if (provider === 'sleeper') {
    const league = params.get('league') ?? env.SLEEPER_LEAGUE_ID;
    if (!league) throw Object.assign(new Error('Missing ?league=<Sleeper league id>'), { status: 400 });
    input = await sleeperMatchup({
      league,
      user: params.get('user') ?? env.SLEEPER_USERNAME,
      roster: params.get('roster'),
      week,
      snapshot,
    });
  } else {
    input = await yahooMatchup({
      env,
      league: params.get('league') ?? env.YAHOO_LEAGUE_ID,
      team: params.get('team') ?? env.YAHOO_TEAM_ID,
      week,
      snapshot,
    });
  }
  const games = await loadWeekGames(input.season, input.league.week, input.season_type).catch(() => ({}));
  const matchup = buildMatchup(input, { games, tz, now });
  return {
    ...matchup,
    title: input.league.name,
    projections: snapshot ? (snapshot.week === input.league.week ? 'on' : 'stale') : 'off',
    updated_at: formatTime(new Date(now), tz),
  };
}

// The team dashboard, via a service binding when configured (no public hop),
// otherwise its public URL.
async function teamDashboard(env, params) {
  const league = params.get('nfl_league') ?? 'nfl';
  const team = params.get('nfl_team') ?? env.SUNDAY_TEAM ?? 'sea';
  const qs = new URLSearchParams({ league, team });
  if (params.get('tz')) qs.set('tz', params.get('tz'));
  if (env.TEAM_DASHBOARD_KEY) qs.set('key', env.TEAM_DASHBOARD_KEY);
  const path = `/team?${qs}`;
  let res;
  if (env.TEAM_DASHBOARD) res = await env.TEAM_DASHBOARD.fetch(`https://team-dashboard${path}`);
  else if (env.TEAM_DASHBOARD_URL) res = await fetch(`${env.TEAM_DASHBOARD_URL.replace(/\/$/, '')}${path}`);
  else return null;
  return res.ok ? res.json() : null;
}

export async function handle(request, env = {}) {
  const url = new URL(request.url);
  const params = url.searchParams;
  const path = url.pathname.replace(/\/$/, '') || '/';

  if (path === '/health') return new Response('ok');
  if (path === '/') {
    return json({
      endpoints: ['/sleeper?league=<id>&user=<username>', '/yahoo', '/sunday?provider=sleeper&league=<id>&user=<username>&nfl_team=sea', '/yahoo/login?key=<ACCESS_KEY>'],
    });
  }

  // The Yahoo callback is protected by the signed OAuth state instead of the key.
  if (path === '/yahoo/callback') {
    if (!(await checkState(env.YAHOO_CLIENT_SECRET ?? '', params.get('state')))) return html('<p>That login link expired or was not started here. Try /yahoo/login again.</p>', 400);
    if (!params.get('code')) return html(`<p>Yahoo did not return a code: ${params.get('error') ?? 'unknown error'}</p>`, 400);
    try {
      await exchangeCode(env, url.origin, params.get('code'));
      return html('<h2>Connected to Yahoo ✓</h2><p>Your TRMNL can now poll <code>/yahoo</code>. You can close this tab.</p>');
    } catch (err) {
      return html(`<p>${err.message}</p>`, 500);
    }
  }

  if (env.ACCESS_KEY && params.get('key') !== env.ACCESS_KEY) return json({ error: 'Missing or wrong ?key=' }, 401);

  if (path === '/yahoo/login') {
    if (!env.YAHOO_CLIENT_ID || !env.YAHOO_CLIENT_SECRET) return html('<p>Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET first.</p>', 500);
    return Response.redirect(await loginUrl(env, url.origin), 302);
  }

  try {
    if (path === '/sleeper' || path === '/yahoo') {
      const body = await fantasyPayload(path.slice(1), params, env);
      return json(body, 200, body.is_live ? 30 : 120);
    }
    if (path === '/sunday') {
      const provider = params.get('provider') ?? (env.SLEEPER_LEAGUE_ID ? 'sleeper' : 'yahoo');
      const [fantasy, team] = await Promise.all([
        fantasyPayload(provider, params, env),
        teamDashboard(env, params).catch(() => null),
      ]);
      return json({ ...fantasy, fantasy_title: fantasy.title, team, has_team: Boolean(team && !team.error) }, 200, fantasy.is_live || team?.is_live ? 30 : 120);
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    console.error('fantasy request failed', path, err);
    const status = err.status && err.status < 600 ? err.status : 500;
    return json({ error: err.message ?? 'Could not load the matchup', title: 'Fantasy football' }, status);
  }
}

export default {
  fetch: (request, env) => handle(request, env),
};
