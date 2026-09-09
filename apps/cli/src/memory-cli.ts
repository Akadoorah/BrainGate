import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { BrainGateInvariantError, ProjectRegistry } from "@braingate/core";
import { MEMORY_KINDS, ProjectMemory, importMemoryPreview, previewMemoryImport, type MemoryImportFormat, type MemoryKind } from "@braingate/memory";
import { resolveOperatorState } from "@braingate/operator";

export interface MemoryCliDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export interface MemoryCliResult { readonly exitCode: number; readonly data: unknown; }

function removeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], name: string, required = false): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new BrainGateInvariantError("CLI_OPTION_REQUIRED", `Missing required option ${name}.`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new BrainGateInvariantError("CLI_OPTION_INVALID", `Option ${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

function takeRepeated(args: string[], name: string): readonly string[] {
  const values: string[] = [];
  for (;;) {
    const index = args.indexOf(name);
    if (index < 0) break;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new BrainGateInvariantError("CLI_OPTION_INVALID", `Option ${name} requires a value.`);
    values.push(value);
    args.splice(index, 2);
  }
  return Object.freeze(values);
}

function noExtra(args: readonly string[]): void {
  if (args.length > 0) throw new BrainGateInvariantError("CLI_ARGUMENT_INVALID", `Unexpected CLI argument: ${args[0]}.`);
}

function safeError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof BrainGateInvariantError) return Object.freeze({ code: error.code, message: error.message });
  return Object.freeze({ code: "CLI_UNEXPECTED", message: "Unexpected memory bootstrap failure. Raw error details were suppressed." });
}

function emit(json: boolean, data: unknown, human: string, stdout: (value: string) => void): void {
  stdout(json ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`);
}

function parseFormat(value: string | undefined): MemoryImportFormat {
  if (value === undefined) return "auto";
  if (["auto", "text", "jsonl", "chatgpt"].includes(value)) return value as MemoryImportFormat;
  throw new BrainGateInvariantError("MEMORY_IMPORT_FORMAT_INVALID", "--format must be auto, text, jsonl, or chatgpt.");
}

