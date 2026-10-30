import { z } from 'zod';
import { TraceBundleSchema } from '../../../packages/contracts/src/evaluation-loop.ts';
import { toolNames } from '../dataset-loader/authoring.ts';
import { caseMaterialSchema, caseV2Schema } from '../dataset-loader/schema.ts';
import { metricCatalog } from '../scoring/catalog.ts';
import { createRegistry } from '../scoring/registry.ts';
import { controlledReplayTools } from '../adapters/replay-policy.ts';
import { buildMiningView } from './mining-view.ts';

/** Readable guidance from runtime schemas; custom refinements still run locally. */
function describe(schema: z.ZodTypeAny): Record<string, unknown> {
    if (schema instanceof z.ZodEffects) return { ...describe(schema.innerType()), localRefinements: true };
    if (schema instanceof z.ZodOptional) return { ...describe(schema.unwrap()), optional: true };
    if (schema instanceof z.ZodDefault) return { ...describe(schema.removeDefault()), defaulted: true };
    if (schema instanceof z.ZodNullable) return { ...describe(schema.unwrap()), nullable: true };
    if (schema instanceof z.ZodObject) {
        const fields = Object.entries(schema.shape as Record<string, z.ZodTypeAny>);
        return { type: 'object', properties: Object.fromEntries(fields.map(([key, value]) => [key, describe(value)])),
            required: fields.filter(([, value]) => !value.isOptional()).map(([key]) => key), additionalProperties: schema._def.unknownKeys === 'passthrough' };
    }
    if (schema instanceof z.ZodString) return { type: 'string', constraints: schema._def.checks.map(check => check.kind === 'regex'
        ? { kind: 'regex', pattern: check.regex.source, flags: check.regex.flags } : check) };
    if (schema instanceof z.ZodNumber) return { type: schema._def.checks.some(check => check.kind === 'int') ? 'integer' : 'number', constraints: schema._def.checks };
    if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
    if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options };
    if (schema instanceof z.ZodLiteral) return { const: schema.value };
    if (schema instanceof z.ZodArray) return { type: 'array', items: describe(schema.element), minItems: schema._def.minLength?.value, maxItems: schema._def.maxLength?.value };
    if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion)
        return { anyOf: schema.options.map((option: z.ZodTypeAny) => describe(option)) };
    if (schema instanceof z.ZodRecord) return { type: 'object', keys: describe(schema._def.keyType), additionalProperties: describe(schema._def.valueType) };
    return { type: schema._def.typeName, localValidation: true };
}
const example = {
    reason: 'Hypothetical example only; derive the real candidate from the actual original Trace and independent sources.', sourceLabels: ['example-independent-source'],
    case: { name: 'task_example_source_value', category: 'task', difficulty: 'difficult', purpose: 'capability', source: 'real-trace',
        input: { prompt: 'Return the value from the supplied example source.' },
        expected: { success: ['Return the source value exactly.'], failure: ['Invent a different value.'], maxToolCalls: 0, mustHaveEvidence: false, expectedAnswerHint: 'EXAMPLE_VALUE' },
        scoring: { deterministic: ['fact-check'], judge: [], manual: 'Human approval is pending.' }, risks: ['Controlled Q&A only.'], tags: ['example'] },
    gold: { values: {}, checks: [{ metric: 'fact-check', required: true, evidence: 'answer', path: [], equals: 'EXAMPLE_VALUE' }],
        opportunities: { 'task-success': 1 }, sources: ['materials/example-source/source.md'], basis: 'Hypothetical independent source, never a model answer.' },
    scenario: { requires: ['agent'], materials: [{ source: 'local-text', sample: 'example-source', file: 'source.md' }],
        steps: [{ id: 'request', action: 'user-message', instruction: '$input' }], selection: { enabledSkills: [], enabledExtensions: [] } },
    bindings: [{ materialId: 'example-source', quote: 'EXAMPLE_VALUE', label: 'Independent requirement', target: { kind: 'success', text: 'Return the source value exactly.' } },
        { materialId: 'example-source', quote: 'EXAMPLE_VALUE', label: 'Independent value', target: { kind: 'answer', text: 'EXAMPLE_VALUE' } }],
    controls: { negative: { label: 'Hypothetical original failure', evidence: { answer: { present: true, actual: 'WRONG_EXAMPLE_VALUE', source: 'Original Trace output' } } },
        positive: { label: 'Independent correct value', evidence: { answer: { present: true, actual: 'EXAMPLE_VALUE', source: 'Independent material' } } } },
    controlBindings: [{ control: 'negative', evidence: 'answer', path: [], source: { kind: 'trace', path: ['output', 'answer'] } },
        { control: 'positive', evidence: 'answer', path: [], source: { kind: 'material', materialId: 'example-source', quote: 'EXAMPLE_VALUE' } }],
};
export function miningModelInput(prompt: string, schema: z.ZodTypeAny) {
    const task = JSON.parse(prompt), trace = TraceBundleSchema.parse(task.trace), registry = createRegistry().list();
    const view = buildMiningView(trace);
    const catalogIds = new Set(metricCatalog.map(metric => metric.id));
    const metricIds = (method: 'deterministic' | 'llm-judge') => [...new Set(registry.filter(item => item.kind === method)
        .flatMap(item => item.outputs ?? [item.id]))].filter(id => catalogIds.has(id));
    const execution = caseV2Schema.innerType().shape;
    return { task: { ...task, trace: view }, contract: {
        schemaKind: 'runtime-zod-description', schema: describe(schema), registeredToolNames: toolNames,
        controlledReplayToolNames: controlledReplayTools(toolNames.map(name => ({ name }))).map(tool => tool.name),
        taskCheckMetrics: ['fact-check', 'reference-fields', 'line-items'], deterministicMetricIds: ['fact-check', 'reference-fields', 'line-items', ...metricIds('deterministic')],
        judgeMetricIds: metricIds('llm-judge'), metricCatalog,
        evaluators: registry.map(item => ({ id: item.id, method: item.kind, outputs: item.outputs, phase: item.phase })),
        goldValueShapes: { reference: describe(execution.expected.shape.reference), research: describe(execution.expected.shape.research),
            materialReferences: describe(execution.expected.shape.materialReferences) },
        executionTagShape: describe(execution.tags),
        materials: trace.materials.map((material, index) => {
            const local = material.path?.match(/^materials\/([^/]+)\/([^/]+)$/), invoice = material.path?.match(/^voxel51\/(\d{6})\/([^/]+)$/);
            const reference = local ? { source: 'local-text', sample: local[1], file: local[2] } : invoice ? { source: 'voxel51', sample: invoice[1], file: invoice[2] } : null;
            const parsed = caseMaterialSchema.safeParse(reference);
            const selected = view.materials.find(item => item.id === material.id);
            return { materialId: material.id, pointer: '/materials/' + index, path: material.path ?? null, replayReference: parsed.success ? parsed.data : null,
                originalContentAvailable: material.text !== undefined || material.content !== undefined,
                contentAvailable: selected?.text !== undefined || selected?.content !== undefined };
        }),
        rules: {
            capabilities: 'Capability fields accept registered tool names only, never logical abilities such as calculation or answer. Omit unused optional capability arrays; do not return empty arrays or overlapping required/optional/forbidden sets.',
            scoring: 'Use the listed metric IDs only. answer is an evidence key, never a metric. Gold checks select only taskCheckMetrics; common safeguards are added by the loader. Judge may be an empty array. task-success has opportunity 1.',
            factCheckPath: 'fact-check.path is an array of property names or indexes, not a string. Use [] for the whole evidence actual value, for example the actual answer string; use ["field"] only if the actual value is an object containing field.',
            materials: 'Use only actual replayReference entries for scenario.materials. sample and file are separate identities with no slashes; Gold.sources uses the full actual material path. Null replayReference cannot be invented into a valid material. A self-contained Q&A can use materials:[] while independent Gold sources stay private.',
            proof: 'Copy the original prompt and turns exactly. Quotes must occur in the actual named material; control values and Trace paths must match actual facts. Gold.values must not overwrite Case constraints. Missing independent proof means omit unsupported case/gold/scenario and explain the gap.',
            projection: 'task.trace is a bounded partial mining view, not the full original. Read its audit.omitted and unknown notes. Use each original JSON pointer for Trace path bindings and original material IDs for quotes; projected array indexes or synthetic decoded text fields are not original paths. All output bindings will be checked against the unchanged complete original Trace.',
            example: 'The example is hypothetical structural guidance only. Never copy its prompt, IDs, values or quotations into the actual candidate. For Gold, omit negative controls if no original failure exists; bind the positive value both to an independent material and the successful original Trace.',
        }, example,
    } };
}
