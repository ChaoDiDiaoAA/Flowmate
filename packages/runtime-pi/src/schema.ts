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
  options?: readonly z.ZodTypeAny[];
  type?: z.ZodTypeAny;
  innerType?: z.ZodTypeAny;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
};

function unsupported(): never {
  throw new Error('tool_schema_unsupported');
}

function nodeDefinition(schema: z.ZodTypeAny): ZodNodeDefinition {
  return schema._def as ZodNodeDefinition;
}

function convert(schema: z.ZodTypeAny): TSchema {
  const def = nodeDefinition(schema);
  switch (def.typeName) {
    case 'ZodObject': {
      if (def.unknownKeys !== 'strict' || !def.shape || !def.catchall
        || nodeDefinition(def.catchall).typeName !== 'ZodNever') return unsupported();
      const properties: Record<string, TSchema> = {};
      for (const [key, child] of Object.entries(def.shape())) properties[key] = convert(child);
      return Type.Object(properties, { additionalProperties: false });
    }
    case 'ZodString': {
      let minLength: number | undefined;
      let maxLength: number | undefined;
      let pattern: string | undefined;
      for (const check of def.checks ?? []) {
        if (check.kind === 'min' && typeof check.value === 'number') minLength = check.value;
        else if (check.kind === 'max' && typeof check.value === 'number') maxLength = check.value;
        else if (check.kind === 'regex' && check.regex && check.regex.flags === '') pattern = check.regex.source;
        else return unsupported();
      }
      return Type.String({ minLength, maxLength, pattern });
    }
    case 'ZodNumber': {
      let integer = false;
      let minimum: number | undefined;
      let maximum: number | undefined;
      let exclusiveMinimum: number | undefined;
      let exclusiveMaximum: number | undefined;
      for (const check of def.checks ?? []) {
        if (check.kind === 'int' || check.kind === 'finite') integer ||= check.kind === 'int';
        else if (check.kind === 'min' && typeof check.value === 'number') {
          if (check.inclusive === false) exclusiveMinimum = check.value;
          else minimum = check.value;
        } else if (check.kind === 'max' && typeof check.value === 'number') {
          if (check.inclusive === false) exclusiveMaximum = check.value;
          else maximum = check.value;
        } else return unsupported();
      }
      return integer
        ? Type.Integer({ minimum, maximum, exclusiveMinimum, exclusiveMaximum })
        : Type.Number({ minimum, maximum, exclusiveMinimum, exclusiveMaximum });
    }
    case 'ZodEnum': {
      if (!def.values?.length) return unsupported();
      return Type.Union(def.values.map((value) => Type.Literal(value)) as [TSchema, TSchema, ...TSchema[]]);
    }
    case 'ZodLiteral': {
      if (def.value === undefined) return unsupported();
      return Type.Literal(def.value);
    }
    case 'ZodArray': {
      if (!def.type) return unsupported();
      let minItems: number | undefined;
      let maxItems: number | undefined;
      for (const check of def.checks ?? []) {
        if ((check.kind === 'min' || check.kind === 'max') && typeof check.value === 'number') {
          if (check.kind === 'min') minItems = check.value;
          else maxItems = check.value;
        } else return unsupported();
      }
      return Type.Array(convert(def.type), { minItems, maxItems });
    }
    case 'ZodNullable':
      return def.innerType ? Type.Union([convert(def.innerType), Type.Null()]) : unsupported();
    case 'ZodUnion': {
      if (!def.options || def.options.length < 2) return unsupported();
      return Type.Union(def.options.map(convert) as [TSchema, TSchema, ...TSchema[]]);
    }
    default:
      return unsupported();
  }
}

/** Convert only the Zod subset used by P3 tool inputs. Unknown nodes fail closed. */
export function toPiParameters(schema: z.ZodTypeAny): TSchema {
  if (nodeDefinition(schema).typeName !== 'ZodObject') return unsupported();
  return convert(schema);
}
