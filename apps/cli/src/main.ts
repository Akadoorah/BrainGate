import { abortActiveRuns } from "@braingate/core";
import { abortTrackedChildren } from "@braingate/shadow";
import { runCli } from "./cli.js";
import { runDogfoodCli } from "./dogfood-cli.js";
import { checkDogfoodExportPath } from "./dogfood-export-path.js";
import { runMemoryCli } from "./memory-cli.js";
import { runModelProfileCli } from "./model-profile-cli.js";
import { runTasksCli } from "./tasks-cli.js";

const args = process.argv.slice(2);
const exportPath = checkDogfoodExportPath(args);

/**
 * The one moment BrainGate is told it is about to stop.
 *
 * A provider CLI is a child process, and a terminal Ctrl-C delivers SIGINT to the foreground
 * *process group* — so a real interactive Ctrl-C already reaches the provider. A signal sent to
 * BrainGate alone (a supervisor, a script, `kill`) does not, and the run died with the task left
 * `running` and a subscription still being spent. Both ends are handled here: the run records an
 * INTERRUPTED outcome, and any child that is still alive is killed rather than orphaned.
 *
 * The exit codes are the shell's convention: 130 for SIGINT, 143 for SIGTERM.
 */
function handleTermination(signal: "SIGINT" | "SIGTERM"): void {
  abortActiveRuns(signal);
  abortTrackedChildren();
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.on("SIGINT", () => { handleTermination("SIGINT"); });
process.on("SIGTERM", () => { handleTermination("SIGTERM"); });

if (!exportPath.safe) {
  process.stderr.write(`BrainGate DOGFOOD_EXPORT_PATH_DENIED: ${exportPath.reason}\n`);
  process.exitCode = 1;
} else if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
  // Bare `braingate` at a terminal opens the interactive session. Piped or scripted, it falls
  // through to the command listing, so nothing that reads this output changes behaviour.
  const { runReplOnTerminal } = await import("./repl.js");
  process.exitCode = await runReplOnTerminal(process.cwd());
} else {
  const result = args[0] === "init" || args[0] === "dogfood"
    ? await runDogfoodCli(args)
    : args[0] === "tasks"
      ? await runTasksCli(args.slice(1))
      : args[0] === "memory"
        ? await runMemoryCli(args)
        : args[0] === "models" && args[1] === "profile"
          ? await runModelProfileCli(args)
          : await runCli(args);
  process.exitCode = result.exitCode;
}
