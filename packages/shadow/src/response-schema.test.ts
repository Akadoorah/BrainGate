import test from "node:test";
import assert from "node:assert/strict";
import { BrainGateInvariantError } from "@braingate/core";
import { jsonSchemaArgument, jsonSchemaFor } from "./response-schema.js";

test("the reviewer contract becomes a schema that admits exactly the allowed verdicts", () => {
  const schema = jsonSchemaFor({ kind: "review", verdict: ["approve", "request_changes", "disagree"], findings: "string[]" }) as {
    properties: Record<string, Record<string, unknown>>;
    required: readonly string[];
    additionalProperties: boolean;
  };
  assert.deepEqual(schema.properties.verdict, { type: "string", enum: ["approve", "request_changes", "disagree"] });
  assert.deepEqual(schema.properties.findings, { type: "array", items: { type: "string" } });
  assert.deepEqual(schema.properties.kind, { type: "string", const: "review" });
  assert.deepEqual([...schema.required], ["kind", "verdict", "findings"]);
  assert.equal(schema.additionalProperties, false);
});

test("a free-text field stays free text", () => {
  const schema = jsonSchemaFor({ kind: "work", output: "string" }) as { properties: Record<string, unknown> };
  assert.deepEqual(schema.properties.output, { type: "string" });
});

test("the literal that restates the role is pinned, so a provider cannot answer as another role", () => {
  const schema = jsonSchemaFor({ kind: "judge", verdict: ["approve", "request_changes"], rationale: "string", findings: "string[]" }) as {
    properties: Record<string, Record<string, unknown>>;
  };
  assert.equal(schema.properties.kind!.const, "judge");
});

test("a contract that describes nothing is refused rather than sent as an empty schema", () => {
  assert.throws(() => jsonSchemaFor({}), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "SHADOW_CONTRACT_EMPTY");
});

test("a field described by something that is not a type, a list or a literal is refused", () => {
  assert.throws(() => jsonSchemaFor({ kind: 7 }), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "SHADOW_CONTRACT_INVALID");
  assert.throws(() => jsonSchemaFor({ verdict: [] }), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "SHADOW_CONTRACT_INVALID");
});

test("the flag form is one line of JSON, so it survives a command line", () => {
  const argument = jsonSchemaArgument({ kind: "work", output: "string" });
  assert.doesNotMatch(argument, /\n/);
  assert.deepEqual(JSON.parse(argument), jsonSchemaFor({ kind: "work", output: "string" }));
});
