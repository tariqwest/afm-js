#!/usr/bin/env node
// ============================================================================
// release.js — Complete release workflow for afm-server
//
// Usage:
//   node scripts/release.js [version]
//
// Environment variables:
//   GITHUB_TOKEN - GitHub personal access token (required)
//   RELEASE_DRY_RUN - Set to "true" to skip actual GitHub operations
//   RELEASE_VERSION - Override version for release (updates package.json)
//   APPLE_FM_SDK_PATH - Path to ts-apple-fm-sdk checkout (default: ../ts-apple-fm-sdk)
//   TAP_REPO - Homebrew tap repository (default: tariqwest/homebrew-tap)
//   TAP_DIR - Local tap clone directory (default: ~/.cache/afm-server-tap)
//
// CI: set RELEASE_VERSION from the pushed tag (e.g. v0.0.11 → 0.0.11) and ensure
// apple-fm-sdk is available at APPLE_FM_SDK_PATH before running.
// ============================================================================

import { execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  createReadStream,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = dirname(__dirname);

const versionArg = process.argv[2];
const currentVersion = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf-8")).version;
const VERSION = resolveReleaseVersion();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DRY_RUN = process.env.RELEASE_DRY_RUN === "true";
const REPO = "tariqwest/afm-server";
const APPLE_FM_SDK_PATH =
  process.env.APPLE_FM_SDK_PATH || join(ROOT_DIR, "..", "ts-apple-fm-sdk");

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
};

function logInfo(message) {
  console.log(`${colors.green}[INFO]${colors.reset} ${message}`);
}

function logWarn(message) {
  console.log(`${colors.yellow}[WARN]${colors.reset} ${message}`);
}

function logError(message) {
  console.error(`${colors.red}[ERROR]${colors.reset} ${message}`);
}

function logStep(message) {
  console.log(`${colors.blue}[STEP]${colors.reset} ${message}`);
}

