import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrainGateInvariantError, ProjectRegistry, parseProjectConfig } from "@braingate/core";
import { SkillFirewall, type SkillManifest } from "./index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "braingate-skills-"));
  const repoA = join(root, "repo-a"); const repoB = join(root, "repo-b"); mkdirSync(repoA); mkdirSync(repoB);
  const registry = new ProjectRegistry(join(root, "state"));
  const a = registry.register(parseProjectConfig({ project_id: "waslo", name: "Waslo", repositories: [repoA] }));
  const b = registry.register(parseProjectConfig({ project_id: "tabaq", name: "Tabaq", repositories: [repoB] }));
  const skillRoot = join(root, "skills");
  const make = (path: string) => { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "SKILL.md"), "Safe skill instructions"); };
  make(join(skillRoot, "global", "typescript")); make(join(skillRoot, "projects", "waslo", "shopify")); make(join(skillRoot, "projects", "tabaq", "ios"));
  const firewall = new SkillFirewall(skillRoot);
  return { a, b, firewall };
}

const base = (skillId: string, projectId: string | null): SkillManifest => ({
  skillId, scope: projectId === null ? "global" : "project", projectId, risk: "low", allowedRoles: ["coder"],
  network: false, filesystem: "read-only", autoLoad: true, safeGlobal: projectId === null,
});

test("project skills cannot cross project boundaries", () => {
  const { a, b, firewall } = fixture();
  firewall.register(base("shopify", "waslo")); firewall.register(base("ios", "tabaq"));
  assert.equal(firewall.resolve({ project: a, requestedIds: ["shopify"], role: "coder", profile: "read-only", networkAllowed: false }).length, 1);
  assert.throws(() => firewall.resolve({ project: b, requestedIds: ["shopify"], role: "coder", profile: "read-only", networkAllowed: false }), (e: unknown) => e instanceof BrainGateInvariantError && e.code === "SKILL_PROJECT_MISMATCH");
});

test("global, risky, role, network and filesystem policy fail closed", () => {
  const { a, firewall } = fixture();
  firewall.register(base("typescript", null));
  assert.equal(firewall.resolve({ project: a, requestedIds: ["typescript"], role: "coder", profile: "read-only", networkAllowed: false }).length, 1);
  assert.throws(() => firewall.register({ ...base("bad-global", null), safeGlobal: false }), /Global skills/);
  assert.throws(() => firewall.register({ ...base("risky", "waslo"), risk: "high", autoLoad: true }), /cannot auto-load/);
  assert.throws(() => firewall.resolve({ project: a, requestedIds: ["missing"], role: "coder", profile: "read-only", networkAllowed: false }), /Unknown skill/);
});
