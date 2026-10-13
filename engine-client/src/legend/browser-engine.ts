// The engine with no legend server: the tab's planner (legend-lite, WebAssembly) turns a query into
// SQL, and one of DataCube's engines runs it -- DuckDB-WASM in the tab, or the warehouse (DuckDB on
// a server, over its SQL API, as the signed-in user). The same seam DataCube plans and runs on;
// only where the SQL runs differs.
//
// It answers legend-engine's API with the Java the server and Python answer it with
// (docs/ONE_PLATFORM_PROGRAM_2026_10_12.md C1): an execute's answer is the planner's -- its parameters bound, its
// builder, its activities, its columns, or a graph fetch's JSON (PureV1Api.jsonPlan) -- and only its rows are the tab's,
// its executor running the SQL and typing them; a lambda's return type and an execution plan are the planner's
// pure/v1, as the server routes them.

import { findAll, isFunction, type Lambda } from '../../../pure-protocol/src/index.ts';
import type { QueryEngine } from '../engine.ts';
import type { Plan } from '../relation-type.ts';
import type { PureModelContextData } from './pmcd.ts';
import { EngineError, type Engine } from './engine.ts';
import type { WasmGrammar } from './wasm-grammar.ts';
import type { CompileResult, ExecuteInput, ExecutionResult, PureModelContext, RelationTypeAnswer, TdsResult } from './wire.ts';

/** The runtime a query runs on: the last argument of its `->from(...)`. */
export function runtimeOf(lambda: Lambda): string {
  const from = findAll(lambda, isFunction).find((f) => f.function === 'from' || f.function.endsWith('::from'));
  const last = from?.parameters[from.parameters.length - 1];
  if (last?._type !== 'packageableElementPtr') throw new EngineError('the query names no runtime: its from(mapping, runtime) has none', 400);
  return last.fullPath;
}

export class BrowserEngine implements Engine {
  readonly #planner: WasmGrammar;
  readonly #engine: QueryEngine;
  readonly #user: string;

  /**
   * `user`: who saved queries belong to (the warehouse's signed-in principal, or the name this browser was
   * configured with).
   */
  constructor(planner: WasmGrammar, engine: QueryEngine, user: string) {
    this.#planner = planner;
    this.#engine = engine;
    this.#user = user;
  }

  get name(): string {
    return this.#engine.name;
  }

  modelJson(text: string): Promise<PureModelContextData> { return this.#planner.modelJson(text); }
  lambdaJson(text: string): Promise<Lambda> { return this.#planner.lambdaJson(text); }
  lambdaText(lambda: Lambda, style: 'PRETTY' | 'STANDARD'): Promise<string> { return this.#planner.lambdaText(lambda, style); }
  modelText(model: PureModelContextData, style: 'PRETTY' | 'STANDARD'): Promise<string> { return this.#planner.modelText(model, style); }
  relationType(model: PureModelContext, lambda: Lambda): Promise<RelationTypeAnswer> { return this.#planner.relationType(model, lambda); }

  async execute(input: ExecuteInput, signal?: AbortSignal): Promise<ExecutionResult> {
    const planned = await this.#planner.executePlan(input);
    if (planned.builder._type === 'json') {
      // a graph fetch: the database builds the objects' JSON array in one cell
      const raw = await this.#engine.run(planned.sql, 0, signal);
      const cell = raw.columns[0]?.values[0];
      if (typeof cell !== 'string') throw new EngineError('the graph fetch returned no JSON', 500);
      const values = JSON.parse(cell) as unknown[];
      // as legend-engine answers: exactly one object is written bare
      return { builder: { _type: 'json' }, values: values.length === 1 ? values[0] : values };
    }
    if (!('columns' in planned)) throw new EngineError('the planner answered a relation with no columns', 500);
    // the rows typed by the builder's types (an enumeration's String, as the engine's TDS builder names it)
    const plan: Plan = { sql: planned.sql, columns: planned.builder.columns.map((c) => ({ name: c.name, type: c.type })) };
    const t = await this.#engine.execute(plan, 0, signal);
    const rows: { values: unknown[] }[] = [];
    for (let i = 0; i < t.rowCount; i++) rows.push({ values: t.columns.map((c) => c.values[i] ?? null) });
    const result: TdsResult = {
      builder: planned.builder,
      activities: planned.activities,
      result: { columns: [...planned.columns], rows },
    };
    return result;
  }

  /** `compilation/compile` in the tab, answered by the planner as the server answers it: OK, or its first failure. */
  compile(model: PureModelContext): Promise<CompileResult> {
    return this.#planner.compile(model);
  }

  returnType(model: PureModelContext, lambda: Lambda): Promise<string> {
    return this.#planner.returnType(model, lambda);
  }

  generatePlan(input: ExecuteInput): Promise<unknown> {
    return this.#planner.generatePlan(input);
  }

  currentUser(): Promise<string> {
    return Promise.resolve(this.#user);
  }
}
