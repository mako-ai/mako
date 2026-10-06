/**
 * The process registry: every definition this deployment can run.
 *
 * Library processes are registered from `library/index.ts`. Add a new process
 * by creating `library/<id>.ts` and adding it to that list — nothing else.
 */
import type { ProcessDefinition } from "./sdk";
import { libraryProcesses } from "./library";

const definitions = new Map<string, ProcessDefinition>();

function register(definition: ProcessDefinition): void {
  const existing = definitions.get(definition.id);
  if (existing && existing !== definition) {
    throw new Error(`Duplicate process id "${definition.id}"`);
  }
  definitions.set(definition.id, definition);
}

for (const definition of libraryProcesses) register(definition);

export function getProcessDefinition(
  id: string,
): ProcessDefinition | undefined {
  return definitions.get(id);
}

export function listProcessDefinitions(): ProcessDefinition[] {
  return [...definitions.values()];
}

/** Tests: add a definition that is not in the library. */
export function registerProcessDefinition(definition: ProcessDefinition): void {
  register(definition);
}
