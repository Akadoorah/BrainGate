// Bundles the CLI into a single `dist/main.js` so a packed tarball can run without `tsx` or a
// TypeScript toolchain on the installing machine. `better-sqlite3` ships a native addon, so it
// stays external and is installed normally from the packed `dependencies` field instead of being
// inlined into the bundle.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(scriptsDir, "..");

await build({
  entryPoints: [path.join(cliDir, "src/main.ts")],
  outfile: path.join(cliDir, "dist/main.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["better-sqlite3"],
  sourcemap: true,
  logLevel: "info",
  banner: {
    // esbuild's ESM output does not provide `require`/`__dirname`, and a bundled dependency may
    // still reach for one of them even under `platform: "node"`.
    js:
      "import { createRequire as __braingateCreateRequire } from 'node:module';\n" +
      "import { fileURLToPath as __braingateFileURLToPath } from 'node:url';\n" +
      "import { dirname as __braingateDirname } from 'node:path';\n" +
      "const require = __braingateCreateRequire(import.meta.url);\n" +
      "const __filename = __braingateFileURLToPath(import.meta.url);\n" +
      "const __dirname = __braingateDirname(__filename);\n",
  },
});
