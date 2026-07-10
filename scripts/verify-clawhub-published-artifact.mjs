#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ATTEMPTS = 12;
const DEFAULT_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;
const MAX_ARTIFACT_BYTES = 130 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function positiveInteger(value, fallback, label) {
  const parsed = value === undefined ? fallback : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer.`);
  }
  return parsed;
}

function retryDelayMs(response, attempt, baseDelayMs) {
  const retryAfter = response?.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_DELAY_MS, Math.max(1, Math.round(seconds * 1_000)));
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.min(MAX_DELAY_MS, Math.max(1, dateMs - Date.now()));
    }
  }
  return Math.min(MAX_DELAY_MS, baseDelayMs * attempt);
}

function retryableStatus(status) {
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function fetchClawHubWithRetry(
  url,
  options = {},
  {
    fetchImpl = fetch,
    attempts = DEFAULT_ATTEMPTS,
    delayMs = DEFAULT_DELAY_MS,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const resolvedAttempts = positiveInteger(attempts, DEFAULT_ATTEMPTS, "attempts");
  const resolvedDelayMs = positiveInteger(delayMs, DEFAULT_DELAY_MS, "delayMs");
  let lastFailure = "unknown";
  for (let attempt = 1; attempt <= resolvedAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
        ...options,
      });
      if (!retryableStatus(response.status)) {
        return response;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < resolvedAttempts) {
      await sleep(retryDelayMs(response, attempt, resolvedDelayMs));
    }
  }
  fail(`${url} did not stabilize after ${resolvedAttempts} attempts; last failure ${lastFailure}.`);
}

async function readBoundedBytes(response, label) {
  if (!response.body) {
    fail(`${label} returned no response body.`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_ARTIFACT_BYTES) {
      await reader.cancel();
      fail(`${label} exceeded ${MAX_ARTIFACT_BYTES} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function requireJson(url, retryOptions) {
  const response = await fetchClawHubWithRetry(
    url,
    { headers: { accept: "application/json" } },
    retryOptions,
  );
  if (!response.ok) {
    fail(`${url} returned HTTP ${response.status}.`);
  }
  const bytes = await readBoundedBytes(response, url);
  if (bytes.byteLength > 1024 * 1024) {
    fail(`${url} returned oversized JSON.`);
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function verifyPublishedClawHubArtifacts(options) {
  const registry = String(options.registry ?? "https://clawhub.ai").replace(/\/+$/u, "");
  const manifest = JSON.parse(await readFile(options.manifestPath, "utf8"));
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail("Validated bootstrap manifest has no entries.");
  }
  const results = [];
  for (const entry of manifest.entries) {
    const encodedName = encodeURIComponent(entry.packageName);
    const encodedVersion = encodeURIComponent(entry.version);
    const detailUrl = `${registry}/api/v1/packages/${encodedName}`;
    const versionUrl = `${detailUrl}/versions/${encodedVersion}`;
    const artifactUrl = `${versionUrl}/artifact/download`;
    const detail = await requireJson(detailUrl, options.retryOptions);
    if (detail?.package?.tags?.[entry.publishTag] !== entry.version) {
      fail(
        `${entry.packageName}: ClawHub tag ${entry.publishTag} does not point to ${entry.version}.`,
      );
    }
    const trustedPublisher = (
      await requireJson(`${detailUrl}/trusted-publisher`, options.retryOptions)
    )?.trustedPublisher;
    if (
      trustedPublisher?.repository !== "openclaw/openclaw" ||
      trustedPublisher?.workflowFilename !== "plugin-clawhub-release.yml" ||
      trustedPublisher?.environment != null
    ) {
      fail(`${entry.packageName}: trusted publisher config does not match OpenClaw OIDC.`);
    }
    const versionResponse = await fetchClawHubWithRetry(versionUrl, {}, options.retryOptions);
    if (!versionResponse.ok) {
      fail(`${versionUrl} returned HTTP ${versionResponse.status}.`);
    }
    const artifactResponse = await fetchClawHubWithRetry(artifactUrl, {}, options.retryOptions);
    if (!artifactResponse.ok) {
      fail(`${artifactUrl} returned HTTP ${artifactResponse.status}.`);
    }
    const bytes = await readBoundedBytes(artifactResponse, artifactUrl);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const size = bytes.byteLength;
    if (entry.bootstrapMode === "publish" && (sha256 !== entry.sha256 || size !== entry.size)) {
      fail(`${entry.packageName}: published ClawHub artifact hash or size mismatch.`);
    }
    results.push({
      packageName: entry.packageName,
      version: entry.version,
      publishTag: entry.publishTag,
      bootstrapMode: entry.bootstrapMode,
      expectedSha256: entry.bootstrapMode === "publish" ? entry.sha256 : null,
      expectedSize: entry.bootstrapMode === "publish" ? entry.size : null,
      registrySha256: sha256,
      registrySize: size,
    });
  }
  return {
    schemaVersion: 1,
    repository: manifest.repository,
    targetSha: manifest.targetSha,
    workflowSha: manifest.workflowSha,
    runId: manifest.runId,
    runAttempt: manifest.runAttempt,
    artifactName: manifest.artifactName,
    artifactId: options.artifactId,
    artifactDigest: options.artifactDigest,
    packages: results,
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`Invalid argument: ${String(key)}`);
    }
    result[key.slice(2).replaceAll("-", "_")] = value;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidence = await verifyPublishedClawHubArtifacts({
    registry: args.registry,
    manifestPath: args.manifest,
    artifactId: args.artifact_id,
    artifactDigest: args.artifact_digest,
    retryOptions: {
      attempts: positiveInteger(
        process.env.OPENCLAW_CLAWHUB_VERIFY_ATTEMPTS,
        DEFAULT_ATTEMPTS,
        "OPENCLAW_CLAWHUB_VERIFY_ATTEMPTS",
      ),
      delayMs: positiveInteger(
        process.env.OPENCLAW_CLAWHUB_VERIFY_DELAY_MS,
        DEFAULT_DELAY_MS,
        "OPENCLAW_CLAWHUB_VERIFY_DELAY_MS",
      ),
    },
  });
  if (args.output) {
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
