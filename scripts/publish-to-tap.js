#!/usr/bin/env node
// ============================================================================
// publish-to-tap.js — Publishes Homebrew formula to tariqwest/homebrew-tap
//
// Usage:
//   node scripts/publish-to-tap.js [version]
//
// Environment variables:
//   GITHUB_TOKEN - GitHub personal access token (required for push)
//   TAP_DIR      - Local directory of the tap repo (optional)
// ============================================================================

import { execSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = dirname(__dirname);

// Parse arguments
const versionArg = process.argv[2];
const VERSION = versionArg || JSON.parse(readFileSync(join(ROOT_DIR, "packages/afm-js/package.json"), "utf-8")).version;
const TAP_REPO = process.env.TAP_REPO || "tariqwest/homebrew-tap";
const TAP_DIR = process.env.TAP_DIR || join(process.env.HOME || "", ".cache/afm-js-tap");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Colors for output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
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

// Check for GitHub token
if (!GITHUB_TOKEN) {
  logWarn("GITHUB_TOKEN not set. Will attempt to use existing git credentials.");
}

// Generate the formula first
logInfo(`Generating Homebrew formula for v${VERSION}...`);
exec("node scripts/generate-homebrew-formula.js", { cwd: ROOT_DIR, args: [VERSION] });

// Check if formula was generated
const formulaPath = join(ROOT_DIR, "afm-js.rb");
if (!existsSync(formulaPath)) {
  logError("Formula not generated. Check for errors above.");
  process.exit(1);
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

// Copy the formula
copyFileSync(formulaPath, join(formulaDir, "afm-js.rb"));

// Check if there are changes
const diffOutput = execSilent('git diff --quiet HEAD -- "Formula/afm-js.rb"', { cwd: TAP_DIR });
if (diffOutput === null) {
  // git diff --quiet returns 0 if no changes, 1 if changes
  // But execSilent returns null on error, so we need to check differently
  try {
    exec('git diff --quiet HEAD -- "Formula/afm-js.rb"', { cwd: TAP_DIR });
    logWarn("No changes detected in formula. Already up to date?");
    process.exit(0);
  } catch {
    // Changes detected, continue
  }
}

// Commit and push
logInfo("Committing changes...");
exec('git add "Formula/afm-js.rb"', { cwd: TAP_DIR });
exec(`git commit -m "afm-js ${VERSION}"`, { cwd: TAP_DIR });

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
    logError(`Failed to push: ${error.message}`);
    process.exit(1);
  }
}

logInfo(`Successfully published afm-js ${VERSION} to ${TAP_REPO}!`);
console.log("");
console.log("Users can now install via:");
console.log("  brew install tariqwest/tap/afm-js");
