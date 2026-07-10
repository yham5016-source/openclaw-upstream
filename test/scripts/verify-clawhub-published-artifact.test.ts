import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchClawHubWithRetry,
  verifyPublishedClawHubArtifacts,
} from "../../scripts/verify-clawhub-published-artifact.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeManifest(mode: "publish" | "configure-only", artifact: Uint8Array) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-readback-"));
  tempDirs.push(root);
  const path = join(root, "manifest.json");
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      repository: "openclaw/openclaw",
      targetSha: "a".repeat(40),
      workflowSha: "b".repeat(40),
      runId: "123",
      runAttempt: "1",
      artifactName: "clawhub-bootstrap-aaaaaaaaaaaa-123-1",
      entries: [
        {
          packageName: "@openclaw/meta",
          version: "2026.7.1-beta.3",
          publishTag: "beta",
          bootstrapMode: mode,
          ...(mode === "publish" ? { sha256, size: artifact.byteLength } : {}),
        },
      ],
    }),
  );
  return path;
}

function registryFetch(artifact: Uint8Array) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/trusted-publisher")) {
      return Response.json({
        trustedPublisher: {
          repository: "openclaw/openclaw",
          workflowFilename: "plugin-clawhub-release.yml",
          environment: null,
        },
      });
    }
    if (url.endsWith("/artifact/download")) {
      return new Response(artifact);
    }
    if (url.includes("/versions/")) {
      return Response.json({ version: "2026.7.1-beta.3" });
    }
    return Response.json({
      package: { tags: { beta: "2026.7.1-beta.3" } },
    });
  });
}

describe("ClawHub published artifact verification", () => {
  it("requires exact registry bytes for a newly published package", async () => {
    const artifact = new TextEncoder().encode("exact tgz bytes");
    const evidence = await verifyPublishedClawHubArtifacts({
      artifactDigest: "c".repeat(64),
      artifactId: "456",
      manifestPath: writeManifest("publish", artifact),
      registry: "https://clawhub.example",
      retryOptions: { fetchImpl: registryFetch(artifact), attempts: 1, delayMs: 1 },
    });
    expect(evidence.packages).toEqual([
      expect.objectContaining({
        packageName: "@openclaw/meta",
        registrySha256: createHash("sha256").update(artifact).digest("hex"),
        registrySize: artifact.byteLength,
      }),
    ]);
  });

  it("rejects registry bytes that differ from the packed artifact", async () => {
    const expected = new TextEncoder().encode("expected");
    const actual = new TextEncoder().encode("actual");
    await expect(
      verifyPublishedClawHubArtifacts({
        manifestPath: writeManifest("publish", expected),
        registry: "https://clawhub.example",
        retryOptions: { fetchImpl: registryFetch(actual), attempts: 1, delayMs: 1 },
      }),
    ).rejects.toThrow("published ClawHub artifact hash or size mismatch");
  });

  it("records historical configure-only bytes without comparing them", async () => {
    const historical = new TextEncoder().encode("historical bytes");
    const evidence = await verifyPublishedClawHubArtifacts({
      manifestPath: writeManifest("configure-only", new Uint8Array()),
      registry: "https://clawhub.example",
      retryOptions: { fetchImpl: registryFetch(historical), attempts: 1, delayMs: 1 },
    });
    expect(evidence.packages[0]).toMatchObject({
      bootstrapMode: "configure-only",
      expectedSha256: null,
      expectedSize: null,
      registrySize: historical.byteLength,
    });
  });

  it("retries transient responses without sleeping after the final attempt", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await expect(
      fetchClawHubWithRetry(
        "https://clawhub.example/test",
        {},
        { fetchImpl, attempts: 2, delayMs: 1, sleep },
      ),
    ).resolves.toHaveProperty("status", 200);
    expect(sleep).toHaveBeenCalledTimes(1);

    const failingSleep = vi.fn(async () => {});
    await expect(
      fetchClawHubWithRetry(
        "https://clawhub.example/test",
        {},
        {
          fetchImpl: vi.fn(async () => new Response("", { status: 503 })),
          attempts: 2,
          delayMs: 1,
          sleep: failingSleep,
        },
      ),
    ).rejects.toThrow("did not stabilize after 2 attempts");
    expect(failingSleep).toHaveBeenCalledTimes(1);
  });
});
