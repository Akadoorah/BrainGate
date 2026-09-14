/**
 * What a request is actually about touching.
 *
 * Risk used to be decided by words anywhere in the request, matched as substrings. Real dogfood
 * turned that into a false positive twice in one sentence:
 *
 * ```text
 * Apply the agreed harmless comment-only change to the selected README file:
 * flutter_migration/…/LaunchImage.imageset/README.md
 * … do not use git checkout …
 * ```
 *
 * - `flutter_migration` contains `migration`, so the request was rated a database migration (T4,
 *   `sensitive-domain:database`) — a directory *name* promoting a Markdown comment to architecture.
 * - `do not use git checkout` contains `checkout`, which is a payments term, so the same request also
 *   read as payment work (`sensitive-domain:payments`). A constraint about a git command was read as
 *   a domain.
 *
 * Neither says anything about the change. What does say something is the **artifact**: a `.sql` file
 * under `migrations/` is a schema change whatever the sentence says, and `README.md` under a
 * directory called `payments/` is documentation whatever the directory is called. This module answers
 * that question, once, so the classifier can weigh the effect instead of the vocabulary.
 *
 * Deliberately small: extensions, basenames and path segments. It is not a static analyser, and it
 * does not try to read code — it decides what kind of file a request names, and whether that kind can
 * carry runtime risk at all.
 */

