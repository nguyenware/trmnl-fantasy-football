// Builds the compact player snapshot the Worker reads from KV (see
// src/players.js) and, when Cloudflare credentials are set, uploads it.
//
//   node scripts/snapshot.mjs                 # writes snapshot.json
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… KV_NAMESPACE_ID=… node scripts/snapshot.mjs
//
// Runs daily from .github/workflows/snapshot.yml. Sleeper asks that the full
// player list be fetched at most once a day.
import { writeFileSync } from 'node:fs';

const SLEEPER = 'https://api.sleeper.app/v1';
const PROJECTIONS = 'https://api.sleeper.com/projections/nfl';
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];
const KEY = 'sleeper:snapshot:v1';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'trmnl-fantasy-football snapshot' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

const state = await getJson(`${SLEEPER}/state/nfl`);
const season = state.season;
const week = state.display_week || state.week || 1;
const seasonType = state.season_type === 'post' ? 'post' : 'regular';

const all = await getJson(`${SLEEPER}/players/nfl`);
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
for (const row of await getJson(`${PROJECTIONS}/${season}/${week}?season_type=${seasonType}&${query}`)) {
  const s = row.stats ?? {};
  if (s.pts_ppr == null && s.pts_std == null) continue;
  proj[row.player_id] = [r1(s.pts_std ?? 0), r1(s.pts_half_ppr ?? s.pts_std ?? 0), r1(s.pts_ppr ?? 0)];
}

const snapshot = { season: Number(season), week, season_type: seasonType, updated: new Date().toISOString(), players, proj };
const body = JSON.stringify(snapshot);
writeFileSync('snapshot.json', body);
console.log(`snapshot: ${Object.keys(players).length} players, ${Object.keys(proj).length} projections, ${(body.length / 1024).toFixed(0)} KB, week ${week}`);

const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, KV_NAMESPACE_ID: namespace } = process.env;
if (token && account && namespace) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(KEY)}`;
  const res = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.success === false) {
    console.error('KV upload failed', res.status, JSON.stringify(out.errors ?? out));
    process.exit(1);
  }
  console.log(`uploaded to KV ${namespace} as ${KEY}`);
} else {
  console.log('Cloudflare credentials not set; skipped the KV upload');
}
