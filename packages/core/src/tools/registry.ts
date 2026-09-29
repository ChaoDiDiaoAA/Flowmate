import { ToolEffectSchema, ToolExecutionModeSchema } from '@flowmate/contracts';
import type { ToolDefinition } from '@flowmate/contracts';

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition<any, any>>();

  public constructor(definitions: readonly ToolDefinition<any, any>[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  public register(definition: ToolDefinition<any, any>): void {
    if (!definition || typeof definition.name !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(definition.name)
      || typeof definition.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(definition.version)
      || typeof definition.description !== 'string' || !definition.description.trim() || definition.description.length > 4096
      || !ToolEffectSchema.safeParse(definition.effect).success
      || !ToolExecutionModeSchema.safeParse(definition.executionMode).success
      || !definition.inputSchema || typeof definition.inputSchema.safeParse !== 'function'
      || !definition.outputSchema || typeof definition.outputSchema.safeParse !== 'function'
      || typeof definition.execute !== 'function'
      || (definition.label !== undefined && (typeof definition.label !== 'string' || !definition.label.trim() || definition.label.length > 128))) {
      throw new Error('tool_definition_invalid');
    }
    if (this.definitions.has(definition.name)) throw new Error('tool_name_duplicate');
    this.definitions.set(definition.name, Object.freeze({ ...definition }));
  }

  public get(name: string): ToolDefinition<any, any> | undefined {
    return this.definitions.get(name);
  }

  public list(): readonly ToolDefinition<any, any>[] {
    return [...this.definitions.values()];
  }
}
