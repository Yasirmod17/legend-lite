// Planners for tests: legend-lite's own WASM module, the same one the tab loads.

import { WasmPlanner } from '../src/wasm-planner.ts';
import { runfileDirUrl } from '../../tools/js/runfiles.mts';

const MODULE_DIR = runfileDirUrl('WASM_PLANNER');

/** A planner over a model, from the same module. */
export function plannerFor(model: string, runtime: string, how: { readonly mapping?: string } = {}): WasmPlanner {
  return new WasmPlanner({ model, runtime, ...how, assetBaseUrl: MODULE_DIR, cache: false });
}
