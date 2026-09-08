import { runCli } from "./cli.js";
import { runDogfoodCli } from "./dogfood-cli.js";
import { checkDogfoodExportPath } from "./dogfood-export-path.js";
import { runMemoryCli } from "./memory-cli.js";
import { runModelProfileCli } from "./model-profile-cli.js";

const args = process.argv.slice(2);
const exportPath = checkDogfoodExportPath(args);

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
    : args[0] === "memory"
      ? await runMemoryCli(args)
      : args[0] === "models" && args[1] === "profile"
        ? await runModelProfileCli(args)
        : await runCli(args);
  process.exitCode = result.exitCode;
}
