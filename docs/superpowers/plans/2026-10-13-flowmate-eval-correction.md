# Flowmate stage-one correction

Spec: the user's approved “第一阶段修正实施计划：先修订完整方案，再按方案修改代码” in this conversation. That plan and later corrections are authoritative.

Global constraints: work in the existing dirty `codex/eval-stage-one` checkout; preserve unrelated work, invoice originals, 86 IDs, Gold, Smoke/holdout and 12 Runtime pairs. Do not commit, push, reset or clean. Public versions remain v1. Evaluation declarations and saved artifacts contain no hashes. No real Agent/Judge, paid evaluation or platform requests.

## Task 1 — restore complete design before implementation

Restore docs/eval/01–08 from the recorded full originals, keeping all chapters, 39 metric definitions and formulas, examples, dated history, future phases and 16 original method URLs. Update only superseded directory, declaration, configuration, version, output and first-stage contracts. Add contextual LangSmith Evaluation types and OpenAI Graders citations. Record the restored chapter mapping and current limitations.

Verification: all original major headings and 16 URLs remain; the two new method URLs have chapter-local citations; current directory, authoring and CLI examples match the approved plan.

## Task 2 — declarations, scenarios, samples and isolation

Write failing local tests first. Group cases/gold/review by the 11 Harness categories using English comments without renumbering; load in ID order. Keep only these three TS files in src/datasets. Separate private scenario declarations into src/testing/scenarios.ts and independent raw samples into src/testing/fixtures; use a small safe Folio-style loader. Remove the embedded-material and redundant resource indexes after equivalence checks. Update all loader, Runner, snapshot, audit and test callers. Exclude datasets and testing from source-copy and Agent mounts.

Verification: 86 declarations and Gold/Review remain equivalent to the digest-free pre-change baseline; original material bytes and source positions remain intact; missing references, malformed JSON, illegal names and escaping links fail; private controls, future steps and grading data stay outside Agent inputs.

## Task 3 — verification and actual record

Run data audit, dataset validation, project typecheck and relevant local/mock tests including existing configuration, scoring, output, resend and legacy report coverage. Keep synthetic output in temporary test directories. Update README and stage-one record with actual results, not historical test counts. Obtain one fresh final review as required by executing-plans; fix material findings with a failing regression test then rerun affected checks. Stop at stage one.

Review focus: complete restored documentation rather than a condensed replacement; no stale active JSON/hash/version contracts; real sample bytes and resource scope; path/link traversal and private fixture isolation; source copy exclusions; stable runtime pair and execution ordering; no external evaluation or uploads; human and real-container acceptance explicitly pending.

## User amendment — 2026-10-13

Cancel standalone Runtime recovery capability set, its 24 cases FM-063..086, pairs, dedicated fault/scoring/strategy/snapshot code, tests and current design. Retain product Runtime and ordinary business behavior. Current data scope is 50 business + 12 research, 62 total. Preserve all original 16 method sources in relevant body chapters, plus LangSmith and Graders. Supersedes prior 86-case and 12-pair requirements.
