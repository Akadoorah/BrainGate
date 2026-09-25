# Releasing BrainGate

BrainGate is published to npm as a single package, `braingate`, built from `apps/cli`. The
`@braingate/*` workspace packages are never published: `pnpm pack` bundles their code into
`dist/main.js`, and the packed manifest depends only on `better-sqlite3`, which stays external
because it ships a native addon.

## What a pack does

Running `pnpm pack` or `pnpm publish` in `apps/cli` runs these steps:

1. **`prepack`** builds `dist/main.js` with esbuild, so a stale or missing bundle is never shipped.
2. It rewrites `package.json` without the workspace dependencies and the dev toolchain.
3. It stages the repository's root `README.md` and `LICENSE` into the package, because npm shows the
   README on the package page and takes both only from the package directory.
4. **`postpack`** restores `package.json` and the package's own README, and removes the staged
   LICENSE. The working tree is left exactly as it was.

Use `pnpm`, not `npm`, for pack and publish: only pnpm resolves the `workspace:*` ranges that
`package.json` carries during development.

## Checklist for a release

1. `main` is green in CI, and `pnpm typecheck && pnpm test` pass locally.
2. Update the version in `apps/cli/package.json` and in the root `package.json`, and move the
   `CHANGELOG.md` entry from "unreleased" to the release date.
3. Smoke-test the tarball on a clean prefix, outside the repository, with a throwaway `HOME` so your
   own `~/.braingate` is untouched:

   ```bash
   cd apps/cli
   pnpm pack --pack-destination /tmp/bg-pack
   mkdir -p /tmp/bg-home/proj && cd /tmp/bg-home/proj && git init -q
   HOME=/tmp/bg-home npm install -g /tmp/bg-pack/braingate-*.tgz --prefix /tmp/bg-prefix
   HOME=/tmp/bg-home /tmp/bg-prefix/bin/braingate --version
   HOME=/tmp/bg-home /tmp/bg-prefix/bin/braingate discover
   HOME=/tmp/bg-home /tmp/bg-prefix/bin/braingate models list   # exercises better-sqlite3
   ```

4. Publish from `apps/cli`. A pre-release goes out under the `preview` tag, so that
   `npm install -g braingate` only picks up a stable version once one exists:

   ```bash
   npm login
   pnpm publish --tag preview      # 0.1.0-preview and other pre-releases
   pnpm publish                    # a stable release, tagged latest
   ```

   The first publish of a new package also becomes `latest`, whatever the tag. Until a stable
   version exists, `npm install -g braingate` and `npm install -g braingate@preview` both install
   the preview.

5. Tag the commit (`git tag v0.1.0-preview && git push origin v0.1.0-preview`) and create a GitHub
   release whose notes are the CHANGELOG entry.
6. Once the package is on npm, add `npm install -g braingate` to the README's quick start, next to
   the git-clone path.
