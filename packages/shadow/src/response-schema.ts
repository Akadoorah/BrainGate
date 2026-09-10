import { BrainGateInvariantError } from "@braingate/core";

/**
 * The role contract, expressed as a JSON Schema the provider itself enforces.
 *
 * BrainGate has always described the shape it wants in prose — eight sentences of it, ending in
 * a worked example, because a model that answers in markdown or nests its reply inside the
 * request fails the parse and costs the whole call. Every one of these CLIs now accepts a real
 * schema, so the shape can be a constraint the provider applies rather than an instruction it
 * may ignore.
 *
 * The vocabulary is the one the contracts already use, so nothing upstream changes:
 *
 * - `"string"` is a string field;
 * - `"string[]"` is an array of strings;
 * - an array of strings is the set of allowed values;
 * - any other literal is a fixed value the provider must echo — `kind`, which restates the role.
 */
export function jsonSchemaFor(contract: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const keys = Object.keys(contract);
  if (keys.length === 0) throw new BrainGateInvariantError("SHADOW_CONTRACT_EMPTY", "A response contract must describe at least one field.");
  const properties: Record<string, unknown> = {};
  for (const key of keys) {
    const described = contract[key];
    if (Array.isArray(described)) {
      const values = described.filter((item): item is string => typeof item === "string");
      if (values.length === 0) throw new BrainGateInvariantError("SHADOW_CONTRACT_INVALID", `Contract field ${key} lists no allowed values.`);
      properties[key] = { type: "string", enum: values };
      continue;
    }
    if (typeof described !== "string") {
      throw new BrainGateInvariantError("SHADOW_CONTRACT_INVALID", `Contract field ${key} must describe a type, an allowed-value list, or a literal.`);
    }
    if (described === "string") { properties[key] = { type: "string" }; continue; }
    if (described === "string[]") { properties[key] = { type: "array", items: { type: "string" } }; continue; }
    properties[key] = { type: "string", const: described };
  }
  return Object.freeze({
    type: "object",
    properties,
    required: keys,
    additionalProperties: false,
  });
}

/** The same schema as one line of JSON, for a CLI that takes it as a flag value. */
export function jsonSchemaArgument(contract: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(jsonSchemaFor(contract));
}
