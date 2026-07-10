import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import {
  isoSecond,
  summarizeTeamUniverseMembers,
  summarizeTeamUniverseRecords,
  teamUniverseWindowQuery,
} from "./github-team-inventory.mjs";

const objectIdPattern = /^[0-9a-f]{40}$/;
const maxBuffer = 128 * 1024 * 1024;
const gitApplyTimeoutMs = 60_000;
const repositoryRedirectVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

function fail(message) {
  throw new Error(message);
}

function canonicalDiffArgs(command, unified = 3) {
  return [
    "-c",
    `core.attributesFile=${devNull}`,
    "-c",
    "core.quotePath=true",
    "-c",
    "diff.suppressBlankEmpty=false",
    command,
    `--unified=${unified}`,
    "--inter-hunk-context=0",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--no-textconv",
    "--no-ext-diff",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-relative",
    `-O${devNull}`,
  ];
}

export function canonicalGitEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  for (const variable of repositoryRedirectVariables) {
    delete environment[variable];
  }
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
    NO_COLOR: "1",
  };
}

function git(cwd, args, { input } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: canonicalGitEnvironment(),
    input,
    maxBuffer,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function gitBuffer(cwd, args, { input } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: null,
    env: canonicalGitEnvironment(),
    input,
    maxBuffer,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(
      `git ${args.join(" ")} failed: ${
        result.stderr?.toString("utf8").trim() || result.signal || result.status
      }`,
    );
  }
  return result.stdout;
}

function resolveCommit(cwd, ref) {
  const commit = git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  if (!objectIdPattern.test(commit)) {
    fail(`${ref} did not resolve to an immutable commit`);
  }
  return commit;
}

