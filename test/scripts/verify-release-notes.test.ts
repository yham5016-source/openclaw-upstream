import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contaminatingPullRequestReferences,
  commitOutputTransaction,
  countTopLevelSectionBullets,
  cumulativeShippedPullRequests,
  githubApi,
  highlightCountError,
  pullRequestMergedByTarget,
  releaseNoteReferences,
  standardRevertedHash,
  subtractShippedPullRequests,
  withoutExcludedContributionRecords,
} from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";

const verifier = resolve(
  ".agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs",
);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "test@openclaw.invalid",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "test@openclaw.invalid",
    },
  }).trim();
}

describe("release-note verification", () => {
  it("ignores nested revert markers in squash-merge bodies", () => {
    const nestedRevert = [
      "feat(android): render display math (#101435)",
      "",
      "* feat(android): render display math",
      "",
      ' * Revert "docs(changelog): note display math"',
      "",
      `This reverts commit ${"a".repeat(40)}.`,
    ].join("\n");
    const topLevelRevert = [
      'Revert "fix(qa): keep smoke profile on one channel (#101173)" (#101184)',
      "",
      `This reverts commit ${"b".repeat(40)}.`,
    ].join("\n");
    const explainedTopLevelRevert = [
      "revert: restore a provider default",
      "",
      "The replacement broke non-native endpoints.",
      "",
      `This reverts commit ${"c".repeat(40)}.`,
    ].join("\n");

    expect(standardRevertedHash(nestedRevert)).toBeUndefined();
    expect(standardRevertedHash(topLevelRevert)).toBe("b".repeat(40));
    expect(standardRevertedHash(explainedTopLevelRevert)).toBe("c".repeat(40));
  });

  it("retries truncated JSON and exit-zero HTML with sanitized exhausted context", () => {
    const query = "query { viewer { login } }";
    const responses = [
      '{"data":{"viewer":{"login":"openclaw"}}',
      "<html><body>upstream unavailable</body></html>",
      '{"data":{"viewer":{"login":"openclaw"}}}',
    ];
    const sleeps: number[] = [];
    const result = githubApi(["graphql", "-f", `query=${query}`], {
      execute: () => responses.shift()!,
      retryDelaysMs: [10, 20],
      sleep: (delayMs: number) => sleeps.push(delayMs),
    });
    expect(result).toEqual({ data: { viewer: { login: "openclaw" } } });
    expect(sleeps).toEqual([10, 20]);

    const secret = `github_pat_${"secret".repeat(8)}`;
    let exhausted: unknown;
    try {
      githubApi(["graphql", "-f", `query=${query}`], {
        execute: () => `<html><body>upstream unavailable ${secret}</body></html>`,
        retryDelaysMs: [0, 0],
        sleep: () => undefined,
      });
    } catch (error) {
      exhausted = error;
    }
    expect(exhausted).toBeInstanceOf(Error);
    expect((exhausted as Error).message).toMatch(
      /^GitHub API graphql query sha256=[0-9a-f]{64} failed after 3\/3 attempts: non-JSON body prefix=/,
    );
    try {
      githubApi(["graphql", "-f", `query=${query}`], {
        execute: () => `<html><body>upstream unavailable ${secret}</body></html>`,
        retryDelaysMs: [],
      });
    } catch (error) {
      expect(String(error)).toContain("[redacted-token]");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("retries only transient nonzero API failures and never accepts their JSON stdout", () => {
    const query = "query { viewer { login } }";
    const sleeps: number[] = [];
    let calls = 0;
    const result = githubApi(["graphql", "-f", `query=${query}`], {
      execute: () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("command failed"), {
            status: 1,
            stderr: "HTTP 429: secondary rate limit",
            stdout: '{"message":"API rate limit exceeded"}',
          });
        }
        return '{"data":{"viewer":{"login":"openclaw"}}}';
      },
      retryDelaysMs: [10],
      sleep: (delayMs: number) => sleeps.push(delayMs),
    });
    expect(result).toEqual({ data: { viewer: { login: "openclaw" } } });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([10]);

    const secret = `github_pat_${"private".repeat(8)}`;
    let permanentCalls = 0;
    expect(() =>
      githubApi(["graphql", "-f", `query=${query}`], {
        execute: () => {
          permanentCalls += 1;
          throw Object.assign(new Error(`command included ${secret} and ${query}`), {
            status: 1,
            stderr: "HTTP 401: Bad credentials",
            stdout: '{"message":"Bad credentials"}',
          });
        },
        retryDelaysMs: [10, 20],
        sleep: () => {
          throw new Error("permanent API failures must not sleep");
        },
      }),
    ).toThrow(/failed after 1\/3 attempts: error response prefix=/);
    expect(permanentCalls).toBe(1);
  });

  it("parses and documents trusted adapted backport provenance", () => {
    const valid = `501:${"a".repeat(40)}:${"b".repeat(40)}`;
    const accepted = spawnSync(
      process.execPath,
      [verifier, "--help", "--provenance-pr-adapted", valid],
      { encoding: "utf8" },
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("--provenance-pr-adapted");

    const rejected = spawnSync(
      process.execPath,
      [
        verifier,
        "--base",
        "HEAD",
        "--target",
        "HEAD",
        "--version",
        "2026.7.1",
        "--provenance-pr-adapted",
        "invalid",
      ],
      { encoding: "utf8" },
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("invalid --provenance-pr-adapted value");
  });

  it("parses and documents grouped integrated backport provenance", () => {
    const target = "c".repeat(40);
    const accepted = spawnSync(
      process.execPath,
      [
        verifier,
        "--help",
        "--provenance-pr-integrated",
        `501:${"a".repeat(40)}:${target}`,
        "--provenance-pr-integrated",
        `501:${"b".repeat(40)}:${target}`,
      ],
      { encoding: "utf8" },
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("--provenance-pr-integrated");

    const rejected = spawnSync(
      process.execPath,
      [
        verifier,
        "--base",
        "HEAD",
        "--target",
        "HEAD",
        "--version",
        "2026.7.1",
        "--provenance-pr-integrated",
        "invalid",
      ],
      { encoding: "utf8" },
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("invalid --provenance-pr-integrated value");

    const conflicting = spawnSync(
      process.execPath,
      [
        verifier,
        "--help",
        "--provenance-pr-integrated",
        `501:${"a".repeat(40)}:${target}`,
        "--provenance-pr-integrated",
        `502:${"b".repeat(40)}:${target}`,
      ],
      { encoding: "utf8" },
    );
    expect(conflicting.status).not.toBe(0);
    expect(conflicting.stderr).toContain(
      "--provenance-pr-integrated target SHAs must map to one pull request",
    );
  });

  it("binds seeded PR merge time to the seed target", () => {
    const target = "a".repeat(40);
    const timestamp = Date.parse("2026-07-09T00:00:00Z");

    expect(
      pullRequestMergedByTarget(
        {
          mergedAt: "2026-07-08T23:59:59Z",
          mergeCommit: { oid: "b".repeat(40) },
        },
        target,
        timestamp,
      ),
    ).toBe(true);
    expect(
      pullRequestMergedByTarget(
        {
          mergedAt: "2026-07-09T00:00:01.001Z",
          mergeCommit: { oid: target },
        },
        target,
        timestamp,
      ),
    ).toBe(false);
    expect(
      pullRequestMergedByTarget(
        {
          mergedAt: "2026-07-09T00:00:01Z",
          mergeCommit: { oid: target },
        },
        target,
        timestamp,
      ),
    ).toBe(true);
    expect(
      pullRequestMergedByTarget(
        {
          mergedAt: "2026-07-09T00:00:01Z",
          mergeCommit: { oid: "b".repeat(40) },
        },
        target,
        timestamp,
      ),
    ).toBe(false);
  });

  it("rejects a malformed seed contribution record before carrying it forward", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-seed-"));
    try {
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "## 2026.7.1",
          "",
          "### Highlights",
          "",
          "- One.",
          "- Two.",
          "- Three.",
          "- Four.",
          "- Five.",
          "",
          "### Changes",
          "",
          "### Fixes",
          "",
          "### Complete contribution record",
          "",
          `This audited record covers the complete HEAD..${"a".repeat(40)} history: 0 merged PRs.`,
          `This audited record covers the complete HEAD..${"b".repeat(40)} history: 0 merged PRs.`,
          "",
          "#### Pull requests",
          "",
        ].join("\n"),
      );
      git(cwd, ["init", "-q"]);
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--seed-ref",
          "HEAD",
          "--write-ledger",
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "seed ref HEAD must contain exactly one complete contribution record provenance line; found 2",
      );
      expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toContain(`HEAD..${"b".repeat(40)}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects manifest paths that alias the verified changelog in audit mode", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-manifest-alias-"));
    try {
      const changelog = [
        "# Changelog",
        "",
        "## 2026.7.1",
        "",
        "### Highlights",
        "",
        "- One.",
        "- Two.",
        "- Three.",
        "- Four.",
        "- Five.",
        "",
        "### Changes",
        "",
        "### Fixes",
      ].join("\n");
      writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
      symlinkSync("CHANGELOG.md", join(cwd, "manifest-link.json"));
      git(cwd, ["init", "-q"]);
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);

      for (const manifestPath of [
        join(cwd, "CHANGELOG.md"),
        join(cwd, "changelog.md"),
        join(cwd, "manifest-link.json"),
      ]) {
        const result = spawnSync(
          process.execPath,
          [
            verifier,
            "--base",
            "HEAD",
            "--target",
            "HEAD",
            "--version",
            "2026.7.1",
            "--manifest",
            manifestPath,
            "--json",
          ],
          { cwd, encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("--manifest must not alias CHANGELOG.md");
        expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe(changelog);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("atomically rejects output when a verified input changes before commit", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-output-"));
    try {
      const changelog = join(cwd, "CHANGELOG.md");
      const manifest = join(cwd, "manifest.json");
      writeFileSync(changelog, "original\n");
      const expectedChangelog = { bytes: Buffer.from("original\n"), exists: true };
      const expectedManifest = { bytes: Buffer.alloc(0), exists: false };

      expect(() =>
        commitOutputTransaction([
          {
            content: "candidate\n",
            expected: expectedChangelog,
            path: changelog,
          },
          {
            content: "alias\n",
            expected: expectedChangelog,
            path: `${cwd}/./CHANGELOG.md`,
          },
        ]),
      ).toThrow("release output transaction paths must be unique");
      expect(readFileSync(changelog, "utf8")).toBe("original\n");
      expect(() =>
        commitOutputTransaction([
          {
            content: "candidate\n",
            expected: expectedChangelog,
            path: changelog,
          },
          {
            content: "case alias\n",
            expected: expectedChangelog,
            path: join(cwd, "changelog.md"),
          },
        ]),
      ).toThrow("release output transaction paths must be unique");

      expect(() =>
        commitOutputTransaction(
          [
            {
              content: "candidate\n",
              expected: expectedChangelog,
              path: changelog,
            },
            {
              content: "{}\n",
              expected: expectedManifest,
              path: manifest,
            },
          ],
          {
            beforeCommit: () => writeFileSync(changelog, "external mutation\n"),
          },
        ),
      ).toThrow("release output changed during verification");
      expect(readFileSync(changelog, "utf8")).toBe("external mutation\n");
      expect(() => readFileSync(manifest, "utf8")).toThrow();
      expect(readdirSync(cwd).some((path) => path.includes(".tmp-"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("counts only top-level Highlights bullets and enforces the 5-8 policy input", () => {
    const highlights = [
      "### Highlights",
      "",
      "- One",
      "  - nested detail",
      "- Two",
      "- Three",
      "- Four",
      "- Five",
      "",
      "### Changes",
      "",
      "- Not a highlight",
    ].join("\n");
    const overLimit = highlights.replace("- Five", "- Five\n- Six\n- Seven\n- Eight\n- Nine");

    expect(countTopLevelSectionBullets(highlights, "Highlights")).toBe(5);
    expect(countTopLevelSectionBullets(overLimit, "Highlights")).toBe(9);
    expect(highlightCountError(highlights)).toBeUndefined();
    expect(highlightCountError(overLimit)).toBe(
      "### Highlights must contain 5-8 top-level bullets; found 9",
    );
  });

  it("rejects prior-release PRs from prose or the existing record unless explicitly seeded", () => {
    const nodes = new Map([
      [97118, { __typename: "PullRequest" }],
      [102000, { __typename: "PullRequest" }],
      [98565, { __typename: "Issue" }],
    ]);
    const params = {
      noteReferences: [97118, 98565],
      recordedReferences: [97118, 102000],
      sourcePullRequests: new Set([102000]),
      sourceReferences: [102000, 98565],
      seededPullRequests: new Set<number>(),
      nodes,
    };

    expect(contaminatingPullRequestReferences(params)).toEqual([97118]);
    expect(
      contaminatingPullRequestReferences({
        ...params,
        seededPullRequests: new Set([97118]),
      }),
    ).toEqual([]);
  });

  it("excludes Unreleased records from a cumulative shipped tag boundary", () => {
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "### Complete contribution record",
      "",
      `This audited record covers the complete base..${"a".repeat(40)} history: 1 merged PR.`,
      "",
      "#### Pull requests",
      "",
      "- **PR #1** fix: not shipped.",
      "",
      "## 2026.6.11",
      "",
      "### Complete contribution record",
      "",
      "This audited record covers the complete base..HEAD history: 0 merged PRs.",
      "",
      "#### Pull requests",
      "",
      "- **PR #2** fix: shipped.",
    ].join("\n");

    expect([...cumulativeShippedPullRequests(changelog, "test baseline")]).toEqual([2]);
  });

  it("subtracts cumulative shipped PRs deterministically from the source inventory", () => {
    const source = {
      pullRequests: new Set([1, 2, 3]),
      references: [1, 2, 4],
    };

    const result = subtractShippedPullRequests(source, [
      { ref: "v2026.6.11", pullRequests: new Set([1, 2]) },
      { ref: "v2026.6.10", pullRequests: new Set([2, 4]) },
    ]);

    expect([...source.pullRequests]).toEqual([3]);
    expect(source.references).toEqual([]);
    expect(result.baselines).toEqual([
      { ref: "v2026.6.10", count: 2, pullRequests: [2, 4] },
      { ref: "v2026.6.11", count: 1, pullRequests: [1] },
    ]);
    expect([...result.pullRequests].toSorted((a, b) => a - b)).toEqual([1, 2, 4]);
  });

  it("removes rewrite-excluded references from an existing contribution record", () => {
    const record = {
      pullRequests: new Map([
        [1, { references: [2, 10], thanks: [] }],
        [2, { references: [11], thanks: [] }],
      ]),
      legacyIssues: new Map([
        [10, { references: [], thanks: [] }],
        [11, { references: [], thanks: [] }],
      ]),
    };

    const filtered = withoutExcludedContributionRecords(record, new Set([2, 10]));

    expect([...filtered.pullRequests]).toEqual([
      [1, { externalReferences: [], references: [], thanks: [] }],
    ]);
    expect([...filtered.legacyIssues]).toEqual([
      [11, { externalReferences: [], references: [], thanks: [] }],
    ]);
  });

  it("does not treat the shipped baseline inventory as current release-note references", () => {
    const baselines = [{ ref: "v2026.6.11", count: 2, pullRequests: [1, 2] }];
    const section = [
      "## 2026.7.1",
      "",
      "- Fixes #1 in the current range.",
      "",
      "### Complete contribution record",
      "",
      "Shipped baseline exclusions: v2026.6.11 (2 PRs: #1, #2).",
      "",
      "- **PR #3** fix: current work.",
    ].join("\n");

    expect(releaseNoteReferences(section, baselines)).toEqual([1, 3]);
  });

  it("records a canonical target SHA when --target is symbolic", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "## 2026.7.1",
          "",
          "### Highlights",
          "",
          "- One.",
          "- Two.",
          "- Three.",
          "- Four.",
          "- Five.",
          "",
          "### Changes",
          "",
          "### Fixes",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const targetSha = git(cwd, ["rev-parse", "HEAD"]);

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--write-ledger",
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout).target).toBe(targetSha);
      expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toContain(
        `This audited record covers the complete HEAD..${targetSha} history:`,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rewrites stale contribution rows without treating them as source references", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "## 2026.7.1",
          "",
          "### Highlights",
          "",
          "- One.",
          "- Two.",
          "- Three.",
          "- Four.",
          "- Five.",
          "",
          "### Changes",
          "",
          "### Fixes",
          "",
          "### Complete contribution record",
          "",
          "This audited record covers the complete HEAD..HEAD history: 1 merged PR.",
          "",
          "#### Pull requests",
          "",
          "- **PR #999999999**",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const bin = join(cwd, "bin");
      mkdirSync(bin);
      const ghx = join(bin, "ghx");
      writeFileSync(
        ghx,
        `#!/bin/sh
cat <<'JSON'
{"data":{"n999999999":{"issueOrPullRequest":{"__typename":"PullRequest","number":999999999,"title":"stale fixture","mergedAt":"2020-01-01T00:00:00Z","author":null,"closingIssuesReferences":{"totalCount":0,"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}
JSON
`,
      );
      chmodSync(ghx, 0o755);
      const manifestPath = join(cwd, "release-manifest.json");

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--manifest",
          manifestPath,
          "--write-ledger",
          "--json",
        ],
        {
          cwd,
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );

      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      const expectedReconciliation = {
        canonicalRows: { count: 0 },
        currentRows: { count: 0, members: [] },
        staleRows: { count: 0, members: [] },
      };
      expect(JSON.parse(result.stdout).reconciliation).toMatchObject(expectedReconciliation);
      const rewrittenChangelog = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
      expect(rewrittenChangelog).not.toContain("#999999999");
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
        artifacts: {
          changelogSha256: createHash("sha256").update(rewrittenChangelog).digest("hex"),
        },
        reconciliation: expectedReconciliation,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("writes an audit manifest when release-note validation fails", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      const changelog = [
        "# Changelog",
        "",
        "## 2026.7.1",
        "",
        "### Highlights",
        "",
        "- One.",
        "- Two.",
        "- Three.",
        "- Four.",
        "",
        "### Changes",
        "",
        "### Fixes",
      ].join("\n");
      writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
      git(cwd, ["init", "-q"]);
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const manifestPath = join(cwd, "release-manifest.json");
      writeFileSync(manifestPath, "sentinel\n");

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--manifest",
          manifestPath,
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(1);
      expect(JSON.parse(result.stdout).errors).toContain(
        "### Highlights must contain 5-8 top-level bullets; found 4",
      );
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
        schemaVersion: 4,
        artifacts: {
          changelogSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          releaseSectionSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        base: "HEAD",
        target: expect.stringMatching(/^[0-9a-f]{40}$/),
        reconciliation: {
          canonicalRows: { count: 0, members: [] },
        },
      });
      expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe(changelog);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses the raw merge base when the shipped release line diverged", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "## 2026.7.1",
          "",
          "### Highlights",
          "",
          "- One.",
          "- Two.",
          "- Three.",
          "- Four.",
          "- Five.",
          "",
          "### Changes",
          "",
          "### Fixes",
          "",
          "### Complete contribution record",
          "",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      git(cwd, ["branch", "target"]);

      writeFileSync(join(cwd, "base.txt"), "base\n");
      git(cwd, ["add", "base.txt"]);
      git(cwd, ["commit", "-qm", "base"]);
      git(cwd, ["tag", "base-ref"]);

      git(cwd, ["checkout", "-q", "target"]);
      const target = git(cwd, ["rev-parse", "HEAD"]);

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "base-ref",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--write-ledger",
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        mergeBase: target,
        target,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
