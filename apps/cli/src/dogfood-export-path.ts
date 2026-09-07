import { isAbsolute } from "node:path";

export interface DogfoodExportPathCheck {
  readonly safe: boolean;
  readonly reason: string | null;
}

export function checkDogfoodExportPath(argv: readonly string[]): DogfoodExportPathCheck {
  if (argv[0] !== "dogfood" || argv[1] !== "export") return Object.freeze({ safe: true, reason: null });

  const index = argv.indexOf("--output");
  if (index < 0) return Object.freeze({ safe: true, reason: null });

  const raw = argv[index + 1];
  if (raw === undefined || raw.startsWith("--")) return Object.freeze({ safe: true, reason: null });
  if (isAbsolute(raw)) return Object.freeze({ safe: false, reason: "Dogfood export output must stay under the local .brain directory." });

  const normalized = raw.replaceAll("\\", "/");
  if (!normalized.startsWith(".brain/")) return Object.freeze({ safe: false, reason: "Dogfood export output must stay under the local .brain directory." });

  const fileName = normalized.slice(".brain/".length);
  if (fileName.length === 0 || fileName === "." || fileName === ".." || fileName.includes("/")) {
    return Object.freeze({ safe: false, reason: "Dogfood export output must be a direct file inside .brain; nested or traversal paths are denied." });
  }

  return Object.freeze({ safe: true, reason: null });
}
