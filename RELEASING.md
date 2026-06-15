# Releasing afm-js

This document describes the release process for afm-js, including Homebrew tap publication.

## Version Numbering

afm-js follows semantic versioning: `MAJOR.MINOR.PATCH`

- **MAJOR**: Breaking changes to the API or CLI interface
- **MINOR**: New features (M1, M2, M3 milestones)
- **PATCH**: Bug fixes and minor improvements

## Automated Release Process

The release process is fully automated via the `release.js` script and GitHub Actions.

### Local Release

To perform a release locally:

```bash
# Set your GitHub token
export GITHUB_TOKEN=ghp_xxxxxxxxxxxx

# Run the release script
pnpm run release
```

The script will:
1. Build the project
2. Build the Swift helper binary
3. Create release tarballs
4. Calculate SHA256 hashes
5. Create GitHub release with artifacts
6. Generate Homebrew formula
7. Publish formula to Homebrew tap

### CI/CD Release

For automated releases via GitHub Actions:

1. Push a version tag to trigger the workflow:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. GitHub Actions will:
   - Build and test the project
   - Run the release script
   - Create GitHub release with artifacts
   - Update Homebrew tap

### Dry Run Mode

To test the release process without making actual changes:

```bash
DRY_RUN=true GITHUB_TOKEN=test pnpm run release
```

## Available Scripts

- `pnpm run release` — Full release process (build, test, GitHub release, Homebrew tap)
- `pnpm run ci` — Build, test, and typecheck (used by CI)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub personal access token (required) |
| `DRY_RUN` | Set to "true" to skip actual GitHub operations |
| `TAP_REPO` | Tap repository (default: `tariqwest/homebrew-tap`) |
| `TAP_DIR` | Local directory for tap clone (default: `~/.cache/afm-js-tap`) |

## Homebrew Tap Structure

The formula is published to `https://github.com/tariqwest/homebrew-tap`:

```
homebrew-tap/
├── Formula/
│   └── afm-js.rb      # The generated formula
├── README.md          # Tap documentation
└── LICENSE
```

Users can then install via:

```bash
brew tap tariqwest/tap
brew install afm-js
```
