[English](EVALUATION-BENCHMARK.md) | [简体中文](EVALUATION-BENCHMARK.zh-CN.md)

# Authoring a Flowmate benchmark

A benchmark turns a task with independently provable expectations into a repeatable evaluation. Start with the task and its evidence, define success and failure, validate the controlled scenario, then publish a version only after current human approval. A trace, a candidate and a published Case are different assets.

The [evaluation guide](EVALUATION.md) explains execution, scoring and Gates. The [module reference](../../agent-eval/README.md) describes configuration and storage.

## Keep the original benchmark explicit

Full retains the original **62 Cases: 50 business and 12 research**. Smoke contains **7 Cases: 5 business and 2 research**:

`FM-001, FM-002, FM-027, FM-033, FM-046, FM-051, FM-055`.

The standard Smoke/Full commands compare Sol and Luna with one repetition, planning 14/124 subject Trials respectively. The counts are a selection plan, not evidence that a run completed. These commands require Langfuse preflight and attempt upload/readback; see [Evaluation](EVALUATION.md) for the fixed Judge and execution status. New candidates do not enter either selection automatically. Select a published benchmark version explicitly when evaluating its members.

## Begin with a real task and independent sources

Save the original user input, turns, authorized materials, scenario conditions and source Trace identity. Preserve their language and ordering. Record where evidence is incomplete instead of inventing the missing input.

Use independent material to prove the expected answer, acceptable business values and required behavior. Each decisive requirement needs a source location or an independently checkable rule. The subject's answer, Judge's previous conclusion and a plausible explanation are not independent Gold.

| Component | What it contains |
|---|---|
| Case | Identity/version, input, category, difficulty, task purpose and expected behavior |
| Gold | Independent facts, acceptable values, source witnesses and rubric |
| Review | Author-side checks of Case quality, ambiguity and evidence sufficiency, with explicit authorship; Agent self-review and human approval stay distinct |
| Scenario | Controlled product state and materials delivered under the task's authorization |
| Source | Actual Trace and material references that explain the candidate's origin |

Keep Gold, Review, private scenario controls and future user turns away from the subject's initial context. The scoring side can use them; the subject receives only the task's authorized inputs and product resources.

## Choose the candidate kind

| Collection | Use |
|---|---|
| Gold candidates | A real successful trajectory with independently supported expectations |
| Bad candidates | A real failure worth diagnosing, with enough evidence to distinguish failure from scoring or capture error |
| Regression candidates | A real bug or failure that should remain reproducible and guard a future fix |

Candidate kind `gold` is not the difficulty label `golden`. New regression Cases use regression purpose/difficulty and retain their real bug/Trace source. A candidate is a draft for review, not a runnable dataset.

For an already covered task with unchanged expectations, reuse its Case. To correct expectations or scoring while keeping the original input, scenario, labels and materials, use `reviseCase: { id, version }` against the current published CaseVersion. This is mutually exclusive with `reuseCaseId`. A different task objective requires a new Case.

## Validate before publication

Check schema, source bindings, independent expectations and the controlled scenario. A success candidate needs a positive control. A failure candidate also needs a negative control that reproduces the relevant failure. Record what each control actually demonstrated.

Controlled replay verifies the fixture/scenario and evaluator behavior. Real model replay verifies the chosen subject under those conditions. Report these independently; `NOT_RUN` never means PASS. Candidate replay uses the existing Luna gateway with `gpt-6-luna/max`; mining uses native Codex `gpt-6-luna/max`. Neither operation runs automatically from Smoke/Full.

If evidence cannot establish an expectation, retain an awaiting-evidence or blocked state with the concrete gap. Do not weaken the expected behavior to make the previous answer pass. A new candidate revision requires new validation and current approval.

## Review and publish an explicit version

Human review evaluates whether the Case and Gold are correct and useful. The approval must identify the current candidate revision and intended publication. An Agent suggestion, a successful validator or a replay PASS is not that approval.

