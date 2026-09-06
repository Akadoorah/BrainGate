import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BrainGateInvariantError } from "./errors.js";

export type ProjectId = string & { readonly __brand: "ProjectId" };

export interface ProjectConfig {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly repositories: readonly string[];
}

const REGISTERED_PROJECT_MARKER = Symbol("braingate.registered-project");

export interface RegisteredProject extends ProjectConfig {
  readonly storageDir: string;
  readonly [REGISTERED_PROJECT_MARKER]: true;
}

const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrainGateInvariantError("PROJECT_CONFIG_INVALID", "Project config must be an object.");
  }
  return value as Record<string, unknown>;
}

export function parseProjectId(value: unknown): ProjectId {
  if (typeof value !== "string" || !PROJECT_ID_PATTERN.test(value)) {
    throw new BrainGateInvariantError(
      "PROJECT_ID_INVALID",
      "project_id must be 1-64 lowercase alphanumeric/hyphen characters and cannot start or end with a hyphen.",
    );
  }
  return value as ProjectId;
}

function canonicalRepositoryPath(repository: string, baseDir: string): string {
  const candidate = resolve(baseDir, repository);
  try {
    if (!statSync(candidate).isDirectory()) {
      throw new BrainGateInvariantError("PROJECT_REPOSITORY_INVALID", `Repository path is not a directory: ${candidate}`);
    }
    return realpathSync.native(candidate);
  } catch (error) {
    if (error instanceof BrainGateInvariantError) throw error;
    throw new BrainGateInvariantError(
      "PROJECT_REPOSITORY_NOT_FOUND",
      `Repository path does not exist or cannot be resolved: ${candidate}`,
    );
  }
}

export function parseProjectConfig(value: unknown, baseDir = process.cwd()): ProjectConfig {
  const input = asRecord(value);
  const projectId = parseProjectId(input.project_id);
  const name = input.name;
  const repositories = input.repositories;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new BrainGateInvariantError("PROJECT_NAME_INVALID", "Project name must be a non-empty string.");
  }
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new BrainGateInvariantError("PROJECT_REPOSITORIES_INVALID", "At least one repository is required.");
  }

  const resolvedRepositories = repositories.map((repository) => {
    if (typeof repository !== "string" || repository.trim().length === 0) {
      throw new BrainGateInvariantError("PROJECT_REPOSITORY_INVALID", "Repository paths must be non-empty strings.");
    }
    return canonicalRepositoryPath(repository, baseDir);
  });

  if (new Set(resolvedRepositories).size !== resolvedRepositories.length) {
    throw new BrainGateInvariantError("PROJECT_REPOSITORY_DUPLICATE", "A project cannot map the same repository twice.");
  }

  return Object.freeze({ projectId, name: name.trim(), repositories: Object.freeze(resolvedRepositories) });
}

export function assertRegisteredProject(project: RegisteredProject): void {
  if (project[REGISTERED_PROJECT_MARKER] !== true) {
    throw new BrainGateInvariantError(
      "PROJECT_HANDLE_INVALID",
      "Task execution requires a project handle issued by ProjectRegistry.",
    );
  }
}

export class ProjectRegistry {
  readonly #storageRoot: string;
  readonly #projects = new Map<ProjectId, RegisteredProject>();
  readonly #repositoryOwners = new Map<string, ProjectId>();

  constructor(storageRoot: string) {
    this.#storageRoot = resolve(storageRoot);
    mkdirSync(join(this.#storageRoot, "projects"), { recursive: true });
  }

  register(config: ProjectConfig): RegisteredProject {
    if (this.#projects.has(config.projectId)) {
      throw new BrainGateInvariantError("PROJECT_ID_CONFLICT", `Project ${config.projectId} is already registered.`);
    }

    for (const repository of config.repositories) {
      const owner = this.#repositoryOwners.get(repository);
      if (owner !== undefined) {
        throw new BrainGateInvariantError(
          "PROJECT_REPOSITORY_CONFLICT",
          `Repository ${repository} is already mapped to project ${owner}.`,
        );
      }
    }

    const storageDir = join(this.#storageRoot, "projects", config.projectId);
    mkdirSync(storageDir, { recursive: true });

    const registered = Object.freeze({ ...config, storageDir, [REGISTERED_PROJECT_MARKER]: true as const });
    this.#projects.set(config.projectId, registered);
    for (const repository of config.repositories) {
      this.#repositoryOwners.set(repository, config.projectId);
    }
    return registered;
  }

  loadFile(filePath: string): RegisteredProject {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return this.register(parseProjectConfig(raw, dirname(resolve(filePath))));
  }

  get(projectId: string): RegisteredProject | undefined {
    return this.#projects.get(parseProjectId(projectId));
  }

  require(projectId: string): RegisteredProject {
    const project = this.get(projectId);
    if (project === undefined) {
      throw new BrainGateInvariantError("PROJECT_NOT_FOUND", `Unknown project_id: ${projectId}`);
    }
    return project;
  }

  resolveRepository(repositoryPath: string): RegisteredProject | undefined {
    let canonical: string;
    try {
      canonical = canonicalRepositoryPath(repositoryPath, process.cwd());
    } catch {
      return undefined;
    }
    const owner = this.#repositoryOwners.get(canonical);
    return owner === undefined ? undefined : this.#projects.get(owner);
  }

  list(): readonly RegisteredProject[] {
    return Object.freeze([...this.#projects.values()]);
  }
}
