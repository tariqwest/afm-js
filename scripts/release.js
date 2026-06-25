#!/usr/bin/env node
// ============================================================================
// release.js — Release workflow for fm-server
//
// Bumps the version, builds, bundles, and publishes:
//   1. Bump version in package.json (auto-detect or explicit)
//   2. Build the project
//   3. Bundle prebuilt tarball (with vendored apple-fm-sdk + fm-wrap)
//   4. Create GitHub release + upload artifact (via gh CLI)
//   5. Generate and publish Homebrew formula to tap
//
// Usage:
//   node scripts/release.js [patch|minor|major|<version>] [--dry-run]
//
// Arguments:
//   patch|minor|major   Explicit bump strategy
//   x.y.z              Explicit version number
//   (none)             Auto-detect from git history (defaults to minor)
//
// Flags:
//   --dry-run   Skip actual operations (bump, build, upload, tap push)
//
// Prerequisites:
//   gh auth login   — authenticate the GitHub CLI (used for releases + tap push)
//
// Environment variables:
//   APPLE_FM_SDK_PATH - Path to ts-apple-fm-sdk checkout (default: ../ts-apple-fm-sdk)
//   FM_WRAP_PATH - Path to fm-wrap checkout (default: ../fm-wrap)
//   TAP_REPO - Homebrew tap repository (default: tariqwest/homebrew-tap)
//   TAP_DIR - Local tap clone directory (default: ~/.cache/fm-server-tap)
// ============================================================================

import { execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = dirname(__dirname);

const pkg = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf-8"));

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const BUMP_ARG = args.find((a) => !a.startsWith("--"));

const REPO = "tariqwest/fm-server";
const APPLE_FM_SDK_PATH =
  process.env.APPLE_FM_SDK_PATH || join(ROOT_DIR, "..", "ts-apple-fm-sdk");
const FM_WRAP_PATH =
  process.env.FM_WRAP_PATH || join(ROOT_DIR, "..", "fm-wrap");

// -- Logging --

const C = { reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", blue: "\x1b[34m" };
const logInfo = (msg) => console.log(`${C.green}[INFO]${C.reset} ${msg}`);
const logWarn = (msg) => console.log(`${C.yellow}[WARN]${C.reset} ${msg}`);
const logError = (msg) => console.error(`${C.red}[ERROR]${C.reset} ${msg}`);
const logStep = (msg) => console.log(`${C.blue}[STEP]${C.reset} ${msg}`);

// -- Shell helpers --

function exec(command, options = {}) {
  try {
    return execSync(command, { encoding: "utf-8", stdio: "pipe", ...options });
  } catch (error) {
    throw new Error(`Command failed: ${command}\n${error.stderr || error.message}`);
  }
}

function execSilent(command, options = {}) {
  try {
    return execSync(command, { encoding: "utf-8", stdio: "pipe", ...options });
  } catch {
    return null;
  }
}

function calculateSha256(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

// -- SDK helpers --

function resolveAppleFmSdkPath() {
  if (!existsSync(join(APPLE_FM_SDK_PATH, "package.json"))) {
    throw new Error(
      `apple-fm-sdk not found at ${APPLE_FM_SDK_PATH}. ` +
        "Clone https://github.com/tariqwest/ts-apple-fm-sdk alongside fm-server " +
        "or set APPLE_FM_SDK_PATH.",
    );
  }
  return APPLE_FM_SDK_PATH;
}

function resolveFmWrapPath() {
  if (!existsSync(join(FM_WRAP_PATH, "package.json"))) {
    throw new Error(
      `fm-wrap not found at ${FM_WRAP_PATH}. ` +
        "Clone https://github.com/tariqwest/fm-wrap alongside fm-server " +
        "or set FM_WRAP_PATH.",
    );
  }
  return FM_WRAP_PATH;
}

function ensureAppleFmSdkBuilt(sdkPath) {
  const needsNative = !existsSync(join(sdkPath, "build", "apple_fm_sdk_napi.node"));
  const needsJs = !existsSync(join(sdkPath, "dist", "index.js"));

  if (!needsNative && !needsJs) return;
  logStep("Building apple-fm-sdk artifacts...");
  if (needsNative) exec("pnpm run build:napi", { cwd: sdkPath });
  if (needsJs) exec("pnpm run build", { cwd: sdkPath });
}

// -- Bundle --

function bundlePrebuiltPackage(deployDir, version) {
  const sdkPath = resolveAppleFmSdkPath();
  const fmWrapPath = resolveFmWrapPath();
  ensureAppleFmSdkBuilt(sdkPath);

  if (existsSync(deployDir)) rmSync(deployDir, { recursive: true, force: true });
  mkdirSync(deployDir, { recursive: true });

  cpSync(join(ROOT_DIR, "dist"), join(deployDir, "dist"), { recursive: true });
  cpSync(join(ROOT_DIR, "bin"), join(deployDir, "bin"), { recursive: true });

  // Vendor apple-fm-sdk (includes native .node binary)
  const vendorSdkDir = join(deployDir, "vendor", "apple-fm-sdk");
  mkdirSync(vendorSdkDir, { recursive: true });
  for (const item of ["dist", "build", "package.json"]) {
    cpSync(join(sdkPath, item), join(vendorSdkDir, item), { recursive: true });
  }

  // Vendor fm-wrap (pure JS)
  const vendorFmWrapDir = join(deployDir, "vendor", "fm-wrap");
  mkdirSync(vendorFmWrapDir, { recursive: true });
  for (const item of ["dist", "package.json"]) {
    cpSync(join(fmWrapPath, item), join(vendorFmWrapDir, item), { recursive: true });
  }

  const deployPkg = {
    name: pkg.name,
    version,
    type: "module",
    dependencies: Object.fromEntries(
      Object.entries(pkg.dependencies).map(([name, spec]) => [
        name,
        name === "apple-fm-sdk" ? "file:./vendor/apple-fm-sdk" :
        name === "fm-wrap" ? "file:./vendor/fm-wrap" : spec,
      ]),
    ),
  };
  writeFileSync(join(deployDir, "package.json"), JSON.stringify(deployPkg, null, 2) + "\n");

  logStep("Installing production dependencies into release bundle...");
  exec("pnpm --config.global=false install --prod --ignore-scripts", { cwd: deployDir });
}

// -- Homebrew formula --

function generateFormula(version, sha256) {
  const url = `https://github.com/${REPO}/releases/download/v${version}/fm-server-prebuilt-arm64-apple-darwin-${version}.tar.gz`;

  return `class FmServer < Formula
  desc "Apple Foundation Models for Node.js — OpenAI-compatible HTTP server + CLI"
  homepage "https://github.com/${REPO}"
  url "${url}"
  sha256 "${sha256}"
  license "MIT"
  version "${version}"

  depends_on "node"
  on_macos do
    depends_on arch: :arm64
  end

  # apple-fm-sdk ships a prebuilt dylib with @rpath install name;
  # prevent Homebrew from rewriting it (which fails due to header size)
  preserve_rpath

  def install
    libexec.install "dist", "bin", "node_modules", "package.json"

    # Clear dylib IDs on native addons so Homebrew skips relocation.
    # These are dlopen'd by Node.js and don't need a dylib ID.
    Dir.glob("#{libexec}/node_modules/**/*.dylib").each do |dylib|
      next unless File.file?(dylib)
      chmod 0644, dylib
      system "install_name_tool", "-id", "", dylib
      system "codesign", "--sign", "-", "--force", dylib
      chmod 0444, dylib
    end

    # Ensure node-pty spawn-helper is executable (needed for PCC backend)
    Dir.glob("#{libexec}/node_modules/**/spawn-helper").each do |helper|
      chmod 0755, helper
    end

    (bin/"fm-server").write <<~EOS
      #!/bin/bash
      exec "\#{Formula["node"].opt_bin}/node" "\#{libexec}/bin/fm-server.js" "$@"
    EOS
    chmod 0755, bin/"fm-server"
  end

  service do
    run [opt_bin/"fm-server", "serve"]
    keep_alive true
    log_path var/"log/fm-server.log"
    error_log_path var/"log/fm-server-error.log"
    environment_variables FM_SERVER_PORT: "11434",
                          FM_SERVER_TOKEN: "fm-server"
    require_root false
  end

  def caveats
    <<~EOS
      fm-server requires:
        - macOS 26 (Tahoe) or later
        - Apple Silicon (M1+)
        - Apple Intelligence enabled in System Settings

      To start the server manually:
        fm-server serve

      Default port: 11434 (override with --port or FM_SERVER_PORT)

      To run as a background service (auto-starts at login):
        brew services start fm-server

      Manage the service:
        brew services stop fm-server
        brew services restart fm-server
        brew services info fm-server
    EOS
  end

  test do
    assert_match "fm-server", shell_output("\#{bin}/fm-server --help")
  end
end
`;
}

// -- Tap publish --

function publishToTap(version, formulaContent) {
  const TAP_REPO = process.env.TAP_REPO || "tariqwest/homebrew-tap";
  const home = process.env.HOME || "";
  const rawTapDir = process.env.TAP_DIR || "~/.cache/fm-server-tap";
  const TAP_DIR = rawTapDir.startsWith("~") ? rawTapDir.replace("~", home) : rawTapDir;

  logStep(`Publishing formula to ${TAP_REPO}...`);
  if (DRY_RUN) { logWarn("DRY RUN: Skipping tap publishing"); return; }

  // Use gh CLI to clone/sync the tap repo (inherits gh auth)
  if (existsSync(join(TAP_DIR, ".git"))) {
    exec("git fetch origin", { cwd: TAP_DIR });
    execSilent("git checkout main", { cwd: TAP_DIR }) ||
      exec("git checkout master", { cwd: TAP_DIR });
    exec("git pull", { cwd: TAP_DIR });
  } else {
    execSilent(`rm -rf "${TAP_DIR}"`);
    exec(`gh repo clone ${TAP_REPO} "${TAP_DIR}"`);
  }

  const formulaDir = join(TAP_DIR, "Formula");
  if (!existsSync(formulaDir)) mkdirSync(formulaDir, { recursive: true });

  writeFileSync(join(formulaDir, "fm-server.rb"), formulaContent);

  // Stage and check if there are actual changes
  exec('git add "Formula/fm-server.rb"', { cwd: TAP_DIR });
  const diff = execSilent("git diff --cached --quiet", { cwd: TAP_DIR });
  if (diff !== null) {
    logWarn("No changes detected in formula. Already up to date?");
    exec("git reset HEAD -- .", { cwd: TAP_DIR });
    return;
  }

  exec(`git commit -m "fm-server ${version}"`, { cwd: TAP_DIR });
  exec("git push", { cwd: TAP_DIR });

  logInfo(`Published fm-server ${version} to ${TAP_REPO}`);
}

// -- Version bump --

function detectBumpStrategy() {
  const lastTag = execSilent("git describe --tags --abbrev=0 2>/dev/null");
  const range = lastTag ? `${lastTag.trim()}..HEAD` : "HEAD~20..HEAD";
  const log = execSilent(`git log ${range} --pretty=format:"%s%n%b"`) || "";

  if (/BREAKING CHANGE|^.+!:/m.test(log)) return "major";
  if (/^feat(\(.+\))?:/m.test(log)) return "minor";
  return "minor";
}

function bumpVersion() {
  const validBumps = ["patch", "minor", "major"];
  let bump;

  if (!BUMP_ARG) {
    bump = detectBumpStrategy();
    logInfo(`Auto-detected bump: ${bump}`);
  } else if (validBumps.includes(BUMP_ARG)) {
    bump = BUMP_ARG;
    logInfo(`Explicit bump: ${bump}`);
  } else if (/^\d+\.\d+\.\d+/.test(BUMP_ARG)) {
    bump = BUMP_ARG;
    logInfo(`Explicit version: ${bump}`);
  } else {
    throw new Error(
      `Invalid bump argument: ${BUMP_ARG}\nUsage: node scripts/release.js [patch|minor|major|<version>] [--dry-run] [--no-brew]`,
    );
  }

  logStep(`Running: pnpm version ${bump} --no-git-tag-version`);
  const result = exec(`pnpm version ${bump} --no-git-tag-version`, { cwd: ROOT_DIR }).trim();
  const version = result.replace(/^v/, "");
  logInfo(`Version bumped to ${version}`);
  return version;
}

// -- Main --

async function main() {
  // Verify gh CLI is authenticated
  if (!DRY_RUN && !execSilent("gh auth status")) {
    throw new Error("Not authenticated. Run: gh auth login");
  }

  if (DRY_RUN) logWarn("DRY RUN mode enabled");

  // 0. Bump version
  let VERSION;
  if (DRY_RUN) {
    VERSION = pkg.version;
    logWarn(`DRY RUN: Skipping bump (using current version ${VERSION})`);
  } else {
    VERSION = bumpVersion();
  }

  logInfo(`Releasing fm-server v${VERSION}`);

  // 1. Build
  logStep("Building...");
  if (!DRY_RUN) exec("pnpm run build", { cwd: ROOT_DIR });
  else logWarn("DRY RUN: Skipping build");

  // 2. Bundle tarball
  const tempDir = join(ROOT_DIR, ".release-temp");
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  const tarballName = `fm-server-prebuilt-arm64-apple-darwin-${VERSION}.tar.gz`;
  const tarballPath = join(tempDir, tarballName);

  if (!DRY_RUN) {
    const deployDir = join(tempDir, "fm-server-deploy");
    logStep("Bundling prebuilt package...");
    bundlePrebuiltPackage(deployDir, VERSION);
    exec(`tar -czf "${tarballPath}" -C "${deployDir}" dist bin node_modules package.json`, { cwd: ROOT_DIR });
  } else {
    logWarn("DRY RUN: Skipping bundle");
    writeFileSync(tarballPath, "dummy");
  }

  const sha256 = calculateSha256(tarballPath);
  logInfo(`SHA256: ${sha256}`);

  // 3. GitHub release via gh CLI
  const tag = `v${VERSION}`;
  logStep(`Creating GitHub release ${tag}...`);

  if (!DRY_RUN) {
    const existing = execSilent(`gh release view ${tag} --repo ${REPO} --json tagName`, { cwd: ROOT_DIR });
    if (existing) {
      logWarn(`Release ${tag} already exists, uploading assets to it...`);
      execSilent(`gh release delete-asset ${tag} "${tarballName}" --repo ${REPO} --yes`, { cwd: ROOT_DIR });
    } else {
      const notes = [
        "## Installation",
        "```bash",
        "brew install tariqwest/tap/fm-server",
        "```",
        "",
        "## Requirements",
        "- macOS 26+ (macOS 27+ for PCC)",
        "- Apple Silicon (M1+)",
        "- Apple Intelligence enabled",
      ].join("\n");

      exec(
        `gh release create ${tag} --repo ${REPO} --title "fm-server ${VERSION}" --notes-file -`,
        { cwd: ROOT_DIR, input: notes },
      );
    }

    exec(`gh release upload ${tag} "${tarballPath}" --repo ${REPO} --clobber`, { cwd: ROOT_DIR });
    logInfo(`Published: https://github.com/${REPO}/releases/tag/${tag}`);
  } else {
    logWarn("DRY RUN: Skipping GitHub release");
  }

  // 4. Homebrew tap
  const formulaContent = generateFormula(VERSION, sha256);
  publishToTap(VERSION, formulaContent);

  // Cleanup
  rmSync(tempDir, { recursive: true, force: true });

  logInfo(`Done! fm-server ${VERSION} released.`);
  console.log(`\n  brew install tariqwest/tap/fm-server\n`);
}

main().catch((error) => {
  logError(error.message);
  process.exit(1);
});
