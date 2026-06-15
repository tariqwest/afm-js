#!/usr/bin/env node
// ============================================================================
// release.js — Complete release workflow for afm-js
//
// Usage:
//   node scripts/release.js [version]
//
// Environment variables:
//   GITHUB_TOKEN - GitHub personal access token (required)
//   DRY_RUN - Set to "true" to skip actual GitHub operations
// ============================================================================

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, createReadStream } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = dirname(__dirname);

// Parse arguments
const versionArg = process.argv[2];
const VERSION = versionArg || JSON.parse(readFileSync(join(ROOT_DIR, "packages/afm-js/package.json"), "utf-8")).version;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DRY_RUN = process.env.DRY_RUN === "true";
const REPO = "tariqwest/afm-js";

// Colors for output
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
  } catch (error) {
    return null;
  }
}

function calculateSha256(filePath) {
  const hash = createHash("sha256");
  const data = readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function generateFormula(version, sha256, helperSha256) {
  const url = `https://github.com/tariqwest/afm-js/releases/download/v${version}/afm-js-prebuilt-arm64-apple-darwin-${version}.tar.gz`;

  return `class AfmJs < Formula
  desc "Apple Foundation Models for Node.js — OpenAI-compatible HTTP server + CLI"
  homepage "https://github.com/tariqwest/afm-js"
  url "${url}"
  sha256 "${sha256}"
  license "MIT"
  version "${version}"

  depends_on "node"
  depends_on :macos
  depends_on arch: :arm64

  resource "afm-fm-helper" do
    url "https://github.com/tariqwest/afm-js/releases/download/v${version}/afm-fm-helper-arm64-apple-darwin-${version}.tar.gz"
    sha256 "${helperSha256}"
  end

  def install
    # Install prebuilt afm-js package
    libexec.install Dir["dist"], "bin"

    # Create wrapper script that uses Homebrew's node
    (bin/"afm-js").write <<~EOS
      #!/bin/bash
      export AFM_JS_HELPER_PATH="#{opt_prefix}/libexec/afm-fm-helper"
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/afm-js.js" "$@"
    EOS
    chmod 0755, bin/"afm-js"

    # Install helper binary from resource
    resource("afm-fm-helper").stage do
      libexec.install "afm-fm-helper"
    end
    chmod 0755, libexec/"afm-fm-helper"
  end

  def caveats
    <<~EOS
      afm-js requires:
        - macOS 26 (Tahoe) or later
        - Apple Silicon (M1+)
        - Apple Intelligence enabled in System Settings

      To start the server manually:
        afm-js serve --port 11434

      To run as a background service (auto-starts at login):
        brew services start afm-js

      Manage the service:
        brew services stop afm-js
        brew services restart afm-js
        brew services info afm-js
    EOS
  end

  service do
    run [opt_bin/"afm-js", "serve", "--port", "11434"]
    keep_alive true
    log_path var/"log/afm-js.log"
    error_log_path var/"log/afm-js-error.log"
    environment_variables AFM_JS_HELPER_PATH: opt_prefix/"libexec/afm-fm-helper"
    require_root false
  end

  test do
    # Test that the binary runs
    assert_match "afm-js", shell_output("#{bin}/afm-js --help")
    
    # Test health endpoint if server can start briefly
    # Note: This may fail if Apple Intelligence is not available
  end
end
`;
}

// GitHub API helpers
async function githubRequest(endpoint, options = {}) {
  const url = `https://api.github.com/repos/${REPO}${endpoint}`;
  const headers = {
    "Authorization": `Bearer ${GITHUB_TOKEN}`,
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "afm-js-release-script",
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

  return response.json();
}

async function createRelease(tag, name, body) {
  logStep(`Creating GitHub release for ${tag}...`);
  
  if (DRY_RUN) {
    logWarn("DRY RUN: Skipping release creation");
    return { upload_url: "https://uploads.github.com/repos/tariqwest/afm-js/releases/123/assets{?name}" };
  }

  return githubRequest("/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      name: name,
      body: body,
      draft: false,
      prerelease: false,
    }),
  });
}

async function uploadAsset(release, filePath, contentType) {
  const fileName = basename(filePath);
  logStep(`Uploading ${fileName} to GitHub release...`);
  
  if (DRY_RUN) {
    logWarn(`DRY RUN: Skipping upload of ${fileName}`);
    return { browser_download_url: `https://github.com/${REPO}/releases/download/v${VERSION}/${fileName}` };
  }

  const uploadUrl = release.upload_url.replace("{?name}", `?name=${fileName}`);
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
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
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
  const TAP_DIR = process.env.TAP_DIR || join(process.env.HOME || "", ".cache/afm-js-tap");
  
  logStep(`Publishing formula to ${TAP_REPO}...`);
  
  if (DRY_RUN) {
    logWarn("DRY RUN: Skipping tap publishing");
    return;
  }

  // Clone or update the tap repository
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

  // Create Formula directory if needed
  const formulaDir = join(TAP_DIR, "Formula");
  if (!existsSync(formulaDir)) {
    mkdirSync(formulaDir, { recursive: true });
  }

  // Write the formula
  const formulaPath = join(formulaDir, "afm-js.rb");
  writeFileSync(formulaPath, formulaContent);

  // Check if there are changes
  try {
    exec('git diff --quiet HEAD -- "Formula/afm-js.rb"', { cwd: TAP_DIR });
    logWarn("No changes detected in formula. Already up to date?");
    return;
  } catch {
    // Changes detected, continue
  }

  // Commit and push
  logInfo("Committing changes...");
  exec('git add "Formula/afm-js.rb"', { cwd: TAP_DIR });
  exec(`git commit -m "afm-js ${version}"`, { cwd: TAP_DIR });

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

  logInfo(`Successfully published afm-js ${version} to ${TAP_REPO}!`);
}

