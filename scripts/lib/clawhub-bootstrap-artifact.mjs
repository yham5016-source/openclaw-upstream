#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const PACKAGE_NAME_PATTERN = /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u;
const PACKAGE_DIR_PATTERN = /^extensions\/[a-z0-9][a-z0-9._-]*$/u;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

function fail(message) {
  throw new Error(message);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} is required.`);
  }
  return value.trim();
}

function requirePattern(value, pattern, label) {
  const result = requireString(value, label);
  if (!pattern.test(result)) {
    fail(`${label} is invalid.`);
  }
  return result;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean.`);
  }
  return value;
}

function parsePlugins(value) {
  const plugins = requireString(value, "plugins")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unique = [...new Set(plugins)].sort();
  if (unique.length !== plugins.length) {
    fail("plugins must not contain duplicates.");
  }
  for (const plugin of unique) {
    requirePattern(plugin, PACKAGE_NAME_PATTERN, `plugin ${plugin}`);
  }
  return unique;
}

function packageSlug(packageName) {
  return packageName.slice("@openclaw/".length);
}

function normalizePlanEntry(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`matrix[${index}] must be an object.`);
  }
  const packageName = requirePattern(
    value.packageName,
    PACKAGE_NAME_PATTERN,
    `matrix[${index}].packageName`,
  );
  const packageDir = requirePattern(
    value.packageDir,
    PACKAGE_DIR_PATTERN,
    `matrix[${index}].packageDir`,
  );
  const publishTag = requirePattern(value.publishTag, TAG_PATTERN, `matrix[${index}].publishTag`);
  const version = requireString(value.version, `matrix[${index}].version`);
  const bootstrapMode = requireString(value.bootstrapMode, `matrix[${index}].bootstrapMode`);
  if (bootstrapMode !== "publish" && bootstrapMode !== "configure-only") {
    fail(`matrix[${index}].bootstrapMode is invalid.`);
  }
  const requiresManualOverride = requireBoolean(
    value.requiresManualOverride,
    `matrix[${index}].requiresManualOverride`,
  );
  if (bootstrapMode === "configure-only" && !requiresManualOverride) {
    fail(`matrix[${index}] configure-only entries must require the manual override.`);
  }
  return {
    packageName,
    version,
    packageDir,
    publishTag,
    bootstrapMode,
    requiresManualOverride,
  };
}

async function hashFile(path) {
  const bytes = await readFile(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

async function listFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail(`Artifact inventory contains a symlink: ${relative(root, path)}`);
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result.push(relative(root, path).split(sep).join("/"));
      } else {
        fail(`Artifact inventory contains a non-regular entry: ${relative(root, path)}`);
      }
    }
  }
  await visit(root);
  return result.sort();
}

