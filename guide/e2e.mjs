// Runs GUIDE.md end to end in headless Chromium and retakes its screenshots.
//   npm i playwright && npx playwright install chromium
//   node guide/e2e.mjs                 every step; exit 0 only if the observer badge shows on survev.io
//   node guide/e2e.mjs --skip-toggle   control: leaves Allow User Scripts off; must FAIL (script installed, never runs)
//   node guide/e2e.mjs --show          with a window (CHROME=/path/to/chromium to use another build)
// It stops at the survev.io menu and never joins a match, so the observer uploads nothing.
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo'; // Tampermonkey in the Chrome Web Store
const RAW = 'https://raw.githubusercontent.com/17nbist/survev-observer/main/survev-observer.user.js';
const IMG = new URL('img/', import.meta.url).pathname;
const SKIP = process.argv.includes('--skip-toggle');
mkdirSync(IMG, { recursive: true });

const step = (n, msg) => console.log(`[${n}] ${msg}`);
const fail = msg => { console.error('FAIL: ' + msg); process.exitCode = 1; };
const shot = (page, name, clip) => SKIP ? null : page.screenshot({ path: join(IMG, name + '.png'), clip });

// Step 1 of the guide is "install Tampermonkey from the Web Store": the same package, fetched and unpacked.
const work = mkdtempSync(join(tmpdir(), 'obs-guide-'));
const ext = join(work, 'tampermonkey');
const crx = Buffer.from(await (await fetch(`https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140.0&acceptformat=crx2,crx3&x=id%3D${TM_ID}%26uc`)).arrayBuffer());
writeFileSync(join(work, 'tm.zip'), crx.subarray(crx.indexOf(Buffer.from('PK\x03\x04'))));
execFileSync('unzip', ['-qo', join(work, 'tm.zip'), '-d', ext]);
if (!existsSync(join(ext, 'manifest.json'))) throw new Error('Tampermonkey download did not unpack');
step(1, 'Tampermonkey ' + JSON.parse(readFileSync(join(ext, 'manifest.json'))).version + ' from the Web Store');

// channel 'chromium' = the full browser in new headless mode, which runs extensions (the headless shell does not).
const ctx = await chromium.launchPersistentContext(join(work, 'profile'), {
  executablePath: process.env.CHROME || undefined, // optional: a Chromium of your own
  channel: 'chromium', headless: !process.argv.includes('--show'),
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const id = new URL(sw.url()).host; // an unpacked copy gets its own id, not TM_ID
  await new Promise(r => setTimeout(r, 2000)); // Tampermonkey opens a welcome tab on first run
  const page = ctx.pages()[0] || await ctx.newPage();
  for (const p of ctx.pages()) if (p !== page) await p.close();

  // Step 2: Allow User Scripts.
  if (SKIP) step(2, 'Allow User Scripts left off on purpose');
  else {
    await page.goto('chrome://extensions/?id=' + id);
    const row = page.locator('extensions-toggle-row:has-text("Allow User Scripts")').first();
    await row.waitFor({ timeout: 10000 });
    await row.scrollIntoViewIfNeeded();
    const b = await row.boundingBox();
    const clip = { x: b.x - 20, y: b.y - 120, width: b.width + 40, height: b.height + 140 };
    await shot(page, '2-off', clip);
    await row.click();
    await page.waitForTimeout(500);
    const on = await row.evaluate(e => e.checked === true || e.shadowRoot?.querySelector('cr-toggle')?.checked === true);
    step(2, 'Allow User Scripts ' + (on ? 'on' : 'STILL OFF'));
    if (!on) fail('the Allow User Scripts toggle did not switch on');
    await shot(page, '2-on', clip);
  }

  // Step 3: the raw link opens Tampermonkey's install page; press Install.
  const opened = ctx.waitForEvent('page', { predicate: p => p.url().startsWith(`chrome-extension://${id}/`), timeout: 20000 }).catch(() => null);
  await page.goto(RAW).catch(() => {});
  const ask = await opened || (page.url().startsWith(`chrome-extension://${id}/`) ? page : null);
  if (!ask) throw new Error('Tampermonkey did not open its install page for the raw link (tab is at ' + page.url() + ')');
  const btn = ask.locator('input[value="Install"], button:has-text("Install")').first();
  await btn.waitFor({ timeout: 15000 });
  const ver = (await ask.content()).match(/@version\s+([\d.]+)/)?.[1];
  if (!ver) fail('the install page does not show the script');
  step(3, 'install page shows survev observer v' + ver);
  await shot(ask, '3-install', { x: 0, y: 0, width: 1280, height: 340 });
  await btn.click();
  await ask.waitForEvent('close', { timeout: 10000 }).catch(() => {});

  // Step 4: survev.io shows the observer badge in the bottom left corner.
  const game = await ctx.newPage();
  for (const p of ctx.pages()) if (p !== game) await p.close().catch(() => {});
  await game.goto('https://survev.io/', { waitUntil: 'domcontentloaded' });
  const badge = game.getByText(/^observer (on|paused)/i).first();
  try { await badge.waitFor({ timeout: 30000 }); step(4, 'badge on survev.io: "' + (await badge.innerText()).trim() + '"'); }
  catch { fail('no observer badge on survev.io'); }
  await game.waitForTimeout(3000);
  await shot(game, '4-menu');
  await shot(game, '4-badge', { x: 0, y: 640, width: 420, height: 160 });
} catch (e) { fail(e.message); }
finally { await ctx.close(); }
if (SKIP) { console.log(process.exitCode ? 'CONTROL OK: without Allow User Scripts the observer does not run' : 'CONTROL WRONG: the observer ran without Allow User Scripts'); process.exitCode = process.exitCode ? 0 : 1; }
else console.log(process.exitCode ? 'GUIDE FAILED' : 'GUIDE PASSED');
