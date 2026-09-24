// This week's NFL games, keyed by team, from ESPN's scoreboard. Used to show
// each fantasy player's game (kickoff, live clock or final) and to work out
// how much of their game is left.
import { cached, fetchJson, formatTime, formatWeekday, HOUR, MINUTE } from './util.js';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

// Providers disagree on a few abbreviations; normalise everything to ESPN's.
const ALIASES = { WAS: 'WSH', JAC: 'JAX', LA: 'LAR', OAK: 'LV', SD: 'LAC', STL: 'LAR' };
export const normTeam = (abbr) => {
  const t = String(abbr ?? '').toUpperCase();
  return ALIASES[t] ?? t;
};

export function trimScoreboard(data) {
  const games = {};
  for (const e of data.events ?? []) {
    const comp = e.competitions?.[0];
    if (!comp) continue;
    const status = comp.status ?? e.status ?? {};
    const teams = comp.competitors.map((c) => ({
      abbr: normTeam(c.team?.abbreviation),
      home_away: c.homeAway,
      score: c.score != null && c.score !== '' ? Number(c.score) : null,
    }));
    for (const t of teams) {
      const o = teams.find((x) => x !== t);
      games[t.abbr] = {
        date: comp.date ?? e.date,
        state: status.type?.state ?? 'pre',
        detail: status.type?.shortDetail ?? '',
        period: status.period ?? 0,
        clock_seconds: typeof status.clock === 'number' ? status.clock : null,
        opp: o?.abbr ?? '',
        home_away: t.home_away,
        score: t.score,
        opp_score: o?.score ?? null,
      };
    }
  }
  return games;
}

export function scoreboardTtl(games, now = Date.now()) {
  const list = Object.values(games);
  if (list.some((g) => g.state === 'in')) return 60;
  const soon = list.some((g) => g.state === 'pre' && Date.parse(g.date) - now < 30 * MINUTE && Date.parse(g.date) + 5 * HOUR > now);
  return soon ? 120 : 15 * 60;
}

export async function loadWeekGames(season, week, seasonType = 2) {
  return cached(`nfl:scoreboard:${season}:${seasonType}:${week}`, (v) => scoreboardTtl(v), async () => {
    const data = await fetchJson(`${SCOREBOARD}?dates=${season}&seasontype=${seasonType}&week=${week}`);
    return trimScoreboard(data);
  });
}

// Share of a player's game still to be played, 0..1.
export function remainingFraction(game) {
  if (!game) return 0;
  if (game.state === 'pre') return 1;
  if (game.state === 'post') return 0;
  const period = Math.min(Math.max(game.period, 1), 4);
  const clock = game.clock_seconds ?? 450;
  const left = (4 - period) * 900 + clock;
  return Math.max(0, Math.min(1, left / 3600));
}

// "Sun 10:00 AM", "Q3 4:12", "Final 27-20"
export function gameText(game, tz) {
  if (!game) return 'BYE';
  if (game.state === 'pre') {
    const d = new Date(game.date);
    return `${formatWeekday(d, tz)} ${formatTime(d, tz).replace(':00', '').replace(' ', '')}`;
  }
  if (game.state === 'post') {
    const res = game.score > game.opp_score ? 'W' : game.score < game.opp_score ? 'L' : 'T';
    return `${res} ${game.score}-${game.opp_score}`;
  }
  const d = game.detail ?? '';
  if (/half/i.test(d)) return 'Half';
  const m = d.match(/^(\d+:\d+) - (\d)/);
  if (m) return `Q${m[2]} ${m[1]}`;
  return d.replace(/ Quarter$/, '').replace(/^End of /, 'End ');
}