Publication saves a benchmark snapshot with explicit CaseVersion membership. Revising an existing Case increases that CaseVersion; older published benchmark snapshots retain their original conditions. Candidate revision, CaseVersion and benchmark version identify different changes.

No candidate is preapproved by this guide. Only a real operation creates a candidate, feedback entry or published version. Mining, replay, review and publication remain explicit actions; evaluation results never silently publish a Case.

## Store one readable asset per operation

```text
agent-eval/
  traces/
    Trace-<date>-<entry>-<purpose>-01.json
  feedback.json
  src/datasets/
    gold-candidates/
      Gold-<date>-<purpose>-01.json
    bad-candidates/
      Bad-<date>-<purpose>-01.json
    regression-candidates/
      Regression-<date>-<purpose>-01.json
    published/
      Benchmark-<name>/
        Version-001-<date>/
          benchmark.json
          materials/              # only necessary binary materials
```

This is a naming convention, not a statement that these assets already exist. Files in each candidate collection are flat; internal UUIDs and explicit versions preserve identity. Do not precreate empty candidates, feedback or publication snapshots.

The candidate JSON carries the Case, independent evidence, validation/replay and review state together. A published `benchmark.json` carries its versioned snapshot; necessary binary materials can accompany it. Do not add separate approval, replay, validation or export sidecar trees.

Four HumanFeedback targets—Case quality, saved Run, Trace and candidate review—share `agent-eval/feedback.json`, created only on the first actual feedback. Original scores remain intact. Evaluation Trace evidence already belongs to `runs/Run-<Shanghai date_time>-smoke|full-compare-01/run.json` and is not copied into the product Trace collection.

## Evaluate and interpret the result

Use the same explicit Case versions, independent Gold, scoring rules and scenario conditions on both sides of a comparison. Review the actual model inputs, tool/subagent observations and business receipts before attributing a difference to the configuration.

Baselines live in `agent-eval/baselines.json`. Smoke7 and Full62 have separate scopes. Critical metrics and required assertions cannot decline, actual leakage/prohibited side effects must remain zero, and other normalized quality ratios allow at most `0.02` absolute decline. Missing, erroneous or incompatible evidence blocks the Gate.

A relative Gate pass can preserve a known failure. Report absolute quality alongside it, with metric numerators and denominators. One repetition does not prove stability; adding or revising a Case does not prove that a product fix works. Link the future validation to the exact failure, affected requirements and comparable conditions.

## Select Metrics without creating model calls

Use Metric IDs in each Case's `scoring.judge`, for example `['tool-selection', 'tool-arguments']`. The registry contains 30 independent semantic definitions across ten domain files, including two optional diagnostics; the formal catalog remains 39 Metrics. Existing 25 local implementations are reused, for 55 active definitions in total. Case-specific expectations and Gold refine the criterion; they do not redefine the Metric's unit or formula.

A Trial merges applicable semantic criteria into zero or one logical Judge submission. Missing evidence is not automatic non-applicability, and a known failure is not erased by incomplete capture. Keep required/optional declarations and original opportunity denominators explicit. New diagnostics use their Metric ID as `evaluatorId`; historical `task-judge`/`tool-use-judge` declarations are read using their explicit `params.metricId`.

Changing an Evaluator's Rubric, evidence contract or validator requires its own version change. Changes to the common protocol require the corresponding scoring/template version change. Keep the Case/Gold version rules distinct. Old results are readable; incompatible versions block comparison/Gates. Single-Metric calibration does not establish combined quality; missing, partial or stale calibration references must remain visible. See the [scoring and calibration guide](EVALUATION.md#evaluators-measure-behavior-before-judging-semantics).

Execution budgets belong to Run/experiment conditions. They do not revise Cases or Gold; keep old budgets with old results. Explicit scoring recovery uses the saved Case and Gold versions, and a scoring revision does not publish a new benchmark.