export async function runMemoryCli(argv: readonly string[], deps: MemoryCliDependencies = {}): Promise<MemoryCliResult> {
  const args = [...argv];
  const json = removeFlag(args, "--json");
  const cwd = realpathSync.native(resolve(deps.cwd ?? process.cwd()));
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = deps.stderr ?? ((value: string) => process.stderr.write(value));
  let data: unknown = null;
  try {
    if (args.shift() !== "memory") throw new BrainGateInvariantError("CLI_COMMAND_INVALID", "Memory CLI requires the memory command.");
    const subcommand = args.shift();
    if (subcommand === undefined || subcommand === "help") {
      data = { commands: ["note", "preview", "import", "promote", "list", "proposals"] };
      emit(json, data, "Memory commands: note, preview, import, promote, list, proposals", stdout);
      return Object.freeze({ exitCode: 0, data });
    }

    const state = resolveOperatorState(env);
    const manifest = takeOption(args, "--project") ?? ".brain/project.json";
    const project = new ProjectRegistry(state.home).loadFile(resolve(cwd, manifest));
    const memory = new ProjectMemory(project);
    try {
      if (subcommand === "preview" || subcommand === "import") {
        const source = takeOption(args, "--source", true)!;
        const format = parseFormat(takeOption(args, "--format"));
        noExtra(args);
        const preview = previewMemoryImport(memory, { sourcePath: resolve(cwd, source), format });
        if (subcommand === "preview") {
          data = preview;
          emit(json, data, `Memory preview: ${preview.candidates.length} candidate(s), ${preview.duplicates} duplicate(s), format=${preview.format}. Nothing persisted.`, stdout);
          return Object.freeze({ exitCode: 0, data });
        }
        const proposals = importMemoryPreview(memory, preview, { proposedBy: "cli-memory-import" });
        data = { projectId: project.projectId, sourceName: preview.sourceName, format: preview.format, proposals, skippedDuplicates: preview.duplicates, canonicalRecordsCreated: 0 };
        emit(json, data, `Imported ${proposals.length} proposal(s); skipped ${preview.duplicates} canonical duplicate(s). No canonical memory was created.`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }

      /**
       * Records something the operator states themselves, as a proposal.
       *
       * The memory model was complete and unusable: making BrainGate know one sentence meant
       * writing a file, previewing it, importing it and promoting it. Nothing gets recorded that
       * way, which is why the store was empty — a gate nobody can reach is not a safeguard, it
       * is an absence.
       *
       * It stays a proposal. What the operator typed is a claim about the project, not a
       * verified one, and the evidence gate is what separates the two; this only removes the
       * file-shuffling between having something to say and its being on record. The proposer is
       * recorded as the operator rather than as BrainGate, because a model's own output must
       * never enter here — that is the boundary the session thread exists to keep.
       */
      if (subcommand === "note") {
        const body = takeOption(args, "--text", true)!;
        const kindRaw = takeOption(args, "--kind") ?? "verified_fact";
        if (!(MEMORY_KINDS as readonly string[]).includes(kindRaw)) {
          throw new BrainGateInvariantError("MEMORY_KIND_INVALID", `--kind must be one of: ${MEMORY_KINDS.join(", ")}.`);
        }
        noExtra(args);
        const proposal = memory.propose({
          kind: kindRaw as MemoryKind,
          body,
          reason: "Stated by the operator in this project.",
          sourceRefs: Object.freeze(["operator-note"]),
          proposedBy: "operator",
        });
        data = proposal;
        emit(
          json,
          data,
          [
            `Recorded proposal ${proposal.proposalId} (${proposal.kind}).`,
            "",
            "It is a proposal, not memory: tasks read canonical records only. Promote it when you",
            "can point at what makes it true:",
            `  braingate memory promote --proposal ${proposal.proposalId} --evidence <file-or-url> --confidence 0.9`,
          ].join("\n"),
          stdout,
        );
        return Object.freeze({ exitCode: 0, data });
      }

      if (subcommand === "proposals") {
        noExtra(args);
        data = memory.listProposals(20);
        const proposals = data as readonly { proposalId: string; kind: string; body: string; proposedBy: string; proposedAt: string }[];
        emit(
          json,
          data,
          proposals.length === 0
            ? "No proposals waiting. `braingate memory note --text \"...\"` records one."
            : proposals.map((item) => `${item.proposalId} · ${item.kind} · ${item.proposedBy} · ${item.body.slice(0, 90)}`).join("\n"),
          stdout,
        );
        return Object.freeze({ exitCode: 0, data });
      }

      if (subcommand === "promote") {
        const proposalId = takeOption(args, "--proposal", true)!;
        const evidence = takeRepeated(args, "--evidence");
        if (evidence.length === 0) throw new BrainGateInvariantError("MEMORY_EVIDENCE_REQUIRED", "memory promote requires at least one --evidence reference.");
        const confidenceRaw = takeOption(args, "--confidence", true)!;
        const confidence = Number(confidenceRaw);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new BrainGateInvariantError("MEMORY_CONFIDENCE_INVALID", "--confidence must be between 0 and 1.");
        const verifier = takeOption(args, "--verifier") ?? "human-cli";
        const commitRef = takeOption(args, "--commit");
        noExtra(args);
        const record = memory.supervisor().approve(proposalId, { verifier, evidenceRefs: evidence, confidence, ...(commitRef === undefined ? {} : { commitRef }) });
        data = record;
        emit(json, data, `Promoted proposal ${proposalId} to canonical memory record ${record.recordId}.`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }

      if (subcommand === "list") {
        const limitRaw = takeOption(args, "--limit");
        noExtra(args);
        const limit = limitRaw === undefined ? 10 : Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new BrainGateInvariantError("MEMORY_LIMIT_INVALID", "--limit must be an integer from 1 to 20.");
        data = memory.listEffective(limit);
        const records = data as ReturnType<ProjectMemory["listEffective"]>;
        emit(json, data, records.length === 0 ? "No effective canonical memory records." : records.map((record) => `${record.kind} · ${record.recordId} · ${record.body.slice(0, 100)}`).join("\n"), stdout);
        return Object.freeze({ exitCode: 0, data });
      }

      throw new BrainGateInvariantError("CLI_SUBCOMMAND_INVALID", "memory requires note, preview, import, promote, list, or proposals.");
    } finally { memory.close(); }
  } catch (error) {
    const safe = safeError(error);
    data = { error: safe };
    stderr(json ? `${JSON.stringify(data, null, 2)}\n` : `BrainGate ${safe.code}: ${safe.message}\n`);
    return Object.freeze({ exitCode: 1, data });
  }
}
