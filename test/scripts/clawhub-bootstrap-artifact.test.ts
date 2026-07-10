import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClawHubBootstrapArtifactManifest,
  verifyClawHubBootstrapArtifactManifest,
} from "../../scripts/lib/clawhub-bootstrap-artifact.mjs";

const tempDirs: string[] = [];
const targetSha = "a".repeat(40);
const workflowSha = "b".repeat(40);

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-bootstrap-"));
  tempDirs.push(root);
  const artifactRoot = join(root, "artifact");
  const packageRoot = join(artifactRoot, "packages", "meta");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "openclaw-meta-2026.7.1-beta.3.tgz"), "packed meta");
  const matrixPath = join(root, "matrix.json");
  writeFileSync(
    matrixPath,
    JSON.stringify([
      {
        packageName: "@openclaw/meta",
        version: "2026.7.1-beta.3",
        packageDir: "extensions/meta",
        publishTag: "beta",
        bootstrapMode: "publish",
        requiresManualOverride: false,
      },
      {
        packageName: "@openclaw/existing",
        version: "2026.7.1-beta.3",
        packageDir: "extensions/existing",
        publishTag: "beta",
        bootstrapMode: "configure-only",
        requiresManualOverride: true,
      },
    ]),
  );
  return {
    artifactRoot,
    matrixPath,
    manifestPath: join(artifactRoot, "manifest.json"),
  };
}

function common(paths: ReturnType<typeof fixture>) {
  return {
    artifactRoot: paths.artifactRoot,
    artifactName: `clawhub-bootstrap-${targetSha.slice(0, 12)}-123-2`,
    plugins: "@openclaw/meta,@openclaw/existing",
    repository: "openclaw/openclaw",
    runAttempt: "2",
    runId: "123",
    targetSha,
    workflowSha,
  };
}

describe("ClawHub bootstrap artifact manifest", () => {
  it("binds the exact package set and packed file identity", async () => {
    const paths = fixture();
    const created = await createClawHubBootstrapArtifactManifest({
      ...common(paths),
      matrixPath: paths.matrixPath,
      outputPath: paths.manifestPath,
    });
    const meta = created.entries.find((entry) => entry.packageName === "@openclaw/meta");
    expect(meta).toMatchObject({
      artifactPath: "packages/meta/openclaw-meta-2026.7.1-beta.3.tgz",
      size: 11,
    });
    expect(meta?.sha256).toMatch(/^[a-f0-9]{64}$/u);

    await expect(
      verifyClawHubBootstrapArtifactManifest({
        ...common(paths),
        manifestPath: paths.manifestPath,
      }),
    ).resolves.toEqual(created);
  });

  it("rejects changed bytes and extra artifact files", async () => {
    const paths = fixture();
    await createClawHubBootstrapArtifactManifest({
      ...common(paths),
      matrixPath: paths.matrixPath,
      outputPath: paths.manifestPath,
    });
    writeFileSync(
      join(paths.artifactRoot, "packages", "meta", "openclaw-meta-2026.7.1-beta.3.tgz"),
      "changed",
    );
    await expect(
      verifyClawHubBootstrapArtifactManifest({
        ...common(paths),
        manifestPath: paths.manifestPath,
      }),
    ).rejects.toThrow("packed artifact hash or size mismatch");

    const manifest = JSON.parse(readFileSync(paths.manifestPath, "utf8"));
    writeFileSync(
      join(paths.artifactRoot, "packages", "meta", "openclaw-meta-2026.7.1-beta.3.tgz"),
      "packed meta",
    );
    writeFileSync(join(paths.artifactRoot, "unexpected.txt"), "unexpected");
    await expect(
      verifyClawHubBootstrapArtifactManifest({
        ...common(paths),
        manifestPath: paths.manifestPath,
      }),
    ).rejects.toThrow("artifact inventory mismatch");
    expect(manifest.entries).toHaveLength(2);
  });

  it("never binds fresh bytes to configure-only repairs", async () => {
    const paths = fixture();
    const manifest = await createClawHubBootstrapArtifactManifest({
      ...common(paths),
      matrixPath: paths.matrixPath,
      outputPath: paths.manifestPath,
    });
    const existing = manifest.entries.find((entry) => entry.packageName === "@openclaw/existing");
    expect(existing).not.toHaveProperty("artifactPath");
    expect(existing).not.toHaveProperty("sha256");
    expect(existing).not.toHaveProperty("size");
  });
});
