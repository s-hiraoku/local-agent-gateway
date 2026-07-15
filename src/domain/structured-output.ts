import { Ajv, type ValidateFunction } from "ajv";
import { GatewayError } from "./errors.js";

export type OutputSchema = Record<string, unknown>;

const maxSchemaBytes = 32 * 1024;
const maxSchemaDepth = 16;
const maxProperties = 128;
const allowedKeywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength"
]);

const ajv = new Ajv({ allErrors: false, strict: true, validateSchema: true });

export function validateOutputSchema(value: unknown): OutputSchema {
  if (!isRecord(value)) invalidSchema();
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > maxSchemaBytes) invalidSchema();

  let properties = 0;
  const inspect = (node: unknown, depth: number, inProperties = false): void => {
    if (depth > maxSchemaDepth) invalidSchema();
    if (Array.isArray(node)) {
      for (const item of node) inspect(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (!inProperties && !allowedKeywords.has(key)) invalidSchema();
      if (key === "properties") {
        if (!isRecord(child)) invalidSchema();
        properties += Object.keys(child).length;
        if (properties > maxProperties) invalidSchema();
        for (const schema of Object.values(child)) inspect(schema, depth + 1);
      } else if (key === "items" || key === "additionalProperties") {
        if (typeof child !== "boolean") inspect(child, depth + 1);
      }
    }
  };
  inspect(value, 0);

  try {
    ajv.compile(value);
  } catch {
    invalidSchema();
  }
  return value;
}

export function parseStructuredOutput(result: string, schema: OutputSchema): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result) as unknown;
  } catch {
    throw invalidOutput();
  }
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch {
    throw invalidOutput();
  }
  if (!validate(parsed)) throw invalidOutput();
  return parsed;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidSchema(): never {
  throw new GatewayError("INVALID_REQUEST", "outputSchema is not supported or exceeds its limits", 400);
}

function invalidOutput(): GatewayError {
  return new GatewayError(
    "STRUCTURED_OUTPUT_INVALID",
    "Codex returned output that did not match the requested schema",
    502,
    false
  );
}
