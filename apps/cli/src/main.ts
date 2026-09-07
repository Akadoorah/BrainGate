import { runCli } from "./cli.js";
import { runDogfoodCli } from "./dogfood-cli.js";

const args = process.argv.slice(2);
const result = args[0] === "init" || args[0] === "dogfood"
  ? await runDogfoodCli(args)
  : await runCli(args);
process.exitCode = result.exitCode;
