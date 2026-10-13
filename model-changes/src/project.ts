// A PROJECT TO WRITE MODELS INTO (docs/ONE_PLATFORM_PROGRAM_2026_10_12.md B4): any SDLC's -- the host's own model home
// (the page's SDLC, Python's), sdlc-server, a real legend-sdlc -- through the one SDLC client. Made, with its workspace,
// when it is not yet; read as one model text at one revision; a change saved over that revision as one, made again once
// over a newer one. Python's twin is python/legend_lite/model.py.

import { SdlcError, type SdlcClient } from '../../sdlc-client/src/client.ts';
import type { PureChange } from '../../sdlc-client/src/wire.ts';

/** A project to make: its name (its artifact id by the SDLC's rule, a taken one numbered), its group, its description. */
export interface NewProject {
  readonly name: string;
  readonly group: string;
  readonly description?: string;
}

/** Where to write: a project (`groupId:artifactId`) and a workspace in it. */
export interface Place {
  readonly project: string;
  readonly workspace: string;
}

/** A project's files as one model text: what the writer reads beside what it makes. */
export function projectText(files: readonly { readonly pureCode: string }[]): string {
  return files.map((f) => (f.pureCode.startsWith('###') ? f.pureCode : `###Pure\n${f.pureCode}`)).join('\n');
}

/** A name as an artifact id: lowercase words joined by hyphens, led by a letter (the SDLC's own rule). */
export function artifactIdOf(name: string): string {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== '');
  const id = words.join('-').replace(/^[^a-z]+/, '');
  return id === '' ? 'project' : id;
}

/** A project made: in its group, named after `made.name` -- a name another project of the group has already numbered
 *  (`trades-2`). */
export async function makeProject(sdlc: SdlcClient, made: NewProject): Promise<string> {
  const taken = new Set((await sdlc.projects()).map((p) => p.projectId));
  const base = artifactIdOf(made.name);
  let artifactId = base;
  for (let n = 2; taken.has(`${made.group}:${artifactId}`); n += 1) artifactId = `${base}-${n}`;
  const project = await sdlc.createProject({
    name: made.name.trim() === '' ? artifactId : made.name.trim(),
    description: made.description ?? '',
    groupId: made.group,
    artifactId,
  });
  return project.projectId;
}

/**
 * The workspace, there: made from the project line when it is not (a commit in Studio closes a workspace) -- another
 * ask having made it meanwhile (409) is its being there. A project that is not there is said, by name.
 */
export async function ensureWorkspace(sdlc: SdlcClient, at: Place): Promise<void> {
  try {
    await sdlc.workspace(at.project, at.workspace);
    return;
  } catch (e) {
    if (!(e instanceof SdlcError && e.status === 404)) throw e;
  }
  try {
    await sdlc.createWorkspace(at.project, at.workspace);
  } catch (e) {
    if (e instanceof SdlcError && e.status === 409) return;
    if (e instanceof SdlcError && e.status === 404) throw new ProjectGone(at.project);
    throw e;
  }
}

/** The workspace's files now as one model text, and the revision they are (the workspace made when it is not). */
export async function projectState(sdlc: SdlcClient, at: Place): Promise<{ readonly text: string; readonly revision: string }> {
  await ensureWorkspace(sdlc, at);
  const revision = (await sdlc.revision(at)).id;
  const files = await sdlc.pure({ ...at, revision });
  return { text: projectText(files), revision };
}

/**
 * MAKE AND SAVE, ONCE AGAIN WHEN STALE: `make` the changes against the project as it is, and save them over that
 * revision as one; refused as stale (the workspace moved since: Studio saved it), the project is read again and the
 * changes made again against it, once -- a second refusal is said, not retried. Answers what was made and the revision
 * it was saved as (none when it changed nothing).
 */
export async function saveFresh<T extends { readonly changes: readonly PureChange[] }>(
  sdlc: SdlcClient, at: Place, message: string, make: (project: string) => Promise<T>,
): Promise<{ readonly made: T; readonly revision: string }> {
  for (let attempt = 0; ; attempt += 1) {
    const state = await projectState(sdlc, at);
    const made = await make(state.text);
    if (made.changes.length === 0) return { made, revision: state.revision };
    try {
      const saved = await sdlc.performPureChanges(at.project, at.workspace,
        { message, changes: made.changes, revisionId: state.revision });
      return { made, revision: saved.id };
    } catch (e) {
      if (!(e instanceof SdlcError && e.status === 409) || attempt > 0) throw e;
    }
  }
}

/** A project the SDLC no longer has (another browser's page's, a cleared store): said by name. */
export class ProjectGone extends Error {
  readonly project: string;
  constructor(project: string) {
    super(`the project ${project} is not in this model home: it was made elsewhere, or its store was cleared`);
    this.name = 'ProjectGone';
    this.project = project;
  }
}
