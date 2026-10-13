// E's measured walk (docs/ONE_PLATFORM_PROGRAM_2026_10_12.md, E's Built note): Legend Studio and Legend Query served by
// Python from the installed wheel, in one browser (one cookie), on a fresh LEGEND_LITE_HOME:
//   1. Studio: "Load demo projects" writes the demo's four projects into Python's repository and publishes each;
//   2. Studio: a published project viewed read-only and compiled (F9);
//   3. Query: the landing lists the Depot's projects; one opened at HEAD; a class's query built (two columns) and run.
//
// Run, after `bazel build //python:wheel` and installing it into a virtual environment, with Python serving:
//   LEGEND_LITE_HOME=<empty folder> <venv>/bin/python -c "import json, time, legend_lite as ll; \
//     print(json.dumps({'query': ll.query(browser=False), 'studio': ll.studio(browser=False)}), flush=True); time.sleep(1e6)"
// then, with Bazel's node (22.16) and DataCube's Playwright:
//   node docs/one-platform/evidence/e-apps-on-python.mjs '<the printed JSON>' "$PWD/bazel-bin/datacube/node_modules/"
// Measured 2026-10-13 (Apple silicon laptop): all seven steps ok -- the demo published in 360 ms, the Depot's four
// projects listed -- with no page error and no failed call, but the last run's
// execute, refused 500 as PARK-35 says ("a project's queries run only in a browser tab for now").
import { createRequire } from 'node:module';
const links = JSON.parse(process.argv[2]);
const { chromium } = createRequire(process.argv[3])('playwright');
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [], failed = [];
page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
const text = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
const step = (name, ok, detail) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);

await page.goto(links.studio);
step('the link traded for the cookie', !page.url().includes('token='), page.url());
const t0 = Date.now();
await page.getByText('Load demo projects').click();
await page.getByText('Demo projects published.').waitFor({ timeout: 180_000 });
step('Studio: demo projects published', true, `${Date.now() - t0} ms`);
const studio = links.studio.replace(/\?.*/, '');
await page.goto(`${studio}#/view/${encodeURIComponent('org.finos.lite.demo:party')}`);
await page.getByText('PartyMapping', { exact: true }).first().click();
await page.keyboard.press('F9');
await page.waitForTimeout(5000);
step('Studio: a published project compiled', /HEAD \(read only\) 0 0/.test(await text()));

const query = links.query.replace(/\?.*/, '');
await page.goto(`${query}#/setup`);
await page.getByText('Projects in Depot').waitFor({ timeout: 60_000 });
const listed = (await page.locator('button[data-project]').evaluateAll((bs) => bs.map((b) => b.dataset.project))).sort();
step('Query: the Depot\'s projects listed', listed.length === 4, listed.join(', '));
await page.locator('button[data-project="org.finos.lite.demo:trading"]').click();
await page.locator('.q-list-row', { hasText: 'PartyMapping' }).first().waitFor({ timeout: 60_000 });
step('Query: a project opened at HEAD', true);
await page.locator('.q-list-row', { hasText: 'PartyMapping' }).first().click();
await page.getByText('Run Query').waitFor({ timeout: 60_000 });
for (const p of ['Id', 'Name']) await page.locator(`text="${p}"`).first().dblclick();
const before = failed.length;
await page.getByRole('button', { name: 'Run Query' }).click();
await page.waitForTimeout(6000);
const refusal = /a project's queries run only in a browser tab/.test(await text());
step('Query: the run refused as PARK-35 says', refusal && failed.length === before + 1, failed.slice(before).join(', '));
step('no page error, and no failed call but the run', errors.length === 0 && failed.length === before + 1,
  JSON.stringify({ errors, failed }));
await browser.close();