function exec(command, options = {}) {
  try {
    return execSync(command, { encoding: "utf-8", ...options });
  } catch (error) {
    throw new Error(`Command failed: ${command}\n${error.message}`);
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
  const data = readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function resolveReleaseVersion() {
  if (process.env.RELEASE_VERSION) {
    return process.env.RELEASE_VERSION.replace(/^v/, "");
  }

  if (versionArg) {
    return versionArg.replace(/^v/, "");
  }

  const tagRef = process.env.GITHUB_REF || "";
  const tagMatch = tagRef.match(/^refs\/tags\/v?(.+)$/);
  if (tagMatch) {
    return tagMatch[1];
  }

  return currentVersion;
}

function resolveAppleFmSdkPath() {
  if (!existsSync(join(APPLE_FM_SDK_PATH, "package.json"))) {
    throw new Error(
      `apple-fm-sdk not found at ${APPLE_FM_SDK_PATH}. ` +
        "Clone https://github.com/tariqwest/ts-apple-fm-sdk alongside afm-server " +
        "or set APPLE_FM_SDK_PATH.",
    );
  }

  return APPLE_FM_SDK_PATH;
}

function ensureAppleFmSdkBuilt(sdkPath) {
  const needsNative = !existsSync(join(sdkPath, "build", "apple_fm_sdk_napi.node"));
  const needsJs = !existsSync(join(sdkPath, "dist", "index.js"));

  if (!needsNative && !needsJs) {
    return;
  }

  logStep("Building apple-fm-sdk artifacts...");

  if (needsNative) {
    exec("pnpm run build:napi", { cwd: sdkPath });
  }

  if (needsJs) {
    exec("pnpm run build", { cwd: sdkPath });
  }
}

function bundlePrebuiltPackage(deployDir, version) {
  const sdkPath = resolveAppleFmSdkPath();
  ensureAppleFmSdkBuilt(sdkPath);

  if (existsSync(deployDir)) {
    rmSync(deployDir, { recursive: true, force: true });
  }
  mkdirSync(deployDir, { recursive: true });

  cpSync(join(ROOT_DIR, "dist"), join(deployDir, "dist"), { recursive: true });
  cpSync(join(ROOT_DIR, "bin"), join(deployDir, "bin"), { recursive: true });

  const vendorSdkDir = join(deployDir, "vendor", "apple-fm-sdk");
  mkdirSync(vendorSdkDir, { recursive: true });
  for (const item of ["dist", "build", "package.json"]) {
    cpSync(join(sdkPath, item), join(vendorSdkDir, item), { recursive: true });
  }

  const rootPkg = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf-8"));
  const deployPkg = {
    name: rootPkg.name,
    version,
    type: "module",
    dependencies: Object.fromEntries(
      Object.entries(rootPkg.dependencies).map(([name, spec]) => [
        name,
        name === "apple-fm-sdk" ? "file:./vendor/apple-fm-sdk" : spec,
      ]),
    ),
  };
  writeFileSync(join(deployDir, "package.json"), JSON.stringify(deployPkg, null, 2) + "\n");

  logStep("Installing production dependencies into release bundle...");
  exec("pnpm --config.global=false install --prod --ignore-scripts", { cwd: deployDir });
}

function generateFormula(version, sha256) {
  const url = `https://github.com/tariqwest/afm-server/releases/download/v${version}/afm-server-prebuilt-arm64-apple-darwin-${version}.tar.gz`;

  return `class AfmServer < Formula
  desc "Apple Foundation Models for Node.js — OpenAI-compatible HTTP server + CLI"
  homepage "https://github.com/tariqwest/afm-server"
  url "${url}"
  sha256 "${sha256}"
  license "MIT"
  version "${version}"

  depends_on "node"
  on_macos do
    depends_on arch: :arm64
  end

  def install
    libexec.install "dist", "bin", "node_modules"

    (bin/"afm-server").write <<~EOS
      #!/bin/bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/afm-server.js" "$@"
    EOS
    chmod 0755, bin/"afm-server"
  end

  service do
    run [opt_bin/"afm-server", "serve"]
    keep_alive true
    log_path var/"log/afm-server.log"
    error_log_path var/"log/afm-server-error.log"
    environment_variables AFM_SERVER_PORT: "1337",
                          AFM_SERVER_TOKEN: "*************"
    require_root false
  end

  def caveats
    <<~EOS
      afm-server requires:
        - macOS 26 (Tahoe) or later
        - Apple Silicon (M1+)
        - Apple Intelligence enabled in System Settings

      To start the server manually:
        afm-server serve --port 1337

      The service runs with default port 1337 and token *************.
      To configure the service with custom port or token:
        brew services set-env afm-server AFM_SERVER_PORT 8080
        brew services set-env afm-server AFM_SERVER_TOKEN your-secret-token
        brew services restart afm-server

      To run as a background service (auto-starts at login):
        brew services start afm-server

      Manage the service:
        brew services stop afm-server
        brew services restart afm-server
        brew services info afm-server
    EOS
  end

  test do
    assert_match "afm-server", shell_output("#{bin}/afm-server --help")
  end
end
`;
}

async function githubRequest(endpoint, options = {}) {
  const url = `https://api.github.com/repos/${REPO}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "afm-server-release-script",
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}\n${error}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function createRelease(tag, name, body) {
  logStep(`Creating GitHub release for ${tag}...`);

  if (DRY_RUN) {
    logWarn("DRY RUN: Skipping release creation");
    return {
      upload_url: "https://uploads.github.com/repos/tariqwest/afm-server/releases/123/assets{?name}",
    };
  }

  try {
    return await githubRequest("/releases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: tag,
        name,
        body,
        draft: false,
        prerelease: false,
      }),
    });
  } catch (error) {
    if (/already_exists|already exists/i.test(error.message)) {
      logWarn(`Release ${tag} already exists, reusing existing release...`);
      const existing = await githubRequest(`/releases/tags/${tag}`);
      if (Array.isArray(existing.assets) && existing.assets.length > 0) {
        for (const asset of existing.assets) {
          logWarn(`Deleting existing asset ${asset.name} (id=${asset.id})...`);
          await githubRequest(`/releases/assets/${asset.id}`, { method: "DELETE" });
        }
      }
      return existing;
    }
    throw error;
  }
}

async function uploadAsset(release, filePath, contentType) {
  const fileName = basename(filePath);
  logStep(`Uploading ${fileName} to GitHub release...`);

  if (DRY_RUN) {
    logWarn(`DRY RUN: Skipping upload of ${fileName}`);
    return {
      browser_download_url: `https://github.com/${REPO}/releases/download/v${VERSION}/${fileName}`,
    };
  }

  const uploadUrl =
    release.upload_url.replace(/\{\?[^}]*\}$/, "") + `?name=${encodeURIComponent(fileName)}`;
  const fileStream = createReadStream(filePath);
  const fileBuffer = await new Promise((resolve, reject) => {
    const chunks = [];
    fileStream.on("data", (chunk) => chunks.push(chunk));
    fileStream.on("end", () => resolve(Buffer.concat(chunks)));
    fileStream.on("error", reject);
  });

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": contentType,
      "Content-Length": fileBuffer.length,
    },
    body: fileBuffer,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload ${fileName}: ${response.status} ${response.statusText}\n${error}`);
  }

  return response.json();
}

async function publishToTap(version, formulaContent) {
  const TAP_REPO = process.env.TAP_REPO || "tariqwest/homebrew-tap";
  const TAP_DIR = process.env.TAP_DIR || join(process.env.HOME || "", ".cache/afm-server-tap");

  logStep(`Publishing formula to ${TAP_REPO}...`);

  if (DRY_RUN) {
    logWarn("DRY RUN: Skipping tap publishing");
    return;
  }

  if (existsSync(join(TAP_DIR, ".git"))) {
    logInfo(`Updating existing tap repo at ${TAP_DIR}...`);
    exec("git fetch origin", { cwd: TAP_DIR });
    exec("git checkout main || git checkout master", { cwd: TAP_DIR, shell: true });
    exec("git pull", { cwd: TAP_DIR });
  } else {
    logInfo(`Cloning tap repository ${TAP_REPO}...`);
    execSilent(`rm -rf "${TAP_DIR}"`);
    const cloneUrl = GITHUB_TOKEN
      ? `https://${GITHUB_TOKEN}@github.com/${TAP_REPO}.git`
      : `https://github.com/${TAP_REPO}.git`;
    exec(`git clone "${cloneUrl}" "${TAP_DIR}"`);
  }

  const formulaDir = join(TAP_DIR, "Formula");
  if (!existsSync(formulaDir)) {
    mkdirSync(formulaDir, { recursive: true });
  }

  const formulaPath = join(formulaDir, "afm-server.rb");
  writeFileSync(formulaPath, formulaContent);

  try {
    exec('git diff --quiet HEAD -- "Formula/afm-server.rb"', { cwd: TAP_DIR });
    logWarn("No changes detected in formula. Already up to date?");
    return;
  } catch {
    // Changes detected, continue
  }

  logInfo("Committing changes...");
  exec('git add "Formula/afm-server.rb"', { cwd: TAP_DIR });
  exec(`git commit -m "afm-server ${version}"`, { cwd: TAP_DIR });

  logInfo(`Pushing to ${TAP_REPO}...`);
  const pushUrl = GITHUB_TOKEN
    ? `https://${GITHUB_TOKEN}@github.com/${TAP_REPO}.git`
    : "origin";

  try {
    exec(`git push "${pushUrl}" HEAD:main`, { cwd: TAP_DIR, stdio: "pipe" });
  } catch {
    try {
      exec(`git push "${pushUrl}" HEAD:master`, { cwd: TAP_DIR, stdio: "pipe" });
    } catch (error) {
      throw new Error(`Failed to push to tap: ${error.message}`);
    }
  }

  logInfo(`Successfully published afm-server ${version} to ${TAP_REPO}!`);
}

