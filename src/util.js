// Shared helpers: upstream fetches, caching, and time formatting.

export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const USER_AGENT = 'trmnl-fantasy-football (+https://github.com/nguyenware/trmnl-fantasy-football)';

export async function fetchJson(url, { timeoutMs = 10000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new UpstreamError(`${new URL(url).host} unreachable: ${err.message}`);
  }
  if (!res.ok) throw new UpstreamError(`${new URL(url).host} returned ${res.status}`, res.status === 404 ? 404 : 502);
  return res.json();
}

// Caches a loader's (already trimmed) result. On Workers this uses the Cache
// API so a big upstream payload is parsed once per TTL rather than on every
// poll; elsewhere (tests, `npm run dev`) it falls back to an in-memory map.
// `ttl` may be a number of seconds or a function of the loaded value.
const memory = new Map();

export async function cached(key, ttl, loader) {
  const cacheUrl = `https://cache.internal/${encodeURIComponent(key)}`;
  const edge = globalThis.caches?.default;
  if (edge) {
    const hit = await edge.match(cacheUrl);
    if (hit) return hit.json();
  } else {
    const hit = memory.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
  }

  const value = await loader();
  const seconds = Math.max(1, Math.round(typeof ttl === 'function' ? ttl(value) : ttl));
  if (edge) {
    const body = JSON.stringify(value);
    await edge.put(cacheUrl, new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${seconds}` },
    }));
  } else {
    memory.set(key, { value, expires: Date.now() + seconds * 1000 });
  }
  return value;
}

export function clearMemoryCache() {
  memory.clear();
}

// ---- Time formatting ------------------------------------------------------

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

function parts(date, tz, options) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options }).format(date);
}

export const formatTime = (date, tz) => parts(date, tz, { hour: 'numeric', minute: '2-digit' });
export const formatWeekday = (date, tz) => parts(date, tz, { weekday: 'short' });
export const formatDate = (date, tz) => parts(date, tz, { month: 'short', day: 'numeric' });
export const formatShortDate = (date, tz) => parts(date, tz, { month: 'numeric', day: 'numeric' });

// Calendar-day difference between two instants in the given time zone.
export function dayDiff(from, to, tz) {
  const key = (d) => parts(d, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const [a, b] = [key(from), key(to)].map((s) => {
    const [m, d, y] = s.split('/').map(Number);
    return Date.UTC(y, m - 1, d);
  });
  return Math.round((b - a) / DAY);
}

// "Today 7:10 PM", "Tomorrow 1:05 PM", "Sun 10:00 AM", "Oct 12 5:00 PM"
export function whenLabel(date, now, tz, { timeTbd = false } = {}) {
  const diff = dayDiff(now, date, tz);
  const time = timeTbd ? 'TBD' : formatTime(date, tz);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff > 1 && diff < 7) return `${formatWeekday(date, tz)} ${time}`;
  return `${formatDate(date, tz)} ${time}`;
}

// "2d 14h", "3h 20m", "45m", "now"
export function countdown(ms) {
  if (ms <= 0) return 'now';
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

// "12m ago", "3h ago", "2d ago"
export function age(date, now) {
  const ms = now - date;
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m ago`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h ago`;
  return `${Math.round(ms / DAY)}d ago`;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

export function isoDate(date, tz) {
  const [m, d, y] = parts(date, tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/');
  return `${y}-${m}-${d}`;
}

export const addDays = (date, n) => new Date(date.getTime() + n * DAY);

// Last-N form string, newest last: "WWLWL"
export const formString = (results, n = 5) => results.slice(-n).join('');

// Up to `n` rows that always include ours: the top of the table, or a window
// around us when we are further down.
export function standingsWindow(rows, n = 8) {
  if (rows.length <= n) return rows;
  const i = rows.findIndex((r) => r.is_us);
  if (i < n) return rows.slice(0, n);
  const start = Math.min(rows.length - n, Math.max(0, i - Math.floor(n / 2)));
  return rows.slice(start, start + n);
}

// Short label for an upcoming game in a schedule strip: "Tmrw 7:10 PM",
// "Sun 10:00 AM" within a week, otherwise just the date.
export function stripWhen(date, now, tz, timeTbd) {
  const diff = dayDiff(new Date(now), date, tz);
  if (diff > 6) return formatShortDate(date, tz);
  return whenLabel(date, now, tz, { timeTbd }).replace(/^Today /, '').replace(/^Tomorrow /, 'Tmrw ');
}
