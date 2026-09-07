import { runCli } from "./cli.js";
import { runDogfoodCli } from "./dogfood-cli.js";
import { checkDogfoodExportPath } from "./dogfood-export-path.js";

const args = process.argv.slice(2);
const exportPath = checkDogfoodExportPath(args);

if (!exportPath.safe) {
  process.stderr.write(`BrainGate DOGFOOD_EXPORT_PATH_DENIED: ${exportPath.reason}\n`);
  process.exitCode = 1;
} else {
  const result = args[0] === "init" || args[0] === "dogfood"
    ? await runDogfoodCli(args)
    : await runCli(args);
  process.exitCode = result.exitCode;
}
