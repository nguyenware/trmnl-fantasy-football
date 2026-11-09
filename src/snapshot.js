// Builds the compact player snapshot that src/players.js reads from KV.
//
// Sleeper's full player list is ~15 MB. On Workers Paid (since 2026-11-08) a
// cron run has 15 minutes of CPU, and parsing it takes about 30 ms, so the
// Worker refreshes the snapshot itself on the schedule in wrangler.jsonc.
// scripts/snapshot.mjs uses the same builder for a manual run from a laptop.
// Sleeper asks that the full player list be fetched at most once a day.
import { SNAPSHOT_KEY, resetSnapshotMemo } from './players.js';

const SLEEPER = 'https://api.sleeper.app/v1';
const PROJECTIONS = 'https://api.sleeper.com/projections/nfl';
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

export async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'trmnl-fantasy-football snapshot' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/** `get(url)` returns parsed JSON; injectable for tests. */
export async function buildSnapshot(get = getJson, now = new Date()) {
  const state = await get(`${SLEEPER}/state/nfl`);
  const season = state.season;
  const week = state.display_week || state.week || 1;
  const seasonType = state.season_type === 'post' ? 'post' : 'regular';

  const all = await get(`${SLEEPER}/players/nfl`);
  const players = {};
  for (const [id, p] of Object.entries(all)) {
    const pos = p.position === 'DEF' ? 'DEF' : (p.fantasy_positions ?? []).find((x) => POSITIONS.includes(x)) ?? (POSITIONS.includes(p.position) ? p.position : null);
    if (!pos) continue;
    if (!p.active) continue;
    const name = p.full_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
    players[id] = [name, pos, p.team ?? '', p.injury_status ?? null, p.yahoo_id ? String(p.yahoo_id) : null];
  }

  const query = POSITIONS.map((p) => `position%5B%5D=${p}`).join('&');
  const proj = {};
  for (const row of await get(`${PROJECTIONS}/${season}/${week}?season_type=${seasonType}&${query}`)) {
    const s = row.stats ?? {};
    if (s.pts_ppr == null && s.pts_std == null) continue;
    proj[row.player_id] = [r1(s.pts_std ?? 0), r1(s.pts_half_ppr ?? s.pts_std ?? 0), r1(s.pts_ppr ?? 0)];
  }

  return { season: Number(season), week, season_type: seasonType, updated: now.toISOString(), players, proj };
}

/** Cron entry point: build and store the snapshot in FANTASY_KV (one KV write). */
export async function refreshSnapshot(env, get = getJson) {
  const snapshot = await buildSnapshot(get);
  await env.FANTASY_KV.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
  resetSnapshotMemo();
  console.log(`snapshot: ${Object.keys(snapshot.players).length} players, ${Object.keys(snapshot.proj).length} projections, week ${snapshot.week}`);
  return snapshot;
}
