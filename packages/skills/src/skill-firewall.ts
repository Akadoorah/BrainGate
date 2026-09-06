import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { BrainGateInvariantError, type RegisteredProject } from "@braingate/core";
import { SecretGuard } from "@braingate/security";

export type SkillScope = "global" | "project";
export type SkillRisk = "low" | "medium" | "high" | "critical";
export type SkillRole = "scout" | "planner" | "coder" | "reviewer" | "judge" | "visual";
export type SkillFilesystem = "read-only" | "worktree-write";

export interface SkillManifest {
  readonly skillId: string;
  readonly scope: SkillScope;
  readonly projectId: string | null;
  readonly risk: SkillRisk;
  readonly allowedRoles: readonly SkillRole[];
  readonly network: boolean;
  readonly filesystem: SkillFilesystem;
  readonly autoLoad: boolean;
  readonly safeGlobal: boolean;
}

export interface LoadedSkill {
  readonly manifest: SkillManifest;
  readonly content: string;
  readonly sourcePath: string;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validate(manifest: SkillManifest): void {
  if (!ID.test(manifest.skillId)) throw new BrainGateInvariantError("SKILL_ID_INVALID", "Invalid skill_id.");
  if (manifest.allowedRoles.length === 0) throw new BrainGateInvariantError("SKILL_ROLES_INVALID", "Skill requires at least one allowed role.");
  if (manifest.scope === "global") {
    if (manifest.projectId !== null || !manifest.safeGlobal) throw new BrainGateInvariantError("SKILL_GLOBAL_UNSAFE", "Global skills must be explicitly safeGlobal and cannot carry project_id.");
  } else if (manifest.projectId === null || !ID.test(manifest.projectId)) {
    throw new BrainGateInvariantError("SKILL_PROJECT_INVALID", "Project skill requires a valid project_id.");
  }
  if ((manifest.risk === "high" || manifest.risk === "critical") && manifest.autoLoad) {
    throw new BrainGateInvariantError("SKILL_AUTOLOAD_RISK", "High/critical skills cannot auto-load.");
  }
}

export class SkillFirewall {
  readonly #root: string;
  readonly #skills = new Map<string, LoadedSkill>();
  readonly #secretGuard = new SecretGuard();

  constructor(root: string) {
    this.#root = realpathSync.native(root);
  }

  register(manifest: SkillManifest): LoadedSkill {
    validate(manifest);
    if (this.#skills.has(manifest.skillId)) throw new BrainGateInvariantError("SKILL_DUPLICATE", `Duplicate skill ${manifest.skillId}.`);
    const expectedRoot = manifest.scope === "global"
      ? join(this.#root, "global", manifest.skillId)
      : join(this.#root, "projects", manifest.projectId!, manifest.skillId);
    const realExpected = realpathSync.native(expectedRoot);
    if (!inside(this.#root, realExpected)) throw new BrainGateInvariantError("SKILL_PATH_ESCAPE", "Skill directory escapes skill root.");
    const skillPath = this.#secretGuard.assertReadablePath(realExpected, "SKILL.md");
    const loaded = Object.freeze({ manifest: Object.freeze({ ...manifest }), content: readFileSync(skillPath, "utf8"), sourcePath: skillPath });
    this.#skills.set(manifest.skillId, loaded);
    return loaded;
  }

  resolve(input: {
    project: RegisteredProject;
    requestedIds: readonly string[];
    role: SkillRole;
    profile: "read-only" | "worktree-write" | "verify";
    networkAllowed: boolean;
    autoLoadOnly?: boolean;
  }): readonly LoadedSkill[] {
    const result: LoadedSkill[] = [];
    for (const id of input.requestedIds) {
      const skill = this.#skills.get(id);
      if (skill === undefined) throw new BrainGateInvariantError("SKILL_UNKNOWN", `Unknown skill ${id}.`);
      if (skill.manifest.scope === "project" && skill.manifest.projectId !== input.project.projectId) {
        throw new BrainGateInvariantError("SKILL_PROJECT_MISMATCH", `Skill ${id} belongs to another project.`);
      }
      if (!skill.manifest.allowedRoles.includes(input.role)) throw new BrainGateInvariantError("SKILL_ROLE_DENIED", `Skill ${id} is not allowed for role ${input.role}.`);
      if (input.autoLoadOnly && !skill.manifest.autoLoad) continue;
      if (skill.manifest.network && !input.networkAllowed) throw new BrainGateInvariantError("SKILL_NETWORK_DENIED", `Skill ${id} requests network access.`);
      if (skill.manifest.filesystem === "worktree-write" && input.profile !== "worktree-write") {
        throw new BrainGateInvariantError("SKILL_FILESYSTEM_DENIED", `Skill ${id} requests broader filesystem access than the execution profile.`);
      }
      result.push(skill);
    }
    return Object.freeze(result);
  }
}