async function resolveRegularArtifactFile(root, artifactPath) {
  if (
    typeof artifactPath !== "string" ||
    artifactPath.startsWith("/") ||
    artifactPath.includes("\\") ||
    artifactPath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`Unsafe artifact path: ${String(artifactPath)}`);
  }
  const rootReal = await realpath(root);
  const candidate = resolve(root, artifactPath);
  const candidateReal = await realpath(candidate);
  if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${sep}`)) {
    fail(`Artifact path escapes the artifact root: ${artifactPath}`);
  }
  const fileStat = await lstat(candidate);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    fail(`Artifact path is not a regular file: ${artifactPath}`);
  }
  return candidate;
}

function assertExactPackageSet(entries, expectedPlugins) {
  const actual = entries.map((entry) => entry.packageName).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedPlugins)) {
    fail(
      `Artifact package set does not match requested plugins: expected ${expectedPlugins.join(",")}, found ${actual.join(",")}.`,
    );
  }
}

export async function createClawHubBootstrapArtifactManifest(options) {
  const artifactRoot = resolve(options.artifactRoot);
  const matrix = JSON.parse(await readFile(options.matrixPath, "utf8"));
  if (!Array.isArray(matrix) || matrix.length === 0) {
    fail("matrix must be a non-empty array.");
  }
  const entries = matrix.map(normalizePlanEntry);
  const expectedPlugins = parsePlugins(options.plugins);
  if (new Set(entries.map((entry) => entry.packageName)).size !== entries.length) {
    fail("matrix must not contain duplicate package names.");
  }
  assertExactPackageSet(entries, expectedPlugins);

  const manifestEntries = [];
  for (const entry of entries.sort((a, b) => a.packageName.localeCompare(b.packageName))) {
    if (entry.bootstrapMode === "configure-only") {
      manifestEntries.push(entry);
      continue;
    }
    const packageDirectory = join(artifactRoot, "packages", packageSlug(entry.packageName));
    const files = (await readdir(packageDirectory)).filter((name) => name.endsWith(".tgz"));
    if (files.length !== 1) {
      fail(`${entry.packageName} must have exactly one packed .tgz artifact.`);
    }
    const artifactPath = `packages/${packageSlug(entry.packageName)}/${files[0]}`;
    const filePath = await resolveRegularArtifactFile(artifactRoot, artifactPath);
    const identity = await hashFile(filePath);
    manifestEntries.push({ ...entry, artifactPath, ...identity });
  }

  const manifest = {
    schemaVersion: 1,
    repository: requireString(options.repository, "repository"),
    targetSha: requirePattern(options.targetSha, COMMIT_PATTERN, "targetSha"),
    workflowSha: requirePattern(options.workflowSha, COMMIT_PATTERN, "workflowSha"),
    runId: requirePattern(options.runId, POSITIVE_INTEGER_PATTERN, "runId"),
    runAttempt: requirePattern(options.runAttempt, POSITIVE_INTEGER_PATTERN, "runAttempt"),
    artifactName: requireString(options.artifactName, "artifactName"),
    requestedPlugins: expectedPlugins,
    entries: manifestEntries,
  };
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function verifyClawHubBootstrapArtifactManifest(options) {
  const artifactRoot = resolve(options.artifactRoot);
  const manifest = JSON.parse(await readFile(options.manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("Bootstrap artifact manifest must be an object.");
  }
  if (manifest.schemaVersion !== 1) {
    fail(`Unsupported bootstrap artifact manifest schema: ${String(manifest.schemaVersion)}.`);
  }
  const expected = {
    repository: requireString(options.repository, "repository"),
    targetSha: requirePattern(options.targetSha, COMMIT_PATTERN, "targetSha"),
    workflowSha: requirePattern(options.workflowSha, COMMIT_PATTERN, "workflowSha"),
    runId: requirePattern(options.runId, POSITIVE_INTEGER_PATTERN, "runId"),
    runAttempt: requirePattern(options.runAttempt, POSITIVE_INTEGER_PATTERN, "runAttempt"),
    artifactName: requireString(options.artifactName, "artifactName"),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) {
      fail(`Bootstrap artifact manifest ${key} mismatch.`);
    }
  }

  const expectedPlugins = parsePlugins(options.plugins);
  if (!Array.isArray(manifest.requestedPlugins)) {
    fail("Bootstrap artifact manifest requestedPlugins must be an array.");
  }
  if (JSON.stringify(manifest.requestedPlugins) !== JSON.stringify(expectedPlugins)) {
    fail("Bootstrap artifact manifest requestedPlugins mismatch.");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail("Bootstrap artifact manifest entries must be a non-empty array.");
  }

  const entries = [];
  const allowedFiles = new Set([relative(artifactRoot, options.manifestPath).split(sep).join("/")]);
  for (const [index, rawEntry] of manifest.entries.entries()) {
    const entry = normalizePlanEntry(rawEntry, index);
    if (entry.bootstrapMode === "configure-only") {
      if (
        rawEntry.artifactPath !== undefined ||
        rawEntry.sha256 !== undefined ||
        rawEntry.size !== undefined
      ) {
        fail(`${entry.packageName} configure-only entry must not bind fresh artifact bytes.`);
      }
      entries.push(entry);
      continue;
    }
    const artifactPath = requireString(rawEntry.artifactPath, `${entry.packageName}.artifactPath`);
    const expectedPrefix = `packages/${packageSlug(entry.packageName)}/`;
    if (!artifactPath.startsWith(expectedPrefix) || !artifactPath.endsWith(".tgz")) {
      fail(`${entry.packageName} artifactPath is invalid.`);
    }
    const expectedSha = requirePattern(
      rawEntry.sha256,
      SHA256_PATTERN,
      `${entry.packageName}.sha256`,
    );
    if (!Number.isSafeInteger(rawEntry.size) || rawEntry.size <= 0) {
      fail(`${entry.packageName}.size must be a positive integer.`);
    }
    const filePath = await resolveRegularArtifactFile(artifactRoot, artifactPath);
    const identity = await hashFile(filePath);
    if (identity.sha256 !== expectedSha || identity.size !== rawEntry.size) {
      fail(`${entry.packageName} packed artifact hash or size mismatch.`);
    }
    allowedFiles.add(artifactPath);
    entries.push({ ...entry, artifactPath, ...identity });
  }
  if (new Set(entries.map((entry) => entry.packageName)).size !== entries.length) {
    fail("Bootstrap artifact manifest must not contain duplicate package names.");
  }
  assertExactPackageSet(entries, expectedPlugins);

  const inventory = await listFiles(artifactRoot);
  const expectedInventory = [...allowedFiles].sort();
  if (JSON.stringify(inventory) !== JSON.stringify(expectedInventory)) {
    fail(
      `Bootstrap artifact inventory mismatch: expected ${expectedInventory.join(",")}, found ${inventory.join(",")}.`,
    );
  }
  return { ...manifest, entries };
}

function parseArgs(argv) {
  const values = [...argv];
  const command = values.shift();
  const result = { command };
  while (values.length > 0) {
    const key = values.shift();
    const value = values.shift();
    if (!key?.startsWith("--") || value === undefined) {
      fail(`Invalid argument: ${String(key)}`);
    }
    result[key.slice(2).replaceAll("-", "_")] = value;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const common = {
    artifactRoot: args.artifact_root,
    artifactName: args.artifact_name,
    repository: args.repository,
    targetSha: args.target_sha,
    workflowSha: args.workflow_sha,
    runId: args.run_id,
    runAttempt: args.run_attempt,
    plugins: args.plugins,
  };
  if (args.command === "create") {
    await createClawHubBootstrapArtifactManifest({
      ...common,
      matrixPath: args.matrix,
      outputPath: args.output,
    });
    return;
  }
  if (args.command === "verify") {
    const manifest = await verifyClawHubBootstrapArtifactManifest({
      ...common,
      manifestPath: args.manifest,
    });
    if (args.output) {
      await mkdir(dirname(args.output), { recursive: true });
      await writeFile(args.output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    } else {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    }
    return;
  }
  fail("Usage: clawhub-bootstrap-artifact.mjs <create|verify> [options]");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
