// CREATE A CLASS… as a person does it (docs/DATACUBE_MODEL_DESIGN_2026_10_10.md §15.7, the browser): a CSV opened,
// its grid's rows made a class -- a column a key only, one left out -- written to the page's project in the page's own
// SDLC; then a second CSV's grid made a second class of the same project, whose window shows the first one's store and
// model mapping as CHANGED: what the first class wrote was saved and is read back. The files are the route's
// (legend-lite's promoteRelationToModel in this tab's module), shown in the window as they will be written.
//
//   bazel test //datacube:verify_class_test        bazel run //datacube:verify_class (by hand)

// first: points Playwright at the Chromium Bazel fetched (as a browser_test; a no-op under bazel run)
import '../../tools/browser/pinned-chromium.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serve, siteRoot, tmpDir } from './harness.mjs';

let failed = false;
function bad(m) { console.log(`FAIL: ${m}`); failed = true; }
function check(ok, m) { if (ok) console.log(`ok: ${m}`); else bad(m); }

// the two sources, written here: their rows are known
const dir = await tmpDir('dc-class-');
const trades = join(dir, 'trades.csv');
const customers = join(dir, 'customers.csv');
await writeFile(trades, ['trade_id,customer_id,region,notional',
  ...Array.from({ length: 40 }, (_, i) => `${i + 1},${i % 7 === 0 ? '' : (i % 5) + 1},${['EMEA', 'AMER', 'APAC'][i % 3]},${(i + 1) * 100}.25`)].join('\n') + '\n');
await writeFile(customers, ['customer_id,name',
  ...Array.from({ length: 5 }, (_, i) => `${i + 1},"Customer, ${i + 1}"`)].join('\n') + '\n');

const { port, close } = await serve(siteRoot());
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('dialog', async (d) => { errors.push(`alert: ${d.message()}`); await d.dismiss(); });

const item = (label) => page.locator('.dc-menu .dc-menu-item', { has: page.locator(`:scope > .dc-menu-label:text-is(${JSON.stringify(label)})`) }).first();
/** A file opened through the source picker, as a person does: its grid's tile is the `n`th. */
async function openFile(path, n) {
  await page.locator('.dc-picker .dc-picker-drop').waitFor({ state: 'visible', timeout: 10_000 });
  await page.setInputFiles('.dc-picker-file', path);
  await page.waitForFunction(() => !document.querySelector('.dc-picker') || document.querySelector('.dc-picker-status.dc-failed'),
    undefined, { timeout: 120_000 });
  await page.waitForFunction((k) => document.querySelectorAll('.dc-tile-menu').length >= k, n, { timeout: 60_000 });
}
/** The grid's own Create a Class…, its window's files listed. */
async function createClassWindow(n) {
  await page.locator('.dc-tile-menu').nth(n - 1).click();
  await item('Create a Class…').click();
  await page.waitForFunction(() => document.querySelectorAll('.dc-class-file').length > 0
    || document.querySelector('.dc-class .dc-picker-status.dc-failed'), undefined, { timeout: 60_000 });
}
const files = () => page.$$eval('.dc-class-file-line', (ls) => ls.map((l) => l.textContent));
const pure = (path) => page.$$eval('.dc-class-file', (ls, p) => ls.find((l) => l.querySelector('.dc-class-path')?.textContent === p)
  ?.querySelector('.dc-class-pure')?.textContent ?? '', path);

