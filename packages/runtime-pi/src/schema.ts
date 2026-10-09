import { Type, type TSchema } from '@earendil-works/pi-ai';
import { z } from 'zod';

type ZodNodeDefinition = {
  typeName: string;
  unknownKeys?: string;
  catchall?: z.ZodTypeAny;
  shape?: () => Record<string, z.ZodTypeAny>;
  checks?: readonly {
    kind: string;
    value?: number;
    inclusive?: boolean;
    regex?: RegExp;
  }[];
  values?: readonly (string | number)[];
  value?: string | number | boolean | null;
  coerce?: boolean;
  options?: readonly z.ZodTypeAny[];
  type?: z.ZodTypeAny;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  effect?: { type: string };
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  exactLength?: { value: number } | null;
};

function unsupported(path = 'root'): never {
  throw new Error(`tool_schema_unsupported:${path}`);
}

function nodeDefinition(schema: z.ZodTypeAny): ZodNodeDefinition {
  return schema._def as ZodNodeDefinition;
}

function convert(schema: z.ZodTypeAny, path = 'root'): TSchema {
  const def = nodeDefinition(schema);
  switch (def.typeName) {
    case 'ZodEffects':
      // Custom refinements still run in prepareArguments and Executor; transformations remain unsupported.
      return def.effect?.type === 'refinement' && def.schema ? convert(def.schema, path) : unsupported(path);
    case 'ZodOptional':
      return def.innerType ? Type.Optional(convert(def.innerType, path)) : unsupported(path);
    case 'ZodObject': {
      if (def.unknownKeys !== 'strict' || !def.shape || !def.catchall
        || nodeDefinition(def.catchall).typeName !== 'ZodNever') return unsupported(path);
      const properties: Record<string, TSchema> = {};
      for (const [key, child] of Object.entries(def.shape())) properties[key] = convert(child, `${path}.${key}`);
      return Type.Object(properties, { additionalProperties: false });
    }
    case 'ZodString': {
      if (def.coerce) return unsupported(path);
      let minLength: number | undefined;
      let maxLength: number | undefined;
      let pattern: string | undefined;
      for (const check of def.checks ?? []) {
        if (check.kind === 'min' && typeof check.value === 'number') minLength = Math.max(minLength ?? check.value, check.value);
        else if (check.kind === 'max' && typeof check.value === 'number') maxLength = Math.min(maxLength ?? check.value, check.value);
        else if (check.kind === 'regex' && check.regex && check.regex.flags === '' && pattern === undefined) pattern = check.regex.source;
        else return unsupported(path);
      }
      return Type.String({ minLength, maxLength, pattern });
    }
    case 'ZodNumber': {
      if (def.coerce) return unsupported(path);
      let integer = false;
      let minimum: number | undefined;
      let maximum: number | undefined;
      let exclusiveMinimum: number | undefined;
      let exclusiveMaximum: number | undefined;
      for (const check of def.checks ?? []) {
        if (check.kind === 'int' || check.kind === 'finite') integer ||= check.kind === 'int';
        else if (check.kind === 'min' && typeof check.value === 'number') {
          const current = exclusiveMinimum === undefined
            ? minimum === undefined ? undefined : { value: minimum, inclusive: true }
            : { value: exclusiveMinimum, inclusive: false };
          const candidate = { value: check.value, inclusive: check.inclusive !== false };
          const strongest = !current || candidate.value > current.value
            || (candidate.value === current.value && !candidate.inclusive && current.inclusive)
            ? candidate : current;
          minimum = strongest.inclusive ? strongest.value : undefined;
          exclusiveMinimum = strongest.inclusive ? undefined : strongest.value;
        } else if (check.kind === 'max' && typeof check.value === 'number') {
          const current = exclusiveMaximum === undefined
            ? maximum === undefined ? undefined : { value: maximum, inclusive: true }
            : { value: exclusiveMaximum, inclusive: false };
          const candidate = { value: check.value, inclusive: check.inclusive !== false };
          const strongest = !current || candidate.value < current.value
            || (candidate.value === current.value && !candidate.inclusive && current.inclusive)
            ? candidate : current;
          maximum = strongest.inclusive ? strongest.value : undefined;
          exclusiveMaximum = strongest.inclusive ? undefined : strongest.value;
        } else return unsupported(path);
      }
      return integer
        ? Type.Integer({ minimum, maximum, exclusiveMinimum, exclusiveMaximum })
        : Type.Number({ minimum, maximum, exclusiveMinimum, exclusiveMaximum });
    }
    case 'ZodEnum': {
      if (!def.values?.length) return unsupported(path);
      return Type.Union(def.values.map((value) => Type.Literal(value)) as unknown as [TSchema, TSchema, ...TSchema[]]);
    }
    case 'ZodLiteral': {
      if (typeof def.value !== 'string' && typeof def.value !== 'number' && typeof def.value !== 'boolean') return unsupported(path);
      return Type.Literal(def.value);
    }
    case 'ZodArray': {
      if (!def.type || def.exactLength) return unsupported(path);
      const minItems = def.minLength?.value;
      const maxItems = def.maxLength?.value;
      return Type.Array(convert(def.type, `${path}[]`), { minItems, maxItems });
    }
    case 'ZodNullable':
      return def.innerType ? Type.Union([convert(def.innerType, `${path}?`), Type.Null()]) : unsupported(path);
    case 'ZodUnion': {
      if (!def.options || def.options.length < 2) return unsupported(path);
      return Type.Union(def.options.map((option, index) => convert(option, `${path}|${index}`)) as unknown as [TSchema, TSchema, ...TSchema[]]);
    }
    default:
      return unsupported(path);
  }
}

/** Convert only the Zod subset used by P3 tool inputs. Unknown nodes fail closed. */
export function toPiParameters(schema: z.ZodTypeAny): TSchema {
  const parameters = convert(schema);
  const def = nodeDefinition(schema);
  if (def.typeName !== 'ZodUnion') return parameters;
  if (!def.options?.every((option) => nodeDefinition(option).typeName === 'ZodObject')) return unsupported();
  // Object unions need an explicit root type for Responses APIs; anyOf still enforces each branch.
  return { ...parameters, type: 'object' } as TSchema;
}
