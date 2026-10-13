// INTO A PROJECT, held alike in both languages (docs/ONE_PLATFORM_PROGRAM_2026_10_12.md B4): each case of test/cases --
// every call one create makes, to the SDLC and to the writer, its exact body and the answer it was given, recorded by
// Python's twin against the native library (python/tests/test_model.py) -- replayed here: this library makes the same
// calls, in order, with the same bodies, byte for byte, and answers the same.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { readLambda } from '../../pure-protocol/src/index.ts';
import { SdlcClient } from '../../sdlc-client/src/client.ts';
import { runfilesFromEnv } from '../../tools/js/runfiles.mts';
import {
  createAssociation, createClass, createDataSpace, writerBodies, type ClassAction, type Created, type ModelAnswer,
  type ModelWriter, type NewProject,
} from '../src/index.ts';

type Call =
  | { readonly to: 'sdlc'; readonly method: string; readonly path: string; readonly body: string | null;
      readonly status: number; readonly answer: string }
  | { readonly to: 'writer'; readonly route: string; readonly body: string; readonly answer: string };

interface Case {
  readonly name: string;
  readonly function: 'createClass' | 'createAssociation' | 'createDataSpace';
  readonly project: string | NewProject;
  readonly workspace: string;
  readonly package: string;
  readonly class?: ClassAction;
  readonly classes?: readonly ClassAction[];
  readonly association?: Parameters<typeof createAssociation>[0]['association'];
  readonly associations?: Parameters<typeof createDataSpace>[0]['associations'];
  readonly dataSpace?: Parameters<typeof createDataSpace>[0]['dataSpace'];
  readonly calls: readonly Call[];
  readonly result: { readonly project: string; readonly workspace: string; readonly revision: string };
}

/** A class action as the case holds it: its relation read as the protocol's lambda. */
const action = (c: ClassAction): ClassAction => ({ ...c, query: readLambda(c.query) });

/** The case's calls, answered in order: each one checked against the next, its answer the recorded one. */
function replay(calls: readonly Call[]): { sdlc: SdlcClient; writer: ModelWriter; done: () => void } {
  let next = 0;
  const expected = (to: Call['to']): Call => {
    const call = calls[next];
    assert.ok(call, `a call more than the case has: the ${to}`);
    next += 1;
    assert.equal(call.to, to, `call ${next}: the case has a call to the ${call.to}`);
    return call;
  };
  const fetcher = (async (url: string, init?: RequestInit) => {
    const call = expected('sdlc');
    if (call.to !== 'sdlc') throw new Error('unreachable');
    const body = init?.body === undefined ? null : String(init.body);
    assert.deepEqual({ method: init?.method, path: url, body }, { method: call.method, path: call.path, body: call.body },
      `call ${next}`);
    return new Response(call.answer === '' ? null : call.answer, { status: call.status });
  }) as typeof fetch;
  const write = (route: string, body: string): ModelAnswer => {
    const call = expected('writer');
    if (call.to !== 'writer') throw new Error('unreachable');
    assert.equal(route, call.route, `call ${next}`);
    assert.equal(body, call.body, `call ${next}: the ${route} body, byte for byte`);
    return JSON.parse(call.answer) as ModelAnswer;
  };
  const writer: ModelWriter = {
    createClass: async (project, pkg, cls) => write('createClass', writerBodies.createClass(project, pkg, cls)),
    createAssociation: async (project, pkg, association, classes) =>
      write('createAssociation', writerBodies.createAssociation(project, pkg, association, classes)),
    createDataSpace: async (project, pkg, dataSpace, classes, associations) =>
      write('createDataSpace', writerBodies.createDataSpace(project, pkg, dataSpace, classes, associations)),
  };
  return { sdlc: new SdlcClient('', fetcher), writer, done: () => assert.equal(next, calls.length, 'every call of the case made') };
}

function run(c: Case, sdlc: SdlcClient, writer: ModelWriter): Promise<Created> {
  const into = { sdlc, writer, project: c.project, workspace: c.workspace, package: c.package };
  switch (c.function) {
    case 'createClass':
      return createClass({ ...into, class: action(c.class!) });
    case 'createAssociation':
      return createAssociation({ ...into, association: c.association!, ...(c.classes ? { classes: c.classes.map(action) } : {}) });
    case 'createDataSpace':
      return createDataSpace({
        ...into, dataSpace: c.dataSpace!, ...(c.classes ? { classes: c.classes.map(action) } : {}),
        ...(c.associations ? { associations: c.associations } : {}),
      });
  }
}

const CASES = runfilesFromEnv('MODEL_CHANGES_CASES').map((f) => JSON.parse(readFileSync(f, 'utf8')) as Case);

describe("into a project: the cases Python's twin recorded", () => {
  it('there are cases', () => assert.ok(CASES.length >= 4));
  for (const c of CASES) {
    it(c.name, async () => {
      const { sdlc, writer, done } = replay(c.calls);
      const made = await run(c, sdlc, writer);
      done();
      assert.deepEqual({ project: made.project, workspace: made.workspace, revision: made.revision }, c.result);
    });
  }
});