async function main() {
  logInfo(`Starting release process for afm-js v${VERSION}...`);
  
  if (!GITHUB_TOKEN) {
    logError("GITHUB_TOKEN environment variable is required");
    process.exit(1);
  }

  if (DRY_RUN) {
    logWarn("DRY RUN mode enabled - no actual changes will be made");
  }

  // Create temporary directory for artifacts
  const tempDir = join(ROOT_DIR, ".release-temp");
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  mkdirSync(tempDir, { recursive: true });

  try {
    // Step 1: Build the project
    logStep("Building afm-js package...");
    if (!DRY_RUN) {
      exec("pnpm run build", { cwd: ROOT_DIR });
    } else {
      logWarn("DRY RUN: Skipping build");
    }

    // Step 2: Build the Swift helper
    logStep("Building afm-fm-helper binary...");
    if (!DRY_RUN) {
      exec("swift build -c release", { cwd: join(ROOT_DIR, "helper") });
    } else {
      logWarn("DRY RUN: Skipping Swift build");
    }

    // Step 3: Create afm-js tarball
    logStep("Creating afm-js prebuilt tarball...");
    const afmJsTarball = join(tempDir, `afm-js-prebuilt-arm64-apple-darwin-${VERSION}.tar.gz`);
    if (!DRY_RUN) {
      exec(
        `tar -czf "${afmJsTarball}" -C packages/afm-js dist bin`,
        { cwd: ROOT_DIR }
      );
    } else {
      logWarn("DRY RUN: Skipping tarball creation");
      // Create dummy file for testing
      writeFileSync(afmJsTarball, "dummy");
    }

    // Step 4: Create helper tarball
    logStep("Creating afm-fm-helper tarball...");
    const helperTarball = join(tempDir, `afm-fm-helper-arm64-apple-darwin-${VERSION}.tar.gz`);
    if (!DRY_RUN) {
      exec(
        `tar -czf "${helperTarball}" -C helper/.build/release afm-fm-helper`,
        { cwd: ROOT_DIR }
      );
    } else {
      logWarn("DRY RUN: Skipping helper tarball creation");
      // Create dummy file for testing
      writeFileSync(helperTarball, "dummy");
    }

    // Step 5: Calculate SHA256 hashes
    logStep("Calculating SHA256 hashes...");
    const afmJsSha256 = calculateSha256(afmJsTarball);
    const helperSha256 = calculateSha256(helperTarball);
    logInfo(`afm-js SHA256: ${afmJsSha256}`);
    logInfo(`helper SHA256: ${helperSha256}`);

    // Step 6: Create GitHub release
    const tagName = `v${VERSION}`;
    const releaseName = `afm-js ${VERSION}`;
    const releaseBody = `afm-js ${VERSION}

## Installation

\`\`\`bash
brew install tariqwest/tap/afm-js
\`\`\`

## What's Changed

See the [CHANGELOG](https://github.com/${REPO}/blob/main/CHANGELOG.md) for details.

## Artifacts

- \`afm-js-prebuilt-arm64-apple-darwin-${VERSION}.tar.gz\` - Prebuilt Node.js package
- \`afm-fm-helper-arm64-apple-darwin-${VERSION}.tar.gz\` - Swift helper binary

## Requirements

- macOS 26 (Tahoe) or later
- Apple Silicon (M1+)
- Apple Intelligence enabled in System Settings
`;

    const release = await createRelease(tagName, releaseName, releaseBody);
    logInfo(`Release created: ${release.html_url}`);

    // Step 7: Upload artifacts
    const afmJsAsset = await uploadAsset(release, afmJsTarball, "application/gzip");
    const helperAsset = await uploadAsset(release, helperTarball, "application/gzip");
    
    logInfo(`afm-js artifact: ${afmJsAsset.browser_download_url}`);
    logInfo(`helper artifact: ${helperAsset.browser_download_url}`);

    // Step 8: Generate Homebrew formula with SHA256 hashes
    logStep("Generating Homebrew formula...");
    const formulaContent = generateFormula(VERSION, afmJsSha256, helperSha256);
    
    // Write formula to file for reference
    const formulaPath = join(ROOT_DIR, "afm-js.rb");
    writeFileSync(formulaPath, formulaContent);
    logInfo(`Formula written to: ${formulaPath}`);

    // Step 9: Publish to tap
    await publishToTap(VERSION, formulaContent);

    logInfo(`Release ${VERSION} completed successfully!`);
    console.log("");
    console.log("Release artifacts:");
    console.log(`  - ${afmJsAsset.browser_download_url}`);
    console.log(`  - ${helperAsset.browser_download_url}`);
    console.log("");
    console.log("Homebrew formula updated and published to tap.");
    console.log("Users can install via:");
    console.log("  brew install tariqwest/tap/afm-js");

  } finally {
    // Cleanup temporary directory
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