async function main() {
  logInfo(`Starting release process for afm-server v${VERSION}...`);

  if (!GITHUB_TOKEN) {
    logError("GITHUB_TOKEN environment variable is required");
    process.exit(1);
  }

  if (DRY_RUN) {
    logWarn("DRY RUN mode enabled - no actual changes will be made");
  }

  if (VERSION === currentVersion) {
    logError(`Release version ${VERSION} is the same as current version in package.json`);
    logError("Update RELEASE_VERSION env variable to a higher version number");
    process.exit(1);
  }

  const currentParts = currentVersion.split(".").map(Number);
  const releaseParts = VERSION.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    if (releaseParts[i] < currentParts[i]) {
      logError(`Release version ${VERSION} is lower than current version ${currentVersion}`);
      logError("Update RELEASE_VERSION env variable to a higher version number");
      process.exit(1);
    }
    if (releaseParts[i] > currentParts[i]) {
      break;
    }
  }

  const packageFiles = [join(ROOT_DIR, "package.json")];

  const originalPackageContents = new Map();
  for (const pkgFile of packageFiles) {
    originalPackageContents.set(pkgFile, readFileSync(pkgFile, "utf-8"));
  }

  const rollbackPackageVersions = () => {
    logWarn("Rolling back package.json version changes...");
    for (const [pkgFile, originalContent] of originalPackageContents) {
      writeFileSync(pkgFile, originalContent);
      logInfo(`Restored ${pkgFile}`);
    }
  };

  let tempDir = join(ROOT_DIR, ".release-temp");

  try {
    if (!DRY_RUN) {
      logStep(`Updating package.json to version ${VERSION}...`);
      for (const pkgFile of packageFiles) {
        const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));
        pkg.version = VERSION;
        writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
        logInfo(`Updated ${pkgFile}`);
      }
    } else {
      logWarn("DRY RUN: Skipping package.json version updates");
    }

    const isCI = process.env.CI === "true";
    if (isCI) {
      logInfo("Running in CI environment - skipping build/test (handled by workflow)");
    }

    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    mkdirSync(tempDir, { recursive: true });

    if (!isCI) {
      logStep("Building afm-server package...");
      if (!DRY_RUN) {
        exec("pnpm run build", { cwd: ROOT_DIR });
      } else {
        logWarn("DRY RUN: Skipping build");
      }
    }

    logStep("Creating afm-server prebuilt tarball...");
    const afmServerTarball = join(
      tempDir,
      `afm-server-prebuilt-arm64-apple-darwin-${VERSION}.tar.gz`,
    );
    if (!DRY_RUN) {
      const deployDir = join(tempDir, "afm-server-deploy");
      logStep("Bundling afm-server with apple-fm-sdk and production dependencies...");
      bundlePrebuiltPackage(deployDir, VERSION);
      exec(`tar -czf "${afmServerTarball}" -C "${deployDir}" dist bin node_modules`, {
        cwd: ROOT_DIR,
      });
    } else {
      logWarn("DRY RUN: Skipping tarball creation");
      writeFileSync(afmServerTarball, "dummy");
    }

    logStep("Calculating SHA256 hash...");
    const afmServerSha256 = calculateSha256(afmServerTarball);
    logInfo(`afm-server SHA256: ${afmServerSha256}`);

    const tagName = `v${VERSION}`;
    const releaseName = `afm-server ${VERSION}`;
    const releaseBody = `afm-server ${VERSION}

## Installation

\`\`\`bash
brew install tariqwest/tap/afm-server
\`\`\`

## What's Changed

See the [release notes](https://github.com/${REPO}/releases/tag/v${VERSION}) and [commit history](https://github.com/${REPO}/commits/main).

## Artifacts

- \`afm-server-prebuilt-arm64-apple-darwin-${VERSION}.tar.gz\` - Prebuilt \`dist/\`, \`bin/\`, and production \`node_modules/\` (includes bundled \`apple-fm-sdk\`)

## Requirements

- macOS 26 (Tahoe) or later
- Apple Silicon (M1+)
- Apple Intelligence enabled in System Settings
`;

    const release = await createRelease(tagName, releaseName, releaseBody);
    logInfo(`Release created: ${release.html_url}`);

    const afmServerAsset = await uploadAsset(release, afmServerTarball, "application/gzip");
    logInfo(`afm-server artifact: ${afmServerAsset.browser_download_url}`);

    logStep("Generating Homebrew formula...");
    const formulaContent = generateFormula(VERSION, afmServerSha256);
    await publishToTap(VERSION, formulaContent);

    logInfo(`Release ${VERSION} completed successfully!`);
    console.log("");
    console.log("Release artifacts:");
    console.log(`  - ${afmServerAsset.browser_download_url}`);
    console.log("");
    console.log("Homebrew formula updated and published to tap.");
    console.log("Users can install via:");
    console.log("  brew install tariqwest/tap/afm-server");
  } catch (error) {
    if (!DRY_RUN) {
      rollbackPackageVersions();
    }
    throw error;
  } finally {
    if (existsSync(tempDir)) {
      logStep("Cleaning up temporary directory...");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  logError(error.message);
  process.exit(1);
});