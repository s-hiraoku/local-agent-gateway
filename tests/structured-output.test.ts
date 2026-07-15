import { describe, expect, it } from "vitest";
import { canonicalJson, parseStructuredOutput, validateOutputSchema } from "../src/domain/structured-output.js";

describe("structured output", () => {
  it("validates the supported schema subset and result", () => {
    const schema = validateOutputSchema({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false
    });
    expect(parseStructuredOutput('{"answer":"yes"}', schema)).toEqual({ answer: "yes" });
    expect(() => parseStructuredOutput('{"answer":1}', schema)).toThrow(/requested schema/);
    expect(() => parseStructuredOutput('```json\n{"answer":"yes"}\n```', schema)).toThrow(/requested schema/);
  });

  it("rejects references and excessive nesting", () => {
    expect(() => validateOutputSchema({ $ref: "https://example.test/schema" })).toThrow(/not supported/);
    let schema: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 20; depth += 1) schema = { type: "array", items: schema };
    expect(() => validateOutputSchema(schema)).toThrow(/not supported/);
  });

  it("canonicalizes object key order for idempotency", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  });
});
