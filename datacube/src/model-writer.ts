// THE MODEL'S WRITER, as DataCube asks it (docs/DATACUBE_MODEL_DESIGN_2026_10_10.md §15.6a): legend-lite's
// createClass, createAssociation and createDataSpace -- core's ModelChanges, each one call and atomic, asked of the tab's
// module through pure/v1's routing on every plane -- what DataCube sends and what it answers (the files, in the SDLC's
// own change shape), and the names DataCube offers before a person changes them.

import type { Lambda } from '../../pure-protocol/src/index.ts';
import type { PureChange } from '../../sdlc-client/src/wire.ts';

/** How a column of the relation is taken: a property of the class, a key only (a local property of the mapping, for an
 *  association to join on), or left out. */
export type ColumnRole = 'property' | 'key' | 'omit';

/** What a person changed about one column; a column not named is a property, named by upstream's rule. */
export interface ColumnChoice {
  readonly as?: ColumnRole;
  readonly name?: string;
  readonly documentation?: string;
}

/** The source's first rows, its table's columns in order, each value the database's own text (or null). */
export interface SampleRows {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
}

/** Where a grid's rows are read from now: its planner's model and the runtime its queries run on. */
export interface GridSource {
  readonly model: string;
  readonly runtime: string;
}

/** A class to make: a grid's rows at their finest level, over the grid's own source. */
export interface ClassAction {
  readonly query: Lambda;
  readonly source: GridSource;
  readonly name: string;
  readonly documentation?: string;
  readonly columns?: Readonly<Record<string, ColumnChoice>>;
  readonly where: {
    /** The Database the relation reads its tables from now (the grid's table model's). */
    readonly from: string;
    /** The place's name in the project: `Browser`, the tab's DuckDB. */
    readonly as: string;
    /** Each table new to the store, by name: its first rows, written as the class's sample. */
    readonly samples?: Readonly<Record<string, SampleRows>>;
  };
}

/**
 * One end of an association, in Pure's own shape: its class, what it is joined on (a property, or a key only), the
 * name the OTHER class reaches it by, how many of it one of the other has -- or the fact (`unique`) the route reads
 * that from.
 */
export interface AssociationEnd {
  readonly class: string;
  readonly on: string;
  readonly name?: string;
  readonly multiplicity?: string;
  readonly unique?: boolean;
}

export interface AssociationAction {
  readonly name?: string;
  readonly ends: readonly [AssociationEnd, AssociationEnd];
}

export interface DataSpaceAction {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** Its classes; every class of the package's domain when none. */
  readonly classes?: readonly string[];
}

/** One column as the class takes it, as the route named and typed it. */
export interface MadeProperty {
  readonly column: string;
  readonly as: ColumnRole;
  readonly property?: string;
  readonly type?: string;
  readonly multiplicity?: string;
}

export interface MadeClass {
  readonly class: string;
  readonly mapping: string;
  readonly runtime: string;
  /** The class read back as the relation's columns, under their own names. */
  readonly query: string;
  readonly properties: readonly MadeProperty[];
}

export interface MadeAssociation {
  readonly association: string;
  readonly ends: readonly { readonly class: string; readonly on: string; readonly name: string; readonly multiplicity: string }[];
}

/** An association the model suggests: a key named after another class and one of its properties, of its type. */
export interface Suggestion {
  readonly ends: readonly [{ readonly class: string; readonly on: string }, { readonly class: string; readonly on: string }];
}

/** A route's answer: the files to write, what was made, the associations suggested. */
export interface ModelAnswer {
  /** `CREATE` for an element the project does not hold, `MODIFY` for one it does. */
  readonly changes: readonly PureChange[];
  readonly classes: readonly MadeClass[];
  readonly associations: readonly MadeAssociation[];
  readonly dataSpace?: string;
  readonly suggestions: readonly Suggestion[];
  readonly notes: readonly string[];
}

/** The model's writer: the tab's module (WasmPlanner), asked on every plane. */
export interface ModelWriter {
  createClass(project: string, pkg: string, cls: ClassAction): Promise<ModelAnswer>;
  createAssociation(project: string, pkg: string, association: AssociationAction,
    classes?: readonly ClassAction[]): Promise<ModelAnswer>;
  createDataSpace(project: string, pkg: string, dataSpace: DataSpaceAction, classes?: readonly ClassAction[],
    associations?: readonly AssociationAction[]): Promise<ModelAnswer>;
}