try {
  await page.goto(`http://127.0.0.1:${port}/demo/index.html`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => document.querySelectorAll('.dc-row').length > 0, undefined, { timeout: 120_000 });
  // a blank page, then the first source
  await page.click('.dc-titlebar-menu');
  await item('New').hover();
  await item('Blank Page').click();
  await page.locator('.dc-blank').waitFor({ timeout: 10_000 });
  await page.click('.dc-blank .dc-primary');
  await openFile(trades, 1);

  // THE FIRST CLASS: the names suggested, every file new
  await createClassWindow(1);
  const names = await page.$$eval('.dc-class-names input', (is) => is.map((i) => i.value));
  check(JSON.stringify(names) === JSON.stringify(['Trade', 'trades', 'trades']), `the class, package and project suggested (${names})`);
  check((await page.locator('.dc-class-table tbody tr').count()) === 4, 'a row per column');
  // customer_id a key only, region left out: the window asks the route again
  const rows = page.locator('.dc-class-table tbody tr');
  await rows.nth(1).locator('select').selectOption('key');
  await rows.nth(2).locator('select').selectOption('omit');
  await page.waitForFunction(() => [...document.querySelectorAll('.dc-class-pure')].some((p) => p.textContent.includes('+customerId: Integer[0..1]: customer_id'))
    && ![...document.querySelectorAll('.dc-class-pure')].some((p) => p.textContent.includes('region: region')), undefined, { timeout: 30_000 });
  const first = await files();
  // the sample named after the source's table in this tab: `trades`, or `trades_2` beside the demo's own
  check(JSON.stringify(first.slice(0, 7)) === JSON.stringify(['newtrades::store::Browser', 'newtrades::connection::Browser',
    'newtrades::runtime::Browser', 'newtrades::function::TradeFn', 'newtrades::domain::Trade',
    'newtrades::mapping::TradeMapping', 'newtrades::mapping::Model']) && first.length === 8
    && /^newtrades::data::Trades(2)?Sample$/.test(first[7] ?? ''), `the files it writes, all new: ${first.join(', ')}`);
  const cls = await pure('trades::domain::Trade');
  check(cls.includes('tradeId: Integer[0..1];') && cls.includes('notional: Float[0..1];') && !cls.includes('customerId')
    && !cls.includes('region'), `the class: a key only and a column left out are not on it\n${cls}`);
  await page.locator('.dc-class .dc-primary').click();
  await page.waitForFunction(() => document.querySelector('.dc-class .dc-picker-status.dc-ok, .dc-class .dc-picker-status.dc-failed'),
    undefined, { timeout: 60_000 });
  const said = await page.locator('.dc-class .dc-picker-status').textContent();
  check(/Created trades::domain::Trade in the project datacube:trades \(workspace datacube\)/.test(said), `created: ${said}`);
  check(/#\/edit\/datacube%3Atrades\/datacube$/.test(await page.locator('.dc-class-studio').getAttribute('href') ?? ''),
    'the way to Studio: its editor on the workspace');
  await page.locator('.dc-class .dc-primary').click();
  await page.locator('.dc-class').waitFor({ state: 'detached', timeout: 10_000 });

  // THE SECOND CLASS, from a second grid: the page's project, read back -- its store and model mapping CHANGED
  await page.click('.dc-titlebar-menu');
  await item('New').hover();
  await item('Data Source…').click();
  await openFile(customers, 2);
  await createClassWindow(2);
  const subtitle = await page.locator('.dc-class .dc-picker-subtitle').textContent();
  check(subtitle.includes("in the page's project, datacube:trades"), `the page's project, not a new one: ${subtitle}`);
  check(await page.locator('.dc-class-package input').isDisabled(), "the page's package, kept");
  const second = await files();
  check(JSON.stringify(second) === JSON.stringify(['changedtrades::store::Browser', 'newtrades::function::CustomerFn',
    'newtrades::domain::Customer', 'newtrades::mapping::CustomerMapping', 'changedtrades::mapping::Model',
    'newtrades::data::CustomersSample']), `the first class's files read back, two changed: ${second.join(', ')}`);
  const store = await pure('trades::store::Browser');
  check(/Table trades\w*/.test(store) && /Table customers\w*/.test(store), `one store, a table per source\n${store}`);
  const sample = await pure('trades::data::CustomersSample');
  check(sample.includes('\'1,"Customer, 1"\\n\''), `the sample's CSV, a comma in a value quoted\n${sample}`);
  await page.locator('.dc-class .dc-primary').click();
  await page.waitForFunction(() => document.querySelector('.dc-class .dc-picker-status.dc-ok, .dc-class .dc-picker-status.dc-failed'),
    undefined, { timeout: 60_000 });
  check(/Created trades::domain::Customer/.test(await page.locator('.dc-class .dc-picker-status').textContent()), 'the second class created');
  check(errors.length === 0, `no page errors or alerts${errors.length ? `: ${errors.join('; ')}` : ''}`);
} catch (e) {
  bad(`${e instanceof Error ? e.message : String(e)}${errors.length ? `\n  page: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
  await close();
}

console.log(failed ? 'verify-class: FAILED' : 'verify-class: ok');
process.exit(failed ? 1 : 0);
