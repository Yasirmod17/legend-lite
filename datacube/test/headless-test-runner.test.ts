// The headless lane's node:test stand-in (test/headless/node-test.ts) held to node:test's rules, where DataCube's tests
// rely on them: which tests run, which pass, fail or are skipped, and in what order the hooks run around them. A suite
// registered on the stand-in here (it is a module like any other in Node), run, and its results and order checked
// against what node:test does with the same suite (node 22, run by hand: the same tests pass, fail and are skipped, in
// this order; node:test reports a skipped suite once where the stand-in reports each of its tests skipped).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as T from './headless/node-test.ts';

const order: string[] = [];
const push = (s: string) => (): void => { order.push(s); };

T.before(push('root before'));
T.after(push('root after'));
T.describe('hooks', () => {
  T.before(push('hooks before'));
  T.after(push('hooks after'));
  T.beforeEach(push('outer beforeEach'));
  T.afterEach(push('outer afterEach'));
  T.it('passes', push('passes'));
  T.it('fails', () => { order.push('fails'); throw new Error('no'); });
  T.it.skip('skipped', push('never: skipped'));
  T.it('no function');
  T.describe('nested', () => {
    T.beforeEach(push('inner beforeEach'));
    T.afterEach(push('inner afterEach'));
    T.it('inner', push('inner'));
  });
});
T.describe('async', async () => {
  await Promise.resolve();
  T.it('registered after an await', push('late'));
});
T.describe('a before that fails', () => {
  T.before(() => { throw new Error('setup'); });
  T.it('x', push('never: x'));
  T.it('y', push('never: y'));
});
T.describe('an afterEach that fails', () => {
  T.afterEach(() => { throw new Error('teardown'); });
  T.it('z', push('z'));
});
T.describe.skip('a skipped suite', () => {
  T.it('w', push('never: w'));
});
T.it('a done callback', (_t, done) => { setTimeout(() => done?.(), 1); });
T.it('a done callback given an error', (_t, done) => { done?.(new Error('callback')); });
T.it('a rejection', async () => { throw new TypeError('async'); });
T.it('t.skip()', (t) => t.skip());
T.it('options: skip', { skip: true }, push('never: options skip'));
T.it('t.diagnostic and t.name', (t) => { t.diagnostic('noted'); order.push(`name ${t.name}`); });

describe('the stand-in runs a suite as node:test runs it', () => {
  it('reports each test as node:test would, and runs the hooks in its order', async () => {
    const results = await T.run();
    assert.deepEqual(results.map((r) => [r.name, r.status]), [
      ['hooks > passes', 'pass'],
      ['hooks > fails', 'fail'],
      ['hooks > skipped', 'skip'],
      ['hooks > no function', 'pass'],
      ['hooks > nested > inner', 'pass'],
      ['async > registered after an await', 'pass'],
      ['a before that fails > x', 'fail'],
      ['a before that fails > y', 'fail'],
      ['an afterEach that fails > z', 'fail'],
      ['a skipped suite > w', 'skip'],
      ['a done callback', 'pass'],
      ['a done callback given an error', 'fail'],
      ['a rejection', 'fail'],
      ['t.skip()', 'skip'],
      ['options: skip', 'skip'],
      ['t.diagnostic and t.name', 'pass'],
    ]);
    assert.match(results.find((r) => r.name === 'a rejection')!.error!, /^TypeError: async/);
    assert.match(results.find((r) => r.name === 'an afterEach that fails > z')!.error!, /teardown/);
    assert.deepEqual(order, [
      'root before',
      'hooks before',
      // beforeEach outer to inner, afterEach inner to outer; afterEach after a failing test too
      'outer beforeEach', 'passes', 'outer afterEach',
      'outer beforeEach', 'fails', 'outer afterEach',
      'outer beforeEach', 'outer afterEach',
      'outer beforeEach', 'inner beforeEach', 'inner', 'inner afterEach', 'outer afterEach',
      'hooks after',
      'late',
      'z',
      'name t.diagnostic and t.name',
      'root after',
    ]);
  });

  it("runs mock timers as node:test's own do", (t) => {
    // one scenario through Node's t.mock.timers and through the stand-in's: the same timers fire, in the same order
    const scenario = (timers: { enable(o?: { apis?: string[] }): void; tick(ms?: number): void }): string[] => {
      const order: string[] = [];
      timers.enable({ apis: ['setTimeout', 'setInterval'] });
      setTimeout(() => order.push('t10'), 10);
      setTimeout(() => order.push('t0'), 0);
      const cleared = setTimeout(() => order.push('cleared'), 5);
      clearTimeout(cleared);
      setTimeout(() => { order.push('t5'); setTimeout(() => order.push('t5+3'), 3); }, 5);
      let runs = 0;
      const every = setInterval(() => { runs += 1; order.push(`i7#${runs}`); }, 7);
      // cleared by another timer: Node's mock runs an interval cleared inside its own callback again (node-test.ts)
      setTimeout(() => clearInterval(every), 22);
      timers.tick(0); order.push('|0');
      timers.tick(9); order.push('|9');
      timers.tick(30); order.push('|39');
      return order;
    };
    const theirs = scenario(t.mock.timers as never);
    t.mock.timers.reset();
    const standIn = new T.TestContext('x');
    const ours = scenario(standIn.mock.timers);
    standIn.resetMocks();
    assert.deepEqual(ours, theirs);
    assert.throws(() => new T.TestContext('y').mock.timers.enable({ apis: ['Date'] }), /mock\.timers for Date is not in the headless lane's stand-in/);
  });

  it('refuses what it does not stand in for, by name', () => {
    assert.throws(() => T.it.only(), /\.only is not run by the headless lane/);
    assert.throws(() => (T.mock as unknown as { timers: unknown }).timers, /mock\.timers is not in the headless lane's stand-in/);
    assert.throws(() => (new T.TestContext('t').mock as unknown as { fn: unknown }).fn, /t\.mock\.fn is not in the headless lane's stand-in/);
    assert.throws(() => new T.TestContext('t').test(), /subtests/);
    assert.throws(() => T.it('x', { plan: 1 } as never, () => undefined), /option 'plan' is not in the headless lane's stand-in/);
  });
});