/** Whether `x` writes the model. */
export function writesModels(x: object): x is ModelWriter {
  return 'createClass' in x && 'createAssociation' in x && 'createDataSpace' in x;
}

/**
 * A request's body, each class's relation spliced in as `toJson` wrote it (so its numbers keep their digits); the
 * grid's runtime goes in its `where`, as the route reads it.
 */
export function modelRequestBody(lambdaJson: (query: Lambda) => string, project: string, pkg: string, parts: {
  readonly class?: ClassAction;
  readonly classes?: readonly ClassAction[];
  readonly association?: AssociationAction;
  readonly associations?: readonly AssociationAction[];
  readonly dataSpace?: DataSpaceAction;
}): string {
  const cls = (c: ClassAction): string => {
    const { query, source, where, ...rest } = c;
    const fields = JSON.stringify({ source: { _type: 'text', code: source.model }, ...rest,
      where: { ...where, runtime: source.runtime } });
    return `{"lambda":${lambdaJson(query)},${fields.slice(1)}`;
  };
  const fields = [`"project":${JSON.stringify({ _type: 'text', code: project })}`, `"package":${JSON.stringify(pkg)}`];
  if (parts.class) fields.push(`"class":${cls(parts.class)}`);
  if (parts.classes) fields.push(`"classes":[${parts.classes.map(cls).join(',')}]`);
  if (parts.association) fields.push(`"association":${JSON.stringify(parts.association)}`);
  if (parts.associations) fields.push(`"associations":${JSON.stringify(parts.associations)}`);
  if (parts.dataSpace) fields.push(`"dataSpace":${JSON.stringify(parts.dataSpace)}`);
  return `{${fields.join(',')}}`;
}

/** The place DataCube's tab is, in a project: the tab's DuckDB. */
export const BROWSER_PLACE = 'Browser';

/**
 * The class a source's name suggests: its file's name without the extension, in upper camel case, singular --
 * `trades.csv` a `Trade`, `order_lines.parquet` an `OrderLine`. A suggestion only: the person names it.
 */
export function suggestedClassName(sourceName: string): string {
  const base = sourceName.replace(/\.[A-Za-z0-9]+$/, '');
  const words = base.split(/[^A-Za-z0-9]+/).filter((w) => w !== '');
  if (words.length > 0) words[words.length - 1] = singular(words[words.length - 1]!);
  const name = words.map((w) => w.charAt(0).toUpperCase() + (w === w.toUpperCase() ? w.slice(1).toLowerCase() : w.slice(1))).join('');
  if (name === '') return 'Item';
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** An English plural's singular, for the common endings; anything else as it is. */
function singular(word: string): string {
  const lower = word.toLowerCase();
  if (/(ss|us|is)$/.test(lower)) return word;
  if (lower.endsWith('ies') && word.length > 3) return `${word.slice(0, -3)}${word.slice(-3) === 'IES' ? 'Y' : 'y'}`;
  if (/(xes|ches|shes|sses)$/.test(lower)) return word.slice(0, -2);
  if (lower.endsWith('s') && word.length > 1) return word.slice(0, -1);
  return word;
}

/**
 * The package a page's name suggests for its project's elements: its words in lower camel case (`Trades by desk`
 * `tradesByDesk`), a Pure name; `datacube` when the name has none.
 */
export function suggestedPackage(pageName: string): string {
  const words = pageName.split(/[^A-Za-z0-9]+/).filter((w) => w !== '');
  const name = words.map((w, i) => {
    const rest = w === w.toUpperCase() ? w.slice(1).toLowerCase() : w.slice(1);
    return (i === 0 ? w.charAt(0).toLowerCase() : w.charAt(0).toUpperCase()) + rest;
  }).join('');
  if (name === '') return 'datacube';
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** The data space a page's name suggests: its words in upper camel case (`Trades by desk` `TradesByDesk`). */
export function suggestedDataSpaceName(pageName: string): string {
  const pkg = suggestedPackage(pageName);
  return pkg.charAt(0).toUpperCase() + pkg.slice(1);
}

/** A Pure name: letters, digits and `_`, not led by a digit, and no word Pure reads as a literal. */
export function isPureName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== 'true' && name !== 'false';
}

/** A package: Pure names joined by `::`. */
export function isPackage(name: string): boolean {
  return name.split('::').every(isPureName);
}
