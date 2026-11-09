// Manual snapshot run (the Worker's cron normally does this; see src/snapshot.js).
//
//   node scripts/snapshot.mjs                 # writes snapshot.json
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… KV_NAMESPACE_ID=… node scripts/snapshot.mjs
//
// Sleeper asks that the full player list be fetched at most once a day.
import { writeFileSync } from 'node:fs';
import { buildSnapshot } from '../src/snapshot.js';
import { SNAPSHOT_KEY as KEY } from '../src/players.js';

const snapshot = await buildSnapshot();
const body = JSON.stringify(snapshot);
writeFileSync('snapshot.json', body);
console.log(`snapshot: ${Object.keys(snapshot.players).length} players, ${Object.keys(snapshot.proj).length} projections, ${(body.length / 1024).toFixed(0)} KB, week ${snapshot.week}`);

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
