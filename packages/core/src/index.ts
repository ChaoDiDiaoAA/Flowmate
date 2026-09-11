export * from "./storage/database.js";
export * from "./storage/migrate.js";
export * from "./storage/artifacts.js";
export * from "./jobs/repository.js";
export * from "./jobs/service.js";
export * from "./configuration/candidate.js";
export * from "./configuration/preflight.js";
export * from "./context/build-context.js";
export * from "./tools/registry.js";
export * from "./tools/gateway.js";
export * from "./runtime/budget.js";
export * from "./runtime/controller.js";
export * from "./evidence/events.js";
export * from "./evidence/handoff.js";

import { openDatabase } from "./storage/database.js";
import { createStore, type Store } from "./jobs/repository.js";

export function openStore(root: string): Store {
  return createStore(openDatabase(root));
}
