import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appError, fail, ok, InputDefinitionIdSchema, GetSubagentDefinitionSchema, SaveSubagentDefinitionSchema,
  SubagentDefinitionSchema, FrozenInputDefinitionsSchema } from '@flowmate/contracts';
import type { Result, SubagentDefinition, SaveSubagentDefinition, FrozenInputDefinitions, InputCommandItem } from '@flowmate/contracts';
import { bytes, decoder, directory, safePath, writeSynced } from './skill-hub/resources.ts';

type Template = { name: string; description: string; content: string; filePath: string };
export function createInputDefinitions(options: { resourceRoot: string; runtimeRoot: string;
  tools: readonly { name: string; effect: string }[];
  parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string };
  loadPromptTemplates(options: { cwd: string; agentDir: string; promptPaths: string[]; includeDefaults: boolean }): { templates: Template[]; diagnostics: readonly unknown[] };
  expandPromptTemplate(text: string, templates: any[]): string }) {
  const builtinRoot = join(options.resourceRoot, 'subagents'), userRoot = join(options.runtimeRoot, 'subagents');
  const templateRoot = join(options.resourceRoot, 'prompt-templates');
  const checked = <T>(operation: () => T): Result<T> => {
    try { return ok(operation()); } catch (error) { return fail(appError('input_invalid', 'input',
      error instanceof Error ? error.message : 'Input definitions could not be verified.')); }
  };
  function parseRole(id: string, content: string, source: 'builtin' | 'user'): SubagentDefinition {
    InputDefinitionIdSchema.parse(id);
    const parsed = options.parseFrontmatter(content), tools = parsed.frontmatter.tools;
    if (parsed.frontmatter.name !== id || !Array.isArray(tools) || tools.some(tool => typeof tool !== 'string')
      || new Set(tools).size !== tools.length || tools.some(name => !options.tools.some(tool => tool.name === name
        && ['PURE', 'READ'].includes(tool.effect) && name !== 'Agent'))) throw new Error('Role name or read-only tool declaration is invalid.');
    return SubagentDefinitionSchema.parse({ id, description: parsed.frontmatter.description, tools, systemPrompt: parsed.body.trim(),
      content, source });
  }
  function roles() {
    const found = new Map<string, SubagentDefinition>();
    for (const [root, source] of [[builtinRoot, 'builtin'], [userRoot, 'user']] as const) {
      if (!existsSync(root)) continue;
      directory(root);
      // Old interrupted saves may leave only these owned staging names in the author directory.
      const files = readdirSync(root).filter(file => source !== 'user' || !/^\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/i.test(file)).sort();
      if (files.length > 64) throw new Error('Role directory exceeds 64 definitions.');
      for (const file of files) {
        if (!file.endsWith('.md')) throw new Error('Role author directory must contain Markdown definitions.');
        const id = file.slice(0, -3), content = decoder.decode(bytes(safePath(root, file), 65536));
        found.set(id, parseRole(id, content, source));
      }
    }
    if (found.size > 64) throw new Error('Effective role directory exceeds 64 definitions.');
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  function templates() {
    if (!existsSync(templateRoot)) return [];
    directory(templateRoot);
    const files = readdirSync(templateRoot).sort(); if (files.length > 64) throw new Error('Template directory exceeds 64 definitions.');
    for (const file of files) { InputDefinitionIdSchema.parse(file.slice(0, -3));
      if (!file.endsWith('.md')) throw new Error('Template directory must contain Markdown definitions.');
      decoder.decode(bytes(safePath(templateRoot, file), 65536)); }
    const result = options.loadPromptTemplates({ cwd: options.runtimeRoot, agentDir: options.runtimeRoot, promptPaths: [templateRoot], includeDefaults: false });
    if (result.diagnostics.length) throw new Error('Explicit prompt templates could not be loaded without diagnostics.');
    const loaded = result.templates;
    if (loaded.length !== files.length || new Set(loaded.map(item => item.name)).size !== loaded.length
      || loaded.some(item => ['subagent', 'skill', 'invoice-assist'].includes(item.name))) throw new Error('Template names conflict or could not be loaded.');
    return loaded;
  }
  return {
    listSubagentDefinitions: () => checked(roles),
    getSubagentDefinition: (raw: { id: string }) => checked(() => { const { id } = GetSubagentDefinitionSchema.parse(raw);
      const role = roles().find(item => item.id === id); if (!role) throw new Error('Subagent role does not exist.'); return role; }),
    saveSubagentDefinition: (raw: SaveSubagentDefinition) => checked(() => {
      const input = SaveSubagentDefinitionSchema.parse(raw), effective = roles(), current = effective.find(item => item.id === input.id);
      if ((current?.content ?? null) !== input.expectedContent) throw new Error('Role changed. Query the current definition before saving.');
      if (!current && effective.length >= 64) throw new Error('Effective role directory exceeds 64 definitions.');
      const role = parseRole(input.id, input.content, 'user');
      mkdirSync(userRoot, { recursive: true }); directory(userRoot);
      const target = join(userRoot, `${input.id}.md`), temporary = join(options.runtimeRoot, `.subagent-${randomUUID()}.tmp`);
      if (existsSync(target)) safePath(userRoot, `${input.id}.md`);
      try { writeSynced(temporary, Buffer.from(input.content)); renameSync(temporary, target); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
      return role;
    }),
    commands: (): Result<InputCommandItem[]> => checked(() => [
      ...roles().map(role => ({ group: 'Subagents' as const, name: role.id, text: `/subagent ${role.id} `,
        description: role.description, available: true, reason: null, assembled: false })),
      ...templates().map(template => ({ group: 'Prompt Templates' as const, name: template.name, text: `/${template.name} `,
        description: template.description, available: true, reason: null, assembled: false })) ]),
    freeze: (text: string): Result<FrozenInputDefinitions> => checked(() => {
      const definitions = roles(), loaded = templates(); let command: FrozenInputDefinitions['command'] = null;
      if (text.startsWith('/') && !text.startsWith('/skill:')) {
        const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text); if (!match) throw new Error('Input command is invalid.');
        const name = match[1]!, args = match[2] ?? '';
        if (name === 'subagent') {
          const delegated = /^([a-z][a-z0-9-]{0,63})\s+([\s\S]+)$/.exec(args);
          const role = definitions.find(item => item.id === delegated?.[1]); if (!role || !delegated?.[2]?.trim()) throw new Error('Choose a registered role and provide a task.');
          const expandedText = `Delegate the following task by calling the Agent tool with subagent_type=${role.id}, run_in_background=false. Return its actual findings. Task: ${delegated[2]}`;
          command = { kind: 'subagent', name, originalText: text, expandedText, requiredRoles: [role.id] };
        } else {
          const template = loaded.find(item => item.name === name); if (!template) throw new Error('Unknown input command.');
          const expandedText = options.expandPromptTemplate(text, loaded);
          const requiredRoles = [...template.content.matchAll(/subagent_type=([a-z][a-z0-9-]*)/g)].map(match => match[1]!);
          if (requiredRoles.some(id => !definitions.some(role => role.id === id))) throw new Error('Template requires an unknown role.');
          command = { kind: 'template', name, originalText: text, expandedText, requiredRoles };
        }
      }
      const frozenTemplates = loaded.map(item => ({ name: item.name, description: item.description, content: item.content,
        filePath: item.filePath }));
      return FrozenInputDefinitionsSchema.parse({ roles: definitions, templates: frozenTemplates,
        command });
    }),
  };
}
export type InputDefinitions = ReturnType<typeof createInputDefinitions>;
