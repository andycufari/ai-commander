import { z } from "zod";

/**
 * Minimal zod → JSON Schema for the API `tools` field.
 *
 * Deliberately not a dependency: the tool schemas in packages/protocol use a small
 * corner of zod (objects, strings, numbers, booleans, enums, arrays, records, optional,
 * default, passthrough) and that is all this needs to cover. Anything unrecognised
 * degrades to an unconstrained value rather than throwing, so an exotic schema still
 * produces a usable tool definition.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as Record<string, unknown>;
  const typeName = def.typeName as string;

  switch (typeName) {
    case "ZodObject": {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const field = value as z.ZodTypeAny;
        properties[key] = zodToJsonSchema(field);
        if (!field.isOptional()) required.push(key);
      }
      const out: Record<string, unknown> = { type: "object", properties };
      if (required.length) out.required = required;
      // passthrough schemas (git) accept extra keys
      if ((def.unknownKeys as string) === "passthrough") out.additionalProperties = true;
      return out;
    }
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return (def.checks as { kind: string }[] | undefined)?.some((c) => c.kind === "int")
        ? { type: "integer" }
        : { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: def.values as string[] };
    case "ZodArray":
      return { type: "array", items: zodToJsonSchema(def.type as z.ZodTypeAny) };
    case "ZodRecord":
      return { type: "object", additionalProperties: true };
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return zodToJsonSchema((def.innerType as z.ZodTypeAny));
    case "ZodEffects":
      return zodToJsonSchema(def.schema as z.ZodTypeAny);
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = (def.options as z.ZodTypeAny[] | Map<string, z.ZodTypeAny>);
      const list = Array.isArray(options) ? options : [...options.values()];
      return { anyOf: list.map(zodToJsonSchema) };
    }
    case "ZodLiteral":
      return { const: def.value };
    default:
      return {};
  }
}
