import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  summarizeTeamUniverseMembers,
  summarizeTeamUniverseRecords,
  teamUniverseWindowQuery,
} from "../../.agents/skills/openclaw-changelog-update/scripts/lib/github-team-inventory.mjs";
import {
  assertCompleteReleaseSourceInventory,
  buildReleaseSourceInventory,
  canonicalGitEnvironment,
} from "../../.agents/skills/openclaw-changelog-update/scripts/lib/release-source-inventory.mjs";
import { sourceContributionsFromInventory } from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type CommitFiles = Record<string, string>;

let indexSequence = 0;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function git(
  cwd: string,
  args: string[],
  { env, input }: { env?: NodeJS.ProcessEnv; input?: Buffer | string } = {},
) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: canonicalGitEnvironment(env),
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

function withRepository<T>(run: (cwd: string) => T): T {
  const cwd = tempDirs.make("openclaw-release-source-inventory-");
  git(cwd, ["init", "-q", "--initial-branch=main"]);
  git(cwd, ["config", "user.name", "OpenClaw Test"]);
  git(cwd, ["config", "user.email", "test@openclaw.invalid"]);
  return run(cwd);
}

function createCommit(
  cwd: string,
  {
    body,
    files,
    parents = [],
    subject,
    timestamp,
  }: {
    body?: string;
    files: CommitFiles;
    parents?: string[];
    subject: string;
    timestamp: number;
  },
) {
  indexSequence += 1;
  const indexPath = join(cwd, `.release-source-index-${indexSequence}`);
  const commitDate = new Date(timestamp * 1000).toISOString();
  const env = {
    GIT_AUTHOR_DATE: commitDate,
    GIT_COMMITTER_DATE: commitDate,
    GIT_INDEX_FILE: indexPath,
  };
  try {
    git(cwd, ["read-tree", "--empty"], { env });
    for (const [path, content] of Object.entries(files).toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const blob = git(cwd, ["hash-object", "-w", "--stdin"], { input: content });
      git(cwd, ["update-index", "--add", "--cacheinfo", "100644", blob, path], { env });
    }
    const tree = git(cwd, ["write-tree"], { env });
    const message = body ? `${subject}\n\n${body}\n` : `${subject}\n`;
    return git(cwd, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])], {
      env,
      input: message,
    });
  } finally {
    rmSync(indexPath, { force: true });
  }
}

function completeAssociations(owners: Map<string, number[]>) {
  return (commits: string[]) =>
    new Map(commits.map((commit) => [commit, owners.get(commit) ?? []]));
}

function completeEvidence(
  owners: Map<string, number[]>,
  pullRequests = new Map<
    number,
    null | {
      __typename: "Issue" | "PullRequest";
      mergedAt?: string | null;
      number: number;
    }
  >(),
  {
    comparison,
    pullRequestCommits = new Map<number, string[]>(),
    pullRequestMetadata = new Map(),
  }: {
    comparison?: unknown;
    pullRequestCommits?: Map<number, string[]>;
    pullRequestMetadata?: Map<number, unknown>;
  } = {},
) {
  return {
    resolveAssociations: completeAssociations(owners),
    resolveComparisonPullRequests: () => comparison,
    resolvePullRequestCommits: (numbers: number[]) =>
      new Map(numbers.map((number) => [number, pullRequestCommits.get(number) ?? []])),
    resolvePullRequestMetadata: (numbers: number[]) =>
      new Map(numbers.map((number) => [number, pullRequestMetadata.get(number)])),
    resolvePullRequests: (numbers: number[]) =>
      new Map(
        numbers.map((number) => [
          number,
          pullRequests.has(number)
            ? (pullRequests.get(number) ?? null)
            : {
                __typename: "PullRequest",
                mergedAt: "1970-01-01T00:00:01.000Z",
                number,
              },
        ]),
      ),
  };
}

function commitRecord(inventory: ReturnType<typeof buildReleaseSourceInventory>, commit: string) {
  const record = inventory.commits.find((entry) => entry.commit === commit);
  expect(record).toBeDefined();
  return record!;
}

