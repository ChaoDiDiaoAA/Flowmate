import { z } from 'zod';
import { AppErrorSchema } from './runtime.ts';

export const InputDefinitionIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const content = z.string().min(1).refine(value => new TextEncoder().encode(value).byteLength <= 65536, 'Definition exceeds 64 KiB.');
export const SubagentDefinitionSchema = z.object({ id: InputDefinitionIdSchema, description: z.string().min(1).max(512),
  tools: z.array(z.string().min(1).max(128)).max(64), systemPrompt: content, content,
  source: z.enum(['builtin', 'user']) }).strict().readonly();
export type SubagentDefinition = z.infer<typeof SubagentDefinitionSchema>;
export const GetSubagentDefinitionSchema = z.object({ id: InputDefinitionIdSchema }).strict();
export const SaveSubagentDefinitionSchema = z.object({ id: InputDefinitionIdSchema, expectedContent: content.nullable(), content }).strict();
export type SaveSubagentDefinition = z.infer<typeof SaveSubagentDefinitionSchema>;
export const FrozenInputCommandSchema = z.object({ kind: z.enum(['template', 'subagent']), name: InputDefinitionIdSchema,
  originalText: content, expandedText: content,
  requiredRoles: z.array(InputDefinitionIdSchema).max(4) }).strict();
export type FrozenInputCommand = z.infer<typeof FrozenInputCommandSchema>;
export const FrozenPromptTemplateSchema = z.object({ name: InputDefinitionIdSchema, description: z.string().max(512),
  content, filePath: z.string().min(1).max(4096) }).strict();
export const FrozenInputDefinitionsSchema = z.object({ roles: z.array(SubagentDefinitionSchema).max(64),
  templates: z.array(FrozenPromptTemplateSchema).max(64),
  command: FrozenInputCommandSchema.nullable() }).strict();
export type FrozenInputDefinitions = z.infer<typeof FrozenInputDefinitionsSchema>;
export const InputCommandOwnerSchema = z.object({ inputId: z.number().int().positive(), runId: z.number().int().positive(),
  sessionId: z.number().int().positive() }).strict();
export const InputCommandReceiptSchema = InputCommandOwnerSchema.extend({ nativeSessionId: z.string().min(1).max(256),
  instanceId: z.string().uuid(), originalText: content, role: InputDefinitionIdSchema }).strict();
export const InputCommandItemSchema = z.object({ group: z.enum(['Skills', 'Subagents', 'Prompt Templates', 'Extension Commands']),
  name: z.string().min(1).max(128), text: z.string().min(1).max(256), description: z.string().max(512),
  available: z.boolean(), reason: z.string().max(2048).nullable(), assembled: z.boolean() }).strict();
export type InputCommandItem = z.infer<typeof InputCommandItemSchema>;
const result = <T extends z.ZodTypeAny>(data: T) => z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]);
const results = { list_input_commands: result(z.array(InputCommandItemSchema).max(256)),
  list_subagent_definitions: result(z.array(SubagentDefinitionSchema).max(64)),
  get_subagent_definition: result(SubagentDefinitionSchema), save_subagent_definition: result(SubagentDefinitionSchema) };
export const InputDefinitionCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('list_input_commands'), input: z.object({ sessionId: z.number().int().positive().optional() }).strict() }).strict(),
  z.object({ type: z.literal('list_subagent_definitions'), input: z.object({}).strict() }).strict(),
  z.object({ type: z.literal('get_subagent_definition'), input: GetSubagentDefinitionSchema }).strict(),
  z.object({ type: z.literal('save_subagent_definition'), input: SaveSubagentDefinitionSchema }).strict() ]);
export function parseInputDefinitionCommand(value: unknown) { const parsed = InputDefinitionCommandSchema.safeParse(value); return parsed.success ? parsed.data : null; }
export function isInputDefinitionHostCommand(type: string): type is keyof typeof results { return Object.hasOwn(results, type); }
export function parseInputDefinitionHostResult(type: string, value: unknown) {
  if (!isInputDefinitionHostCommand(type)) return null;
  const parsed = results[type].safeParse(value); return parsed.success ? parsed.data : null;
}
export function matchesInputDefinitionResponse(command: { type: string; input?: unknown }, value: unknown): boolean {
  const captured = parseInputDefinitionCommand({ type: command.type, input: command.input }), result = parseInputDefinitionHostResult(command.type, value);
  return !!captured && !!result && (!result.ok || !('id' in captured.input) || 'id' in result.data && captured.input.id === result.data.id);
}
export function inputDefinitionHostFailure(type: string) { return { ok: false as const, error: {
  code: type === 'save_subagent_definition' ? 'operation_result_unknown' : 'storage_read_failed', category: 'runtime' as const,
  retryable: true, message: type === 'save_subagent_definition' ? 'Save receipt is unknown. Query the definition before retrying.' : 'Input definitions could not be read.' } }; }
