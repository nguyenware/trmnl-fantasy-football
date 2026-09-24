// Re-records test/fixtures from live Sleeper and ESPN data, with manager and
// team names replaced so no real league members end up in the repo.
//   node scripts/capture-fixtures.mjs <sleeper league id> <completed week> <current week>
import { writeFileSync } from 'node:fs';

const [leagueId, doneWeek, curWeek] = process.argv.slice(2);
if (!leagueId) {
  console.error('usage: node scripts/capture-fixtures.mjs <league id> <completed week> <current week>');
  process.exit(1);
}
const API = 'https://api.sleeper.app/v1';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
};
const save = (name, data) => {
  writeFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url), JSON.stringify(data));
  console.log(name, JSON.stringify(data).length);
};

const league = await get(`${API}/league/${leagueId}`);
const users = await get(`${API}/league/${leagueId}/users`);
const rosters = await get(`${API}/league/${leagueId}/rosters`);

// Stable fake identities: user N -> "Manager N" / "Team N", fake ids.
const alias = new Map(users.map((u, i) => [u.user_id, String(900000000 + i + 1)]));
const fakeUsers = users.map((u, i) => ({
  user_id: alias.get(u.user_id),
  display_name: `Manager${i + 1}`,
  username: `manager${i + 1}`,
  metadata: { team_name: `Team ${String.fromCharCode(65 + i)}` },
}));
const fakeRosters = rosters.map((r) => ({
  ...r,
  owner_id: alias.get(r.owner_id) ?? null,
  co_owners: (r.co_owners ?? []).map((id) => alias.get(id)).filter(Boolean),
  league_id: 'L1',
}));

save('sleeper-league', { ...league, league_id: 'L1', name: 'Test League', previous_league_id: null, draft_id: null, avatar: null, metadata: {} });
save('sleeper-users', fakeUsers);
save('sleeper-rosters', fakeRosters);
save('sleeper-state', await get(`${API}/state/nfl`));
save(`sleeper-matchups-${doneWeek}`, await get(`${API}/league/${leagueId}/matchups/${doneWeek}`));
save(`sleeper-matchups-${curWeek}`, await get(`${API}/league/${leagueId}/matchups/${curWeek}`));

const trim = (sb) => ({
  events: sb.events.map((e) => ({
    id: e.id,
    date: e.date,
    competitions: [{
      date: e.competitions[0].date,
      status: e.competitions[0].status,
      competitors: e.competitions[0].competitors.map((c) => ({ homeAway: c.homeAway, score: c.score, team: { abbreviation: c.team.abbreviation } })),
    }],
  })),
});
save(`espn-scoreboard-${doneWeek}`, trim(await get(`${ESPN}?dates=${league.season}&seasontype=2&week=${doneWeek}`)));
save(`espn-scoreboard-${curWeek}`, trim(await get(`${ESPN}?dates=${league.season}&seasontype=2&week=${curWeek}`)));

// A snapshot limited to this league's players (the real one covers everyone).
const snapshot = JSON.parse((await import('node:fs')).readFileSync(process.env.SNAPSHOT ?? 'snapshot.json', 'utf8'));
const ids = new Set(rosters.flatMap((r) => r.players ?? []));
save('snapshot', {
  ...snapshot,
  players: Object.fromEntries(Object.entries(snapshot.players).filter(([id]) => ids.has(id))),
  proj: Object.fromEntries(Object.entries(snapshot.proj).filter(([id]) => ids.has(id))),
});
