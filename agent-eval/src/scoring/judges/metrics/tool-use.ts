import { defineSemanticMetric as metric } from '../metric.ts';
export const toolUseMetrics = [
    metric('tool-selection', 'tool-use', 1, 'Judge task-specific tool and non-use decisions against authorized capabilities and the user goal. Allow equivalent legitimate paths; an optional tool is not mandatory.'),
    metric('tool-arguments', 'tool-use', 1, 'Compare original and final tool arguments with authorized objects, requested values and tool contracts. Structurally valid arguments may still target the wrong object.'),
    metric('tool-result-use', 'tool-use', 1, 'Check whether the subsequent answer or action correctly uses each relevant original tool result. Delivery alone does not prove use; do not reward ignored contradictions.'),
    metric('redundant-tools', 'tool-use', 1, 'Count unnecessary repeated or irrelevant tool calls against the task and observed prior results. Distinguish justified recovery and newly required information from waste.'),
    metric('diagnostic-recovery-strategy', 'tool-use', 1, 'Check recovery decisions against the original fault, permitted retry policy and committed effects. Unsafe retries or duplicate effects fail; merely saying retry is not recovery.'),
];