describe("release source inventory", () => {
  it("keeps evidence hashes stable under hostile local diff and attribute configuration", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "ordered.txt": "unchanged\n",
        "repeated.txt": "D\nC\nB\nA\nD\nC\nB\nA\nD\nC\nB\nA\nD\nC\nB\nA\nD\nC\nB\nA\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const target = createCommit(cwd, {
        files: {
          ...rootFiles,
          "ordered.txt": "changed\n",
          "repeated.txt": "D\nC\nB\nA\nC\nB\nA\nC\nB\nD\nC\nB\nA\nD\nC\nA\n",
        },
        parents: [root],
        subject: "fix: repeated-line behavior",
        timestamp: 20,
      });
      const build = () =>
        buildReleaseSourceInventory(
          { baseRef: root, cwd, sourceTargetRef: target },
          completeEvidence(new Map()),
        );
      const baseline = build();
      const attributesPath = join(cwd, ".git", "hostile-attributes");
      const orderPath = join(cwd, ".git", "hostile-diff-order");
      writeFileSync(attributesPath, "*.txt -diff\n");
      writeFileSync(orderPath, "repeated.txt\nordered.txt\n");
      for (const [key, value] of [
        ["core.attributesFile", attributesPath],
        ["core.quotePath", "false"],
        ["diff.algorithm", "histogram"],
        ["diff.context", "9"],
        ["diff.indentHeuristic", "true"],
        ["diff.interHunkContext", "99"],
        ["diff.mnemonicPrefix", "true"],
        ["diff.noprefix", "true"],
        ["diff.orderFile", orderPath],
        ["diff.renames", "copies"],
        ["diff.suppressBlankEmpty", "true"],
      ]) {
        git(cwd, ["config", key, value]);
      }
      const hostile = build();

      expect(canonicalGitEnvironment()).toMatchObject({
        GIT_ATTR_NOSYSTEM: "1",
        LC_ALL: "C",
      });
      expect(hostile.sha256).toBe(baseline.sha256);
      expect(commitRecord(hostile, target)).toEqual(commitRecord(baseline, target));
    }));

  it("rejects mutable repository-local info attributes", () =>
    withRepository((cwd) => {
      const root = createCommit(cwd, {
        files: { "CHANGELOG.md": "# Changelog\n" },
        subject: "chore: root",
        timestamp: 10,
      });
      writeFileSync(join(cwd, ".git", "info", "attributes"), "*.md -diff\n");

      expect(() =>
        buildReleaseSourceInventory(
          { baseRef: root, cwd, sourceTargetRef: root },
          completeEvidence(new Map()),
        ),
      ).toThrow("release source inventory refuses a non-empty Git info/attributes file");
    }));

  it("enumerates divergent target ancestry and keeps contextual references out of ownership", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "README.md": "root\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const divergentBase = createCommit(cwd, {
        files: { ...rootFiles, "base-only.txt": "published line\n" },
        parents: [root],
        subject: "chore: divergent published base",
        timestamp: 20,
      });
      const directFiles = { ...rootFiles, "direct.txt": "direct work\n" };
      const direct = createCommit(cwd, {
        files: directFiles,
        parents: [root],
        subject: "fix: direct behavior",
        timestamp: 30,
      });
      const contextualFiles = { ...directFiles, "mainline.txt": "mainline\n" };
      const contextual = createCommit(cwd, {
        body: "Context: #999",
        files: contextualFiles,
        parents: [direct],
        subject: "fix: contextual follow-up",
        timestamp: 40,
      });
      const sideFiles = { ...directFiles, "side.txt": "side branch\n" };
      const side = createCommit(cwd, {
        files: sideFiles,
        parents: [direct],
        subject: "feat: side branch behavior",
        timestamp: 50,
      });
      const mergeFiles = { ...contextualFiles, "side.txt": "side branch\n" };
      const merge = createCommit(cwd, {
        files: mergeFiles,
        parents: [contextual, side],
        subject: "Merge branch 'side'",
        timestamp: 60,
      });
      const strict = createCommit(cwd, {
        body: "Source-PR: #102",
        files: { ...mergeFiles, "strict.txt": "strict source\n" },
        parents: [merge],
        subject: "fix: strict source ownership",
        timestamp: 70,
      });

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: divergentBase,
          cwd,
          sourceTargetRef: strict,
        },
        completeEvidence(new Map([[side, [101]]])),
      );

      expect(inventory.range.mergeBase).toBe(root);
      expect(inventory.partitions.commits.universe.members).toEqual(
        [direct, contextual, side, merge, strict].toSorted(),
      );
      expect(inventory.commits.map((entry) => entry.commit)).toEqual([
        direct,
        contextual,
        side,
        merge,
        strict,
      ]);
      expect(commitRecord(inventory, direct)).toMatchObject({
        disposition: "direct",
        pullRequests: [],
      });
      expect(commitRecord(inventory, contextual)).toMatchObject({
        disposition: "direct",
        explicitPullRequestReferences: [],
        pullRequests: [],
        references: [999],
      });
      expect(commitRecord(inventory, side)).toMatchObject({
        disposition: "pull-request",
        evidence: [{ method: "association", number: 101, sourceCommit: side }],
        pullRequests: [101],
      });
      expect(commitRecord(inventory, merge)).toMatchObject({
        disposition: "structural-merge",
        parents: [contextual, side],
      });
      expect(commitRecord(inventory, strict)).toMatchObject({
        disposition: "pull-request",
        evidence: [{ method: "explicit-reference", number: 102, sourceCommit: strict }],
        explicitPullRequestReferences: [102],
        pullRequests: [102],
      });
      expect(inventory.partitions.commits).toMatchObject({
        direct: { count: 2 },
        pullRequest: { count: 2 },
        structuralMerge: { count: 1 },
        universe: { count: 5 },
      });
      expect(inventory.partitions.pullRequests.included.members).toEqual([101, 102]);
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("requires strict ownership references to be merged pull requests by the source cutoff", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const strict = createCommit(cwd, {
        body: "Co-authored-by: Contributor <contributor@example.com>",
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: strict source ownership (#501)",
        timestamp: 20,
      });
      const invalidEvidence = [
        {
          label: "unmerged pull request",
          node: {
            __typename: "PullRequest" as const,
            mergedAt: null,
            number: 501,
          },
        },
        {
          label: "late pull request",
          node: {
            __typename: "PullRequest" as const,
            mergedAt: "1970-01-01T00:00:21.000Z",
            number: 501,
          },
        },
      ];

      for (const evidence of invalidEvidence) {
        const inventory = buildReleaseSourceInventory(
          { baseRef: root, cwd, sourceTargetRef: strict },
          completeEvidence(new Map(), new Map([[501, evidence.node]])),
        );
        expect(commitRecord(inventory, strict), evidence.label).toMatchObject({
          disposition: "unresolved",
        });
        expect(() => assertCompleteReleaseSourceInventory(inventory)).toThrow(
          "is not a merged pull request by the source target cutoff",
        );
      }

      const issueReferenceInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: strict },
        completeEvidence(new Map(), new Map([[501, { __typename: "Issue", number: 501 }]])),
      );
      expect(commitRecord(issueReferenceInventory, strict)).toMatchObject({
        disposition: "direct",
        explicitPullRequestReferences: [],
        pullRequests: [],
        references: [501],
      });
      expect(assertCompleteReleaseSourceInventory(issueReferenceInventory)).toBe(
        issueReferenceInventory,
      );

      const required = createCommit(cwd, {
        body: "Source-PR: #501",
        files: { ...rootFiles, "required.txt": "new\n" },
        parents: [root],
        subject: "fix: required source ownership",
        timestamp: 20,
      });
      const requiredInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: required },
        completeEvidence(new Map(), new Map([[501, { __typename: "Issue", number: 501 }]])),
      );
      expect(commitRecord(requiredInventory, required)).toMatchObject({
        disposition: "unresolved",
      });
      expect(() => assertCompleteReleaseSourceInventory(requiredInventory)).toThrow(
        "is not a merged pull request by the source target cutoff",
      );

      const inventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: strict },
        completeEvidence(
          new Map(),
          new Map([
            [
              501,
              {
                __typename: "PullRequest",
                mergedAt: "1970-01-01T00:00:20.000Z",
                number: 501,
              },
            ],
          ]),
        ),
      );
      expect(commitRecord(inventory, strict)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [501],
      });
      const source = sourceContributionsFromInventory(inventory, new Map([[strict, ["alice"]]]));
      expect(source.activeCommits[0].coauthors).toEqual(["alice"]);
      expect(source.coauthorsByReference.get(501)).toEqual(new Set(["alice"]));
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      const exactMergeSkewInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: strict },
        completeEvidence(
          new Map([[strict, [501]]]),
          new Map([
            [
              501,
              {
                __typename: "PullRequest",
                mergedAt: "1970-01-01T00:00:21.000Z",
                number: 501,
              },
            ],
          ]),
        ),
      );
      expect(commitRecord(exactMergeSkewInventory, strict)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [501],
      });
      expect(assertCompleteReleaseSourceInventory(exactMergeSkewInventory)).toBe(
        exactMergeSkewInventory,
      );
    }));

  it("resolves exact cherry provenance and fails closed on ambiguous trusted patches", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "ambiguous.txt": "value=old\n",
        "cherry.txt": "old\n",
        "operator.txt": "old\n",
        "unique.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const cherryOrigin = createCommit(cwd, {
        files: { ...rootFiles, "cherry.txt": "new\n" },
        parents: [root],
        subject: "fix: cherry source",
        timestamp: 20,
      });
      const candidateOne = createCommit(cwd, {
        files: { ...rootFiles, "ambiguous.txt": "value = new\n" },
        parents: [root],
        subject: "fix: candidate one",
        timestamp: 22,
      });
      const candidateTwo = createCommit(cwd, {
        files: { ...rootFiles, "ambiguous.txt": "value = new\n" },
        parents: [root],
        subject: "fix: candidate two",
        timestamp: 23,
      });
      const patchIdCollision = createCommit(cwd, {
        files: { ...rootFiles, "ambiguous.txt": "value  =  new\n" },
        parents: [root],
        subject: "fix: whitespace collision",
        timestamp: 24,
      });
      const uniqueCandidate = createCommit(cwd, {
        files: { ...rootFiles, "unique.txt": "new\n" },
        parents: [root],
        subject: "fix: unique trusted source",
        timestamp: 25,
      });
      const operatorOrigin = createCommit(cwd, {
        files: { ...rootFiles, "operator.txt": "new\n" },
        parents: [root],
        subject: "fix: operator-supplied source",
        timestamp: 26,
      });
      const operatorPullRequestCommit = createCommit(cwd, {
        files: { ...rootFiles, "operator.txt": "new\n" },
        parents: [root],
        subject: "fix: pull request member",
        timestamp: 27,
      });
      const nonEquivalentOrigin = createCommit(cwd, {
        files: { ...rootFiles, "operator.txt": "source\n" },
        parents: [root],
        subject: "fix: conflict-adjusted source",
        timestamp: 28,
      });
      const cherry = createCommit(cwd, {
        body: `(cherry picked from commit ${cherryOrigin})`,
        files: { ...rootFiles, "cherry.txt": "new\n" },
        parents: [root],
        subject: "fix: cherry source",
        timestamp: 30,
      });
      const ambiguous = createCommit(cwd, {
        files: {
          ...rootFiles,
          "ambiguous.txt": "value = new\n",
          "cherry.txt": "new\n",
        },
        parents: [cherry],
        subject: "fix: ambiguous source",
        timestamp: 40,
      });
      const uniqueBackport = createCommit(cwd, {
        files: {
          ...rootFiles,
          "cherry.txt": "new\n",
          "unique.txt": "new\n",
        },
        parents: [cherry],
        subject: "fix: unique trusted source",
        timestamp: 41,
      });
      const operatorBackport = createCommit(cwd, {
        body: `(cherry picked from commit ${operatorOrigin})`,
        files: { ...rootFiles, "operator.txt": "new\n" },
        parents: [root],
        subject: "fix: operator-supplied source",
        timestamp: 42,
      });
      const nonEquivalentBackport = createCommit(cwd, {
        body: `(cherry picked from commit ${nonEquivalentOrigin})`,
        files: { ...rootFiles, "operator.txt": "backport\n" },
        parents: [root],
        subject: "fix: conflict-adjusted source (#306)",
        timestamp: 43,
      });
      const owners = new Map<string, number[]>([
        [cherryOrigin, [201]],
        [candidateOne, [301]],
        [candidateTwo, [302]],
        [patchIdCollision, [303]],
        [uniqueCandidate, [304]],
      ]);

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceRefs: [candidateOne, candidateTwo, patchIdCollision],
          sourceTargetRef: ambiguous,
        },
        completeEvidence(owners),
      );

      expect(commitRecord(inventory, cherry)).toMatchObject({
        disposition: "pull-request",
        evidence: [
          {
            method: "cherry-origin-association",
            number: 201,
            sourceCommit: cherryOrigin,
          },
        ],
        pullRequests: [201],
      });
      expect(commitRecord(inventory, ambiguous)).toMatchObject({
        disposition: "unresolved",
        pullRequests: [],
      });
      expect(inventory.unresolved).toContainEqual({
        commit: ambiguous,
        kind: "ownership",
        pullRequests: [301, 302],
        reason: "ownership evidence resolves to more than one pull request",
      });
      expect(inventory.unresolved.some((entry) => entry.pullRequests?.includes(303))).toBe(false);
      expect(inventory.partitions.pullRequests.included.members).toEqual([201]);
      expect(() => assertCompleteReleaseSourceInventory(inventory)).toThrow(
        "ownership evidence resolves to more than one pull request",
      );

      const uniqueInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceRefs: [uniqueCandidate],
          sourceTargetRef: uniqueBackport,
        },
        completeEvidence(owners),
      );
      expect(commitRecord(uniqueInventory, uniqueBackport)).toMatchObject({
        disposition: "pull-request",
        evidence: [
          {
            method: "trusted-patch-association",
            number: 304,
            sourceCommit: uniqueCandidate,
          },
        ],
        pullRequests: [304],
      });
      expect(assertCompleteReleaseSourceInventory(uniqueInventory)).toBe(uniqueInventory);

      const directCherryInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          sourceTargetRef: operatorBackport,
        },
        completeEvidence(owners),
      );
      expect(commitRecord(directCherryInventory, operatorBackport)).toMatchObject({
        disposition: "direct",
        pullRequests: [],
        verifiedCherryPickOrigins: [operatorOrigin],
      });
      expect(assertCompleteReleaseSourceInventory(directCherryInventory)).toBe(
        directCherryInventory,
      );

      const trustedInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenancePullRequests: [{ commitRef: operatorOrigin, number: 305 }],
          sourceTargetRef: operatorBackport,
        },
        completeEvidence(owners, new Map(), {
          pullRequestCommits: new Map([[305, [operatorPullRequestCommit]]]),
        }),
      );
      expect(commitRecord(trustedInventory, operatorBackport)).toMatchObject({
        disposition: "pull-request",
        evidence: [
          {
            method: "trusted-pr-provenance",
            number: 305,
            pullRequestCommit: operatorPullRequestCommit,
            sourceCommit: operatorOrigin,
          },
        ],
        pullRequests: [305],
      });
      expect(trustedInventory.range.provenancePullRequests).toEqual([
        {
          commit: operatorOrigin,
          details: [
            expect.objectContaining({
              method: "trusted-pr-provenance",
              number: 305,
              pullRequestCommit: operatorPullRequestCommit,
              targetCommit: operatorBackport,
              trailerOrigin: operatorOrigin,
            }),
          ],
          matchedCommits: [operatorBackport],
          number: 305,
          ref: operatorOrigin,
        },
      ]);
      expect(assertCompleteReleaseSourceInventory(trustedInventory)).toBe(trustedInventory);

      const revertedOperatorBackport = createCommit(cwd, {
        body: `This reverts commit ${operatorBackport}.`,
        files: rootFiles,
        parents: [operatorBackport],
        subject: 'Revert "fix: operator-supplied source"',
        timestamp: 44,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenancePullRequests: [{ commitRef: operatorOrigin, number: 305 }],
            sourceTargetRef: revertedOperatorBackport,
          },
          completeEvidence(owners, new Map(), {
            pullRequestCommits: new Map([[305, [operatorPullRequestCommit]]]),
          }),
        ),
      ).toThrow(`trusted provenance target commit ${operatorBackport} is not active`);

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenancePullRequests: [{ commitRef: uniqueCandidate, number: 305 }],
            sourceTargetRef: operatorBackport,
          },
          completeEvidence(owners, new Map(), {
            pullRequestCommits: new Map([[305, [operatorPullRequestCommit]]]),
          }),
        ),
      ).toThrow("must match exactly one pull request commit");

      const conflictAdjustedInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          sourceTargetRef: nonEquivalentBackport,
        },
        completeEvidence(owners),
      );
      expect(commitRecord(conflictAdjustedInventory, nonEquivalentBackport)).toMatchObject({
        disposition: "unresolved",
        nonEquivalentCherryPickOrigins: [nonEquivalentOrigin],
        pullRequests: [],
        verifiedCherryPickOrigins: [],
      });
      expect(conflictAdjustedInventory.unresolved).toContainEqual({
        commit: nonEquivalentBackport,
        kind: "ownership",
        pullRequests: [306],
        reason: "non-equivalent cherry-pick provenance requires reviewed adaptation ownership",
      });
      expect(() => assertCompleteReleaseSourceInventory(conflictAdjustedInventory)).toThrow(
        "non-equivalent cherry-pick provenance requires reviewed adaptation ownership",
      );
    }));

  it("accepts only a reviewed strict-path-subset partial backport", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "a.txt": "old\n",
        "b.txt": "old\n",
        "c.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const source = createCommit(cwd, {
        files: {
          ...rootFiles,
          "a.txt": "new\n",
          "b.txt": "new\n",
          "c.txt": "new\n",
        },
        parents: [root],
        subject: "feat: source feature",
        timestamp: 20,
      });
      const target = createCommit(cwd, {
        body: `Partial backport of ${source}.\n\nBackport of #401.`,
        files: {
          ...rootFiles,
          "a.txt": "new\n",
          "b.txt": "new\n",
        },
        parents: [root],
        subject: "feat: partial release backport",
        timestamp: 30,
      });
      const altered = createCommit(cwd, {
        body: `Partial backport of ${source}.\n\nBackport of #401.`,
        files: {
          ...rootFiles,
          "a.txt": "different\n",
          "b.txt": "new\n",
        },
        parents: [root],
        subject: "feat: altered partial release backport",
        timestamp: 31,
      });
      const whitespaceAltered = createCommit(cwd, {
        body: `Partial backport of ${source}.\n\nBackport of #401.`,
        files: {
          ...rootFiles,
          "a.txt": "new \n",
          "b.txt": "new\n",
        },
        parents: [root],
        subject: "feat: whitespace-altered partial release backport",
        timestamp: 32,
      });
      const ambiguous = createCommit(cwd, {
        body: `Partial backport of ${source}.\n\nPartial backport of ${source}.\n\nBackport of #401.`,
        files: {
          ...rootFiles,
          "a.txt": "new\n",
          "b.txt": "new\n",
        },
        parents: [root],
        subject: "feat: ambiguous partial release backport",
        timestamp: 33,
      });
      const evidence = completeEvidence(new Map([[source, [401]]]), new Map(), {
        pullRequestCommits: new Map([[401, [source]]]),
      });

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenancePartialPullRequests: [
            { number: 401, sourceCommitRef: source, targetCommitRef: target },
          ],
          sourceTargetRef: target,
        },
        evidence,
      );
      expect(commitRecord(inventory, target)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [401],
        trustedPartialPullRequest: {
          method: "trusted-pr-partial-backport",
          number: 401,
          omittedPaths: ["c.txt"],
          sourceCommit: source,
          sourcePaths: ["a.txt", "b.txt", "c.txt"],
          targetCommit: target,
          targetPaths: ["a.txt", "b.txt"],
        },
      });
      expect(inventory.range.provenancePartialPullRequests).toEqual([
        expect.objectContaining({
          number: 401,
          sourceCommit: source,
          targetCommit: target,
          details: expect.objectContaining({
            method: "trusted-pr-partial-backport",
            omittedPaths: ["c.txt"],
          }),
        }),
      ]);
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenancePartialPullRequests: [
              { number: 401, sourceCommitRef: source, targetCommitRef: altered },
            ],
            sourceTargetRef: altered,
          },
          evidence,
        ),
      ).toThrow("does not preserve the exact path patch for a.txt");
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenancePartialPullRequests: [
              { number: 401, sourceCommitRef: source, targetCommitRef: ambiguous },
            ],
            sourceTargetRef: ambiguous,
          },
          evidence,
        ),
      ).toThrow("is not a canonical non-equivalent partial backport");
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenancePartialPullRequests: [
              {
                number: 401,
                sourceCommitRef: source,
                targetCommitRef: whitespaceAltered,
              },
            ],
            sourceTargetRef: whitespaceAltered,
          },
          evidence,
        ),
      ).toThrow("does not preserve the exact path patch for a.txt");
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenancePartialPullRequests: [
              { number: 401, sourceCommitRef: source, targetCommitRef: target },
              { number: 402, sourceCommitRef: source, targetCommitRef: target },
            ],
            sourceTargetRef: target,
          },
          completeEvidence(new Map([[source, [401, 402]]]), new Map(), {
            pullRequestCommits: new Map([
              [401, [source]],
              [402, [source]],
            ]),
          }),
        ),
      ).toThrow("target commits must be unique");
    }));

  it("accepts only an active same-path conflict-resolved adapted backport", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "a.txt": "old\n",
        "b.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const sourceFiles = {
        ...rootFiles,
        "a.txt": "source\n",
        "b.txt": "source\n",
      };
      const pullRequestCommit = createCommit(cwd, {
        files: sourceFiles,
        parents: [root],
        subject: "fix: pull request source",
        timestamp: 20,
      });
      const origin = createCommit(cwd, {
        files: sourceFiles,
        parents: [root],
        subject: "fix: landed source",
        timestamp: 21,
      });
      const targetFiles = {
        ...rootFiles,
        "a.txt": "source\n",
        "b.txt": "release adaptation\n",
      };
      const target = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})`,
        files: targetFiles,
        parents: [root],
        subject: "fix: adapted release backport",
        timestamp: 30,
      });
      const evidence = completeEvidence(new Map([[pullRequestCommit, [501]]]), new Map(), {
        pullRequestCommits: new Map([[501, [pullRequestCommit]]]),
      });
      const provenanceAdaptedPullRequests = [
        {
          number: 501,
          originCommitRef: origin,
          targetCommitRef: target,
        },
      ];

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceAdaptedPullRequests,
          sourceTargetRef: target,
        },
        evidence,
      );
      expect(commitRecord(inventory, target)).toMatchObject({
        disposition: "pull-request",
        nonEquivalentCherryPickOrigins: [origin],
        pullRequests: [501],
        trustedAdaptedPullRequest: {
          method: "trusted-pr-adapted-backport",
          number: 501,
          originCommit: origin,
          paths: ["a.txt", "b.txt"],
          pullRequestCommit,
          targetCommit: target,
        },
      });
      expect(inventory.range.provenanceAdaptedPullRequests).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            method: "trusted-pr-adapted-backport",
            originAuthor: expect.objectContaining({ name: "OpenClaw Test" }),
            originPatchId: expect.any(String),
            pullRequestCommitAuthor: expect.objectContaining({ name: "OpenClaw Test" }),
            targetCommitAuthor: expect.objectContaining({ name: "OpenClaw Test" }),
            targetPatchId: expect.any(String),
          }),
          number: 501,
          originCommit: origin,
          targetCommit: target,
        }),
      ]);
      expect(inventory.range.provenanceAdaptedPullRequests[0].details.originPatchId).not.toBe(
        inventory.range.provenanceAdaptedPullRequests[0].details.targetPatchId,
      );
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      const exactTarget = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})`,
        files: sourceFiles,
        parents: [root],
        subject: "fix: exact release backport",
        timestamp: 31,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 501,
                originCommitRef: origin,
                targetCommitRef: exactTarget,
              },
            ],
            sourceTargetRef: exactTarget,
          },
          evidence,
        ),
      ).toThrow("is not a canonical non-equivalent cherry-pick adaptation");

      const wrongPaths = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})`,
        files: { ...rootFiles, "a.txt": "source\n" },
        parents: [root],
        subject: "fix: incomplete adapted release backport",
        timestamp: 32,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 501,
                originCommitRef: origin,
                targetCommitRef: wrongPaths,
              },
            ],
            sourceTargetRef: wrongPaths,
          },
          evidence,
        ),
      ).toThrow("must change exactly the same non-empty paths");

      const whitespaceOnlyTarget = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})`,
        files: {
          ...rootFiles,
          "a.txt": "source \n",
          "b.txt": "source \n",
        },
        parents: [root],
        subject: "fix: whitespace-only adapted release backport",
        timestamp: 32,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 501,
                originCommitRef: origin,
                targetCommitRef: whitespaceOnlyTarget,
              },
            ],
            sourceTargetRef: whitespaceOnlyTarget,
          },
          evidence,
        ),
      ).toThrow("is not a canonical non-equivalent cherry-pick adaptation");

      const duplicateTrailer = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})\n(cherry picked from commit ${origin})`,
        files: targetFiles,
        parents: [root],
        subject: "fix: duplicated adapted provenance",
        timestamp: 33,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 501,
                originCommitRef: origin,
                targetCommitRef: duplicateTrailer,
              },
            ],
            sourceTargetRef: duplicateTrailer,
          },
          evidence,
        ),
      ).toThrow("is not a canonical non-equivalent cherry-pick adaptation");

      const differentTrailer = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})\n(cherry picked from commit ${pullRequestCommit})`,
        files: targetFiles,
        parents: [root],
        subject: "fix: ambiguous adapted provenance",
        timestamp: 34,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 501,
                originCommitRef: origin,
                targetCommitRef: differentTrailer,
              },
            ],
            sourceTargetRef: differentTrailer,
          },
          evidence,
        ),
      ).toThrow("is not a canonical non-equivalent cherry-pick adaptation");

      const partialTrailer = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})\nPartial backport of ${pullRequestCommit}.`,
        files: targetFiles,
        parents: [root],
        subject: "fix: mixed adapted provenance",
        timestamp: 35,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 501,
                originCommitRef: origin,
                targetCommitRef: partialTrailer,
              },
            ],
            sourceTargetRef: partialTrailer,
          },
          evidence,
        ),
      ).toThrow("is not a canonical non-equivalent cherry-pick adaptation");

      const revertedTarget = createCommit(cwd, {
        body: `This reverts commit ${target}.`,
        files: rootFiles,
        parents: [target],
        subject: 'Revert "fix: adapted release backport"',
        timestamp: 40,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests,
            sourceTargetRef: revertedTarget,
          },
          evidence,
        ),
      ).toThrow(`trusted adapted target commit ${target} is not active`);
    }));

  it("accepts only an active explicit multi-source integrated backport", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "a.txt": "old\n",
        "b.txt": "old\n",
        "c.txt": "old\n",
        "d.txt": "old\n",
        "omitted.txt": "old\n",
        "prefix.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const integrationFiles = {
        ...rootFiles,
        "c.txt": "integrated\n",
        "d.txt": "integrated\n",
        "omitted.txt": "integrated but omitted\n",
      };
      const integrationSource = createCommit(cwd, {
        files: integrationFiles,
        parents: [root],
        subject: "fix: earlier pull request integration",
        timestamp: 20,
      });
      const primaryParentFiles = {
        ...integrationFiles,
        "prefix.txt": "aligned\n",
      };
      const primaryParent = createCommit(cwd, {
        files: primaryParentFiles,
        parents: [integrationSource],
        subject: "fix: align pull request prefix",
        timestamp: 21,
      });
      const primaryFiles = {
        ...primaryParentFiles,
        "a.txt": "source\n",
        "b.txt": "source\n",
      };
      const primarySource = createCommit(cwd, {
        files: primaryFiles,
        parents: [primaryParent],
        subject: "fix: pull request head",
        timestamp: 22,
      });
      const mergeCommit = createCommit(cwd, {
        files: primaryFiles,
        parents: [root],
        subject: "fix: merged pull request",
        timestamp: 23,
      });
      const targetParentFiles = {
        ...rootFiles,
        "prefix.txt": "aligned\n",
      };
      const targetParent = createCommit(cwd, {
        body: `(cherry picked from commit ${primaryParent})`,
        files: targetParentFiles,
        parents: [root],
        subject: "fix: align release prefix",
        timestamp: 24,
      });
      const targetFiles = {
        ...targetParentFiles,
        "a.txt": "source\n",
        "b.txt": "release adaptation\n",
        "c.txt": "integrated\n",
        "d.txt": "integrated\n",
      };
      const target = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})`,
        files: targetFiles,
        parents: [targetParent],
        subject: "fix: integrated release backport",
        timestamp: 30,
      });
      const pullRequestCommits = [integrationSource, primaryParent, primarySource];
      const pullRequestMetadata = {
        baseBranch: "main",
        baseCommit: root,
        headCommit: primarySource,
        mergeCommit,
        mergedAt: "1970-01-01T00:00:01.000Z",
        number: 601,
      };
      const evidence = completeEvidence(
        new Map([
          [integrationSource, [601]],
          [primaryParent, [601]],
          [primarySource, [601]],
        ]),
        new Map(),
        {
          pullRequestCommits: new Map([[601, pullRequestCommits]]),
          pullRequestMetadata: new Map([[601, pullRequestMetadata]]),
        },
      );
      const provenanceIntegratedPullRequests = [
        {
          number: 601,
          sourceCommitRef: primarySource,
          targetCommitRef: target,
        },
        {
          number: 601,
          sourceCommitRef: integrationSource,
          targetCommitRef: target,
        },
      ];

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceIntegratedPullRequests,
          sourceTargetRef: target,
        },
        evidence,
      );
      expect(commitRecord(inventory, target)).toMatchObject({
        disposition: "pull-request",
        nonEquivalentCherryPickOrigins: [primarySource],
        pullRequests: [601],
        trustedIntegratedPullRequest: {
          method: "trusted-pr-adapted-integration-backport",
          number: 601,
          originCommit: primarySource,
          parentAlignment: {
            primaryParentCommit: primaryParent,
            targetParentCommit: targetParent,
          },
          pathPartitions: {
            adaptedPrimary: { count: 1, members: ["b.txt"] },
            exactIntegration: { count: 2, members: ["c.txt", "d.txt"] },
            exactPrimary: { count: 1, members: ["a.txt"] },
          },
          primarySource: {
            commit: primarySource,
            paths: { count: 2, members: ["a.txt", "b.txt"] },
          },
          pullRequest: pullRequestMetadata,
          targetCommit: target,
          targetPaths: {
            count: 4,
            members: ["a.txt", "b.txt", "c.txt", "d.txt"],
          },
        },
      });
      expect(
        commitRecord(inventory, target).trustedIntegratedPullRequest.integrationSources,
      ).toEqual([
        expect.objectContaining({
          commit: integrationSource,
          contributionPaths: {
            count: 2,
            members: ["c.txt", "d.txt"],
            sha256: expect.any(String),
          },
          omittedPaths: {
            count: 1,
            members: ["omitted.txt"],
            sha256: expect.any(String),
          },
          paths: {
            count: 3,
            members: ["c.txt", "d.txt", "omitted.txt"],
            sha256: expect.any(String),
          },
        }),
      ]);
      expect(inventory.range.provenanceIntegratedPullRequests).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            method: "trusted-pr-adapted-integration-backport",
            pullRequestCommits: {
              count: 3,
              members: [...pullRequestCommits].toSorted(),
              sha256: expect.any(String),
            },
          }),
          number: 601,
          sources: [
            { commit: integrationSource, ref: integrationSource },
            { commit: primarySource, ref: primarySource },
          ].toSorted((left, right) => left.commit.localeCompare(right.commit)),
          targetCommit: target,
        }),
      ]);
      expect(inventory.partitions.commits.manifestDirect.members).toContain(target);
      expect(inventory.partitions.commits.directOwnershipOverlap.members).toContain(target);
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: [provenanceIntegratedPullRequests[0]],
            sourceTargetRef: target,
          },
          evidence,
        ),
      ).toThrow("must bind at least two unique pull request source commits");

      const nonMember = createCommit(cwd, {
        files: { ...rootFiles, "c.txt": "integrated\n" },
        parents: [root],
        subject: "fix: unrelated source",
        timestamp: 25,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: [
              provenanceIntegratedPullRequests[0],
              { number: 601, sourceCommitRef: nonMember, targetCommitRef: target },
            ],
            sourceTargetRef: target,
          },
          evidence,
        ),
      ).toThrow("contains a source commit that is not an exact pull request member");

      const siblingIntegration = createCommit(cwd, {
        files: {
          ...rootFiles,
          "c.txt": "integrated\n",
          "d.txt": "integrated\n",
        },
        parents: [root],
        subject: "fix: non-ancestral integration source",
        timestamp: 26,
      });
      const siblingEvidence = completeEvidence(new Map(), new Map(), {
        pullRequestCommits: new Map([[601, [siblingIntegration, primaryParent, primarySource]]]),
        pullRequestMetadata: new Map([[601, pullRequestMetadata]]),
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: [
              provenanceIntegratedPullRequests[0],
              {
                number: 601,
                sourceCommitRef: siblingIntegration,
                targetCommitRef: target,
              },
            ],
            sourceTargetRef: target,
          },
          siblingEvidence,
        ),
      ).toThrow("integration sources must be strict one-parent ancestors of the PR head");

      const integrationRevertFiles = {
        ...integrationFiles,
        "c.txt": "old\n",
      };
      const integrationRevert = createCommit(cwd, {
        files: integrationRevertFiles,
        parents: [integrationSource],
        subject: "fix: revert one integration path",
        timestamp: 27,
      });
      const revertedPrimaryParentFiles = {
        ...integrationRevertFiles,
        "prefix.txt": "aligned\n",
      };
      const revertedPrimaryParent = createCommit(cwd, {
        files: revertedPrimaryParentFiles,
        parents: [integrationRevert],
        subject: "fix: align pull request after integration revert",
        timestamp: 28,
      });
      const revertedPrimaryFiles = {
        ...revertedPrimaryParentFiles,
        "a.txt": "source\n",
        "b.txt": "source\n",
      };
      const revertedPrimarySource = createCommit(cwd, {
        files: revertedPrimaryFiles,
        parents: [revertedPrimaryParent],
        subject: "fix: pull request head after integration revert",
        timestamp: 29,
      });
      const revertedTargetParent = createCommit(cwd, {
        body: `(cherry picked from commit ${revertedPrimaryParent})`,
        files: targetParentFiles,
        parents: [root],
        subject: "fix: align release prefix after integration revert",
        timestamp: 30,
      });
      const revertedPathTarget = createCommit(cwd, {
        body: `(cherry picked from commit ${revertedPrimarySource})`,
        files: targetFiles,
        parents: [revertedTargetParent],
        subject: "fix: release backport restores reverted integration path",
        timestamp: 31,
      });
      const revertedPullRequestCommits = [
        integrationSource,
        integrationRevert,
        revertedPrimaryParent,
        revertedPrimarySource,
      ];
      const revertedPathEvidence = completeEvidence(
        new Map(revertedPullRequestCommits.map((commit) => [commit, [601]])),
        new Map(),
        {
          pullRequestCommits: new Map([[601, revertedPullRequestCommits]]),
          pullRequestMetadata: new Map([
            [
              601,
              {
                ...pullRequestMetadata,
                headCommit: revertedPrimarySource,
              },
            ],
          ]),
        },
      );
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: [
              {
                number: 601,
                sourceCommitRef: revertedPrimarySource,
                targetCommitRef: revertedPathTarget,
              },
              {
                number: 601,
                sourceCommitRef: integrationSource,
                targetCommitRef: revertedPathTarget,
              },
            ],
            sourceTargetRef: revertedPathTarget,
          },
          revertedPathEvidence,
        ),
      ).toThrow("integration path c.txt did not survive unchanged into the PR head parent");

      const wrongHeadEvidence = completeEvidence(new Map(), new Map(), {
        pullRequestCommits: new Map([[601, pullRequestCommits]]),
        pullRequestMetadata: new Map([
          [601, { ...pullRequestMetadata, headCommit: primaryParent }],
        ]),
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests,
            sourceTargetRef: target,
          },
          wrongHeadEvidence,
        ),
      ).toThrow("is not a canonical adapted multi-source pull request backport");

      const missingTrailer = createCommit(cwd, {
        files: targetFiles,
        parents: [targetParent],
        subject: "fix: integrated release backport without trailer",
        timestamp: 31,
      });
      const missingTrailerProvenance = provenanceIntegratedPullRequests.map((entry) => ({
        ...entry,
        targetCommitRef: missingTrailer,
      }));
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: missingTrailerProvenance,
            sourceTargetRef: missingTrailer,
          },
          evidence,
        ),
      ).toThrow("is not a canonical adapted multi-source pull request backport");

      const duplicateTrailer = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})\n(cherry picked from commit ${primarySource})`,
        files: targetFiles,
        parents: [targetParent],
        subject: "fix: integrated release backport with duplicate trailer",
        timestamp: 31,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: provenanceIntegratedPullRequests.map((entry) => ({
              ...entry,
              targetCommitRef: duplicateTrailer,
            })),
            sourceTargetRef: duplicateTrailer,
          },
          evidence,
        ),
      ).toThrow("is not a canonical adapted multi-source pull request backport");

      const unalignedTargetParent = createCommit(cwd, {
        files: targetParentFiles,
        parents: [root],
        subject: "fix: release prefix without source trailer",
        timestamp: 25,
      });
      const unalignedTarget = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})`,
        files: targetFiles,
        parents: [unalignedTargetParent],
        subject: "fix: integrated backport on unaligned parent",
        timestamp: 32,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: provenanceIntegratedPullRequests.map((entry) => ({
              ...entry,
              targetCommitRef: unalignedTarget,
            })),
            sourceTargetRef: unalignedTarget,
          },
          evidence,
        ),
      ).toThrow("is not a canonical adapted multi-source pull request backport");

      const missingPrimaryPath = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})`,
        files: { ...targetFiles, "a.txt": "old\n" },
        parents: [targetParent],
        subject: "fix: integrated backport missing primary path",
        timestamp: 32,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: provenanceIntegratedPullRequests.map((entry) => ({
              ...entry,
              targetCommitRef: missingPrimaryPath,
            })),
            sourceTargetRef: missingPrimaryPath,
          },
          evidence,
        ),
      ).toThrow("must add paths to the complete non-empty PR-head path set");

      const unmatchedIntegration = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})`,
        files: { ...targetFiles, "extra.txt": "unowned\n" },
        parents: [targetParent],
        subject: "fix: integrated backport with unowned path",
        timestamp: 33,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: provenanceIntegratedPullRequests.map((entry) => ({
              ...entry,
              targetCommitRef: unmatchedIntegration,
            })),
            sourceTargetRef: unmatchedIntegration,
          },
          evidence,
        ),
      ).toThrow("must map integration path extra.txt to exactly one explicit PR member");

      const noExactPrimary = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})`,
        files: {
          ...targetFiles,
          "a.txt": "release adaptation too\n",
        },
        parents: [targetParent],
        subject: "fix: integrated backport without exact primary path",
        timestamp: 34,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: provenanceIntegratedPullRequests.map((entry) => ({
              ...entry,
              targetCommitRef: noExactPrimary,
            })),
            sourceTargetRef: noExactPrimary,
          },
          evidence,
        ),
      ).toThrow("must preserve exact PR-head paths and adapt at least one PR-head path");

      const noAdaptedPrimary = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})`,
        files: {
          ...targetFiles,
          "b.txt": "source\n",
        },
        parents: [targetParent],
        subject: "fix: integrated backport without primary adaptation",
        timestamp: 35,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: provenanceIntegratedPullRequests.map((entry) => ({
              ...entry,
              targetCommitRef: noAdaptedPrimary,
            })),
            sourceTargetRef: noAdaptedPrimary,
          },
          evidence,
        ),
      ).toThrow("must preserve exact PR-head paths and adapt at least one PR-head path");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 601,
                originCommitRef: primarySource,
                targetCommitRef: target,
              },
            ],
            provenanceIntegratedPullRequests,
            sourceTargetRef: target,
          },
          evidence,
        ),
      ).toThrow("adapted, integrated, and partial provenance target commits must be disjoint");

      const revertedTarget = createCommit(cwd, {
        body: `This reverts commit ${target}.`,
        files: targetParentFiles,
        parents: [target],
        subject: 'Revert "fix: integrated release backport"',
        timestamp: 40,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests,
            sourceTargetRef: revertedTarget,
          },
          evidence,
        ),
      ).toThrow(`trusted integrated target commit ${target} is not active`);
    }));

  it("classifies an unassociated same-second ancestral merge as comparison boundary", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "root\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 9,
      });
      const boundaryCommit = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "boundary\n" },
        parents: [root],
        subject: "fix: pre-fork merged work",
        timestamp: 10,
      });
      const base = createCommit(cwd, {
        files: {
          ...rootFiles,
          "base.txt": "published\n",
          "state.txt": "boundary\n",
        },
        parents: [boundaryCommit],
        subject: "chore: published base",
        timestamp: 15,
      });
      const sourceTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "release.txt": "release\n",
          "state.txt": "boundary\n",
        },
        parents: [boundaryCommit],
        subject: "fix: release work",
        timestamp: 20,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: boundaryCommit,
          mergeCommit: boundaryCommit,
          mergedAt: "1970-01-01T00:00:10.500Z",
          number: 101,
        },
      ];
      const members = summarizeTeamUniverseMembers([101]);
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:20Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 1,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 1,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 20_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 20_000, startTimestamp: 10_000 },
      };

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: base,
          comparisonBaseBranch: "main",
          cwd,
          sourceTargetRef: sourceTarget,
        },
        completeEvidence(new Map(), new Map(), { comparison }),
      );

      expect(inventory.comparison).toMatchObject({
        comparisonOnly: { members: [101] },
        partitionEvidence: {
          boundary: {
            records: [
              {
                mergeBase: boundaryCommit,
                mergeCommit: boundaryCommit,
                mergedAt: "1970-01-01T00:00:10.500Z",
                method: "same-second-ancestral-merge",
                pullRequest: 101,
                windowStartTimestamp: 10_000,
              },
            ],
          },
        },
        partitions: {
          postForkNotBackported: { count: 0 },
          shippedOrBoundary: { members: [101] },
        },
        unclassified: { count: 0 },
      });
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("reconciles exact merged-main comparison members and rejects hidden backports", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "old-backport.txt": "old\n",
        "release.txt": "old\n",
        "post-fork.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const oldBackport = createCommit(cwd, {
        files: { ...rootFiles, "old-backport.txt": "new\n" },
        parents: [root],
        subject: "fix: older main PR backport",
        timestamp: 15,
      });
      const releaseCommit = createCommit(cwd, {
        files: {
          ...rootFiles,
          "old-backport.txt": "new\n",
          "release.txt": "new\n",
        },
        parents: [oldBackport],
        subject: "fix: released work",
        timestamp: 20,
      });
      const postForkHead = createCommit(cwd, {
        files: { ...rootFiles, "post-fork.txt": "new\n" },
        parents: [root],
        subject: "feat: later main work",
        timestamp: 25,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "old-backport.txt": "new\n",
          "release.txt": "new\n",
          "CHANGELOG.md": "# Changelog\n\nFinal notes.\n",
        },
        parents: [releaseCommit],
        subject: "docs(changelog): finalize notes",
        timestamp: 30,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: oldBackport,
          headCommit: releaseCommit,
          mergeCommit: releaseCommit,
          mergedAt: "1970-01-01T00:00:20.000Z",
          number: 101,
        },
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: postForkHead,
          mergeCommit: postForkHead,
          mergedAt: "1970-01-01T00:00:25.000Z",
          number: 202,
        },
      ];
      const members = summarizeTeamUniverseMembers(records.map((record) => record.number));
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:30Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: members.count,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: members.count,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 30_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 30_000, startTimestamp: 10_000 },
      };
      const evidence = completeEvidence(
        new Map([
          [oldBackport, [303]],
          [releaseCommit, [101]],
        ]),
        new Map(),
        {
          comparison,
          pullRequestCommits: new Map([[202, [postForkHead]]]),
          pullRequestMetadata: new Map([
            [
              303,
              {
                baseBranch: "main",
                baseCommit: "c".repeat(40),
                headCommit: "d".repeat(40),
                mergeCommit: "e".repeat(40),
                mergedAt: "1970-01-01T00:00:05.000Z",
                number: 303,
              },
            ],
          ]),
        },
      );
      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          comparisonBaseBranch: "main",
          cwd,
          finalTargetRef: finalTarget,
          sourceTargetRef: releaseCommit,
        },
        evidence,
      );
      expect(inventory.comparison).toMatchObject({
        canonical: { members: [101, 303] },
        canonicalOnly: { members: [303] },
        comparisonOnly: { members: [202] },
        partitions: {
          postForkNotBackported: { members: [202] },
        },
        unclassified: { count: 0 },
      });
      expect(inventory.comparison?.targetAssociatedOutsideSearch).toMatchObject({
        records: [
          expect.objectContaining({
            omissionReason: "merged-before-search-window",
            number: 303,
            targetCommits: [oldBackport],
          }),
        ],
      });
      expect(inventory.comparison?.partitionEvidence.postFork).toMatchObject({
        count: 1,
      });

      const hiddenBackport = createCommit(cwd, {
        files: { ...rootFiles, "post-fork.txt": "new\n" },
        parents: [root],
        subject: "feat: hidden release backport",
        timestamp: 20,
      });
      const hiddenFinalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "post-fork.txt": "new\n",
          "CHANGELOG.md": "# Changelog\n\nFinal hidden notes.\n",
        },
        parents: [hiddenBackport],
        subject: "docs(changelog): finalize hidden notes",
        timestamp: 30,
      });
      const hiddenRecords = records.map((record) =>
        record.number === 101
          ? {
              ...record,
              headCommit: hiddenBackport,
              mergeCommit: hiddenBackport,
            }
          : record,
      );
      const hiddenRecordEvidence = summarizeTeamUniverseRecords(hiddenRecords);
      const hiddenComparison = {
        ...comparison,
        records: hiddenRecordEvidence.records,
        recordsSha256: hiddenRecordEvidence.sha256,
        segments: comparison.segments.map((segment) => ({
          ...segment,
          recordsSha256: hiddenRecordEvidence.sha256,
        })),
      };
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            finalTargetRef: hiddenFinalTarget,
            sourceTargetRef: hiddenBackport,
          },
          completeEvidence(new Map(), new Map(), {
            comparison: hiddenComparison,
            pullRequestCommits: new Map([
              [101, [hiddenBackport]],
              [202, [postForkHead]],
            ]),
          }),
        ),
      ).toThrow("has target provenance");
    }));

  it("rejects a hidden squashed backport of a multi-commit pull request", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "first.txt": "old\n",
        "second.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const first = createCommit(cwd, {
        files: { ...rootFiles, "first.txt": "new\n" },
        parents: [root],
        subject: "fix: first PR member",
        timestamp: 20,
      });
      const head = createCommit(cwd, {
        files: { ...rootFiles, "first.txt": "new\n", "second.txt": "new\n" },
        parents: [first],
        subject: "fix: second PR member",
        timestamp: 21,
      });
      const squashedBackport = createCommit(cwd, {
        files: { ...rootFiles, "first.txt": "new\n", "second.txt": "new\n" },
        parents: [root],
        subject: "fix: hidden squashed backport",
        timestamp: 22,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "first.txt": "new\n",
          "second.txt": "new\n",
          "CHANGELOG.md": "# Changelog\n\nFinal notes.\n",
        },
        parents: [squashedBackport],
        subject: "docs(changelog): finalize notes",
        timestamp: 30,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: head,
          mergeCommit: head,
          mergedAt: "1970-01-01T00:00:25.000Z",
          number: 202,
        },
      ];
      const members = summarizeTeamUniverseMembers([202]);
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:30Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 1,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 1,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 30_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 30_000, startTimestamp: 10_000 },
      };

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: squashedBackport,
          },
          completeEvidence(new Map(), new Map(), {
            comparison,
            pullRequestCommits: new Map([[202, [first, head]]]),
          }),
        ),
      ).toThrow("comparison-only pull request #202 has target provenance");
    }));

  it("rejects a post-fork pull request split across target commits with same-file context", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "one=old\nmiddle=base\nthree=old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const pullRequestHead = createCommit(cwd, {
        files: {
          ...rootFiles,
          "state.txt": "one=new\nmiddle=base\nthree=new\n",
        },
        parents: [root],
        subject: "fix: later main work",
        timestamp: 20,
      });
      const releaseContext = createCommit(cwd, {
        files: {
          ...rootFiles,
          "state.txt": "one=old\nmiddle=release\nthree=old\n",
        },
        parents: [root],
        subject: "fix: release-only context",
        timestamp: 21,
      });
      const releaseFirst = createCommit(cwd, {
        files: {
          ...rootFiles,
          "state.txt": "one=new\nmiddle=release\nthree=old\n",
        },
        parents: [releaseContext],
        subject: "fix: hidden first member",
        timestamp: 22,
      });
      const releaseHead = createCommit(cwd, {
        files: {
          ...rootFiles,
          "state.txt": "one=new\nmiddle=release\nthree=new\n",
        },
        parents: [releaseFirst],
        subject: "fix: hidden second member",
        timestamp: 23,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "CHANGELOG.md": "# Changelog\n\nFinal notes.\n",
          "state.txt": "one=new\nmiddle=release\nthree=new\n",
        },
        parents: [releaseHead],
        subject: "docs(changelog): finalize notes",
        timestamp: 30,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: pullRequestHead,
          mergeCommit: pullRequestHead,
          mergedAt: "1970-01-01T00:00:25.000Z",
          number: 202,
        },
      ];
      const members = summarizeTeamUniverseMembers([202]);
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:30Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 1,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 1,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 30_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 30_000, startTimestamp: 10_000 },
      };

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: releaseHead,
          },
          completeEvidence(new Map(), new Map(), {
            comparison,
            pullRequestCommits: new Map([[202, [pullRequestHead]]]),
          }),
        ),
      ).toThrow("comparison-only pull request #202 has target provenance");
    }));

  it("rejects an individual post-fork PR member embedded in a combined target commit", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "a.txt": "old\n",
        "b.txt": "old\n",
        "extra.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const first = createCommit(cwd, {
        files: { ...rootFiles, "a.txt": "new\n" },
        parents: [root],
        subject: "fix: first PR member",
        timestamp: 20,
      });
      const head = createCommit(cwd, {
        files: { ...rootFiles, "a.txt": "new\n", "b.txt": "new\n" },
        parents: [first],
        subject: "fix: second PR member",
        timestamp: 21,
      });
      const combinedTarget = createCommit(cwd, {
        files: { ...rootFiles, "a.txt": "new\n", "extra.txt": "release\n" },
        parents: [root],
        subject: "fix: combined release work",
        timestamp: 22,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "CHANGELOG.md": "# Changelog\n\nFinal notes.\n",
          "a.txt": "new\n",
          "extra.txt": "release\n",
        },
        parents: [combinedTarget],
        subject: "docs(changelog): finalize notes",
        timestamp: 30,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: head,
          mergeCommit: head,
          mergedAt: "1970-01-01T00:00:25.000Z",
          number: 202,
        },
      ];
      const members = summarizeTeamUniverseMembers([202]);
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:30Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 1,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 1,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 30_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 30_000, startTimestamp: 10_000 },
      };

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: combinedTarget,
          },
          completeEvidence(new Map(), new Map(), {
            comparison,
            pullRequestCommits: new Map([[202, [first, head]]]),
          }),
        ),
      ).toThrow("comparison-only pull request #202 has target provenance");
    }));

  it("ignores provenance commits newer than the source cutoff", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const candidate = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: trusted source",
        timestamp: 15,
      });
      const cherry = createCommit(cwd, {
        body: `(cherry picked from commit ${candidate})`,
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: trusted source",
        timestamp: 20,
      });
      const future = createCommit(cwd, {
        files: { ...rootFiles, "future.txt": "future\n", "state.txt": "new\n" },
        parents: [candidate],
        subject: "fix: future provenance",
        timestamp: 30,
      });
      const requestedAssociations: string[] = [];

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceRefs: [future],
          sourceTargetRef: cherry,
        },
        {
          resolveAssociations: (commits: string[]) => {
            requestedAssociations.push(...commits);
            return completeAssociations(new Map([[candidate, [201]]]))(commits);
          },
          resolvePullRequests: () => new Map(),
        },
      );

      expect(requestedAssociations).toContain(candidate);
      expect(requestedAssociations).not.toContain(future);
      expect(commitRecord(inventory, cherry)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [201],
      });
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("tracks exact revert parity and rejects a forged inverse", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const original = createCommit(cwd, {
        body: "Fixes #402",
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: change state",
        timestamp: 20,
      });
      const siblingFiles = {
        ...rootFiles,
        "sibling.txt": "still active\n",
        "state.txt": "new\n",
      };
      const sibling = createCommit(cwd, {
        files: siblingFiles,
        parents: [original],
        subject: "fix: keep the same pull request active",
        timestamp: 25,
      });
      const revert = createCommit(cwd, {
        body: `This reverts commit ${original}.`,
        files: { ...siblingFiles, "state.txt": "old\n" },
        parents: [sibling],
        subject: 'Revert "fix: change state"',
        timestamp: 30,
      });
      const restore = createCommit(cwd, {
        body: `This reverts commit ${revert}.`,
        files: siblingFiles,
        parents: [revert],
        subject: 'Revert "Revert fix: change state"',
        timestamp: 40,
      });
      const replacement = createCommit(cwd, {
        body: "Fixes #402",
        files: {
          ...siblingFiles,
          "replacement.txt": "replacement\n",
          "state.txt": "old\n",
        },
        parents: [revert],
        subject: "fix: replace reverted issue work",
        timestamp: 45,
      });
      const forged = createCommit(cwd, {
        body: `This reverts commit ${original}.`,
        files: { ...rootFiles, "state.txt": "forged\n" },
        parents: [original],
        subject: 'Revert "fix: change state"',
        timestamp: 50,
      });
      const originalOnlyOwners = new Map<string, number[]>([[original, [401]]]);
      const owners = new Map<string, number[]>([
        [original, [401]],
        [sibling, [401]],
      ]);

      const fullyRevertedInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: revert },
        completeEvidence(originalOnlyOwners),
      );
      expect(fullyRevertedInventory.partitions.pullRequests.included.members).toEqual([]);
      expect(
        [...sourceContributionsFromInventory(fullyRevertedInventory).revertedReferences].toSorted(
          (left, right) => left - right,
        ),
      ).toEqual([401, 402]);

      const revertedInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: revert },
        completeEvidence(owners),
      );
      expect(commitRecord(revertedInventory, original).disposition).toBe("reverted");
      expect(commitRecord(revertedInventory, revert).disposition).toBe("direct");
      expect(revertedInventory.partitions.pullRequests.included.members).toEqual([401]);
      expect(
        [...sourceContributionsFromInventory(revertedInventory).revertedReferences].toSorted(
          (left, right) => left - right,
        ),
      ).toEqual([402]);
      expect(assertCompleteReleaseSourceInventory(revertedInventory)).toBe(revertedInventory);

      const restoredInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: restore },
        completeEvidence(owners),
      );
      expect(commitRecord(restoredInventory, original)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [401],
      });
      expect(commitRecord(restoredInventory, revert).disposition).toBe("reverted");
      expect(commitRecord(restoredInventory, restore).disposition).toBe("direct");
      expect(restoredInventory.partitions.pullRequests.included.members).toEqual([401]);
      expect(sourceContributionsFromInventory(restoredInventory).revertedReferences.size).toBe(0);
      expect(assertCompleteReleaseSourceInventory(restoredInventory)).toBe(restoredInventory);

      const replacementInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: replacement },
        completeEvidence(owners),
      );
      expect(sourceContributionsFromInventory(replacementInventory).revertedReferences.size).toBe(
        0,
      );

      const forgedInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: forged },
        completeEvidence(owners),
      );
      expect(commitRecord(forgedInventory, forged).disposition).toBe("unresolved");
      expect(forgedInventory.unresolved).toContainEqual({
        commit: forged,
        kind: "revert",
        reason: `revert does not exactly invert ancestor ${original}`,
      });
      expect(() => assertCompleteReleaseSourceInventory(forgedInventory)).toThrow(
        "revert does not exactly invert ancestor",
      );
    }));

  it("projects an exact outside-range revert and clears it after an in-range restore", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const originalFiles = { ...rootFiles, "state.txt": "new\n" };
      const original = createCommit(cwd, {
        body: "Fixes #702",
        files: originalFiles,
        parents: [root],
        subject: "fix: pre-range behavior",
        timestamp: 20,
      });
      const revert = createCommit(cwd, {
        body: `This reverts commit ${original}.`,
        files: rootFiles,
        parents: [original],
        subject: 'Revert "fix: pre-range behavior"',
        timestamp: 30,
      });
      const restore = createCommit(cwd, {
        body: `This reverts commit ${revert}.`,
        files: originalFiles,
        parents: [revert],
        subject: 'Revert "Revert fix: pre-range behavior"',
        timestamp: 40,
      });
      const owners = new Map<string, number[]>([[original, [701]]]);

      const revertedInventory = buildReleaseSourceInventory(
        { baseRef: original, cwd, sourceTargetRef: revert },
        completeEvidence(owners),
      );
      expect(commitRecord(revertedInventory, revert)).toMatchObject({
        disposition: "direct",
        revertedExternalPullRequests: [701],
        revertedExternalReferences: [702],
      });
      expect(
        [...sourceContributionsFromInventory(revertedInventory).revertedReferences].toSorted(
          (left, right) => left - right,
        ),
      ).toEqual([701, 702]);
      expect(assertCompleteReleaseSourceInventory(revertedInventory)).toBe(revertedInventory);

      const restoredInventory = buildReleaseSourceInventory(
        { baseRef: original, cwd, sourceTargetRef: restore },
        completeEvidence(owners),
      );
      expect(commitRecord(restoredInventory, revert).disposition).toBe("reverted");
      expect(commitRecord(restoredInventory, restore)).toMatchObject({
        disposition: "direct",
        revertedExternalPullRequests: [],
        revertedExternalReferences: [],
      });
      expect(sourceContributionsFromInventory(restoredInventory).revertedReferences.size).toBe(0);
      expect(assertCompleteReleaseSourceInventory(restoredInventory)).toBe(restoredInventory);

      const forgedFiles = { ...rootFiles, "state.txt": "forged\n" };
      const forgedExternalRevert = createCommit(cwd, {
        body: `This reverts commit ${original}.`,
        files: forgedFiles,
        parents: [original],
        subject: 'Revert "fix: pre-range behavior"',
        timestamp: 25,
      });
      const undoForgedExternalRevert = createCommit(cwd, {
        body: `This reverts commit ${forgedExternalRevert}.`,
        files: originalFiles,
        parents: [forgedExternalRevert],
        subject: 'Revert "Revert fix: pre-range behavior"',
        timestamp: 35,
      });
      const forgedInventory = buildReleaseSourceInventory(
        {
          baseRef: forgedExternalRevert,
          cwd,
          sourceTargetRef: undoForgedExternalRevert,
        },
        completeEvidence(owners),
      );
      expect(commitRecord(forgedInventory, undoForgedExternalRevert)).toMatchObject({
        disposition: "unresolved",
      });
      expect(() => assertCompleteReleaseSourceInventory(forgedInventory)).toThrow(
        `external revert ${forgedExternalRevert} does not exactly invert ancestor ${original}`,
      );
    }));

  it("fails closed when a forged shipped-baseline revert would hide an exact duplicate", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const sourceDuplicate = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: duplicate release patch",
        timestamp: 20,
      });
      const shippedOriginal = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: already shipped patch",
        timestamp: 30,
      });
      const forgedBaselineRevert = createCommit(cwd, {
        body: `This reverts commit ${shippedOriginal}.`,
        files: { ...rootFiles, "state.txt": "forged\n" },
        parents: [shippedOriginal],
        subject: 'Revert "fix: already shipped patch"',
        timestamp: 40,
      });

      const shippedInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          shippedRefs: [shippedOriginal],
          sourceTargetRef: sourceDuplicate,
        },
        completeEvidence(new Map()),
      );
      expect(commitRecord(shippedInventory, sourceDuplicate)).toMatchObject({
        disposition: "shipped",
        shippedEvidence: [{ commits: [shippedOriginal], ref: shippedOriginal }],
      });

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            shippedRefs: [forgedBaselineRevert],
            sourceTargetRef: sourceDuplicate,
          },
          completeEvidence(new Map()),
        ),
      ).toThrow(
        `shipped baseline ${forgedBaselineRevert} revert ${forgedBaselineRevert} does not exactly invert ${shippedOriginal}`,
      );
    }));

  it("recognizes exact shipped content across split and squashed commit forms", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "zero\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const shippedFirst = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "one\n" },
        parents: [root],
        subject: "fix: shipped first member",
        timestamp: 20,
      });
      const shippedHead = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "two\n" },
        parents: [shippedFirst],
        subject: "fix: shipped second member",
        timestamp: 21,
      });
      const sourceSquash = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "two\n" },
        parents: [root],
        subject: "fix: source squash",
        timestamp: 30,
      });
      const splitBaseline = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          shippedRefs: [shippedHead],
          sourceTargetRef: sourceSquash,
        },
        completeEvidence(
          new Map([
            [shippedFirst, [101]],
            [shippedHead, [101]],
            [sourceSquash, [101]],
          ]),
        ),
      );
      expect(commitRecord(splitBaseline, sourceSquash)).toMatchObject({
        disposition: "shipped",
        shippedEvidence: [
          expect.objectContaining({
            method: "baseline-final-tree",
            ref: shippedHead,
          }),
        ],
      });

      const shippedSquash = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "two\n" },
        parents: [root],
        subject: "fix: shipped squash",
        timestamp: 40,
      });
      const sourceFirst = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "one\n" },
        parents: [root],
        subject: "fix: source first member",
        timestamp: 50,
      });
      const sourceHead = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "two\n" },
        parents: [sourceFirst],
        subject: "fix: source second member",
        timestamp: 51,
      });
      const squashedBaseline = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          shippedRefs: [shippedSquash],
          sourceTargetRef: sourceHead,
        },
        completeEvidence(
          new Map([
            [shippedSquash, [102]],
            [sourceFirst, [102]],
            [sourceHead, [102]],
          ]),
        ),
      );
      expect(commitRecord(squashedBaseline, sourceFirst)).toMatchObject({
        disposition: "shipped",
        shippedEvidence: [
          expect.objectContaining({
            method: "baseline-final-tree-pull-request-aggregate",
            sourceCommits: [sourceFirst, sourceHead],
            treeProof: {
              candidateBaseCommit: root,
              candidateCommit: sourceHead,
              candidateDiffSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
              candidatePatchId: expect.stringMatching(/^[0-9a-f]{40}$/),
              changedPaths: ["state.txt"],
              proofMethod: "reverse-then-forward-apply-exact-target-tree",
              proofStrength: "exact",
              targetCommit: shippedSquash,
              targetTree: expect.stringMatching(/^[0-9a-f]{40}$/),
            },
          }),
        ],
      });
      expect(commitRecord(squashedBaseline, sourceHead).disposition).toBe("shipped");
      expect(squashedBaseline.partitions.pullRequests.included.members).not.toContain(102);

      const contextGap = "keep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nkeep-6\n";
      const contextualBase = createCommit(cwd, {
        files: {
          ...rootFiles,
          "context.txt": `one=old\ntwo=old\n${contextGap}extra=base\n`,
        },
        parents: [root],
        subject: "chore: contextual base",
        timestamp: 60,
      });
      const shippedContext = createCommit(cwd, {
        files: {
          ...rootFiles,
          "context.txt": `one=old\ntwo=old\n${contextGap}extra=release\n`,
        },
        parents: [contextualBase],
        subject: "fix: shipped same-file context",
        timestamp: 61,
      });
      const shippedContextFirst = createCommit(cwd, {
        files: {
          ...rootFiles,
          "context.txt": `one=new\ntwo=old\n${contextGap}extra=release\n`,
        },
        parents: [shippedContext],
        subject: "fix: shipped contextual first member",
        timestamp: 62,
      });
      const shippedContextHead = createCommit(cwd, {
        files: {
          ...rootFiles,
          "context.txt": `one=new\ntwo=new\n${contextGap}extra=release\n`,
        },
        parents: [shippedContextFirst],
        subject: "fix: shipped contextual second member",
        timestamp: 63,
      });
      const contextualSourceSquash = createCommit(cwd, {
        files: {
          ...rootFiles,
          "context.txt": `one=new\ntwo=new\n${contextGap}extra=base\n`,
        },
        parents: [contextualBase],
        subject: "fix: source contextual squash",
        timestamp: 64,
      });
      const contextualInventory = buildReleaseSourceInventory(
        {
          baseRef: contextualBase,
          cwd,
          shippedRefs: [shippedContextHead],
          sourceTargetRef: contextualSourceSquash,
        },
        completeEvidence(new Map([[contextualSourceSquash, [103]]])),
      );
      expect(commitRecord(contextualInventory, contextualSourceSquash)).toMatchObject({
        disposition: "shipped",
        shippedEvidence: [
          expect.objectContaining({
            method: "baseline-final-tree",
            ref: shippedContextHead,
            treeProof: {
              candidateBaseCommit: contextualBase,
              candidateCommit: contextualSourceSquash,
              candidateDiffSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
              candidatePatchId: expect.stringMatching(/^[0-9a-f]{40}$/),
              changedPaths: ["context.txt"],
              proofMethod: "reverse-then-forward-apply-exact-target-tree",
              proofStrength: "exact",
              targetCommit: shippedContextHead,
              targetTree: expect.stringMatching(/^[0-9a-f]{40}$/),
            },
          }),
        ],
      });
    }));

  it("accepts one terminal CHANGELOG-only child and requires complete association keys", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n\n## 1.0.0\n\nInitial release.\n",
        "src/app.ts": "export const value = 1;\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const sourceFiles = {
        ...rootFiles,
        "src/app.ts": "export const value = 2;\n",
      };
      const sourceTarget = createCommit(cwd, {
        files: sourceFiles,
        parents: [root],
        subject: "fix: product behavior",
        timestamp: 20,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...sourceFiles,
          "CHANGELOG.md": "# Changelog\n\n## 1.0.0\n\nFinal release notes.\n",
        },
        parents: [sourceTarget],
        subject: "docs(changelog): finalize release notes",
        timestamp: 30,
      });
      const invalidFinalTarget = createCommit(cwd, {
        files: {
          ...sourceFiles,
          "CHANGELOG.md": "# Changelog\n\n## 1.0.0\n\nInvalid release notes.\n",
          "src/app.ts": "export const value = 3;\n",
        },
        parents: [sourceTarget],
        subject: "docs(changelog): mix product bytes",
        timestamp: 40,
      });

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          finalTargetRef: finalTarget,
          sourceTargetRef: sourceTarget,
        },
        completeEvidence(new Map()),
      );
      expect(inventory.range.sourceTail).toMatchObject({
        commits: [
          {
            commit: finalTarget,
            parent: sourceTarget,
            paths: ["CHANGELOG.md"],
            subject: "docs(changelog): finalize release notes",
          },
        ],
        count: 1,
        maxCommits: 1,
      });
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            finalTargetRef: invalidFinalTarget,
            sourceTargetRef: sourceTarget,
          },
          completeEvidence(new Map()),
        ),
      ).toThrow("must be a linear association-free, reference-free CHANGELOG.md-only tail");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: sourceTarget,
          },
          {
            resolveAssociations: (commits: string[]) => ({
              allPullRequests: new Map(
                commits.map((commit) => [commit, commit === finalTarget ? [900] : []]),
              ),
              pullRequests: new Map(commits.map((commit) => [commit, []])),
            }),
          },
        ),
      ).toThrow("must be a linear association-free, reference-free CHANGELOG.md-only tail");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: sourceTarget,
          },
          {
            resolveAssociations: (commits: string[]) =>
              new Map(
                commits.filter((commit) => commit !== finalTarget).map((commit) => [commit, []]),
              ),
          },
        ),
      ).toThrow(`association evidence is missing commit ${finalTarget}`);
    }));
});
