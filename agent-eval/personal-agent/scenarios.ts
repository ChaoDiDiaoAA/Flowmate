export const scenarioVersion = 1;

const coordination = 'tests/core/application/invoice-work-coordination.integration.test.ts';
const approval = 'tests/core/application/personal-approval-coordination.integration.test.ts';
const recovery = 'tests/core/application/personal-trigger-recovery.integration.test.ts';
const memory = 'tests/core/memory/openviking-repository.integration.test.ts';
const regression = (file: string, title: string, timeoutMs = 30_000) => ({
  version: 1, suite: 'full', stage: 'regression', file, title, timeoutMs, checks: ['required-regression'],
} as const);

export const scenarios = {
  'model-timing': { version: 1, suite: 'smoke', stage: 'host', timeoutMs: 30_000,
    checks: ['http-status', 'provider-calls', 'visible-output'] },
  'provider-failure': { version: 1, suite: 'smoke', stage: 'host', timeoutMs: 30_000,
    checks: ['http-status', 'provider-calls', 'no-visible-output'] },
  'candidate-provenance': { version: 1, suite: 'smoke', stage: 'host', timeoutMs: 60_000,
    checks: ['candidate-saves', 'amount', 'tax', 'original-tool-call', 'original-model-call', 'timeline-observations', 'old-feedback', 'legacy-unlinked', 'provider-calls'] },
  'desktop-progress': { version: 1, suite: 'smoke', stage: 'desktop', timeoutMs: 90_000,
    checks: ['calls-after-reload', 'provider-calls', 'original-tool-call'] },
  'work-isolation': { version: 1, suite: 'smoke', stage: 'host', timeoutMs: 30_000,
    checks: ['original-work', 'separate-observations', 'provider-calls'] },
  'missing-field': regression(coordination, 'a saved candidate with an unavailable required field creates an original field and source bound supplement Todo'),
  'arithmetic-conflict': regression(coordination, 'a legally saved arithmetic conflict retains its original rule and field sources for human review'),
  'approval-once': regression(approval, 'a Work continues another invoice and handles its original browser tool after twice-restart'),
  'approval-denied': regression(approval, 'a Work continues another invoice and handles its original browser tool after twice-reject'),
  'stop-and-continue': regression(coordination, 'a committed user stop settles the original root and later clarification requires explicit continue'),
  'unknown-receipt': regression(recovery, 'a real native-receipt unknown result followed by legal clarification cold-recovers the original input and consumes the new input separately'),
  'no-transport': regression(coordination, 'a user stop closes a genuinely frozen but never submitted phase only with exact native not-started proof'),
  'owned-child': regression('tests/runtime-durable/subagents.integration.test.ts',
    'a genuine owned child reports through the parent tool into the next Master HTTP request: item-read'),
  'memory-owner': regression(memory, 'a Durable recall belongs to the original Work, invoice and phase'),
  'memory-unconfirmed': regression(memory, 'a pending recall becomes unavailable after restart without a new external read'),
  'observation-write-failure': regression('agent-eval/personal-agent/personal-observations.integration.test.ts',
    'observation writes can fail without changing the committed Personal Agent result', 40_000),
  'observation-upgrade-and-retention': regression('agent-eval/personal-agent/personal-observations.integration.test.ts',
    'upgrades an existing schema 29 Work and expires observation details without deleting its source'),
} as const;
export type ScenarioId = keyof typeof scenarios;