function assertCanonicalRepository(cwd) {
  if (git(cwd, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    fail("release source inventory refuses shallow Git repositories");
  }
  if (git(cwd, ["for-each-ref", "--format=%(refname)", "refs/replace"]).trim() !== "") {
    fail("release source inventory refuses Git replacement refs");
  }
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  try {
    if (readFileSync(join(commonDir, "info", "grafts")).length > 0) {
      fail("release source inventory refuses a non-empty Git grafts file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    if (readFileSync(join(commonDir, "info", "attributes")).length > 0) {
      fail("release source inventory refuses a non-empty Git info/attributes file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function parseIdentity(value, label, commit) {
  const match = value.match(/^(?<name>.*) <(?<email>[^>]*)> (?<timestamp>\d+) [+-]\d{4}$/);
  if (!match?.groups) {
    fail(`commit ${commit} has a malformed ${label} header`);
  }
  return {
    email: match.groups.email,
    name: match.groups.name,
    timestamp: Number(match.groups.timestamp) * 1000,
  };
}

function parseRawCommit(commit, content) {
  const separator = content.indexOf("\n\n");
  if (separator < 0) {
    fail(`commit ${commit} has malformed raw content`);
  }
  const headerLines = content.slice(0, separator).split("\n");
  const headers = [];
  for (const line of headerLines) {
    if (line.startsWith(" ")) {
      if (headers.length === 0) {
        fail(`commit ${commit} has malformed continued headers`);
      }
      headers[headers.length - 1] += `\n${line}`;
    } else {
      headers.push(line);
    }
  }
  const values = (name) =>
    headers
      .filter((line) => line.startsWith(`${name} `))
      .map((line) => line.slice(name.length + 1));
  const trees = values("tree");
  const parents = values("parent");
  const authors = values("author");
  const committers = values("committer");
  if (
    trees.length !== 1 ||
    !objectIdPattern.test(trees[0]) ||
    parents.some((parent) => !objectIdPattern.test(parent)) ||
    authors.length !== 1 ||
    committers.length !== 1
  ) {
    fail(`commit ${commit} has malformed raw topology or identity headers`);
  }
  const message = content.slice(separator + 2);
  const [subject = ""] = message.split(/\r?\n/, 1);
  const firstLineEnd = message.indexOf("\n");
  const body = firstLineEnd < 0 ? "" : message.slice(firstLineEnd + 1).trimStart();
  return {
    author: parseIdentity(authors[0], "author", commit),
    body,
    commit,
    committer: parseIdentity(committers[0], "committer", commit),
    message,
    parents,
    subject,
    tree: trees[0],
  };
}

function readCommitBatch(cwd, commits) {
  if (commits.length === 0) {
    return new Map();
  }
  const output = gitBuffer(cwd, ["cat-file", "--batch"], {
    input: Buffer.from(`${commits.join("\n")}\n`),
  });
  const records = new Map();
  let offset = 0;
  for (const requested of commits) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      fail(`git cat-file omitted commit ${requested}`);
    }
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = header.match(/^(?<commit>[0-9a-f]{40}) (?<type>\S+) (?<size>\d+)$/);
    if (!match?.groups || match.groups.commit !== requested || match.groups.type !== "commit") {
      fail(`git cat-file could not read commit ${requested}`);
    }
    const size = Number(match.groups.size);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || contentEnd > output.length) {
      fail(`git cat-file returned an invalid size for commit ${requested}`);
    }
    const content = output.subarray(contentStart, contentEnd).toString("utf8");
    records.set(requested, parseRawCommit(requested, content));
    offset = contentEnd + 1;
  }
  return records;
}

function readRawClosure(cwd, tips) {
  const records = new Map();
  const prime = git(cwd, ["rev-list", ...tips])
    .trim()
    .split("\n")
    .filter(Boolean);
  let pending = [...new Set([...tips, ...prime])];
  while (pending.length > 0) {
    const batch = pending.filter((commit) => !records.has(commit)).toSorted();
    if (batch.length === 0) {
      break;
    }
    const loaded = readCommitBatch(cwd, batch);
    for (const [commit, record] of loaded) {
      records.set(commit, record);
    }
    pending = [...loaded.values()].flatMap((record) => record.parents);
  }
  return records;
}

function ancestorsOf(graph, tip) {
  const ancestors = new Set();
  const pending = [tip];
  while (pending.length > 0) {
    const commit = pending.pop();
    if (ancestors.has(commit)) {
      continue;
    }
    const record = graph.get(commit);
    if (!record) {
      fail(`raw Git graph is missing commit ${commit}`);
    }
    ancestors.add(commit);
    pending.push(...record.parents);
  }
  return ancestors;
}

function rawMergeBase(graph, left, right) {
  const leftAncestors = ancestorsOf(graph, left);
  const rightAncestors = ancestorsOf(graph, right);
  const common = new Set([...leftAncestors].filter((commit) => rightAncestors.has(commit)));
  const commonChildren = new Set();
  for (const commit of common) {
    for (const parent of graph.get(commit).parents) {
      if (common.has(parent)) {
        commonChildren.add(parent);
      }
    }
  }
  const mergeBases = [...common].filter((commit) => !commonChildren.has(commit)).toSorted();
  if (mergeBases.length !== 1) {
    fail(`${left} and ${right} have ${mergeBases.length} raw merge bases`);
  }
  return mergeBases[0];
}

function oldestFirst(graph, commits) {
  const members = new Set(commits);
  const children = new Map();
  const parentCounts = new Map();
  for (const commit of members) {
    const parents = graph.get(commit).parents.filter((parent) => members.has(parent));
    parentCounts.set(commit, parents.length);
    for (const parent of parents) {
      const values = children.get(parent) ?? [];
      values.push(commit);
      children.set(parent, values);
    }
  }
  const compare = (left, right) =>
    graph.get(left).committer.timestamp - graph.get(right).committer.timestamp ||
    left.localeCompare(right);
  const ready = [...members].filter((commit) => parentCounts.get(commit) === 0).sort(compare);
  const ordered = [];
  while (ready.length > 0) {
    const commit = ready.shift();
    ordered.push(commit);
    for (const child of children.get(commit) ?? []) {
      const remaining = parentCounts.get(child) - 1;
      parentCounts.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort(compare);
      }
    }
  }
  if (ordered.length !== members.size) {
    fail("raw Git graph contains a cycle");
  }
  return ordered;
}

function localReferencesIn(text) {
  const references = [];
  for (const match of text.matchAll(
    /(?<![A-Za-z0-9_.&-])(?:(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+))?#(?<number>\d+)/g,
  )) {
    const repository = match.groups?.owner
      ? `${match.groups.owner}/${match.groups.name}`.toLowerCase()
      : undefined;
    if (!repository || repository === "openclaw/openclaw") {
      references.push(Number(match.groups.number));
    }
  }
  return [...new Set(references)];
}

export function explicitPullRequestReferences(subject, body) {
  const references = [];
  const trailing = subject.match(/\((?:(?:openclaw\/openclaw)?#(?<number>\d+))\)\s*$/i);
  if (trailing?.groups?.number) {
    references.push(Number(trailing.groups.number));
  }
  const merge = subject.match(/^Merge pull request #(?<number>\d+)\b/i);
  if (merge?.groups?.number) {
    references.push(Number(merge.groups.number));
  }
  if (/^Reapply\s+"/i.test(subject)) {
    references.push(...localReferencesIn(subject));
  }
  const referenceList = String.raw`(?:(?:openclaw\/openclaw)?#\d+)(?:\s*(?:,|and)\s*(?:(?:openclaw\/openclaw)?#\d+))*`;
  const directive = new RegExp(
    String.raw`^(?:(?:pull request|pr|source-pr|cherry-pick(?:ed)? from)\s*:?\s*${referenceList}|backport(?:ed)? (?:from|of)\s+${referenceList}(?:\s+to\s+\S+)?)\s*[.!]?$`,
    "i",
  );
  for (const line of body.split(/\r?\n/).map((value) => value.trim())) {
    if (directive.test(line)) {
      references.push(...localReferencesIn(line));
    }
  }
  return [...new Set(references)].toSorted((left, right) => left - right);
}

function requiredPullRequestReferences(subject, body) {
  const references = [];
  const merge = subject.match(/^Merge pull request #(?<number>\d+)\b/i);
  if (merge?.groups?.number) {
    references.push(Number(merge.groups.number));
  }
  if (/^Reapply\s+"/i.test(subject)) {
    references.push(...localReferencesIn(subject));
  }
  const referenceList = String.raw`(?:(?:openclaw\/openclaw)?#\d+)(?:\s*(?:,|and)\s*(?:(?:openclaw\/openclaw)?#\d+))*`;
  const directive = new RegExp(
    String.raw`^(?:(?:pull request|pr|source-pr|cherry-pick(?:ed)? from)\s*:?\s*${referenceList}|backport(?:ed)? (?:from|of)\s+${referenceList}(?:\s+to\s+\S+)?)\s*[.!]?$`,
    "i",
  );
  for (const line of body.split(/\r?\n/).map((value) => value.trim())) {
    if (directive.test(line)) {
      references.push(...localReferencesIn(line));
    }
  }
  return new Set(references);
}

function cherryPickOrigins(message) {
  return [...message.matchAll(/^\(cherry picked from commit ([0-9a-f]{40})\)$/gim)].map((match) =>
    match[1].toLowerCase(),
  );
}

function adaptationOrigins(message) {
  return [...message.matchAll(/^Partial backport of ([0-9a-f]{40})(?:[.;]|$)/gim)].map((match) =>
    match[1].toLowerCase(),
  );
}

function revertedCommit(message) {
  return message.trimStart().match(/^This reverts commit ([0-9a-f]{40})\.(?:\r?\n|$)/i)?.[1];
}

function commitPatch(cwd, graph, commit) {
  const record = graph.get(commit);
  if (!record || record.parents.length !== 1) {
    return undefined;
  }
  return commitFirstParentPatch(cwd, graph, commit);
}

function commitFirstParentPatch(cwd, graph, commit) {
  const record = graph.get(commit);
  if (!record || record.parents.length === 0) {
    return undefined;
  }
  const patch = git(cwd, [
    ...canonicalDiffArgs("diff"),
    "--binary",
    "--full-index",
    "--no-color",
    record.parents[0],
    commit,
    "--",
  ]);
  if (patch === "") {
    return undefined;
  }
  const patchId = git(cwd, ["patch-id", "--stable"], { input: patch }).trim().split(/\s+/)[0];
  return {
    diffSha256: createHash("sha256").update(patch).digest("hex"),
    parent: record.parents[0],
    patch,
    patchId,
  };
}

function commitRangePatch(cwd, baseCommit, headCommit) {
  const patch = git(cwd, [
    ...canonicalDiffArgs("diff"),
    "--binary",
    "--full-index",
    "--no-color",
    baseCommit,
    headCommit,
    "--",
  ]);
  if (patch === "") {
    return undefined;
  }
  return {
    diffSha256: createHash("sha256").update(patch).digest("hex"),
    parent: baseCommit,
    patch,
    patchId: git(cwd, ["patch-id", "--stable"], { input: patch }).trim().split(/\s+/)[0],
  };
}

function uniqueMergeBase(cwd, left, right, label) {
  const result = spawnSync("git", ["merge-base", "--all", left, right], {
    cwd,
    encoding: "utf8",
    env: canonicalGitEnvironment(),
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const commits = result.stdout.trim().split(/\s+/).filter(Boolean);
  if (result.status !== 0 || commits.length !== 1 || !objectIdPattern.test(commits[0])) {
    fail(`${label} does not have exactly one immutable merge base`);
  }
  return commits[0];
}

function extendGraphWithCommitsAndParents(cwd, graph, commits) {
  const missing = [...new Set(commits)].filter((commit) => !graph.has(commit)).toSorted();
  const records = readCommitBatch(cwd, missing);
  for (const [commit, record] of records) {
    graph.set(commit, record);
  }
  const missingParents = [
    ...new Set(
      [...records.values()]
        .flatMap((record) => record.parents)
        .filter((commit) => !graph.has(commit)),
    ),
  ].toSorted();
  for (const [commit, record] of readCommitBatch(cwd, missingParents)) {
    graph.set(commit, record);
  }
}

function commitPathPatch(cwd, graph, commit, path) {
  const record = graph.get(commit);
  if (!record || record.parents.length !== 1) {
    return undefined;
  }
  const patch = git(cwd, [
    ...canonicalDiffArgs("diff"),
    "--binary",
    "--full-index",
    "--no-color",
    record.parents[0],
    commit,
    "--",
    path,
  ]);
  if (patch === "") {
    return undefined;
  }
  return {
    diffSha256: createHash("sha256").update(patch).digest("hex"),
    parent: record.parents[0],
    patch,
    patchId: git(cwd, ["patch-id", "--stable"], { input: patch }).trim().split(/\s+/)[0],
  };
}

function exactPathPatchEvidence(cwd, graph, sourceCommit, targetCommit, path) {
  const sourcePatch = commitPathPatch(cwd, graph, sourceCommit, path);
  const targetPatch = commitPathPatch(cwd, graph, targetCommit, path);
  if (
    !sourcePatch?.patchId ||
    !targetPatch?.patchId ||
    sourcePatch.patchId !== targetPatch.patchId ||
    !patchProducesPathState(cwd, sourcePatch.patch, targetPatch.parent, targetCommit, path) ||
    !patchProducesPathState(cwd, targetPatch.patch, sourcePatch.parent, sourceCommit, path)
  ) {
    return undefined;
  }
  return {
    patchId: sourcePatch.patchId,
    path,
    sourceCommit,
    sourceDiffSha256: sourcePatch.diffSha256,
    sourceParent: sourcePatch.parent,
    targetDiffSha256: targetPatch.diffSha256,
    targetParent: targetPatch.parent,
  };
}

function pathStateSha256(cwd, commit, path) {
  const state = gitBuffer(cwd, ["ls-tree", "-z", "--full-tree", commit, "--", path]);
  return createHash("sha256").update(state).digest("hex");
}

function applyPatchToIndex(cwd, directory, environment, patch, args) {
  const patchPath = join(directory, "patch.diff");
  writeFileSync(patchPath, patch);
  const result = spawnSync(
    "git",
    ["apply", "--cached", ...args, "--binary", "--whitespace=nowarn", patchPath],
    {
      cwd,
      encoding: "utf8",
      env: environment,
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: gitApplyTimeoutMs,
    },
  );
  return !result.error && result.status === 0;
}

function patchProducesTree(cwd, patch, parent, expectedTree) {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-release-patch-"));
  const environment = canonicalGitEnvironment({ GIT_INDEX_FILE: join(directory, "index") });
  try {
    execFileSync("git", ["read-tree", parent], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!applyPatchToIndex(cwd, directory, environment, patch, ["--3way"])) {
      return false;
    }
    return (
      execFileSync("git", ["write-tree"], {
        cwd,
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() === expectedTree
    );
  } catch {
    return false;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function patchProducesPathState(cwd, patch, parent, expectedCommit, path) {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-release-path-patch-"));
  const environment = canonicalGitEnvironment({ GIT_INDEX_FILE: join(directory, "index") });
  try {
    execFileSync("git", ["read-tree", parent], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!applyPatchToIndex(cwd, directory, environment, patch, ["--3way"])) {
      return false;
    }
    const comparison = spawnSync(
      "git",
      ["diff", "--cached", "--quiet", "--no-ext-diff", expectedCommit, "--", path],
      {
        cwd,
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return comparison.status === 0;
  } catch {
    return false;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function patchRoundTripRestoresTree(cwd, targetCommit, targetTree, patch, applyMode) {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-release-tree-patch-"));
  const environment = canonicalGitEnvironment({ GIT_INDEX_FILE: join(directory, "index") });
  const applyPatch = (reverse) =>
    applyPatchToIndex(cwd, directory, environment, patch, [
      ...applyMode,
      ...(reverse ? ["--reverse"] : []),
    ]);
  try {
    execFileSync("git", ["read-tree", targetCommit], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!applyPatch(true)) {
      return false;
    }
    if (!applyPatch(false)) {
      return false;
    }
    const restoredTree = execFileSync("git", ["write-tree"], {
      cwd,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return restoredTree === targetTree;
  } catch {
    return false;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function candidateTreeProofFields(candidate, targetCommit, targetTree) {
  return {
    candidateBaseCommit: candidate.parent,
    candidateCommit: candidate.commit,
    candidateDiffSha256: candidate.diffSha256,
    candidatePatchId: candidate.patchId,
    changedPaths: candidate.paths,
    targetCommit,
    targetTree,
  };
}

function candidatePatchTreeProof(cwd, graph, targetCommit, candidate) {
  const targetRecord = graph.get(targetCommit);
  if (
    !targetRecord ||
    candidate.paths.length === 0 ||
    !patchRoundTripRestoresTree(cwd, targetCommit, targetRecord.tree, candidate.patch, ["--3way"])
  ) {
    return undefined;
  }
  return {
    ...candidateTreeProofFields(candidate, targetCommit, targetRecord.tree),
    proofMethod: "reverse-then-forward-apply-exact-target-tree",
    proofStrength: "exact",
  };
}

function candidatePatchAmbiguityProof(cwd, graph, targetCommit, candidate) {
  const targetRecord = graph.get(targetCommit);
  if (!targetRecord || candidate.paths.length === 0) {
    return undefined;
  }
  const proofPatch = git(cwd, [
    ...canonicalDiffArgs("diff", 0),
    "--binary",
    "--full-index",
    "--no-color",
    candidate.parent,
    candidate.commit,
    "--",
    ...candidate.paths,
  ]);
  if (
    proofPatch === "" ||
    !patchRoundTripRestoresTree(cwd, targetCommit, targetRecord.tree, proofPatch, [
      "--unidiff-zero",
    ])
  ) {
    return undefined;
  }
  return {
    ...candidateTreeProofFields(candidate, targetCommit, targetRecord.tree),
    proofDiffSha256: createHash("sha256").update(proofPatch).digest("hex"),
    proofMethod: "reverse-then-forward-zero-context-exact-target-tree",
    proofPatchId: git(cwd, ["patch-id", "--stable"], { input: proofPatch }).trim().split(/\s+/)[0],
    proofStrength: "ambiguous-target-provenance",
  };
}

function exactPatchEquivalent(cwd, graph, left, right, { inverse = false } = {}) {
  const leftPatch = commitPatch(cwd, graph, left);
  const rightPatch = commitPatch(cwd, graph, right);
  const leftRecord = graph.get(left);
  const rightRecord = graph.get(right);
  if (!leftPatch || !rightPatch || !leftRecord || !rightRecord) {
    return false;
  }
  if (inverse) {
    return (
      patchProducesTree(cwd, leftPatch.patch, right, graph.get(rightPatch.parent).tree) &&
      patchProducesTree(cwd, rightPatch.patch, left, graph.get(leftPatch.parent).tree)
    );
  }
  if (leftPatch.patchId !== rightPatch.patchId) {
    return false;
  }
  return (
    patchProducesTree(cwd, leftPatch.patch, rightPatch.parent, rightRecord.tree) &&
    patchProducesTree(cwd, rightPatch.patch, leftPatch.parent, leftRecord.tree)
  );
}

function exactCandidatePatchEquivalent(cwd, graph, target, candidate) {
  const targetPatch = commitPatch(cwd, graph, target);
  const targetRecord = graph.get(target);
  if (!targetPatch || !targetRecord) {
    return false;
  }
  if (targetPatch.patchId !== candidate.patchId) {
    return false;
  }
  return (
    patchProducesTree(cwd, candidate.patch, targetPatch.parent, targetRecord.tree) &&
    patchProducesTree(cwd, targetPatch.patch, candidate.parent, candidate.tree)
  );
}

function normalizeAssociationMap(pullRequests, commits, label) {
  if (!(pullRequests instanceof Map)) {
    fail(`association resolver did not return a ${label} map`);
  }
  const normalized = new Map();
  for (const commit of commits) {
    if (!pullRequests.has(commit)) {
      fail(`${label} association evidence is missing commit ${commit}`);
    }
    const numbers = pullRequests.get(commit);
    if (
      !Array.isArray(numbers) ||
      numbers.some((number) => !Number.isInteger(number) || number <= 0)
    ) {
      fail(`association evidence for commit ${commit} is invalid`);
    }
    normalized.set(
      commit,
      [...new Set(numbers)].toSorted((left, right) => left - right),
    );
  }
  return normalized;
}

function normalizeAssociations(result, commits) {
  if (result instanceof Map) {
    const pullRequests = normalizeAssociationMap(result, commits, "included");
    return { allPullRequests: pullRequests, pullRequests };
  }
  return {
    allPullRequests: normalizeAssociationMap(result?.allPullRequests, commits, "complete"),
    pullRequests: normalizeAssociationMap(result?.pullRequests, commits, "included"),
  };
}

function normalizePullRequestEvidence(result, numbers) {
  if (!(result instanceof Map)) {
    fail("pull request evidence resolver did not return a map");
  }
  const normalized = new Map();
  for (const number of numbers) {
    if (!result.has(number)) {
      fail(`pull request evidence is missing #${number}`);
    }
    const node = result.get(number);
    if (node === null) {
      normalized.set(number, null);
      continue;
    }
    if (
      !node ||
      (node.__typename !== "Issue" && node.__typename !== "PullRequest") ||
      node.number !== number ||
      (node.__typename === "PullRequest" &&
        node.mergedAt !== null &&
        typeof node.mergedAt !== "string")
    ) {
      fail(`pull request evidence for #${number} is invalid`);
    }
    normalized.set(number, node);
  }
  return normalized;
}

function normalizePullRequestCommits(result, numbers) {
  if (!(result instanceof Map)) {
    fail("pull request commit resolver did not return a map");
  }
  const normalized = new Map();
  for (const number of numbers) {
    if (!result.has(number)) {
      fail(`pull request commit evidence is missing #${number}`);
    }
    const commits = result.get(number);
    if (
      !Array.isArray(commits) ||
      commits.length === 0 ||
      commits.some((commit) => typeof commit !== "string" || !objectIdPattern.test(commit))
    ) {
      fail(`pull request commit evidence for #${number} is invalid`);
    }
    const unique = [...new Set(commits)].toSorted();
    if (unique.length !== commits.length) {
      fail(`pull request commit evidence for #${number} contains duplicates`);
    }
    normalized.set(number, unique);
  }
  return normalized;
}

function normalizePullRequestMetadata(result, numbers) {
  if (!(result instanceof Map)) {
    fail("pull request metadata resolver did not return a map");
  }
  const normalized = new Map();
  for (const number of numbers) {
    const record = result.get(number);
    const mergedAt = Date.parse(record?.mergedAt);
    if (
      record?.number !== number ||
      typeof record?.baseBranch !== "string" ||
      record.baseBranch.length === 0 ||
      typeof record?.baseCommit !== "string" ||
      !objectIdPattern.test(record.baseCommit) ||
      typeof record?.headCommit !== "string" ||
      !objectIdPattern.test(record.headCommit) ||
      typeof record?.mergeCommit !== "string" ||
      !objectIdPattern.test(record.mergeCommit) ||
      !Number.isFinite(mergedAt)
    ) {
      fail(`pull request metadata evidence for #${number} is invalid`);
    }
    normalized.set(number, {
      baseBranch: record.baseBranch,
      baseCommit: record.baseCommit,
      headCommit: record.headCommit,
      mergeCommit: record.mergeCommit,
      mergedAt: new Date(mergedAt).toISOString(),
      number,
    });
  }
  return normalized;
}

function activeCommitsAfterReverts(commits, edges) {
  const members = new Set(commits);
  const revertsByTarget = new Map();
  for (const edge of edges) {
    if (!members.has(edge.revertCommit) || !members.has(edge.targetCommit)) {
      continue;
    }
    const reverts = revertsByTarget.get(edge.targetCommit) ?? [];
    reverts.push(edge.revertCommit);
    revertsByTarget.set(edge.targetCommit, reverts);
  }
  const active = new Map();
  function isActive(commit, seen = new Set()) {
    if (active.has(commit)) {
      return active.get(commit);
    }
    if (seen.has(commit)) {
      fail(`cyclic revert graph at ${commit}`);
    }
    const nextSeen = new Set(seen);
    nextSeen.add(commit);
    const value = !(revertsByTarget.get(commit) ?? []).some((revert) => isActive(revert, nextSeen));
    active.set(commit, value);
    return value;
  }
  return new Set([...members].filter((commit) => isActive(commit)));
}

function revertLineage(graph, start) {
  const commits = [];
  const seen = new Set();
  let current = start;
  while (graph.has(current)) {
    if (seen.has(current)) {
      fail(`cyclic revert lineage at ${current}`);
    }
    seen.add(current);
    commits.push(current);
    const target = revertedCommit(graph.get(current).body);
    if (!target) {
      break;
    }
    current = target;
  }
  return commits;
}

function setSummary(values, compare = (left, right) => String(left).localeCompare(String(right))) {
  const members = [...new Set(values)].sort(compare);
  return {
    count: members.length,
    members,
    sha256: createHash("sha256")
      .update(members.map((value) => `${value}\n`).join(""))
      .digest("hex"),
  };
}

function recordSummary(values) {
  const serialized = values.map((value) => JSON.stringify(value));
  if (new Set(serialized).size !== serialized.length) {
    fail("release source inventory evidence records contain duplicates");
  }
  const sorted = serialized.toSorted();
  return {
    count: sorted.length,
    records: sorted.map((value) => JSON.parse(value)),
    sha256: createHash("sha256")
      .update(sorted.map((value) => `${value}\n`).join(""))
      .digest("hex"),
  };
}

function digestInventory(inventory) {
  return createHash("sha256")
    .update(`${JSON.stringify(inventory)}\n`)
    .digest("hex");
}

function changedPaths(cwd, parent, commit) {
  return git(cwd, [...canonicalDiffArgs("diff"), "--name-only", "-z", parent, commit, "--"])
    .split("\0")
    .filter(Boolean)
    .toSorted();
}

function sourceTailCommits(graph, sourceTarget, finalTarget, maxCommits) {
  if (!Number.isSafeInteger(maxCommits) || maxCommits < 0 || maxCommits > graph.size) {
    fail("maximum CHANGELOG-only tail length is invalid");
  }
  const reversed = [];
  let current = finalTarget;
  while (current !== sourceTarget) {
    const record = graph.get(current);
    if (!record || record.parents.length !== 1) {
      fail(
        `final target ${finalTarget} is not a linear descendant of source target ${sourceTarget}`,
      );
    }
    reversed.push(current);
    if (reversed.length > maxCommits) {
      fail(
        `final target ${finalTarget} exceeds the allowed ${maxCommits}-commit CHANGELOG-only tail from ${sourceTarget}`,
      );
    }
    current = record.parents[0];
  }
  return reversed.reverse();
}

function normalizeComparisonUniverse(
  result,
  { baseBranch, endTimestamp, repository, startTimestamp },
) {
  const query = teamUniverseWindowQuery({
    base: baseBranch,
    end: isoSecond(endTimestamp),
    repository,
    start: isoSecond(startTimestamp),
  });
  if (
    !result ||
    result.baseBranch !== baseBranch ||
    result.query !== query ||
    result.repository !== repository ||
    result.window?.startTimestamp !== startTimestamp ||
    result.window?.endTimestamp !== endTimestamp ||
    !Number.isInteger(result.count) ||
    result.count < 0 ||
    !Array.isArray(result.pullRequests) ||
    result.pullRequests.some((number) => !Number.isInteger(number) || number <= 0) ||
    !Array.isArray(result.records) ||
    typeof result.recordsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.recordsSha256) ||
    typeof result.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.sha256) ||
    !Array.isArray(result.segments)
  ) {
    fail("merged pull request comparison resolver returned invalid evidence");
  }
  const pullRequests = summarizeTeamUniverseMembers(result.pullRequests);
  if (
    pullRequests.count !== result.count ||
    pullRequests.count !== result.pullRequests.length ||
    pullRequests.sha256 !== result.sha256 ||
    JSON.stringify(pullRequests.members) !== JSON.stringify(result.pullRequests)
  ) {
    fail("merged pull request comparison resolver returned inconsistent members");
  }
  const records = result.records.map((record) => {
    const mergedAt = Date.parse(record?.mergedAt);
    if (
      record?.baseBranch !== baseBranch ||
      typeof record?.baseCommit !== "string" ||
      !objectIdPattern.test(record.baseCommit) ||
      typeof record?.headCommit !== "string" ||
      !objectIdPattern.test(record.headCommit) ||
      typeof record?.mergeCommit !== "string" ||
      !objectIdPattern.test(record.mergeCommit) ||
      !Number.isFinite(mergedAt) ||
      mergedAt < startTimestamp ||
      mergedAt > endTimestamp ||
      !Number.isInteger(record?.number) ||
      record.number <= 0
    ) {
      fail("merged pull request comparison resolver returned invalid PR metadata");
    }
    return {
      baseBranch,
      baseCommit: record.baseCommit,
      headCommit: record.headCommit,
      mergeCommit: record.mergeCommit,
      mergedAt: new Date(mergedAt).toISOString(),
      number: record.number,
    };
  });
  const recordSummary = summarizeTeamUniverseRecords(records);
  if (
    recordSummary.count !== result.count ||
    recordSummary.sha256 !== result.recordsSha256 ||
    JSON.stringify(recordSummary.records) !== JSON.stringify(result.records) ||
    JSON.stringify(recordSummary.records.map((record) => record.number)) !==
      JSON.stringify(pullRequests.members)
  ) {
    fail("merged pull request comparison resolver returned inconsistent PR metadata");
  }
  if (result.segments.length === 0) {
    fail("merged pull request comparison resolver returned no search segments");
  }
  const recordByNumber = new Map(records.map((record) => [record.number, record]));
  const segments = result.segments.map((segment, index) => {
    const segmentStart = segment?.window?.startTimestamp;
    const segmentEnd = segment?.window?.endTimestamp;
    if (
      !Number.isSafeInteger(segmentStart) ||
      !Number.isSafeInteger(segmentEnd) ||
      segmentStart < startTimestamp ||
      segmentEnd > endTimestamp ||
      segmentStart > segmentEnd ||
      segment?.query !==
        teamUniverseWindowQuery({
          base: baseBranch,
          end: isoSecond(segmentEnd),
          repository,
          start: isoSecond(segmentStart),
        }) ||
      !Number.isInteger(segment?.count) ||
      segment.count < 0 ||
      !Array.isArray(segment?.pullRequests) ||
      typeof segment?.recordsSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(segment.recordsSha256) ||
      typeof segment?.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(segment.sha256)
    ) {
      fail(`merged pull request comparison resolver returned invalid segment ${index}`);
    }
    const members = summarizeTeamUniverseMembers(segment.pullRequests);
    const segmentRecords = segment.pullRequests.map((number) => {
      const record = recordByNumber.get(number);
      const mergedAt = Date.parse(record?.mergedAt);
      if (!record || mergedAt < segmentStart || mergedAt > segmentEnd) {
        fail(`merged pull request comparison segment ${index} contains invalid member #${number}`);
      }
      return record;
    });
    const segmentRecordSummary = summarizeTeamUniverseRecords(segmentRecords);
    if (
      members.count !== segment.count ||
      members.count !== segment.pullRequests.length ||
      members.sha256 !== segment.sha256 ||
      segmentRecordSummary.sha256 !== segment.recordsSha256 ||
      JSON.stringify(members.members) !== JSON.stringify(segment.pullRequests)
    ) {
      fail(`merged pull request comparison segment ${index} is inconsistent`);
    }
    return {
      count: members.count,
      pullRequests: members.members,
      query: segment.query,
      recordsSha256: segmentRecordSummary.sha256,
      sha256: members.sha256,
      window: { endTimestamp: segmentEnd, startTimestamp: segmentStart },
    };
  });
  if (
    segments[0].window.startTimestamp !== startTimestamp ||
    segments.at(-1).window.endTimestamp !== endTimestamp ||
    segments.some(
      (segment, index) =>
        index > 0 && segments[index - 1].window.endTimestamp !== segment.window.startTimestamp,
    )
  ) {
    fail("merged pull request comparison segments do not exactly cover the requested window");
  }
  const segmentMembers = summarizeTeamUniverseMembers(
    segments.flatMap((segment) => segment.pullRequests),
  );
  if (
    segmentMembers.count !== pullRequests.count ||
    segmentMembers.sha256 !== pullRequests.sha256
  ) {
    fail("merged pull request comparison segments do not equal the requested universe");
  }
  return {
    baseBranch,
    pullRequests: pullRequests.members,
    query,
    records,
    recordsSha256: recordSummary.sha256,
    repository,
    segments,
    sha256: pullRequests.sha256,
    window: { endTimestamp, startTimestamp },
  };
}

function mergeResolutionDigest(cwd, commit) {
  const diff = git(cwd, [
    ...canonicalDiffArgs("show"),
    "--remerge-diff",
    "--format=",
    "--binary",
    "--full-index",
    "--no-color",
    commit,
    "--",
  ]);
  return diff === "" ? undefined : createHash("sha256").update(diff).digest("hex");
}

export function buildReleaseSourceInventory(
  {
    baseRef,
    comparisonBaseBranch,
    cwd = process.cwd(),
    finalTargetRef,
    maxSourceTailCommits = 1,
    provenanceAdaptedPullRequests = [],
    provenanceIntegratedPullRequests = [],
    provenancePartialPullRequests = [],
    provenanceRefs = [],
    provenancePullRequests = [],
    repository = "openclaw/openclaw",
    shippedRefs = [],
    sourceTargetRef,
  },
  {
    resolveAssociations,
    resolveComparisonPullRequests,
    resolvePullRequestCommits,
    resolvePullRequestMetadata,
    resolvePullRequests,
  },
) {
  assertCanonicalRepository(cwd);
  const base = resolveCommit(cwd, baseRef);
  const sourceTarget = resolveCommit(cwd, sourceTargetRef);
  const finalTarget = resolveCommit(cwd, finalTargetRef ?? sourceTargetRef);
  const shipped = shippedRefs.map((ref) => ({ commit: resolveCommit(cwd, ref), ref }));
  const provenance = provenanceRefs.map((ref) => ({ commit: resolveCommit(cwd, ref), ref }));
  const trustedAdaptedPullRequestProvenance = provenanceAdaptedPullRequests.map(
    ({ number, originCommitRef, targetCommitRef }) => {
      if (
        !Number.isInteger(number) ||
        number <= 0 ||
        typeof originCommitRef !== "string" ||
        typeof targetCommitRef !== "string"
      ) {
        fail("trusted adapted pull request provenance is invalid");
      }
      return {
        number,
        originCommit: resolveCommit(cwd, originCommitRef),
        originRef: originCommitRef,
        targetCommit: resolveCommit(cwd, targetCommitRef),
        targetRef: targetCommitRef,
      };
    },
  );
  const trustedAdaptedPullRequestProvenanceKeys = new Set(
    trustedAdaptedPullRequestProvenance.map(
      (entry) => `${entry.number}:${entry.originCommit}:${entry.targetCommit}`,
    ),
  );
  if (trustedAdaptedPullRequestProvenanceKeys.size !== trustedAdaptedPullRequestProvenance.length) {
    fail("trusted adapted pull request provenance values must be unique");
  }
  if (
    new Set(trustedAdaptedPullRequestProvenance.map((entry) => entry.targetCommit)).size !==
    trustedAdaptedPullRequestProvenance.length
  ) {
    fail("trusted adapted pull request provenance target commits must be unique");
  }
  const trustedIntegratedPullRequestEntries = provenanceIntegratedPullRequests.map(
    ({ number, sourceCommitRef, targetCommitRef }) => {
      if (
        !Number.isInteger(number) ||
        number <= 0 ||
        typeof sourceCommitRef !== "string" ||
        typeof targetCommitRef !== "string"
      ) {
        fail("trusted integrated pull request provenance is invalid");
      }
      return {
        number,
        sourceCommit: resolveCommit(cwd, sourceCommitRef),
        sourceRef: sourceCommitRef,
        targetCommit: resolveCommit(cwd, targetCommitRef),
        targetRef: targetCommitRef,
      };
    },
  );
  const trustedIntegratedPullRequestEntryKeys = new Set(
    trustedIntegratedPullRequestEntries.map(
      (entry) => `${entry.number}:${entry.sourceCommit}:${entry.targetCommit}`,
    ),
  );
  if (trustedIntegratedPullRequestEntryKeys.size !== trustedIntegratedPullRequestEntries.length) {
    fail("trusted integrated pull request provenance values must be unique");
  }
  const trustedIntegratedPullRequestGroups = new Map();
  for (const entry of trustedIntegratedPullRequestEntries) {
    const current = trustedIntegratedPullRequestGroups.get(entry.targetCommit);
    if (current && current.number !== entry.number) {
      fail(
        "trusted integrated pull request provenance target commits must map to one pull request",
      );
    }
    const group = current ?? {
      number: entry.number,
      sources: [],
      targetCommit: entry.targetCommit,
      targetRef: entry.targetRef,
    };
    group.sources.push({ commit: entry.sourceCommit, ref: entry.sourceRef });
    trustedIntegratedPullRequestGroups.set(entry.targetCommit, group);
  }
  const trustedIntegratedPullRequestProvenance = [...trustedIntegratedPullRequestGroups.values()]
    .map((entry) => ({
      ...entry,
      sources: entry.sources.toSorted((left, right) => left.commit.localeCompare(right.commit)),
    }))
    .toSorted(
      (left, right) =>
        left.number - right.number || left.targetCommit.localeCompare(right.targetCommit),
    );
  for (const entry of trustedIntegratedPullRequestProvenance) {
    if (entry.sources.length < 2) {
      fail(
        `trusted integrated provenance #${entry.number}:${entry.targetCommit} must bind at least two unique pull request source commits`,
      );
    }
  }
  const trustedPartialPullRequestProvenance = provenancePartialPullRequests.map(
    ({ number, sourceCommitRef, targetCommitRef }) => {
      if (
        !Number.isInteger(number) ||
        number <= 0 ||
        typeof sourceCommitRef !== "string" ||
        typeof targetCommitRef !== "string"
      ) {
        fail("trusted partial pull request provenance is invalid");
      }
      return {
        number,
        sourceCommit: resolveCommit(cwd, sourceCommitRef),
        sourceRef: sourceCommitRef,
        targetCommit: resolveCommit(cwd, targetCommitRef),
        targetRef: targetCommitRef,
      };
    },
  );
  const trustedPartialPullRequestProvenanceKeys = new Set(
    trustedPartialPullRequestProvenance.map(
      (entry) => `${entry.number}:${entry.sourceCommit}:${entry.targetCommit}`,
    ),
  );
  if (trustedPartialPullRequestProvenanceKeys.size !== trustedPartialPullRequestProvenance.length) {
    fail("trusted partial pull request provenance values must be unique");
  }
  if (
    new Set(trustedPartialPullRequestProvenance.map((entry) => entry.targetCommit)).size !==
    trustedPartialPullRequestProvenance.length
  ) {
    fail("trusted partial pull request provenance target commits must be unique");
  }
  const explicitProvenanceTargets = [
    ...trustedAdaptedPullRequestProvenance.map((entry) => entry.targetCommit),
    ...trustedIntegratedPullRequestProvenance.map((entry) => entry.targetCommit),
    ...trustedPartialPullRequestProvenance.map((entry) => entry.targetCommit),
  ];
  if (new Set(explicitProvenanceTargets).size !== explicitProvenanceTargets.length) {
    fail("trusted adapted, integrated, and partial provenance target commits must be disjoint");
  }
  const trustedPullRequestProvenance = provenancePullRequests.map(({ commitRef, number }) => {
    if (!Number.isInteger(number) || number <= 0 || typeof commitRef !== "string") {
      fail("trusted pull request provenance is invalid");
    }
    return { commit: resolveCommit(cwd, commitRef), number, ref: commitRef };
  });
  const trustedPullRequestProvenanceKeys = new Set(
    trustedPullRequestProvenance.map((entry) => `${entry.number}:${entry.commit}`),
  );
  if (trustedPullRequestProvenanceKeys.size !== trustedPullRequestProvenance.length) {
    fail("trusted pull request provenance values must be unique");
  }
  const provenanceNumbers = [
    ...new Set([
      ...trustedAdaptedPullRequestProvenance.map((entry) => entry.number),
      ...trustedIntegratedPullRequestProvenance.map((entry) => entry.number),
      ...trustedPartialPullRequestProvenance.map((entry) => entry.number),
      ...trustedPullRequestProvenance.map((entry) => entry.number),
    ]),
  ].toSorted((left, right) => left - right);
  if (provenanceNumbers.length > 0 && typeof resolvePullRequestCommits !== "function") {
    fail("release source inventory requires a pull request commit resolver");
  }
  const provenancePullRequestCommits =
    provenanceNumbers.length === 0
      ? new Map()
      : normalizePullRequestCommits(
          resolvePullRequestCommits(provenanceNumbers),
          provenanceNumbers,
        );
  const integratedPullRequestNumbers = [
    ...new Set(trustedIntegratedPullRequestProvenance.map((entry) => entry.number)),
  ].toSorted((left, right) => left - right);
  if (integratedPullRequestNumbers.length > 0 && typeof resolvePullRequestMetadata !== "function") {
    fail("release source inventory requires a pull request metadata resolver");
  }
  const integratedPullRequestMetadata =
    integratedPullRequestNumbers.length === 0
      ? new Map()
      : normalizePullRequestMetadata(
          resolvePullRequestMetadata(integratedPullRequestNumbers),
          integratedPullRequestNumbers,
        );
  const graph = readRawClosure(cwd, [
    base,
    sourceTarget,
    finalTarget,
    ...shipped.map((entry) => entry.commit),
    ...provenance.map((entry) => entry.commit),
    ...trustedAdaptedPullRequestProvenance.flatMap((entry) => [
      entry.originCommit,
      entry.targetCommit,
    ]),
    ...trustedIntegratedPullRequestProvenance.flatMap((entry) => [
      ...entry.sources.map((source) => source.commit),
      entry.targetCommit,
    ]),
    ...trustedPartialPullRequestProvenance.flatMap((entry) => [
      entry.sourceCommit,
      entry.targetCommit,
    ]),
    ...trustedPullRequestProvenance.map((entry) => entry.commit),
    ...[...provenancePullRequestCommits.values()].flatMap((commits) => commits),
  ]);
  const mergeBase = rawMergeBase(graph, base, sourceTarget);
  const boundaryAncestors = ancestorsOf(graph, mergeBase);
  const sourceAncestors = ancestorsOf(graph, sourceTarget);
  const sourceCommits = oldestFirst(
    graph,
    [...sourceAncestors].filter((commit) => !boundaryAncestors.has(commit)),
  );
  const targetTimestamp = graph.get(sourceTarget).committer.timestamp;
  const finalTargetTimestamp = graph.get(finalTarget).committer.timestamp;
  const tailCommits = sourceTailCommits(graph, sourceTarget, finalTarget, maxSourceTailCommits);
  let comparisonUniverse;
  if (comparisonBaseBranch) {
    if (typeof resolveComparisonPullRequests !== "function") {
      fail("release source inventory requires a merged pull request comparison resolver");
    }
    const startTimestamp = graph.get(mergeBase).committer.timestamp;
    comparisonUniverse = normalizeComparisonUniverse(
      resolveComparisonPullRequests({
        baseBranch: comparisonBaseBranch,
        endTimestamp: finalTargetTimestamp,
        repository,
        startTimestamp,
      }),
      {
        baseBranch: comparisonBaseBranch,
        endTimestamp: finalTargetTimestamp,
        repository,
        startTimestamp,
      },
    );
  }
  const sourceOrigins = [
    ...new Set(sourceCommits.flatMap((commit) => cherryPickOrigins(graph.get(commit).body))),
  ];
  if (sourceOrigins.length > 0) {
    const originGraph = readRawClosure(cwd, sourceOrigins);
    for (const [commit, record] of originGraph) {
      graph.set(commit, record);
    }
  }
  const provenanceExclusive = [
    ...new Set(
      provenance.flatMap((entry) =>
        [...ancestorsOf(graph, entry.commit)].filter((commit) => !sourceAncestors.has(commit)),
      ),
    ),
  ];
  const provenanceCandidates = provenanceExclusive.filter((commit) => {
    const record = graph.get(commit);
    return record.parents.length === 1 && record.committer.timestamp <= targetTimestamp;
  });
  const externalRevertLineage = [
    ...new Set(
      sourceCommits.flatMap((commit) => {
        const target = revertedCommit(graph.get(commit).body);
        return target ? revertLineage(graph, target) : [];
      }),
    ),
  ];
  const shippedExclusiveByRef = shipped.map((entry) => ({
    ...entry,
    commits: [...ancestorsOf(graph, entry.commit)].filter((commit) => !sourceAncestors.has(commit)),
    mergeBase: rawMergeBase(graph, entry.commit, sourceTarget),
  }));
  const associationCommits = [
    ...new Set([
      ...sourceCommits,
      ...sourceOrigins,
      ...provenanceCandidates,
      ...externalRevertLineage,
      ...shippedExclusiveByRef.flatMap((entry) => entry.commits),
      ...tailCommits,
      ...trustedAdaptedPullRequestProvenance.map((entry) => entry.originCommit),
      ...trustedIntegratedPullRequestProvenance.flatMap((entry) =>
        entry.sources.map((source) => source.commit),
      ),
      ...trustedPartialPullRequestProvenance.map((entry) => entry.sourceCommit),
      ...(comparisonUniverse ? [mergeBase] : []),
    ]),
  ].toSorted();
  const associationEvidence = normalizeAssociations(
    resolveAssociations(associationCommits, graph.get(sourceTarget).committer.timestamp),
    associationCommits,
  );
  const associations = associationEvidence.pullRequests;
  const allAssociations = associationEvidence.allPullRequests;

  let sourceTail;
  if (tailCommits.length > 0) {
    const commits = tailCommits.map((commit, index) => {
      const record = graph.get(commit);
      const parent = index === 0 ? sourceTarget : tailCommits[index - 1];
      const paths = changedPaths(cwd, parent, commit);
      const explicit = explicitPullRequestReferences(record.subject, record.body);
      const origins = [...cherryPickOrigins(record.body), ...adaptationOrigins(record.body)];
      if (
        record.parents.length !== 1 ||
        record.parents[0] !== parent ||
        paths.length !== 1 ||
        paths[0] !== "CHANGELOG.md" ||
        allAssociations.get(commit).length > 0 ||
        explicit.length > 0 ||
        origins.length > 0 ||
        localReferencesIn(record.message).length > 0
      ) {
        fail(
          `final target ${finalTarget} must be a linear association-free, reference-free CHANGELOG.md-only tail from ${sourceTarget}`,
        );
      }
      return {
        commit,
        diffSha256: commitPatch(cwd, graph, commit)?.diffSha256,
        parent,
        paths,
        subject: record.subject,
        tree: record.tree,
      };
    });
    sourceTail = {
      commits,
      count: commits.length,
      maxCommits: maxSourceTailCommits,
      sha256: createHash("sha256")
        .update(`${JSON.stringify(commits)}\n`)
        .digest("hex"),
    };
  }

  const sourceRecords = sourceCommits.map((commit, topoIndex) => {
    const record = graph.get(commit);
    return {
      ...record,
      adaptationOrigins: adaptationOrigins(record.body),
      associatedPullRequests: associations.get(commit),
      cherryPickOrigins: cherryPickOrigins(record.body),
      explicitPullRequestReferences: explicitPullRequestReferences(record.subject, record.body),
      nonEquivalentCherryPickOrigins: [],
      references: localReferencesIn(record.message),
      revertedExternalPullRequests: [],
      revertedExternalReferences: [],
      topoIndex,
      verifiedCherryPickOrigins: [],
    };
  });
  const explicitNumbers = [
    ...new Set([
      ...sourceRecords.flatMap((record) => record.explicitPullRequestReferences),
      ...trustedAdaptedPullRequestProvenance.map((entry) => entry.number),
      ...trustedIntegratedPullRequestProvenance.map((entry) => entry.number),
      ...trustedPartialPullRequestProvenance.map((entry) => entry.number),
      ...trustedPullRequestProvenance.map((entry) => entry.number),
    ]),
  ].toSorted((left, right) => left - right);
  if (explicitNumbers.length > 0 && typeof resolvePullRequests !== "function") {
    fail("release source inventory requires a pull request evidence resolver");
  }
  const explicitPullRequests =
    explicitNumbers.length === 0
      ? new Map()
      : normalizePullRequestEvidence(resolvePullRequests(explicitNumbers), explicitNumbers);
  const patchCache = new Map();
  const patchFor = (commit) => {
    if (!patchCache.has(commit)) {
      patchCache.set(commit, commitPatch(cwd, graph, commit));
    }
    return patchCache.get(commit);
  };
  const trustedPullRequestEvidence = new Map();
  const trustedPullRequestDetails = new Map();
  for (const provenanceEntry of trustedPullRequestProvenance) {
    const node = explicitPullRequests.get(provenanceEntry.number);
    const mergedAt =
      node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
        ? Date.parse(node.mergedAt)
        : Number.NaN;
    if (
      node?.__typename !== "PullRequest" ||
      !Number.isFinite(mergedAt) ||
      mergedAt > targetTimestamp
    ) {
      fail(
        `trusted provenance #${provenanceEntry.number}:${provenanceEntry.commit} is not a merged pull request by the source target cutoff`,
      );
    }
    const matchingPullRequestCommits = provenancePullRequestCommits
      .get(provenanceEntry.number)
      .filter((commit) => exactPatchEquivalent(cwd, graph, provenanceEntry.commit, commit));
    if (matchingPullRequestCommits.length !== 1) {
      fail(
        `trusted provenance #${provenanceEntry.number}:${provenanceEntry.commit} must match exactly one pull request commit`,
      );
    }
    const matches = sourceRecords.filter(
      (record) =>
        record.cherryPickOrigins.includes(provenanceEntry.commit) &&
        exactPatchEquivalent(cwd, graph, record.commit, provenanceEntry.commit),
    );
    if (matches.length !== 1) {
      fail(
        `trusted provenance #${provenanceEntry.number}:${provenanceEntry.commit} must have exactly one exact trailer-linked source commit`,
      );
    }
    const pullRequestCommit = matchingPullRequestCommits[0];
    const pullRequestPatch = patchFor(pullRequestCommit);
    const trailerPatch = patchFor(provenanceEntry.commit);
    for (const record of matches) {
      if (trustedPullRequestDetails.has(record.commit)) {
        fail(`source commit ${record.commit} has conflicting trusted pull request provenance`);
      }
      const evidence = trustedPullRequestEvidence.get(record.commit) ?? [];
      evidence.push({
        method: "trusted-pr-provenance",
        number: provenanceEntry.number,
        pullRequestCommit,
        sourceCommit: provenanceEntry.commit,
      });
      trustedPullRequestEvidence.set(record.commit, evidence);
      const targetPatch = patchFor(record.commit);
      trustedPullRequestDetails.set(record.commit, {
        method: "trusted-pr-provenance",
        number: provenanceEntry.number,
        patchId: trailerPatch?.patchId,
        paths: changedPaths(cwd, record.parents[0], record.commit),
        pullRequestCommit,
        pullRequestCommitDiffSha256: pullRequestPatch?.diffSha256,
        targetCommit: record.commit,
        targetDiffSha256: targetPatch?.diffSha256,
        trailerOrigin: provenanceEntry.commit,
        trailerOriginDiffSha256: trailerPatch?.diffSha256,
      });
    }
  }
  const trustedAdaptedPullRequestEvidence = new Map();
  const trustedAdaptedPullRequestDetails = new Map();
  for (const provenanceEntry of trustedAdaptedPullRequestProvenance) {
    const node = explicitPullRequests.get(provenanceEntry.number);
    const mergedAt =
      node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
        ? Date.parse(node.mergedAt)
        : Number.NaN;
    if (
      node?.__typename !== "PullRequest" ||
      !Number.isFinite(mergedAt) ||
      mergedAt > targetTimestamp
    ) {
      fail(
        `trusted adapted provenance #${provenanceEntry.number}:${provenanceEntry.originCommit}:${provenanceEntry.targetCommit} is not a merged pull request by the source target cutoff`,
      );
    }
    const matchingPullRequestCommits = provenancePullRequestCommits
      .get(provenanceEntry.number)
      .filter((commit) => exactPatchEquivalent(cwd, graph, provenanceEntry.originCommit, commit));
    if (matchingPullRequestCommits.length !== 1) {
      fail(
        `trusted adapted provenance #${provenanceEntry.number}:${provenanceEntry.originCommit}:${provenanceEntry.targetCommit} must match exactly one pull request commit`,
      );
    }
    const originRecord = graph.get(provenanceEntry.originCommit);
    const targetRecord = sourceRecords.find(
      (record) => record.commit === provenanceEntry.targetCommit,
    );
    const originPatch = patchFor(provenanceEntry.originCommit);
    const targetPatch = patchFor(provenanceEntry.targetCommit);
    const matchingTargetPullRequestCommits = provenancePullRequestCommits
      .get(provenanceEntry.number)
      .filter((commit) => exactPatchEquivalent(cwd, graph, provenanceEntry.targetCommit, commit));
    if (
      originRecord?.parents.length !== 1 ||
      !targetRecord ||
      targetRecord.parents.length !== 1 ||
      targetRecord.cherryPickOrigins.length !== 1 ||
      targetRecord.cherryPickOrigins[0] !== provenanceEntry.originCommit ||
      targetRecord.adaptationOrigins.length > 0 ||
      matchingTargetPullRequestCommits.length > 0 ||
      !originPatch?.patchId ||
      !targetPatch?.patchId ||
      originPatch.patchId === targetPatch.patchId ||
      exactPatchEquivalent(cwd, graph, provenanceEntry.targetCommit, provenanceEntry.originCommit)
    ) {
      fail(
        `trusted adapted provenance #${provenanceEntry.number}:${provenanceEntry.originCommit}:${provenanceEntry.targetCommit} is not a canonical non-equivalent cherry-pick adaptation`,
      );
    }
    const originPaths = changedPaths(cwd, originRecord.parents[0], provenanceEntry.originCommit);
    const targetPaths = changedPaths(cwd, targetRecord.parents[0], provenanceEntry.targetCommit);
    if (
      originPaths.length === 0 ||
      targetPaths.length === 0 ||
      JSON.stringify(originPaths) !== JSON.stringify(targetPaths)
    ) {
      fail(
        `trusted adapted provenance #${provenanceEntry.number}:${provenanceEntry.originCommit}:${provenanceEntry.targetCommit} must change exactly the same non-empty paths`,
      );
    }
    const pullRequestCommit = matchingPullRequestCommits[0];
    const pullRequestRecord = graph.get(pullRequestCommit);
    const pullRequestPatch = patchFor(pullRequestCommit);
    trustedAdaptedPullRequestEvidence.set(provenanceEntry.targetCommit, [
      {
        method: "trusted-pr-adapted-backport",
        number: provenanceEntry.number,
        pullRequestCommit,
        sourceCommit: provenanceEntry.originCommit,
      },
    ]);
    trustedAdaptedPullRequestDetails.set(provenanceEntry.targetCommit, {
      method: "trusted-pr-adapted-backport",
      number: provenanceEntry.number,
      originCommit: provenanceEntry.originCommit,
      originAuthor: originRecord.author,
      originDiffSha256: originPatch?.diffSha256,
      originPatchId: originPatch?.patchId,
      paths: originPaths,
      pullRequestCommit,
      pullRequestCommitAuthor: pullRequestRecord.author,
      pullRequestCommitDiffSha256: pullRequestPatch?.diffSha256,
      targetCommit: provenanceEntry.targetCommit,
      targetCommitAuthor: targetRecord.author,
      targetDiffSha256: targetPatch?.diffSha256,
      targetPatchId: targetPatch?.patchId,
    });
  }
  const trustedIntegratedPullRequestEvidence = new Map();
  const trustedIntegratedPullRequestDetails = new Map();
  for (const provenanceEntry of trustedIntegratedPullRequestProvenance) {
    const label = `trusted integrated provenance #${provenanceEntry.number}:${provenanceEntry.targetCommit}`;
    if (trustedPullRequestDetails.has(provenanceEntry.targetCommit)) {
      fail(`${label} conflicts with exact pull request provenance`);
    }
    const node = explicitPullRequests.get(provenanceEntry.number);
    const mergedAt =
      node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
        ? Date.parse(node.mergedAt)
        : Number.NaN;
    const metadata = integratedPullRequestMetadata.get(provenanceEntry.number);
    const metadataMergedAt = Date.parse(metadata?.mergedAt);
    const pullRequestCommits = provenancePullRequestCommits.get(provenanceEntry.number);
    if (
      node?.__typename !== "PullRequest" ||
      !Number.isFinite(mergedAt) ||
      mergedAt > targetTimestamp ||
      !metadata ||
      metadataMergedAt !== mergedAt ||
      !pullRequestCommits.includes(metadata.headCommit)
    ) {
      fail(`${label} is not an immutable merged pull request by the source target cutoff`);
    }
    if (provenanceEntry.sources.some((source) => !pullRequestCommits.includes(source.commit))) {
      fail(`${label} contains a source commit that is not an exact pull request member`);
    }
    const targetRecord = sourceRecords.find(
      (record) => record.commit === provenanceEntry.targetCommit,
    );
    const primarySourceCommit = targetRecord?.cherryPickOrigins[0];
    const primarySource = provenanceEntry.sources.find(
      (source) => source.commit === primarySourceCommit,
    );
    const integrationSources = provenanceEntry.sources.filter(
      (source) => source.commit !== primarySourceCommit,
    );
    const primaryRecord = graph.get(primarySourceCommit);
    const targetPatch = patchFor(provenanceEntry.targetCommit);
    const primaryPatch = patchFor(primarySourceCommit);
    const primaryParentCommit = primaryRecord?.parents[0];
    const targetParentCommit = targetRecord?.parents[0];
    const targetParentRecord = graph.get(targetParentCommit);
    const targetParentOrigins = targetParentRecord
      ? cherryPickOrigins(targetParentRecord.body)
      : [];
    const matchingTargetPullRequestCommits = pullRequestCommits.filter((commit) =>
      exactPatchEquivalent(cwd, graph, provenanceEntry.targetCommit, commit),
    );
    if (
      !targetRecord ||
      targetRecord.parents.length !== 1 ||
      targetRecord.cherryPickOrigins.length !== 1 ||
      targetRecord.adaptationOrigins.length > 0 ||
      !primarySource ||
      primarySourceCommit !== metadata.headCommit ||
      metadata.baseBranch !== "main" ||
      primaryRecord?.parents.length !== 1 ||
      !pullRequestCommits.includes(primaryParentCommit) ||
      integrationSources.length === 0 ||
      matchingTargetPullRequestCommits.length > 0 ||
      !primaryPatch?.patchId ||
      !targetPatch?.patchId ||
      primaryPatch.patchId === targetPatch.patchId ||
      exactPatchEquivalent(cwd, graph, provenanceEntry.targetCommit, primarySourceCommit) ||
      targetParentRecord?.parents.length !== 1 ||
      targetParentOrigins.length !== 1 ||
      targetParentOrigins[0] !== primaryParentCommit ||
      !exactPatchEquivalent(cwd, graph, primaryParentCommit, targetParentCommit)
    ) {
      fail(`${label} is not a canonical adapted multi-source pull request backport`);
    }
    const primaryAncestors = ancestorsOf(graph, primarySourceCommit);
    if (
      integrationSources.some(
        (source) =>
          graph.get(source.commit)?.parents.length !== 1 ||
          source.commit === primarySourceCommit ||
          !primaryAncestors.has(source.commit),
      )
    ) {
      fail(`${label} integration sources must be strict one-parent ancestors of the PR head`);
    }
    const primaryPaths = changedPaths(cwd, primaryRecord.parents[0], primarySourceCommit);
    const targetPaths = changedPaths(cwd, targetRecord.parents[0], provenanceEntry.targetCommit);
    if (
      primaryPaths.length === 0 ||
      targetPaths.length <= primaryPaths.length ||
      !primaryPaths.every((path) => targetPaths.includes(path))
    ) {
      fail(`${label} must add paths to the complete non-empty PR-head path set`);
    }
    const primaryExactPathEvidence = [];
    const primaryAdaptedPathEvidence = [];
    for (const path of primaryPaths) {
      const exactEvidence = exactPathPatchEvidence(
        cwd,
        graph,
        primarySourceCommit,
        provenanceEntry.targetCommit,
        path,
      );
      if (exactEvidence) {
        primaryExactPathEvidence.push(exactEvidence);
        continue;
      }
      const sourcePathPatch = commitPathPatch(cwd, graph, primarySourceCommit, path);
      const targetPathPatch = commitPathPatch(cwd, graph, provenanceEntry.targetCommit, path);
      if (
        !sourcePathPatch?.patchId ||
        !targetPathPatch?.patchId ||
        sourcePathPatch.patchId === targetPathPatch.patchId
      ) {
        fail(`${label} does not contain a reviewable PR-head adaptation for ${path}`);
      }
      primaryAdaptedPathEvidence.push({
        path,
        sourceCommit: primarySourceCommit,
        sourceDiffSha256: sourcePathPatch.diffSha256,
        sourceParent: sourcePathPatch.parent,
        sourcePatchId: sourcePathPatch.patchId,
        targetDiffSha256: targetPathPatch.diffSha256,
        targetParent: targetPathPatch.parent,
        targetPatchId: targetPathPatch.patchId,
      });
    }
    if (primaryExactPathEvidence.length === 0 || primaryAdaptedPathEvidence.length === 0) {
      fail(`${label} must preserve exact PR-head paths and adapt at least one PR-head path`);
    }
    const primaryPathSet = new Set(primaryPaths);
    const integrationPaths = targetPaths.filter((path) => !primaryPathSet.has(path));
    const integrationPathEvidence = integrationPaths.map((path) => {
      const matches = integrationSources
        .map((source) =>
          exactPathPatchEvidence(cwd, graph, source.commit, provenanceEntry.targetCommit, path),
        )
        .filter(Boolean);
      if (matches.length !== 1) {
        fail(`${label} must map integration path ${path} to exactly one explicit PR member`);
      }
      const [match] = matches;
      const sourcePathStateSha256 = pathStateSha256(cwd, match.sourceCommit, path);
      const primaryParentPathStateSha256 = pathStateSha256(cwd, primaryParentCommit, path);
      if (sourcePathStateSha256 !== primaryParentPathStateSha256) {
        fail(`${label} integration path ${path} did not survive unchanged into the PR head parent`);
      }
      return {
        ...match,
        primaryParentCommit,
        primaryParentPathStateSha256,
        sourcePathStateSha256,
      };
    });
    const integrationSourceDetails = integrationSources.map((source) => {
      const sourceRecord = graph.get(source.commit);
      const sourcePaths = changedPaths(cwd, sourceRecord.parents[0], source.commit);
      const contributionEvidence = integrationPathEvidence.filter(
        (entry) => entry.sourceCommit === source.commit,
      );
      if (contributionEvidence.length === 0) {
        fail(`${label} contains an explicit PR member with no exact integration path`);
      }
      const contributionPaths = contributionEvidence.map((entry) => entry.path).toSorted();
      const sourcePatch = patchFor(source.commit);
      return {
        author: sourceRecord.author,
        commit: source.commit,
        contributionPaths: setSummary(contributionPaths),
        diffSha256: sourcePatch?.diffSha256,
        omittedPaths: setSummary(sourcePaths.filter((path) => !contributionPaths.includes(path))),
        patchId: sourcePatch?.patchId,
        paths: setSummary(sourcePaths),
        ref: source.ref,
      };
    });
    trustedIntegratedPullRequestEvidence.set(provenanceEntry.targetCommit, [
      {
        integrationSourceCommits: integrationSources.map((source) => source.commit).toSorted(),
        method: "trusted-pr-adapted-integration-backport",
        number: provenanceEntry.number,
        sourceCommit: primarySourceCommit,
      },
    ]);
    trustedIntegratedPullRequestDetails.set(provenanceEntry.targetCommit, {
      coverageEquation: `${targetPaths.length} target paths = ${primaryPaths.length} PR-head paths + ${integrationPaths.length} exact integration paths`,
      integrationPathEvidence,
      integrationSources: integrationSourceDetails,
      method: "trusted-pr-adapted-integration-backport",
      number: provenanceEntry.number,
      originCommit: primarySourceCommit,
      pathPartitions: {
        adaptedPrimary: setSummary(primaryAdaptedPathEvidence.map((entry) => entry.path)),
        exactIntegration: setSummary(integrationPaths),
        exactPrimary: setSummary(primaryExactPathEvidence.map((entry) => entry.path)),
      },
      parentAlignment: {
        primaryParentCommit,
        primaryParentDiffSha256: patchFor(primaryParentCommit)?.diffSha256,
        primaryParentPatchId: patchFor(primaryParentCommit)?.patchId,
        targetParentCommit,
        targetParentDiffSha256: patchFor(targetParentCommit)?.diffSha256,
        targetParentPatchId: patchFor(targetParentCommit)?.patchId,
      },
      primaryAdaptedPathEvidence,
      primaryExactPathEvidence,
      primarySource: {
        author: primaryRecord.author,
        commit: primarySourceCommit,
        diffSha256: primaryPatch.diffSha256,
        patchId: primaryPatch.patchId,
        paths: setSummary(primaryPaths),
        ref: primarySource.ref,
      },
      pullRequest: metadata,
      pullRequestCommits: setSummary(pullRequestCommits),
      targetCommit: provenanceEntry.targetCommit,
      targetCommitAuthor: targetRecord.author,
      targetDiffSha256: targetPatch.diffSha256,
      targetPatchId: targetPatch.patchId,
      targetPaths: setSummary(targetPaths),
    });
  }
  const trustedPartialPullRequestEvidence = new Map();
  const trustedPartialPullRequestDetails = new Map();
  for (const provenanceEntry of trustedPartialPullRequestProvenance) {
    const node = explicitPullRequests.get(provenanceEntry.number);
    const mergedAt =
      node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
        ? Date.parse(node.mergedAt)
        : Number.NaN;
    if (
      node?.__typename !== "PullRequest" ||
      !Number.isFinite(mergedAt) ||
      mergedAt > targetTimestamp
    ) {
      fail(
        `trusted partial provenance #${provenanceEntry.number}:${provenanceEntry.sourceCommit}:${provenanceEntry.targetCommit} is not a merged pull request by the source target cutoff`,
      );
    }
    if (
      !provenancePullRequestCommits
        .get(provenanceEntry.number)
        .includes(provenanceEntry.sourceCommit)
    ) {
      fail(
        `trusted partial source commit ${provenanceEntry.sourceCommit} does not belong to pull request #${provenanceEntry.number}`,
      );
    }
    if (!associations.get(provenanceEntry.sourceCommit)?.includes(provenanceEntry.number)) {
      fail(
        `trusted partial source commit ${provenanceEntry.sourceCommit} is not associated with pull request #${provenanceEntry.number}`,
      );
    }
    const sourceRecord = graph.get(provenanceEntry.sourceCommit);
    const targetRecord = sourceRecords.find(
      (record) => record.commit === provenanceEntry.targetCommit,
    );
    if (
      sourceRecord?.parents.length !== 1 ||
      !targetRecord ||
      targetRecord.parents.length !== 1 ||
      targetRecord.adaptationOrigins.length !== 1 ||
      targetRecord.adaptationOrigins[0] !== provenanceEntry.sourceCommit ||
      targetRecord.cherryPickOrigins.length !== 0 ||
      !targetRecord.references.includes(provenanceEntry.number) ||
      exactPatchEquivalent(cwd, graph, provenanceEntry.targetCommit, provenanceEntry.sourceCommit)
    ) {
      fail(
        `trusted partial provenance #${provenanceEntry.number}:${provenanceEntry.sourceCommit}:${provenanceEntry.targetCommit} is not a canonical non-equivalent partial backport`,
      );
    }
    const sourcePaths = changedPaths(cwd, sourceRecord.parents[0], provenanceEntry.sourceCommit);
    const targetPaths = changedPaths(cwd, targetRecord.parents[0], provenanceEntry.targetCommit);
    if (
      targetPaths.length === 0 ||
      targetPaths.length >= sourcePaths.length ||
      !targetPaths.every((path) => sourcePaths.includes(path))
    ) {
      fail(
        `trusted partial provenance #${provenanceEntry.number}:${provenanceEntry.sourceCommit}:${provenanceEntry.targetCommit} does not change a strict non-empty subset of source paths`,
      );
    }
    const pathEvidence = targetPaths.map((path) => {
      const sourcePatch = commitPathPatch(cwd, graph, provenanceEntry.sourceCommit, path);
      const targetPatch = commitPathPatch(cwd, graph, provenanceEntry.targetCommit, path);
      if (
        !sourcePatch?.patchId ||
        !targetPatch?.patchId ||
        sourcePatch.patchId !== targetPatch.patchId ||
        !patchProducesPathState(
          cwd,
          sourcePatch.patch,
          targetPatch.parent,
          provenanceEntry.targetCommit,
          path,
        ) ||
        !patchProducesPathState(
          cwd,
          targetPatch.patch,
          sourcePatch.parent,
          provenanceEntry.sourceCommit,
          path,
        )
      ) {
        fail(
          `trusted partial provenance #${provenanceEntry.number}:${provenanceEntry.sourceCommit}:${provenanceEntry.targetCommit} does not preserve the exact path patch for ${path}`,
        );
      }
      return {
        path,
        patchId: sourcePatch.patchId,
        sourceDiffSha256: sourcePatch.diffSha256,
        targetDiffSha256: targetPatch.diffSha256,
      };
    });
    trustedPartialPullRequestEvidence.set(provenanceEntry.targetCommit, [
      {
        method: "trusted-pr-partial-backport",
        number: provenanceEntry.number,
        sourceCommit: provenanceEntry.sourceCommit,
      },
    ]);
    trustedPartialPullRequestDetails.set(provenanceEntry.targetCommit, {
      method: "trusted-pr-partial-backport",
      number: provenanceEntry.number,
      omittedPaths: sourcePaths.filter((path) => !targetPaths.includes(path)),
      pathEvidence,
      sourceCommit: provenanceEntry.sourceCommit,
      sourceDiffSha256: patchFor(provenanceEntry.sourceCommit)?.diffSha256,
      sourcePaths,
      targetCommit: provenanceEntry.targetCommit,
      targetDiffSha256: patchFor(provenanceEntry.targetCommit)?.diffSha256,
      targetPaths,
    });
  }
  const unresolved = [];
  const revertEdges = [];
  const sourceCommitSet = new Set(sourceCommits);
  const externalRevertStates = new Map();

  function externalRevertState(commit, seen = new Set()) {
    if (externalRevertStates.has(commit)) {
      return externalRevertStates.get(commit);
    }
    if (seen.has(commit)) {
      return { reason: `cyclic external revert lineage at ${commit}` };
    }
    const record = graph.get(commit);
    if (!record) {
      return { reason: `external revert target ${commit} is unavailable` };
    }
    const target = revertedCommit(record.body);
    if (!target) {
      if (record.subject.startsWith('Revert "')) {
        return {
          reason: `external revert ${commit} is missing a canonical full-SHA trailer`,
        };
      }
      const state = {
        depth: 0,
        pullRequests: associations.get(commit) ?? [],
        references: localReferencesIn(record.message),
        rootCommit: commit,
      };
      externalRevertStates.set(commit, state);
      return state;
    }
    const targetRecord = graph.get(target);
    if (
      record.parents.length !== 1 ||
      !targetRecord ||
      targetRecord.parents.length !== 1 ||
      !ancestorsOf(graph, record.parents[0]).has(target) ||
      !exactPatchEquivalent(cwd, graph, target, commit, { inverse: true })
    ) {
      return {
        reason: `external revert ${commit} does not exactly invert ancestor ${target}`,
      };
    }
    const targetState = externalRevertState(target, new Set([...seen, commit]));
    if (targetState.reason) {
      return targetState;
    }
    const state = { ...targetState, depth: targetState.depth + 1 };
    externalRevertStates.set(commit, state);
    return state;
  }

  for (const record of sourceRecords) {
    const target = revertedCommit(record.body);
    if (!target) {
      if (record.subject.startsWith('Revert "')) {
        unresolved.push({
          commit: record.commit,
          kind: "revert",
          reason: "revert subject is missing a canonical full-SHA trailer",
        });
      }
      continue;
    }
    const targetRecord = graph.get(target);
    const parent = record.parents[0];
    if (
      record.parents.length !== 1 ||
      !targetRecord ||
      targetRecord.parents.length !== 1 ||
      !ancestorsOf(graph, parent).has(target) ||
      !exactPatchEquivalent(cwd, graph, target, record.commit, { inverse: true })
    ) {
      unresolved.push({
        commit: record.commit,
        kind: "revert",
        reason: `revert does not exactly invert ancestor ${target}`,
      });
      continue;
    }
    revertEdges.push({ revertCommit: record.commit, targetCommit: target });
    if (!sourceCommitSet.has(target)) {
      const state = externalRevertState(target);
      if (state.reason) {
        unresolved.push({
          commit: record.commit,
          kind: "revert",
          reason: state.reason,
        });
      } else if (state.depth % 2 === 0) {
        record.revertedExternalPullRequests = state.pullRequests;
        record.revertedExternalReferences = state.references;
      }
    }
  }
  const active = activeCommitsAfterReverts(sourceCommits, revertEdges);
  for (const targetCommit of trustedPullRequestDetails.keys()) {
    if (!active.has(targetCommit)) {
      fail(`trusted provenance target commit ${targetCommit} is not active in the source range`);
    }
  }
  for (const provenanceEntry of trustedAdaptedPullRequestProvenance) {
    if (!active.has(provenanceEntry.targetCommit)) {
      fail(
        `trusted adapted target commit ${provenanceEntry.targetCommit} is not active in the source range`,
      );
    }
  }
  for (const provenanceEntry of trustedIntegratedPullRequestProvenance) {
    if (!active.has(provenanceEntry.targetCommit)) {
      fail(
        `trusted integrated target commit ${provenanceEntry.targetCommit} is not active in the source range`,
      );
    }
  }
  for (const provenanceEntry of trustedPartialPullRequestProvenance) {
    if (!active.has(provenanceEntry.targetCommit)) {
      fail(
        `trusted partial target commit ${provenanceEntry.targetCommit} is not active in the source range`,
      );
    }
  }

  const associatedProvenanceCandidates = provenanceCandidates.filter(
    (commit) => associations.get(commit).length > 0,
  );
  const provenanceByPatch = new Map();
  for (const commit of associatedProvenanceCandidates) {
    const patch = patchFor(commit);
    if (!patch?.patchId) {
      continue;
    }
    const values = provenanceByPatch.get(patch.patchId) ?? [];
    values.push(commit);
    provenanceByPatch.set(patch.patchId, values);
  }

  const ownership = new Map();
  for (const record of sourceRecords) {
    const evidence = [
      ...(trustedAdaptedPullRequestEvidence.get(record.commit) ?? []),
      ...(trustedIntegratedPullRequestEvidence.get(record.commit) ?? []),
      ...(trustedPartialPullRequestEvidence.get(record.commit) ?? []),
      ...(trustedPullRequestEvidence.get(record.commit) ?? []),
    ];
    for (const number of record.associatedPullRequests) {
      evidence.push({ method: "association", number, sourceCommit: record.commit });
    }
    for (const number of record.explicitPullRequestReferences) {
      const node = explicitPullRequests.get(number);
      const mergedAt =
        node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
          ? Date.parse(node.mergedAt)
          : Number.NaN;
      const associatedByCutoff = record.associatedPullRequests.includes(number);
      const required = requiredPullRequestReferences(record.subject, record.body).has(number);
      if (!associatedByCutoff && node?.__typename === "Issue" && !required) {
        continue;
      }
      if (
        !associatedByCutoff &&
        (node?.__typename !== "PullRequest" ||
          !Number.isFinite(mergedAt) ||
          mergedAt > targetTimestamp)
      ) {
        unresolved.push({
          commit: record.commit,
          kind: "ownership",
          pullRequests: [number],
          reason: `strict ownership reference #${number} is not a merged pull request by the source target cutoff`,
        });
        continue;
      }
      evidence.push({ method: "explicit-reference", number, sourceCommit: record.commit });
    }
    for (const origin of record.cherryPickOrigins) {
      const originRecord = graph.get(origin);
      if (!originRecord || !exactPatchEquivalent(cwd, graph, record.commit, origin)) {
        record.nonEquivalentCherryPickOrigins.push(origin);
        continue;
      }
      record.verifiedCherryPickOrigins.push(origin);
      for (const number of associations.get(origin) ?? []) {
        evidence.push({ method: "cherry-origin-association", number, sourceCommit: origin });
      }
    }
    const patch = patchFor(record.commit);
    const trustedCandidates = (provenanceByPatch.get(patch?.patchId) ?? []).filter((candidate) =>
      exactPatchEquivalent(cwd, graph, record.commit, candidate),
    );
    for (const candidate of trustedCandidates) {
      for (const number of associations.get(candidate) ?? []) {
        evidence.push({
          method: "trusted-patch-association",
          number,
          sourceCommit: candidate,
        });
      }
    }
    const pullRequests = [...new Set(evidence.map((entry) => entry.number))].toSorted(
      (left, right) => left - right,
    );
    const nonEquivalentOriginPullRequests = [
      ...new Set(
        record.nonEquivalentCherryPickOrigins.flatMap((origin) => associations.get(origin) ?? []),
      ),
    ].toSorted((left, right) => left - right);
    const adaptedDetails =
      trustedAdaptedPullRequestDetails.get(record.commit) ??
      trustedIntegratedPullRequestDetails.get(record.commit);
    if (
      record.nonEquivalentCherryPickOrigins.length > 0 &&
      (!adaptedDetails ||
        record.nonEquivalentCherryPickOrigins.length !== 1 ||
        record.nonEquivalentCherryPickOrigins[0] !== adaptedDetails.originCommit)
    ) {
      unresolved.push({
        commit: record.commit,
        kind: "ownership",
        pullRequests: [...new Set([...pullRequests, ...nonEquivalentOriginPullRequests])].toSorted(
          (left, right) => left - right,
        ),
        reason: "non-equivalent cherry-pick provenance requires reviewed adaptation ownership",
      });
      continue;
    }
    if (pullRequests.length > 1) {
      unresolved.push({
        commit: record.commit,
        kind: "ownership",
        pullRequests,
        reason: "ownership evidence resolves to more than one pull request",
      });
      continue;
    }
    ownership.set(record.commit, {
      evidence: evidence.filter((entry) => entry.number === pullRequests[0]),
      pullRequests,
    });
  }

  const shippedMatches = new Map();
  const addShippedMatch = (commit, evidence) => {
    const values = shippedMatches.get(commit) ?? [];
    if (!values.some((value) => value.ref === evidence.ref)) {
      values.push(evidence);
      shippedMatches.set(commit, values);
    }
  };
  for (const baseline of shippedExclusiveByRef) {
    const baselineEdges = [];
    for (const commit of baseline.commits) {
      const record = graph.get(commit);
      const target = revertedCommit(record.body);
      if (!target) {
        if (record.subject.startsWith('Revert "')) {
          fail(
            `shipped baseline ${baseline.ref} revert ${commit} is missing a canonical full-SHA trailer`,
          );
        }
        continue;
      }
      if (!baseline.commits.includes(target)) {
        continue;
      }
      const targetRecord = graph.get(target);
      const parent = record.parents[0];
      if (
        record.parents.length !== 1 ||
        !targetRecord ||
        targetRecord.parents.length !== 1 ||
        !ancestorsOf(graph, parent).has(target) ||
        !exactPatchEquivalent(cwd, graph, target, commit, { inverse: true })
      ) {
        fail(`shipped baseline ${baseline.ref} revert ${commit} does not exactly invert ${target}`);
      }
      baselineEdges.push({ revertCommit: commit, targetCommit: target });
    }
    const activeBaselineCommits = activeCommitsAfterReverts(baseline.commits, baselineEdges);
    const byPatch = new Map();
    for (const commit of activeBaselineCommits) {
      const patch = patchFor(commit);
      if (!patch?.patchId) {
        continue;
      }
      const values = byPatch.get(patch.patchId) ?? [];
      values.push(commit);
      byPatch.set(patch.patchId, values);
    }
    for (const record of sourceRecords) {
      if (!active.has(record.commit) || record.parents.length !== 1) {
        continue;
      }
      const patch = patchFor(record.commit);
      const matches = (byPatch.get(patch?.patchId) ?? []).filter((candidate) =>
        exactPatchEquivalent(cwd, graph, record.commit, candidate),
      );
      if (matches.length > 0) {
        addShippedMatch(record.commit, {
          commits: matches.toSorted(),
          method: "baseline-commit-patch",
          ref: baseline.ref,
        });
        continue;
      }
      if (!patch) {
        continue;
      }
      const candidate = {
        ...patch,
        commit: record.commit,
        paths: changedPaths(cwd, patch.parent, record.commit),
        tree: record.tree,
      };
      const treeProof = candidatePatchTreeProof(cwd, graph, baseline.commit, candidate);
      if (treeProof) {
        addShippedMatch(record.commit, {
          commits: [baseline.commit],
          method: "baseline-final-tree",
          ref: baseline.ref,
          treeProof,
        });
      }
    }
    let run = [];
    const flushRun = () => {
      if (run.length < 2) {
        run = [];
        return;
      }
      const first = run[0];
      const last = run.at(-1);
      const patch = commitRangePatch(cwd, first.parents[0], last.commit);
      if (patch) {
        const candidate = {
          ...patch,
          commit: last.commit,
          paths: changedPaths(cwd, patch.parent, last.commit),
          tree: last.tree,
        };
        const treeProof = candidatePatchTreeProof(cwd, graph, baseline.commit, candidate);
        if (treeProof) {
          const sourceMatches = run.map((record) => record.commit);
          for (const record of run) {
            addShippedMatch(record.commit, {
              commits: [baseline.commit],
              method: "baseline-final-tree-pull-request-aggregate",
              ref: baseline.ref,
              sourceCommits: sourceMatches,
              treeProof,
            });
          }
        }
      }
      run = [];
    };
    for (const record of sourceRecords) {
      const owner = ownership.get(record.commit);
      const number = owner?.pullRequests.length === 1 ? owner.pullRequests[0] : undefined;
      const previous = run.at(-1);
      const previousOwner = previous ? ownership.get(previous.commit) : undefined;
      const previousNumber =
        previousOwner?.pullRequests.length === 1 ? previousOwner.pullRequests[0] : undefined;
      if (
        !active.has(record.commit) ||
        record.parents.length !== 1 ||
        number === undefined ||
        (previous &&
          (record.parents[0] !== previous.commit ||
            previousNumber === undefined ||
            number !== previousNumber))
      ) {
        flushRun();
      }
      if (active.has(record.commit) && record.parents.length === 1 && number !== undefined) {
        run.push(record);
      }
    }
    flushRun();
  }

  const commits = [];
  for (const record of sourceRecords) {
    const owner = ownership.get(record.commit) ?? { evidence: [], pullRequests: [] };
    let disposition;
    let mergeResolution;
    if (unresolved.some((entry) => entry.commit === record.commit)) {
      disposition = "unresolved";
    } else if (!active.has(record.commit)) {
      disposition = "reverted";
    } else if (shippedMatches.has(record.commit)) {
      disposition = "shipped";
    } else if (owner.pullRequests.length === 1) {
      disposition = "pull-request";
    } else if (record.parents.length > 1) {
      mergeResolution = mergeResolutionDigest(cwd, record.commit);
      if (record.parents.length === 2 && !mergeResolution) {
        disposition = "structural-merge";
      } else {
        disposition = "unresolved";
        unresolved.push({
          commit: record.commit,
          kind: "merge-resolution",
          reason:
            record.parents.length > 2
              ? "octopus merge requires reviewed provenance"
              : "merge resolution content has no singular ownership",
        });
      }
    } else {
      disposition = "direct";
    }
    const patch = record.parents.length === 1 ? patchFor(record.commit) : undefined;
    commits.push({
      adaptationOrigins: record.adaptationOrigins,
      associatedPullRequests: record.associatedPullRequests,
      authorEmail: record.author.email,
      authorName: record.author.name,
      body: record.body,
      cherryPickOrigins: record.cherryPickOrigins,
      commit: record.commit,
      diffSha256: patch?.diffSha256,
      disposition,
      evidence: owner.evidence,
      explicitPullRequestReferences: owner.evidence
        .filter((entry) => entry.method === "explicit-reference")
        .map((entry) => entry.number),
      mergeResolutionDiffSha256: mergeResolution,
      nonEquivalentCherryPickOrigins: record.nonEquivalentCherryPickOrigins,
      parents: record.parents,
      patchId: patch?.patchId,
      pullRequests: owner.pullRequests,
      references: record.references,
      revertedExternalPullRequests: record.revertedExternalPullRequests,
      revertedExternalReferences: record.revertedExternalReferences,
      shippedEvidence: shippedMatches.get(record.commit) ?? [],
      subject: record.subject,
      topoIndex: record.topoIndex,
      tree: record.tree,
      trustedAdaptedPullRequest: trustedAdaptedPullRequestDetails.get(record.commit),
      ...(trustedIntegratedPullRequestDetails.has(record.commit)
        ? {
            trustedIntegratedPullRequest: trustedIntegratedPullRequestDetails.get(record.commit),
          }
        : {}),
      trustedPartialPullRequest: trustedPartialPullRequestDetails.get(record.commit),
      trustedPullRequest: trustedPullRequestDetails.get(record.commit),
      verifiedCherryPickOrigins: record.verifiedCherryPickOrigins,
    });
  }

  const includedPullRequests = commits
    .filter((commit) => commit.disposition === "pull-request")
    .flatMap((commit) => commit.pullRequests);
  const shippedPullRequests = commits
    .filter((commit) => commit.disposition === "shipped")
    .flatMap((commit) => commit.pullRequests);
  const revertedPullRequests = commits
    .filter((commit) => commit.disposition === "reverted")
    .flatMap((commit) => commit.pullRequests);
  const directCommits = commits
    .filter((commit) => commit.disposition === "direct")
    .map((commit) => commit.commit);
  const manifestDirectCommits = commits
    .filter(
      (commit) =>
        (commit.disposition === "direct" || commit.disposition === "pull-request") &&
        commit.parents.length === 1 &&
        commit.associatedPullRequests.length === 0,
    )
    .map((commit) => commit.commit);
  const directOwnershipOverlap = commits
    .filter(
      (commit) =>
        commit.disposition === "pull-request" &&
        commit.parents.length === 1 &&
        commit.associatedPullRequests.length === 0,
    )
    .map((commit) => commit.commit);
  const structuralMerges = commits
    .filter((commit) => commit.disposition === "structural-merge")
    .map((commit) => commit.commit);
  const shippedCommits = commits
    .filter((commit) => commit.disposition === "shipped")
    .map((commit) => commit.commit);
  const revertedCommits = commits
    .filter((commit) => commit.disposition === "reverted")
    .map((commit) => commit.commit);
  const unresolvedCommits = commits
    .filter((commit) => commit.disposition === "unresolved")
    .map((commit) => commit.commit);
  const partitions = {
    commits: {
      direct: setSummary(directCommits),
      directOwnershipOverlap: setSummary(directOwnershipOverlap),
      exclusiveDirect: setSummary(directCommits),
      manifestDirect: setSummary(manifestDirectCommits),
      pullRequest: setSummary(
        commits
          .filter((commit) => commit.disposition === "pull-request")
          .map((commit) => commit.commit),
      ),
      reverted: setSummary(revertedCommits),
      shipped: setSummary(shippedCommits),
      structuralMerge: setSummary(structuralMerges),
      unresolved: setSummary(unresolvedCommits),
      universe: setSummary(sourceCommits),
    },
    pullRequests: {
      included: setSummary(includedPullRequests, (left, right) => left - right),
      reverted: setSummary(revertedPullRequests, (left, right) => left - right),
      shipped: setSummary(shippedPullRequests, (left, right) => left - right),
    },
    directReconciliation: {
      equation: `${manifestDirectCommits.length} manifest-direct - ${directOwnershipOverlap.length} PR-owned overlap = ${directCommits.length} exclusive-direct`,
    },
  };
  if (
    partitions.commits.manifestDirect.count - partitions.commits.directOwnershipOverlap.count !==
    partitions.commits.exclusiveDirect.count
  ) {
    fail("release source inventory direct commit reconciliation is inconsistent");
  }
  const covered =
    partitions.commits.direct.count +
    partitions.commits.pullRequest.count +
    partitions.commits.reverted.count +
    partitions.commits.shipped.count +
    partitions.commits.structuralMerge.count +
    partitions.commits.unresolved.count;
  if (covered !== partitions.commits.universe.count) {
    fail(
      `release source inventory partition covers ${covered} of ${partitions.commits.universe.count} commits`,
    );
  }
  let comparison;
  if (comparisonUniverse) {
    const canonical = new Set(partitions.pullRequests.included.members);
    const searchUniverse = new Set(comparisonUniverse.pullRequests);
    const searchMetadata = new Map(
      comparisonUniverse.records.map((record) => [record.number, record]),
    );
    const canonicalOnly = [...canonical]
      .filter((number) => !searchUniverse.has(number))
      .toSorted((left, right) => left - right);
    if (canonicalOnly.length > 0 && typeof resolvePullRequestMetadata !== "function") {
      fail("release source inventory requires a pull request metadata resolver");
    }
    const supplementalMetadata =
      canonicalOnly.length === 0
        ? new Map()
        : normalizePullRequestMetadata(resolvePullRequestMetadata(canonicalOnly), canonicalOnly);
    const targetAssociatedOutsideSearch = canonicalOnly.map((number) => {
      const metadata = supplementalMetadata.get(number);
      const mergedAt = Date.parse(metadata.mergedAt);
      const targetCommits = commits
        .filter((commit) => commit.pullRequests.includes(number))
        .map((commit) => commit.commit)
        .toSorted();
      const mergeCommitInTarget = sourceAncestors.has(metadata.mergeCommit);
      let omissionReason;
      if (metadata.baseBranch !== comparisonUniverse.baseBranch) {
        omissionReason = "base-outside-search";
      } else if (mergedAt < comparisonUniverse.window.startTimestamp) {
        omissionReason = "merged-before-search-window";
      } else if (
        metadata.baseBranch === comparisonUniverse.baseBranch &&
        mergedAt > comparisonUniverse.window.endTimestamp &&
        mergedAt <= comparisonUniverse.window.endTimestamp + 1_000 &&
        mergeCommitInTarget
      ) {
        omissionReason = "merged-after-search-cutoff";
      }
      if (!omissionReason || targetCommits.length === 0) {
        fail(`canonical pull request #${number} is absent from the exact comparison search`);
      }
      return {
        ...metadata,
        mergeCommitInTarget,
        omissionReason,
        targetCommits,
      };
    });
    const universe = new Set([...searchUniverse, ...canonicalOnly]);
    const overlap = [...universe].filter((number) => canonical.has(number));
    const comparisonOnly = new Set([...universe].filter((number) => !canonical.has(number)));
    const remaining = new Set(comparisonOnly);
    const take = (members) => {
      const values = [];
      for (const number of members) {
        if (remaining.delete(number)) {
          values.push(number);
        }
      }
      return values.toSorted((left, right) => left - right);
    };
    const netReverted = take(partitions.pullRequests.reverted.members);
    const shipped = take(partitions.pullRequests.shipped.members);
    const associatedBoundary = take(allAssociations.get(mergeBase) ?? []);
    const sameSecondAncestralBoundary = take(
      [...remaining].filter((number) => {
        const metadata = searchMetadata.get(number);
        const mergedAt = Date.parse(metadata?.mergedAt);
        return (
          Number.isFinite(mergedAt) &&
          mergedAt >= comparisonUniverse.window.startTimestamp &&
          mergedAt < comparisonUniverse.window.startTimestamp + 1_000 &&
          boundaryAncestors.has(metadata.mergeCommit)
        );
      }),
    );
    const boundary = [...associatedBoundary, ...sameSecondAncestralBoundary].toSorted(
      (left, right) => left - right,
    );
    const postForkNotBackported = [...remaining].toSorted((left, right) => left - right);
    if (postForkNotBackported.length > 0 && typeof resolvePullRequestCommits !== "function") {
      fail("release source inventory requires a pull request commit resolver");
    }
    const postForkCommitLists =
      postForkNotBackported.length === 0
        ? new Map()
        : normalizePullRequestCommits(
            resolvePullRequestCommits(postForkNotBackported),
            postForkNotBackported,
          );
    const postForkMetadataCommits = postForkNotBackported.flatMap((number) => {
      const metadata = searchMetadata.get(number);
      if (!metadata) {
        fail(`comparison-only pull request #${number} has no exact search metadata`);
      }
      return [metadata.baseCommit, metadata.headCommit, metadata.mergeCommit];
    });
    const postForkCandidateCommits = [
      ...new Set([...postForkMetadataCommits, ...[...postForkCommitLists.values()].flat()]),
    ].toSorted();
    extendGraphWithCommitsAndParents(cwd, graph, postForkCandidateCommits);
    const comparisonPatches = new Map();
    const patchMatchesByPullRequest = new Map();
    const addPatchMatch = (number, match) => {
      const matches = patchMatchesByPullRequest.get(number) ?? [];
      matches.push(match);
      patchMatchesByPullRequest.set(number, matches);
    };
    const addComparisonPatch = (candidate) => {
      if (!candidate.patchId) {
        return;
      }
      const candidates = comparisonPatches.get(candidate.patchId) ?? [];
      candidates.push(candidate);
      comparisonPatches.set(candidate.patchId, candidates);
    };
    for (const number of postForkNotBackported) {
      const metadata = searchMetadata.get(number);
      const pullRequestCommits = postForkCommitLists.get(number);
      if (!pullRequestCommits.includes(metadata.headCommit)) {
        fail(`comparison-only pull request #${number} commit list omits its exact head`);
      }
      for (const candidateCommit of [...new Set([metadata.mergeCommit, ...pullRequestCommits])]) {
        const patch = commitFirstParentPatch(cwd, graph, candidateCommit);
        const record = graph.get(candidateCommit);
        if (!patch || !record) {
          continue;
        }
        const candidate = {
          ...patch,
          commit: candidateCommit,
          kind: candidateCommit === metadata.mergeCommit ? "merge" : "pull-request",
          number,
          paths: changedPaths(cwd, patch.parent, candidateCommit),
          tree: record.tree,
        };
        addComparisonPatch(candidate);
        const treeProof =
          candidatePatchTreeProof(cwd, graph, sourceTarget, candidate) ??
          candidatePatchAmbiguityProof(cwd, graph, sourceTarget, candidate);
        if (treeProof) {
          addPatchMatch(number, {
            candidateKind: `${candidate.kind}-final-tree`,
            ...treeProof,
          });
        }
      }
      // GitHub retains the base/head OIDs associated with a merged PR even
      // after its refs are deleted. Resolve those snapshots, never moving main.
      const aggregateBaseCommit = uniqueMergeBase(
        cwd,
        metadata.baseCommit,
        metadata.headCommit,
        `comparison-only pull request #${number}`,
      );
      const aggregatePatch = commitRangePatch(cwd, aggregateBaseCommit, metadata.headCommit);
      const headRecord = graph.get(metadata.headCommit);
      if (aggregatePatch && headRecord) {
        const aggregateCandidate = {
          ...aggregatePatch,
          commit: metadata.headCommit,
          kind: "pull-request-aggregate",
          number,
          paths: changedPaths(cwd, aggregateBaseCommit, metadata.headCommit),
          tree: headRecord.tree,
        };
        addComparisonPatch(aggregateCandidate);
        const treeProof =
          candidatePatchTreeProof(cwd, graph, sourceTarget, aggregateCandidate) ??
          candidatePatchAmbiguityProof(cwd, graph, sourceTarget, aggregateCandidate);
        if (treeProof) {
          addPatchMatch(number, {
            candidateKind: "pull-request-aggregate-final-tree",
            ...treeProof,
          });
        }
      }
    }
    for (const commit of commits.filter(
      (entry) =>
        entry.parents.length === 1 &&
        (entry.disposition === "direct" || entry.disposition === "pull-request"),
    )) {
      for (const candidate of comparisonPatches.get(commit.patchId) ?? []) {
        if (exactCandidatePatchEquivalent(cwd, graph, commit.commit, candidate)) {
          addPatchMatch(candidate.number, {
            candidateBaseCommit: candidate.parent,
            candidateCommit: candidate.commit,
            candidateKind: candidate.kind,
            targetCommit: commit.commit,
          });
        }
      }
    }
    const postForkEvidence = postForkNotBackported.map((number) => {
      const metadata = searchMetadata.get(number);
      const pullRequestCommits = postForkCommitLists.get(number);
      const pullRequestCommitSet = new Set(pullRequestCommits);
      const canonicalCommits = commits
        .filter(
          (commit) =>
            commit.pullRequests.includes(number) ||
            commit.associatedPullRequests.includes(number) ||
            commit.evidence.some((entry) => entry.number === number) ||
            commit.explicitPullRequestReferences.includes(number),
        )
        .map((commit) => commit.commit)
        .toSorted();
      const contextualReferences = commits
        .filter(
          (commit) =>
            commit.references.includes(number) &&
            !commit.explicitPullRequestReferences.includes(number),
        )
        .map((commit) => commit.commit)
        .toSorted();
      const cherryPickCommits = commits
        .filter((commit) =>
          [...commit.cherryPickOrigins, ...commit.adaptationOrigins].some((origin) =>
            pullRequestCommitSet.has(origin),
          ),
        )
        .map((commit) => commit.commit)
        .toSorted();
      const ancestralCommits = [metadata.mergeCommit, metadata.headCommit, ...pullRequestCommits]
        .filter((commit) => sourceAncestors.has(commit))
        .toSorted();
      const patchEquivalentCommits = (patchMatchesByPullRequest.get(number) ?? []).toSorted(
        (left, right) =>
          left.targetCommit.localeCompare(right.targetCommit) ||
          left.candidateCommit.localeCompare(right.candidateCommit),
      );
      if (
        canonicalCommits.length > 0 ||
        cherryPickCommits.length > 0 ||
        ancestralCommits.length > 0 ||
        patchEquivalentCommits.length > 0
      ) {
        fail(`comparison-only pull request #${number} has target provenance`);
      }
      return {
        ancestralCommits,
        baseBranch: metadata.baseBranch,
        baseCommit: metadata.baseCommit,
        canonicalCommits,
        cherryPickCommits,
        contextualReferences,
        headCommit: metadata.headCommit,
        mergeCommit: metadata.mergeCommit,
        mergedAt: metadata.mergedAt,
        patchEquivalentCommits,
        pullRequest: number,
        pullRequestCommits,
      };
    });
    const associatedBoundarySet = new Set(associatedBoundary);
    const boundaryEvidence = boundary.map((number) => {
      const metadata = searchMetadata.get(number);
      return associatedBoundarySet.has(number)
        ? {
            mergeCommit: mergeBase,
            method: "merge-base-association",
            pullRequest: number,
          }
        : {
            mergeBase,
            mergeCommit: metadata.mergeCommit,
            mergedAt: metadata.mergedAt,
            method: "same-second-ancestral-merge",
            pullRequest: number,
            windowStartTimestamp: comparisonUniverse.window.startTimestamp,
          };
    });
    const shippedEvidence = shipped.map((number) => {
      const targetCommits = commits
        .filter(
          (commit) => commit.disposition === "shipped" && commit.pullRequests.includes(number),
        )
        .map((commit) => ({
          commit: commit.commit,
          shippedEvidence: commit.shippedEvidence,
        }))
        .toSorted((left, right) => left.commit.localeCompare(right.commit));
      if (targetCommits.length === 0) {
        fail(`shipped comparison pull request #${number} has no exact target evidence`);
      }
      return { pullRequest: number, targetCommits };
    });
    const netRevertedEvidence = netReverted.map((number) => {
      const targetCommits = commits
        .filter(
          (commit) => commit.disposition === "reverted" && commit.pullRequests.includes(number),
        )
        .map((commit) => commit.commit)
        .toSorted();
      const targetSet = new Set(targetCommits);
      const edges = revertEdges
        .filter((edge) => targetSet.has(edge.targetCommit) && active.has(edge.revertCommit))
        .toSorted(
          (left, right) =>
            left.targetCommit.localeCompare(right.targetCommit) ||
            left.revertCommit.localeCompare(right.revertCommit),
        );
      if (
        targetCommits.length === 0 ||
        !targetCommits.every((commit) => edges.some((edge) => edge.targetCommit === commit))
      ) {
        fail(`net-reverted comparison pull request #${number} lacks exact revert evidence`);
      }
      return { pullRequest: number, revertEdges: edges, targetCommits };
    });
    const partitionsByName = {
      netReverted: setSummary(netReverted, (left, right) => left - right),
      postForkNotBackported: setSummary(postForkNotBackported, (left, right) => left - right),
      shippedOrBoundary: setSummary([...boundary, ...shipped], (left, right) => left - right),
    };
    const memberships = new Map();
    for (const [name, partition] of Object.entries({
      canonical: [...canonical],
      netReverted,
      postForkNotBackported,
      shippedOrBoundary: [...boundary, ...shipped],
    })) {
      for (const number of partition) {
        const names = memberships.get(number) ?? [];
        names.push(name);
        memberships.set(number, names);
      }
    }
    const missing = [...universe]
      .filter((number) => !memberships.has(number))
      .toSorted((left, right) => left - right);
    const overlaps = [...memberships]
      .filter(([, names]) => names.length > 1)
      .map(([number, names]) => ({ names: names.toSorted(), number }))
      .toSorted((left, right) => left.number - right.number);
    const unexpected = [...memberships.keys()]
      .filter((number) => !universe.has(number))
      .toSorted((left, right) => left - right);
    if (missing.length > 0 || overlaps.length > 0 || unexpected.length > 0) {
      fail("merged pull request comparison partitions are not disjoint and exhaustive");
    }
    const excludedCount = Object.values(partitionsByName).reduce(
      (total, entry) => total + entry.count,
      0,
    );
    if (excludedCount !== comparisonOnly.size) {
      fail(
        `merged pull request comparison partition covers ${excludedCount} of ${comparisonOnly.size} exclusions`,
      );
    }
    comparison = {
      baseBranch: comparisonUniverse.baseBranch,
      canonical: setSummary(canonical, (left, right) => left - right),
      canonicalOnly: setSummary(canonicalOnly, (left, right) => left - right),
      comparisonOnly: setSummary(comparisonOnly, (left, right) => left - right),
      equation: `${universe.size} - ${partitionsByName.postForkNotBackported.count} post-fork PRs not backported - ${partitionsByName.shippedOrBoundary.count} shipped/boundary PRs - ${partitionsByName.netReverted.count} net-reverted PRs = ${canonical.size}`,
      overlap: setSummary(overlap, (left, right) => left - right),
      partitionAudit: {
        excludedCount,
        missing,
        overlaps,
        universeCoveredCount: memberships.size,
        unexpected,
      },
      partitionEvidence: {
        boundary: recordSummary(boundaryEvidence),
        netReverted: recordSummary(netRevertedEvidence),
        postFork: recordSummary(postForkEvidence),
        shipped: recordSummary(shippedEvidence),
      },
      partitions: partitionsByName,
      query: comparisonUniverse.query,
      repository: comparisonUniverse.repository,
      searchRecordsSha256: comparisonUniverse.recordsSha256,
      searchUniverse: setSummary(searchUniverse, (left, right) => left - right),
      segments: comparisonUniverse.segments,
      targetAssociatedOutsideSearch: recordSummary(targetAssociatedOutsideSearch),
      unclassified: setSummary([], (left, right) => left - right),
      universe: setSummary(universe, (left, right) => left - right),
      window: comparisonUniverse.window,
    };
  }
  const inventory = {
    comparison,
    complete: unresolved.length === 0,
    commits,
    partitions,
    range: {
      base: { commit: base, ref: baseRef },
      finalTarget,
      finalTargetTimestamp,
      mergeBase,
      mergeBaseTimestamp: graph.get(mergeBase).committer.timestamp,
      provenance,
      provenanceAdaptedPullRequests: trustedAdaptedPullRequestProvenance.map((entry) => ({
        details: trustedAdaptedPullRequestDetails.get(entry.targetCommit),
        number: entry.number,
        originCommit: entry.originCommit,
        originRef: entry.originRef,
        targetCommit: entry.targetCommit,
        targetRef: entry.targetRef,
      })),
      ...(trustedIntegratedPullRequestProvenance.length > 0
        ? {
            provenanceIntegratedPullRequests: trustedIntegratedPullRequestProvenance.map(
              (entry) => ({
                details: trustedIntegratedPullRequestDetails.get(entry.targetCommit),
                number: entry.number,
                sources: entry.sources,
                targetCommit: entry.targetCommit,
                targetRef: entry.targetRef,
              }),
            ),
          }
        : {}),
      provenancePartialPullRequests: trustedPartialPullRequestProvenance.map((entry) => ({
        details: trustedPartialPullRequestDetails.get(entry.targetCommit),
        number: entry.number,
        sourceCommit: entry.sourceCommit,
        sourceRef: entry.sourceRef,
        targetCommit: entry.targetCommit,
        targetRef: entry.targetRef,
      })),
      provenancePullRequests: trustedPullRequestProvenance.map((entry) => ({
        commit: entry.commit,
        details: sourceRecords
          .map((record) => trustedPullRequestDetails.get(record.commit))
          .filter((details) => details?.number === entry.number),
        matchedCommits: sourceRecords
          .filter((record) =>
            (trustedPullRequestEvidence.get(record.commit) ?? []).some(
              (evidence) =>
                evidence.number === entry.number && evidence.sourceCommit === entry.commit,
            ),
          )
          .map((record) => record.commit),
        number: entry.number,
        ref: entry.ref,
      })),
      shipped: shippedExclusiveByRef.map(({ commit, mergeBase: baselineMergeBase, ref }) => ({
        commit,
        mergeBase: baselineMergeBase,
        ref,
      })),
      sourceTarget,
      sourceTail,
      targetTimestamp,
    },
    repository,
    schemaVersion: 3,
    unresolved: unresolved.toSorted(
      (left, right) =>
        left.commit.localeCompare(right.commit) || left.kind.localeCompare(right.kind),
    ),
  };
  return { ...inventory, sha256: digestInventory(inventory) };
}

export function assertCompleteReleaseSourceInventory(inventory) {
  if (!inventory?.complete || inventory.unresolved?.length > 0) {
    const reasons = (inventory?.unresolved ?? [])
      .map((entry) => `${entry.commit}: ${entry.reason}`)
      .join("\n");
    fail(`release source inventory is incomplete${reasons ? `:\n${reasons}` : ""}`);
  }
  return inventory;
}
