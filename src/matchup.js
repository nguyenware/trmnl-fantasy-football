// Turns a provider-neutral matchup (Sleeper or Yahoo) into the payload the
// TRMNL templates render: slot-by-slot rows, live game status per player,
// players left to play, projections, a win probability and alerts.
import { gameText, normTeam, remainingFraction } from './nfl.js';

const SLOT_LABELS = {
  SUPER_FLEX: 'SF', FLEX: 'FLX', REC_FLEX: 'W/T', WRRB_FLEX: 'W/R', IDP_FLEX: 'IDP', 'W/R/T': 'FLX', 'W/R': 'W/R',
  'W/T': 'W/T', 'Q/W/R/T': 'SF', 'D/ST': 'DEF', DST: 'DEF',
};
export const slotLabel = (slot) => SLOT_LABELS[slot] ?? slot;

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const fmt = (n) => (n == null ? '-' : (Math.round(n * 10) / 10).toFixed(1));

// Standard normal CDF (Abramowitz-Stegun 7.1.26).
function phi(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

function decorate(player, points, games, tz) {
  if (!player) return { empty: true, name: 'Empty', pos: '', team: '', state: 'empty', game: '', points: 0, projected: null, injury: null };
  const team = normTeam(player.team);
  const game = team ? games[team] : null;
  // With no scoreboard at all (ESPN down) we can't tell a bye from unknown.
  const known = Object.keys(games).length > 0;
  const onBye = known && Boolean(team) && !game;
  const state = !team || (!game && !onBye) ? 'none' : onBye ? 'bye' : game.state;
  const pts = points ?? 0;
  // Live projection: points so far plus the unplayed share of the projection.
  const frac = state === 'bye' ? 0 : remainingFraction(game);
  const live = player.projected != null ? pts + player.projected * frac : null;
  return {
    empty: false,
    name: player.name,
    pos: player.pos,
    team: team || 'FA',
    opp: game ? `${game.home_away === 'away' ? '@' : 'vs'} ${game.opp}` : '',
    state,
    playing: state === 'in',
    done: state === 'post',
    game: onBye ? 'BYE' : !team ? 'FA' : game ? gameText(game, tz) : '',
    points: round1(pts),
    points_text: fmt(pts),
    projected: round1(player.projected),
    projected_text: player.projected == null ? '' : fmt(player.projected),
    live_projection: round1(live),
    remaining_projection: player.projected != null ? player.projected * frac : null,
    injury: player.injury && player.injury !== 'NA' ? player.injury : null,
  };
}

function sideSummary(team, starters) {
  const toPlay = starters.filter((p) => !p.empty && p.state === 'pre').length;
  const playing = starters.filter((p) => p.state === 'in').length;
  const done = starters.filter((p) => p.state === 'post' || p.state === 'bye').length;
  const withProj = starters.filter((p) => p.live_projection != null);
  const projected = team.projected ?? (withProj.length ? round1(starters.reduce((s, p) => s + (p.live_projection ?? p.points ?? 0), 0)) : null);
  return {
    name: team.name,
    manager: team.manager ?? '',
    record: team.record ?? '',
    rank: team.rank ?? null,
    points: round1(team.points ?? starters.reduce((s, p) => s + (p.points ?? 0), 0)),
    points_text: fmt(team.points ?? starters.reduce((s, p) => s + (p.points ?? 0), 0)),
    projected,
    projected_text: projected == null ? '' : fmt(projected),
    to_play: toPlay,
    playing,
    done,
    left: toPlay + playing,
  };
}

// Win probability from each side's live projection. Each unplayed share of
// a player's projection is treated as independent with a standard deviation
// of half its size (a typical coefficient of variation for weekly fantasy
// points), so the spread shrinks as games finish.
export function winProbability(me, opp, meRows, oppRows) {
  const rem = (rows) => rows.map((p) => p.remaining_projection ?? 0);
  const expected = (side, rows) => side.points + rem(rows).reduce((s, x) => s + x, 0);
  const variance = (rows) => rem(rows).reduce((s, x) => s + (0.5 * x) ** 2, 0);
  const diff = expected(me, meRows) - expected(opp, oppRows);
  const sd = Math.sqrt(variance(meRows) + variance(oppRows));
  if (sd < 0.5) return diff > 0 ? 100 : diff < 0 ? 0 : 50;
  return Math.round(phi(diff / sd) * 100);
}

// "B. Robinson" twice (Bijan and Brian, same team): spell out first names
// for any short names that collide within the matchup.
export function disambiguate(players) {
  const list = players.filter((p) => p?.full_name);
  const count = new Map();
  for (const p of list) count.set(p.name, new Set([...(count.get(p.name) ?? []), p.full_name]));
  return players.map((p) => (p?.full_name && count.get(p.name)?.size > 1 ? { ...p, name: p.full_name } : p));
}

export function buildMatchup(rawInput, { games, tz, now = Date.now() }) {
  const all0 = disambiguate([...rawInput.me_starters, ...(rawInput.opp_starters ?? []), ...(rawInput.me_bench ?? [])]);
  const nMe = rawInput.me_starters.length;
  const nOpp = rawInput.opp_starters?.length ?? 0;
  const input = {
    ...rawInput,
    me_starters: all0.slice(0, nMe),
    opp_starters: all0.slice(nMe, nMe + nOpp),
    me_bench: all0.slice(nMe + nOpp),
  };
  const slots = input.slots.map(slotLabel);
  const meRows = input.me_starters.map((p, i) => decorate(p, p?.points ?? input.me_points?.[i], games, tz));
  const oppRows = input.opp ? input.opp_starters.map((p, i) => decorate(p, p?.points ?? input.opp_points?.[i], games, tz)) : [];
  const me = sideSummary(input.me, meRows);
  const opp = input.opp ? sideSummary(input.opp, oppRows) : null;

  const all = [...meRows, ...oppRows].filter((p) => !p.empty && p.state !== 'none');
  const status = !all.length ? (input.status_hint ?? 'pre')
    : all.every((p) => p.state === 'post' || p.state === 'bye') ? 'final'
      : all.some((p) => p.state === 'in' || p.state === 'post') ? 'live' : 'pre';

  let winPct = input.me.win_probability != null ? Math.round(input.me.win_probability * 100) : null;
  if (winPct == null && opp) {
    const haveProj = [...meRows, ...oppRows].some((p) => p.projected != null);
    if (haveProj || status === 'final') winPct = winProbability(me, opp, meRows, oppRows);
  }

  // Once every game is over the result says it all.
  if (status === 'final') winPct = null;

  const rows = slots.map((slot, i) => ({ slot, me: meRows[i], opp: oppRows[i] ?? null }));

  const alerts = [];
  meRows.forEach((p, i) => {
    if (p.empty) alerts.push(`Empty ${slots[i]} slot`);
    else if (p.state === 'bye') alerts.push(`${p.name} is on bye`);
    else if (p.state === 'pre' && ['O', 'IR', 'D', 'SUS', 'PUP'].includes(p.injury)) alerts.push(`${p.name} is ${injuryWord(p.injury)}`);
  });
  const questionable = meRows.filter((p) => p.state === 'pre' && p.injury === 'Q').map((p) => p.name);
  if (questionable.length) alerts.push(`Questionable: ${questionable.join(', ')}`);

  // Best bench player this week (points so far, or projection before kickoff).
  const bench = (input.me_bench ?? []).map((p) => decorate(p, p.points, games, tz)).filter((p) => !p.empty);
  const benchValue = (p) => (status === 'pre' ? p.projected ?? 0 : p.points ?? 0);
  bench.sort((a, b) => benchValue(b) - benchValue(a));
  const benchPoints = round1(bench.reduce((s, p) => s + (p.points ?? 0), 0));

  const margin = opp ? round1(me.points - opp.points) : null;
  const headline = !opp ? 'No matchup this week'
    : status === 'pre' ? `${me.projected_text ? `Proj ${me.projected_text}-${opp.projected_text}` : 'Kickoff soon'}${winPct != null ? ` · ${winPct}% to win` : ''}`
      : status === 'final' ? `${margin > 0 ? 'Won' : margin < 0 ? 'Lost' : 'Tied'} ${me.points_text}-${opp.points_text}`
        : `${margin > 0 ? 'Up' : margin < 0 ? 'Down' : 'Tied'} ${Math.abs(margin).toFixed(1)} · ${me.left} left vs ${opp.left}`;

  return {
    provider: input.provider,
    league: input.league,
    week: input.league.week,
    status,
    is_pre: status === 'pre',
    is_live: status === 'live',
    is_final: status === 'final',
    me,
    opp,
    has_opp: Boolean(opp),
    margin,
    margin_text: margin == null ? '' : `${margin > 0 ? '+' : ''}${margin.toFixed(1)}`,
    win_pct: winPct,
    headline,
    rows,
    bench: bench.slice(0, 3),
    bench_points: benchPoints,
    alerts: alerts.slice(0, 4),
    standings: input.standings ?? [],
  };
}

function injuryWord(code) {
  return { O: 'out', IR: 'on IR', D: 'doubtful', SUS: 'suspended', PUP: 'on PUP' }[code] ?? code;
}
