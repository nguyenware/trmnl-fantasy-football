// Player names, positions, NFL teams, injury status and weekly projections.
//
// Sleeper's full player list is ~15 MB, far too big to parse inside a Worker
// on the free plan (10 ms CPU). A GitHub Action (scripts/snapshot.mjs) trims
// it once or twice a day into a compact snapshot in Workers KV:
//
//   { season, week, updated, players: { id: [name, pos, team, injury, yahooId] },
//     proj: { id: [std, half, ppr] } }
//
// Without a snapshot, Sleeper players are looked up one by one (capped), and
// projections are left out.
import { fetchJson } from './util.js';

export const SNAPSHOT_KEY = 'sleeper:snapshot:v1';
const PLAYER_URL = 'https://api.sleeper.com/players/nfl/';
const FALLBACK_LIMIT = 30;

let memo = null;

export async function loadSnapshot(env) {
  if (!env?.FANTASY_KV) return null;
  if (memo && memo.expires > Date.now()) return memo.value;
  const value = await env.FANTASY_KV.get(SNAPSHOT_KEY, { type: 'json', cacheTtl: 3600 });
  memo = { value, expires: Date.now() + 10 * 60_000 };
  return value;
}

export function resetSnapshotMemo() {
  memo = null;
}

export const shortName = (full = '') => {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full;
  const suffix = /^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(parts[parts.length - 1]) ? ` ${parts.pop()}` : '';
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}${suffix}`;
};

const INJURY = { Questionable: 'Q', Doubtful: 'D', Out: 'O', IR: 'IR', PUP: 'PUP', Sus: 'SUS', NA: 'NA', COV: 'COV', DNR: 'DNR' };
export const injuryAbbr = (s) => (s ? INJURY[s] ?? String(s).slice(0, 3).toUpperCase() : null);

const IDP = new Set(['DL', 'LB', 'DB', 'DE', 'DT', 'CB', 'S']);

// Team defenses are keyed by team abbreviation in Sleeper ("SEA").
const isTeamId = (id) => /^[A-Z]{2,3}$/.test(id);

export function scoringIndex(rec) {
  if (rec >= 1) return 2;
  if (rec >= 0.5) return 1;
  return 0;
}

// Resolve Sleeper player ids to display info. `priority` ids (starters) are
// looked up individually when the snapshot is missing them.
export async function resolveSleeperPlayers(ids, { snapshot: snap, priority = [], scoring = 2, week = null }) {
  // Projections are only for the snapshot's week; don't show them for others.
  const snapshot = snap && week != null && Number(snap.week) !== Number(week) ? { ...snap, proj: {} } : snap;
  const out = {};
  const missing = [];
  for (const id of ids) {
    if (!id || id === '0') continue;
    if (isTeamId(id)) {
      out[id] = { id, name: `${id} D/ST`, pos: 'DEF', team: id, injury: null, projected: snapshot?.proj?.[id]?.[scoring] ?? null };
      continue;
    }
    const p = snapshot?.players?.[id];
    if (p) {
      // IDP scoring varies too much between leagues for a generic projection.
      const projected = IDP.has(p[1]) ? null : snapshot.proj?.[id]?.[scoring] ?? null;
      out[id] = { id, name: shortName(p[0]), full_name: p[0], pos: p[1], team: p[2], injury: injuryAbbr(p[3]), projected };
    } else {
      missing.push(id);
    }
  }
  const lookup = missing.filter((id) => priority.includes(id)).slice(0, FALLBACK_LIMIT);
  await Promise.all(lookup.map(async (id) => {
    try {
      const p = await fetchJson(`${PLAYER_URL}${id}`);
      out[id] = {
        id,
        name: shortName(p.full_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`),
        full_name: p.full_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
        pos: p.position ?? p.fantasy_positions?.[0] ?? '',
        team: p.team ?? '',
        injury: injuryAbbr(p.injury_status),
        projected: null,
      };
    } catch {
      // Leave it unresolved; the row shows the id.
    }
  }));
  for (const id of missing) out[id] ??= { id, name: `Player ${id}`, pos: '', team: '', injury: null, projected: null };
  return out;
}

// Yahoo player id -> Sleeper projection (Sleeper's player records carry
// yahoo_id), so Yahoo matchups get per-player projections too.
export function yahooIndex(snapshot) {
  if (!snapshot?.players) return {};
  if (snapshot._yahoo) return snapshot._yahoo;
  const index = {};
  for (const [id, p] of Object.entries(snapshot.players)) if (p[4]) index[p[4]] = id;
  Object.defineProperty(snapshot, '_yahoo', { value: index, enumerable: false });
  return index;
}
