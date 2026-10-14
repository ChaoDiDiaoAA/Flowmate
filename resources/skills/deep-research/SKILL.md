---
name: deep-research
description: Plan a complex research question, investigate authorized sources and produce a traceable report with visible coverage and evidence gaps.
disable-model-invocation: false
---
# Deep Research

Use the trusted task, phase, immutable plan version and frozen source scope. Product permissions and exposed tools are authoritative.

1. During planning, split the user's problem into dimensions, subquestions, evidence needs and explicit stop conditions. Read only selected local materials when necessary. Save the plan and finish the Run for confirmation; do not search, browse or delegate before confirmation.
2. During investigation, work broad-to-deep within the confirmed scope. Delegate only independent investigations worth the shared cost to research-investigator; supply subquestion IDs, permitted sources, expected evidence and stop conditions. A direct investigation is valid when delegation adds no value.
3. Read selected local source bodies. During investigation, copy the complete returned `evidenceRef` into Claim `evidence[].ref`: it already includes the confirmed plan, original source execution and exact UTF-16 locator. During planning this field is null; after confirmation use `query_research_evidence` on the saved source to obtain a usable reference. For a narrower passage, request an excerpt and copy its returned reference.
4. Turn findings into atomic claims using a question ID from the confirmed plan. Dependencies are numeric IDs of saved Claims. Put status and specific reasons inside `verification`; compare supporting/refuting passages, entity identity, date, version and conditions. Multi-hop conclusions depend on saved intermediate claims; missing or unverified links remain unresolved.
5. Check every planned subquestion against current findings. Before a follow-up reading, state the missing fact and why the next reading can resolve it. Use validation feedback to correct the indicated fields within the same remaining budget. As the budget runs low, save a partial report with known findings and explicit gaps. Stop for user confirmation if scope must change.
6. Save a report tied to the confirmed plan with an answer, analysis, claim references, coverage, conflicts, limitations and unresolved questions. Use partial when evidence remains insufficient. Full/partial is separate from the Run terminal status. Finish after the save receipt and let the user inspect saved citations, export Markdown or explicitly continue.

Assemble a Claim from actual returned values (the variables below stand for those values):

```javascript
{
  questionId: confirmedQuestionId,
  text: atomicStatement,
  dependencies: savedDependencyIds,
  evidence: [{ relation: "supports", ref: readResult.evidenceRef }],
  verification: { status: "insufficient", reasons: [specificUnresolvedCondition] }
}
```

Folio informs bounded acquisition and references to real execution; the ICLR research characterization informs Claims and breadth/depth analysis; ACL CaRR informs single-hop support and complete evidence chains; Anthropic informs coordinator/investigator division and synthesis. The workflow and confirmation/budget/storage rules are Flowmate's engineering choices. Product coverage is current evidence, never independent Gold. Do not claim measured research gains from this workflow alone.
