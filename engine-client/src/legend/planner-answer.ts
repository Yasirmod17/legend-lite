// The planner's (WebAssembly) answer to one request: the module's export of the same name, with no logic of its own.
// The tab's worker (planner-worker.ts) and the tests' in-process ports both answer through it, so they cannot answer
// differently.

export interface PlannerModule {
  readonly exports: {
    // legend-engine's pure/v1 -- and lite's own /api/lite/v1/compilation/compile -- routed as legend-lite's server
    // routes them (PureV1Api): `OK\n<status>\n<type>\n<body>`
    pureV1OrError(path: string, rawQuery: string, body: string): string;
    // execute's plan half in the engine's JSON (PureV1Api.jsonPlan), and its answer from the rows the tab's database
    // wrote (PureV1Api.jsonAnswer): `OK\n<status>\n<type>\n<body>`
    executeJsonPlanOrError(body: string, modelsJson: string): string;
    executeJsonAnswerOrError(plan: string, wire: string): string;
    planJsonOrError(model: string, lambdaJson: string, runtime: string): string;
    warmModel(model: string): number;
    testDataSqlOrError(model: string, database: string, tablesJson: string): string;
  };
}

export type PlannerRequest =
  // one pure/v1 call: its path (`/api/pure/v1/...`), its raw query string ('' for none) and its body
  | { readonly kind: 'pureV1'; readonly path: string; readonly query: string; readonly body: string }
  // an ExecuteInput's plan half (its body) over the only models the tab runs (a JSON array of their texts)
  | { readonly kind: 'executePlan'; readonly body: string; readonly models: string }
  // that plan's answer (its JSON, as the planner gave it) from the one value the tab's database wrote running it
  | { readonly kind: 'executeAnswer'; readonly plan: string; readonly wire: string }
  | { readonly kind: 'plan'; readonly model: string; readonly lambda: string; readonly runtime: string }
  | { readonly kind: 'warm'; readonly model: string }
  // a model's test data as the statements the server seeds DuckDB with, and each table's names as they spell it
  | { readonly kind: 'testData'; readonly model: string; readonly database: string; readonly tables: string };

export function answer(m: PlannerModule, r: PlannerRequest): string {
  switch (r.kind) {
    case 'pureV1': return m.exports.pureV1OrError(r.path, r.query, r.body);
    case 'executePlan': return m.exports.executeJsonPlanOrError(r.body, r.models);
    case 'executeAnswer': return m.exports.executeJsonAnswerOrError(r.plan, r.wire);
    case 'plan': return m.exports.planJsonOrError(r.model, r.lambda, r.runtime);
    case 'warm': m.exports.warmModel(r.model); return 'OK\n';
    case 'testData': return m.exports.testDataSqlOrError(r.model, r.database, r.tables);
  }
}
