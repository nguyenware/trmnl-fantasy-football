// Sleeper provider: public, read-only API, no auth.
// https://docs.sleeper.com
import { resolveSleeperPlayers, scoringIndex } from './players.js';
import { cached, fetchJson } from './util.js';

const API = 'https://api.sleeper.app/v1';
const NON_STARTER = new Set(['BN', 'IR', 'TAXI']);

const scoringLabel = (rec) => (rec >= 1 ? 'PPR' : rec >= 0.5 ? 'Half PPR' : 'Standard');

export async function loadState() {
  return cached('sleeper:state', 15 * 60, () => fetchJson(`${API}/state/nfl`));
}

async function loadLeague(leagueId) {
  return cached(`sleeper:league:${leagueId}`, 60 * 60, async () => {
    const l = await fetchJson(`${API}/league/${leagueId}`);
    if (!l) throw Object.assign(new Error(`Sleeper league ${leagueId} not found`), { status: 404 });
    return {
      id: l.league_id,
      name: l.name,
      season: l.season,
      status: l.status,
      roster_positions: l.roster_positions ?? [],
      rec: l.scoring_settings?.rec ?? 0,
      playoff_week_start: l.settings?.playoff_week_start ?? null,
      last_scored_leg: l.settings?.last_scored_leg ?? null,
    };
  });
}

async function loadUsers(leagueId) {
  return cached(`sleeper:users:${leagueId}`, 60 * 60, async () => {
    const users = await fetchJson(`${API}/league/${leagueId}/users`);
    return Object.fromEntries((users ?? []).map((u) => [u.user_id, {
      name: u.metadata?.team_name || u.display_name,
      manager: u.display_name,
      username: (u.username ?? u.display_name ?? '').toLowerCase(),
    }]));
  });
}

async function loadRosters(leagueId) {
  return cached(`sleeper:rosters:${leagueId}`, 10 * 60, async () => {
    const rosters = await fetchJson(`${API}/league/${leagueId}/rosters`);
    return (rosters ?? []).map((r) => ({
      roster_id: r.roster_id,
      owner_id: r.owner_id,
      co_owners: r.co_owners ?? [],
      wins: r.settings?.wins ?? 0,
      losses: r.settings?.losses ?? 0,
      ties: r.settings?.ties ?? 0,
      fpts: (r.settings?.fpts ?? 0) + (r.settings?.fpts_decimal ?? 0) / 100,
      fpts_against: (r.settings?.fpts_against ?? 0) + (r.settings?.fpts_against_decimal ?? 0) / 100,
      streak: r.metadata?.streak ?? '',
    }));
  });
}

async function loadMatchups(leagueId, week, live) {
  // Live points change constantly on game days; otherwise matchups are stable.
  return cached(`sleeper:matchups:${leagueId}:${week}`, live ? 60 : 10 * 60, () => fetchJson(`${API}/league/${leagueId}/matchups/${week}`));
}

async function resolveUserId(username) {
  if (/^\d{6,}$/.test(username)) return username;
  return cached(`sleeper:user:${username.toLowerCase()}`, 24 * 3600, async () => {
    const u = await fetchJson(`${API}/user/${encodeURIComponent(username)}`);
    if (!u?.user_id) throw Object.assign(new Error(`Sleeper user "${username}" not found`), { status: 404 });
    return u.user_id;
  });
}

// Standings: wins, then ties, then points for.
export function rankRosters(rosters) {
  return [...rosters].sort((a, b) => b.wins - a.wins || b.ties - a.ties || b.fpts - a.fpts)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

const record = (r) => (r.ties ? `${r.wins}-${r.losses}-${r.ties}` : `${r.wins}-${r.losses}`);

// Returns the provider-neutral matchup input for buildMatchup().
export async function sleeperMatchup({ league: leagueId, user, roster, week: weekParam, snapshot, liveHint = true }) {
  const [league, state] = await Promise.all([loadLeague(leagueId), loadState()]);
  const week = Number(weekParam) || state.display_week || state.week || 1;
  const [users, rosters, matchups] = await Promise.all([
    loadUsers(leagueId), loadRosters(leagueId), loadMatchups(leagueId, week, liveHint),
  ]);

  let mine;
  if (roster) {
    mine = rosters.find((r) => String(r.roster_id) === String(roster));
  } else if (user) {
    const userId = await resolveUserId(user);
    mine = rosters.find((r) => r.owner_id === userId || r.co_owners.includes(userId));
  }
  if (!mine) {
    throw Object.assign(new Error(user || roster ? `Couldn't find ${user ? `user "${user}"` : `roster ${roster}`} in ${league.name}` : 'Add &user=<your Sleeper username> or &roster=<roster id>'), { status: 400 });
  }

  const ranked = rankRosters(rosters);
  const rankOf = (id) => ranked.find((r) => r.roster_id === id)?.rank ?? null;
  const myMatch = (matchups ?? []).find((m) => m.roster_id === mine.roster_id);
  const oppMatch = myMatch?.matchup_id != null
    ? matchups.find((m) => m.matchup_id === myMatch.matchup_id && m.roster_id !== mine.roster_id) : null;
  const oppRoster = oppMatch ? rosters.find((r) => r.roster_id === oppMatch.roster_id) : null;

  const slots = league.roster_positions.filter((p) => !NON_STARTER.has(p));
  const scoring = scoringIndex(league.rec);
  const myStarters = myMatch?.starters ?? [];
  const oppStarters = oppMatch?.starters ?? [];
  const myBench = (myMatch?.players ?? []).filter((id) => !myStarters.includes(id));
  const ids = [...new Set([...myStarters, ...oppStarters, ...myBench])];
  const players = await resolveSleeperPlayers(ids, { snapshot, priority: [...myStarters, ...oppStarters], scoring, week });

  const withPoints = (id, pts) => (id && id !== '0' && players[id] ? { ...players[id], points: pts ?? 0 } : null);
  const side = (r, m) => {
    const u = users[r.owner_id] ?? {};
    return {
      name: u.name ?? `Team ${r.roster_id}`,
      manager: u.manager ?? '',
      record: record(r),
      rank: rankOf(r.roster_id),
      points: m?.custom_points ?? m?.points ?? 0,
      projected: null,
      win_probability: null,
    };
  };

  return {
    provider: 'sleeper',
    league: {
      id: league.id,
      name: league.name,
      season: league.season,
      week,
      scoring: scoringLabel(league.rec),
      is_playoffs: league.playoff_week_start ? week >= league.playoff_week_start : false,
    },
    season: Number(state.season ?? league.season),
    season_type: state.season_type === 'post' ? 3 : 2,
    slots,
    me: side(mine, myMatch),
    opp: oppRoster ? side(oppRoster, oppMatch) : null,
    me_starters: slots.map((_, i) => withPoints(myStarters[i], myMatch?.starters_points?.[i])),
    opp_starters: slots.map((_, i) => withPoints(oppStarters[i], oppMatch?.starters_points?.[i])),
    me_bench: myBench.map((id) => withPoints(id, myMatch?.players_points?.[id])).filter(Boolean),
    standings: ranked.map((r) => ({
      rank: r.rank,
      name: users[r.owner_id]?.name ?? `Team ${r.roster_id}`,
      record: record(r),
      pf: Math.round(r.fpts),
      is_me: r.roster_id === mine.roster_id,
      is_opp: r.roster_id === oppRoster?.roster_id,
    })),
  };
}
