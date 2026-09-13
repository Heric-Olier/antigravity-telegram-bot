#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm" : "npm";
const semverInputPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const packageJsonPath = resolve(process.cwd(), "package.json");

const validBumps = new Set([
  "major",
  "minor",
  "patch",
  "premajor",
  "preminor",
  "prepatch",
  "prerelease",
]);

function run(command, args, shell) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
}

function resolveRepository() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }

  const repositoryField = JSON.parse(readFileSync(packageJsonPath, "utf8")).repository;
  const url = typeof repositoryField === "string" ? repositoryField : repositoryField?.url;
  const match =
    typeof url === "string" ? url.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i) : null;

  return match ? match[1] : "";
}

// Seed a curated release-notes file for a stable version, prefilled with the
// same auto-generated content the publish workflow would produce. This script
// does NOT commit - the release preparer (see the prepare-release skill)
// rewrites this file and commits it together with the version bump. The
// workflow uses the file verbatim when present, so RC releases, which are not
// seeded, keep pure CI generation.
function seedReleaseNotes(version) {
  const notesDir = resolve(process.cwd(), "docs", "release-notes");
  const notesPath = join(notesDir, `v${version}.md`);
  const relPath = relative(process.cwd(), notesPath);

  if (existsSync(notesPath)) {
    process.stdout.write(`Release notes already exist at ${relPath}, keeping them\n`);
    return notesPath;
  }

  const repository = resolveRepository();

  if (!repository) {
    process.stderr.write(
      "Could not resolve the GitHub repository; skipping release-notes seed. " +
        "Set GITHUB_REPOSITORY or a repository.url in package.json.\n",
    );
    return null;
  }

  mkdirSync(notesDir, { recursive: true });
  run(
    process.execPath,
    [
      resolve(process.cwd(), "scripts", "generate-release-notes.mjs"),
      "--version",
      version,
      "--repo",
      repository,
      "--output",
      notesPath,
    ],
    false,
  );
  process.stdout.write(`Seeded release notes at ${relPath}\n`);

  return notesPath;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  npm run release:prepare -- <version-or-bump>",
      "",
      "Examples:",
      "  npm run release:prepare -- 0.23.0",
      "  npm run release:prepare -- patch",
      "  npm run release:rc",
      "",
      "Notes:",
      "  - Updates package.json/package-lock.json",
      "  - For a stable version, seeds docs/release-notes/v<version>.md with a draft",
      "  - Does NOT commit and does NOT tag: curate the notes, then commit them",
      "    together as chore(release): v<version> (see the prepare-release skill)",
    ].join("\n") + "\n",
  );
}

const input = process.argv[2];

if (!input || input === "-h" || input === "--help") {
  printUsage();
  process.exit(0);
}

const npmVersionArgs = ["version"];
let explicitVersionInput;

if (input === "rc") {
  npmVersionArgs.push("prerelease", "--preid=rc");
} else if (validBumps.has(input)) {
  npmVersionArgs.push(input);
} else if (semverInputPattern.test(input)) {
  explicitVersionInput = input;
  npmVersionArgs.push(input);
} else {
  process.stderr.write(`Invalid release input: ${input}. Use a bump keyword or semver value.\n`);
  printUsage();
  process.exit(2);
}

npmVersionArgs.push("--no-git-tag-version");

const packageJsonBefore = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const currentVersionBefore = packageJsonBefore.version;

if (explicitVersionInput && explicitVersionInput === currentVersionBefore) {
  process.stdout.write(`Version is already ${currentVersionBefore}, skipping npm version step\n`);
} else {
  run(npmCommand, npmVersionArgs, isWindows);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const version = packageJson.version;

const isStable = /^\d+\.\d+\.\d+$/.test(version);
const notesPath = isStable ? seedReleaseNotes(version) : null;

process.stdout.write(`\nBumped version to v${version} (not committed).\n`);

if (notesPath) {
  process.stdout.write(`Seeded ${relative(process.cwd(), notesPath)} - curate it.\n`);
}

process.stdout.write(
  "Next: curate the release notes and commit them together with the version bump as " +
    `chore(release): v${version} (do not push). See the prepare-release skill.\n`,
);
