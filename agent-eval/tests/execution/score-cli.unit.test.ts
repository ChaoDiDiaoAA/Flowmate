import { expect, test } from 'bun:test';
import { parseWorkflowCli } from '../../src/cli.ts';
import { isWorkflowReadOnly, EvaluationWorkflowResultSchema } from '../../../packages/contracts/src/evaluation-workflow.ts';

const operation = '550e8400-e29b-41d4-a716-446655440000';
const revision = 'Scoring-' + operation;
test('scoring retry must be explicit, failed-only, and never silently selects a revision', () => {
  expect(parseWorkflowCli(['score','retry','--run-id','Run-example','--failed-only','--trial','trial-1','--operation-id',operation]))
    .toEqual({ action:'score.retry',runId:'Run-example',failedOnly:true,trialId:'trial-1',operationId:operation });
  expect(() => parseWorkflowCli(['score','retry','--run-id','Run-example'])).toThrow();
  expect(parseWorkflowCli(['score','list','--run-id','Run-example'])).toEqual({action:'score.list',runId:'Run-example'});
  expect(isWorkflowReadOnly('score.list')).toBe(true);
  expect(isWorkflowReadOnly('score.show')).toBe(true);
  expect(isWorkflowReadOnly('score.retry')).toBe(false);
  expect(isWorkflowReadOnly('score.upload')).toBe(false);
});

test('comparison and Gate receive only an explicitly named scoring revision', () => {
  expect(parseWorkflowCli(['experiment','compare','--experiment-id','Run-example'])).toEqual({action:'experiment.compare',experimentId:'Run-example'});
  expect(parseWorkflowCli(['experiment','compare','--experiment-id','Run-example','--scoring-revision',revision]))
    .toEqual({action:'experiment.compare',experimentId:'Run-example',scoringRevision:revision});
  expect(parseWorkflowCli(['score','show','--run-id','Run-example','--revision-id',revision,'--execution-id','execution-1','--trial','trial-1']))
    .toEqual({action:'score.show',runId:'Run-example',revisionId:revision,executionId:'execution-1',trialId:'trial-1'});
  expect(EvaluationWorkflowResultSchema.safeParse({action:'score.list',exitCode:0,data:{items:[]}}).success).toBe(true);
});
