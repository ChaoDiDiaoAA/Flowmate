/**
 * Runtime-facing contract entrypoint.
 *
 * The initial P0 implementation kept these schemas in execution.ts while the
 * package was being bootstrapped. Keep that compatibility path intact and
 * expose the canonical runtime boundary named by the project layout.
 */
export * from "./execution.js";