export const ARTIFACT_KINDS = ["documentation", "schema", "configuration", "code", "unknown"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

const DOCUMENTATION_EXTENSIONS: readonly string[] = Object.freeze(["md", "mdx", "txt", "rst", "adoc", "org"]);
const CONFIGURATION_EXTENSIONS: readonly string[] = Object.freeze(["json", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "lock"]);
const CODE_EXTENSIONS: readonly string[] = Object.freeze([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "dart",
  "php", "cs", "c", "h", "cc", "cpp", "hpp", "sh", "bash", "zsh", "ps1", "sql", "tf", "proto", "graphql",
]);
const DOCUMENTATION_BASENAMES = /^(readme|license|licence|changelog|changes|contributing|notes?|notice|authors|code_of_conduct|security)(\.|$)/i;

/** Path segments that mean "this directory holds schema migrations", not "this word is nearby". */
const MIGRATION_SEGMENTS: readonly string[] = Object.freeze(["migrations", "migration", "migrate", "schema", "schemas", "alembic", "flyway", "liquibase", "ddl", "seed", "seeds"]);

/**
 * Domain words a filesystem name has to *be*, not merely contain.
 *
 * The same class of mistake as `flutter_migration` lives one level down: a substring test over path
 * segments makes `author/` an authentication directory (it starts with `auth`), `keyboard/` a
 * security one (it starts with `key`), `product/` a deployment (it starts with `prod`) and
 * `certain.txt` a certificate. So a segment counts only when the whole segment — or the whole file
 * stem — is one of these words, and the list is the vocabulary that means the domain rather than the
 * letters that appear in it.
 *
 * Compound names are deliberately excluded: `flutter_migration/` is a project name, `user_auth/` is a
 * name that happens to contain a domain word, and neither is evidence about what a change does. The
 * prose of a request still carries that evidence, which is where it belongs.
 */
const SEGMENT_DOMAIN_TERMS: Readonly<Record<string, string>> = Object.freeze({
  auth: "auth", authentication: "auth", authn: "auth", authz: "auth", authorization: "auth",
  authorize: "auth", login: "auth", signin: "auth", signon: "auth", oauth: "auth", oidc: "auth", jwt: "auth",
  saml: "auth", session: "auth", sessions: "auth", permission: "auth", permissions: "auth", rbac: "auth",
  acl: "auth", password: "auth", passwords: "auth", credentials: "security", credential: "security",

  payment: "payments", payments: "payments", billing: "payments", invoice: "payments", invoices: "payments",
  stripe: "payments", refund: "payments", refunds: "payments", charge: "payments", charges: "payments",
  checkout: "payments", subscriptions: "payments", subscription: "payments", pricing: "payments",

  security: "security", secret: "security", secrets: "security", encryption: "security", encrypt: "security",
  crypto: "security", cryptography: "security", vault: "security", cert: "security", certs: "security",
  certificate: "security", certificates: "security", key: "security", keys: "security", keychain: "security",
  keystore: "security", tls: "security", ssl: "security",

  database: "database", databases: "database", db: "database", schema: "database", schemas: "database",
  migration: "database", migrations: "database", migrate: "database", migrator: "database",
  prisma: "database", sequelize: "database", knex: "database", alembic: "database", flyway: "database",
  seeds: "database", seed: "database",

  production: "production", prod: "production", deploy: "production", deploys: "production",
  deployment: "production", deployments: "production", release: "production", releases: "production",
  infra: "production", terraform: "production", kubernetes: "production", k8s: "production", helm: "production",
});

/** The domain a single filesystem name carries, if the whole name is a domain word. */
function domainOfName(name: string): string | null {
  const normalised = name.toLowerCase().replace(/^[._-]+|[._-]+$/g, "");
  return SEGMENT_DOMAIN_TERMS[normalised] ?? null;
}

/** Directory segments and the file stem, each read as one whole name. */
function namePartsOf(path: string): readonly string[] {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const basename = segments[segments.length - 1] ?? "";
  const dot = basename.lastIndexOf(".");
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  return Object.freeze([...segments.slice(0, -1), stem]);
}

/**
 * Path-like tokens in a request.
 *
 * A token with a separator or an extension: `a/b/README.md`, `migrations/001_x.sql`, `src/app.ts`. A
 * bare word is not a path, so `flutter_migration` on its own is left to the word-boundary rule in the
 * classifier rather than being treated as a file.
 */
export const PATH_TOKEN = /(?:[\w.@+-]+\/)+[\w.@+-]+|\b[\w-]+\.(?:[A-Za-z0-9]{1,6})\b/g;

export interface ArtifactAssessment {
  /** Every path-like token the request named, as written. */
  readonly paths: readonly string[];
  /** The most significant kind among them: schema and code outrank documentation. */
  readonly kind: ArtifactKind;
  /** True when the request names documentation and nothing else. */
  readonly documentationOnly: boolean;
  /** Domains the named artifacts themselves belong to. Documentation belongs to none. */
  readonly domains: readonly string[];
  /** True when a named artifact is a schema migration, which is architecture-level work. */
  readonly schemaMigration: boolean;
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function segmentsOf(path: string): readonly string[] {
  return Object.freeze(path.split("/").filter((segment) => segment.length > 0));
}

/** What kind of file this is, from its name and the directories it sits in. */
export function artifactKindOf(path: string): ArtifactKind {
  const extension = extensionOf(path);
  const basename = basenameOf(path);
  const segments = segmentsOf(path);
  const inMigrations = segments.some((segment) => MIGRATION_SEGMENTS.includes(segment.toLowerCase()));
  // A schema migration is a schema migration whatever it is written in and wherever it sits, and
  // documentation is documentation even inside `migrations/`.
  if (DOCUMENTATION_EXTENSIONS.includes(extension) || DOCUMENTATION_BASENAMES.test(basename)) return "documentation";
  if (extension === "sql" || inMigrations) return "schema";
  if (CONFIGURATION_EXTENSIONS.includes(extension)) return "configuration";
  if (CODE_EXTENSIONS.includes(extension)) return "code";
  return "unknown";
}

const KIND_WEIGHT: Readonly<Record<ArtifactKind, number>> = Object.freeze({
  documentation: 0, unknown: 1, configuration: 2, code: 3, schema: 4,
});

/**
 * What the request's artifacts say about risk.
 *
 * A documentation artifact contributes no domain at all: a README inside `payments/` is not payment
 * processing, and a comment in a Markdown file cannot change runtime behaviour. Everything else is
 * judged by the directory and file names it actually lives under, which is where a domain signal is
 * real — `auth/login.ts` is authentication work because of what the file *is*.
 */
export function classifyArtifacts(text: string): ArtifactAssessment {
  const paths = Object.freeze([...new Set(text.match(PATH_TOKEN) ?? [])]);
  if (paths.length === 0) {
    return Object.freeze({ paths: Object.freeze([]), kind: "unknown", documentationOnly: false, domains: Object.freeze([]), schemaMigration: false });
  }
  const kinds = paths.map(artifactKindOf);
  const kind = kinds.reduce((best, candidate) => (KIND_WEIGHT[candidate] > KIND_WEIGHT[best] ? candidate : best), "unknown" as ArtifactKind);
  const documentationOnly = kinds.every((candidate) => candidate === "documentation");
  const schemaMigration = paths.some((path) => artifactKindOf(path) === "schema");

  const domains = new Set<string>();
  if (!documentationOnly) {
    for (const path of paths) {
      // Documentation contributes no domain at all, whatever it is called and wherever it sits: a
      // comment in a Markdown file cannot change runtime behaviour.
      if (artifactKindOf(path) === "documentation") continue;
      for (const part of namePartsOf(path)) {
        const domain = domainOfName(part);
        if (domain !== null) domains.add(domain);
      }
    }
  }
  return Object.freeze({ paths, kind, documentationOnly, domains: Object.freeze([...domains].sort()), schemaMigration });
}
