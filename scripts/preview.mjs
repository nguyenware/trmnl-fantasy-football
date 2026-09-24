// Renders the TRMNL templates locally with the real TRMNL Framework CSS, so
// layouts can be checked without pasting them into trmnl.com.
//
//   node scripts/preview.mjs <payload.json | http://localhost:8787/sleeper?...>
//   node scripts/preview.mjs --templates=trmnl/sunday <payload...>
//   node scripts/preview.mjs --screenshot <payload...>   # PNGs too (needs playwright)
//
// Output goes to preview/<name>-<layout>.html (and .png).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Liquid } from 'liquidjs';

const FRAMEWORK = 'https://trmnl.com';
const VERSION = '3.3.2';
const LAYOUTS = {
  full: { size: [800, 480], wrap: (m) => `<div class="view view--full">${m}</div>` },
  half_horizontal: {
    size: [800, 480],
    wrap: (m) => `<div class="mashup mashup--1Tx1B"><div class="view view--half_horizontal">${m}</div><div class="view view--half_horizontal"></div></div>`,
  },
  half_vertical: {
    size: [800, 480],
    wrap: (m) => `<div class="mashup mashup--1Lx1R"><div class="view view--half_vertical">${m}</div><div class="view view--half_vertical"></div></div>`,
  },
  quadrant: {
    size: [800, 480],
    wrap: (m) => `<div class="mashup mashup--2x2"><div class="view view--quadrant">${m}</div><div class="view view--quadrant"></div><div class="view view--quadrant"></div><div class="view view--quadrant"></div></div>`,
  },
};

const page = (body) => `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${FRAMEWORK}/css/${VERSION}/plugins.min.css">
<script src="${FRAMEWORK}/js/${VERSION}/plugins.min.js"></script>
<style>body{margin:0}</style>
</head><body class="environment trmnl"><div class="screen screen--og screen--1bit">${body}</div></body></html>`;

const args = process.argv.slice(2);
const screenshot = args.includes('--screenshot');
const inputs = args.filter((a) => !a.startsWith('--'));
const templates = (args.find((a) => a.startsWith('--templates='))?.split('=')[1] ?? 'trmnl/matchup').replace(/\/?$/, '/');
if (!inputs.length) {
  console.error('usage: node scripts/preview.mjs [--screenshot] <payload.json | url> ...');
  process.exit(1);
}

const root = new URL('..', import.meta.url);
const liquid = new Liquid();
const outDir = new URL('preview/', root);
mkdirSync(outDir, { recursive: true });

const written = [];
for (const input of inputs) {
  const data = /^https?:/.test(input) ? await (await fetch(input)).json() : JSON.parse(readFileSync(input, 'utf8'));
  const name = (input.split('/').pop() || 'payload').replace(/\.json$/, '').replace(/[^a-z0-9-]+/gi, '-').slice(0, 40);
  for (const [layout, { wrap, size }] of Object.entries(LAYOUTS)) {
    const markup = await liquid.parseAndRender(readFileSync(new URL(`${templates}${layout}.liquid`, root), 'utf8'), data);
    const file = new URL(`${name}-${templates.split('/').at(-2)}-${layout}.html`, outDir);
    writeFileSync(file, page(wrap(markup)));
    written.push({ file, size });
  }
}
console.log(written.map((w) => w.file.pathname).join('\n'));

if (screenshot) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 800, height: 480 } });
  // Fetch remote assets (framework CSS, fonts, logos) through Node so they
  // follow the same proxy/CA settings as the rest of the tooling.
  await ctx.route(/^https?:/, async (route) => {
    try {
      const res = await fetch(route.request().url());
      const headers = Object.fromEntries([...res.headers].filter(([k]) => !['content-encoding', 'content-length'].includes(k)));
      route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    } catch {
      route.abort();
    }
  });
  const tab = await ctx.newPage();
  for (const { file } of written) {
    await tab.goto(file.href, { waitUntil: 'networkidle' });
    await tab.screenshot({ path: file.pathname.replace(/\.html$/, '.png') });
  }
  await browser.close();
}
