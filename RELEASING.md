# Releasing fm-server

Release process for fm-server, including Homebrew tap publication.

## Version Numbering

Semantic versioning: `MAJOR.MINOR.PATCH`

- **MAJOR**: Breaking changes to the API or CLI interface
- **MINOR**: New features
- **PATCH**: Bug fixes and minor improvements

## Quick Start

```bash
gh auth login                 # one-time setup
pnpm run release              # auto-detect bump + build + publish (GH + Homebrew)
pnpm run release patch        # explicit patch bump + publish
pnpm run release -- --dry-run # dry-run (no bump, no publish)
```

## How It Works

A single script (`scripts/release.js`) handles the entire release:

1. Bumps the version in `package.json` (skipped during `--dry-run`)
2. Builds the project (`pnpm run build`)
3. Bundles prebuilt tarball with vendored apple-fm-sdk + fm-wrap
4. Creates GitHub release + uploads artifact (via `gh` CLI)
5. Generates and publishes Homebrew formula to tap

### Version Bump

Pass an explicit strategy as a positional argument, or let it auto-detect from git history:

```bash
node scripts/release.js patch   # 0.2.0 → 0.2.1
node scripts/release.js minor   # 0.2.0 → 0.3.0
node scripts/release.js major   # 0.2.0 → 1.0.0
node scripts/release.js 1.2.3   # explicit version
node scripts/release.js         # auto-detect from commits
```

Auto-detection heuristic (from commits since last tag):

- `BREAKING CHANGE` in body or `feat!:` prefix → **major**
- `feat:` or `feat(scope):` prefix → **minor**
- Default → **minor**

### Dry Run

```bash
pnpm run release -- --dry-run
```

Skips bumping, building, uploading, and tap publishing. Uses the current version from `package.json` for display.

## Scripts

- `pnpm run release [patch|minor|major|version]` — Bump + build + publish (GH + Homebrew)
- `pnpm run ci` — Build + test + typecheck

## Flags

- `--dry-run` — Skip bump and all destructive operations

## Environment Variables

- `APPLE_FM_SDK_PATH` — Path to ts-apple-fm-sdk (default: `../ts-apple-fm-sdk`)
- `FM_WRAP_PATH` — Path to fm-wrap (default: `../fm-wrap`)
- `TAP_REPO` — Homebrew tap repository (default: `tariqwest/homebrew-tap`)
- `TAP_DIR` — Local tap clone directory (default: `~/.cache/fm-server-tap`)

## Homebrew Tap

Users install via:

```bash
brew tap tariqwest/tap
brew install fm-server
```
