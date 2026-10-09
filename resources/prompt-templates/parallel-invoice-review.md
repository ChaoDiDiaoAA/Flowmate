---
description: Delegate independent evidence and reasoning checks concurrently, then reconcile findings.
---
For the task below, call two Agent tools in the same turn for independent checks: subagent_type=invoice-evidence-checker for source evidence and subagent_type=general-analyst for analysis of the supplied information. Both use run_in_background=false.
Task: $ARGUMENTS
Reconcile the actual tool results and distinguish evidence, assumptions, and unresolved gaps. Do not claim a child ran unless its Agent tool actually returned.
