import { createHash } from "node:crypto";

const UTC_SECOND_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})Z$/;
const objectIdPattern = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(message);
}

function utcSecond(value, label) {
  if (typeof value !== "string" || !UTC_SECOND_PATTERN.test(value)) {
    fail(`${label} must be an exact UTC second`);
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().replace(".000Z", "Z") !== value
  ) {
    fail(`${label} must be an exact UTC second`);
  }
  return timestamp;
}

export function isoSecond(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp % 1000 !== 0) {
    fail("team-universe timestamp must be an exact UTC second");
  }
  return new Date(timestamp).toISOString().replace(".000Z", "Z");
}

function validateRepository(repository) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail("GitHub repository must be an owner/name pair");
  }
}

function validateBase(base) {
  if (typeof base !== "string" || !/^[A-Za-z0-9._/-]+$/.test(base)) {
    fail("GitHub base branch is invalid");
  }
}

export function teamUniverseWindowQuery({ repository, base = "main", start, end }) {
  validateRepository(repository);
  validateBase(base);
  const startTimestamp = utcSecond(start, "team-universe window start");
  const endTimestamp = utcSecond(end, "team-universe window end");
  if (startTimestamp > endTimestamp) {
    fail("team-universe window start must not be after its end");
  }
  return `repo:${repository} is:pr is:merged base:${base} merged:${start}..${end}`;
}

export function parseTeamUniverseWindowQuery(query, { repository, base = "main" }) {
  validateRepository(repository);
  validateBase(base);
  const prefix = `repo:${repository} is:pr is:merged base:${base} merged:`;
  if (typeof query !== "string" || !query.startsWith(prefix)) {
    fail(`invalid canonical team-universe query: ${query}`);
  }
  const window = query.slice(prefix.length);
  const separator = window.indexOf("..");
  if (separator < 0 || separator !== window.lastIndexOf("..")) {
    fail(`invalid canonical team-universe query: ${query}`);
  }
  const start = window.slice(0, separator);
  const end = window.slice(separator + 2);
  if (teamUniverseWindowQuery({ repository, base, start, end }) !== query) {
    fail(`invalid canonical team-universe query: ${query}`);
  }
  return { end, start };
}

export function summarizeTeamUniverseMembers(values) {
  const members = [...new Set(values)].toSorted((left, right) => left - right);
  return {
    count: members.length,
    members,
    sha256: createHash("sha256")
      .update(members.map((number) => `${number}\n`).join(""))
      .digest("hex"),
  };
}

function canonicalRecord(record) {
  return {
    baseBranch: record.baseBranch,
    baseCommit: record.baseCommit,
    headCommit: record.headCommit,
    mergeCommit: record.mergeCommit,
    mergedAt: record.mergedAt,
    number: record.number,
  };
}

export function summarizeTeamUniverseRecords(values) {
  const records = values.map(canonicalRecord).toSorted((left, right) => left.number - right.number);
  return {
    count: records.length,
    records,
    sha256: createHash("sha256")
      .update(records.map((record) => `${JSON.stringify(record)}\n`).join(""))
      .digest("hex"),
  };
}

function validateSearchPage(page, query, expectedIssueCount) {
  if (
    !page ||
    !Number.isInteger(page.issueCount) ||
    page.issueCount < 0 ||
    !Array.isArray(page.nodes) ||
    typeof page.pageInfo?.hasNextPage !== "boolean"
  ) {
    fail(`GitHub search returned incomplete team-universe data for ${query}`);
  }
  if (expectedIssueCount !== undefined && page.issueCount !== expectedIssueCount) {
    fail(`GitHub search issue count changed during pagination for ${query}`);
  }
  if (
    page.pageInfo.hasNextPage &&
    (typeof page.pageInfo.endCursor !== "string" || page.pageInfo.endCursor.length === 0)
  ) {
    fail(`GitHub search pagination was incomplete for ${query}`);
  }
}

function normalizePullRequestNode(node, { base, endTimestamp, query, startTimestamp }) {
  const mergedAt = Date.parse(node?.mergedAt);
  if (
    !Number.isInteger(node?.number) ||
    node.number <= 0 ||
    node.baseRefName !== base ||
    !Number.isFinite(mergedAt) ||
    mergedAt < startTimestamp ||
    mergedAt > endTimestamp ||
    typeof node.baseRefOid !== "string" ||
    !objectIdPattern.test(node.baseRefOid) ||
    typeof node.headRefOid !== "string" ||
    !objectIdPattern.test(node.headRefOid) ||
    typeof node.mergeCommit?.oid !== "string" ||
    !objectIdPattern.test(node.mergeCommit.oid)
  ) {
    fail(`GitHub search returned an invalid team-universe PR for ${query}`);
  }
  return canonicalRecord({
    baseBranch: node.baseRefName,
    baseCommit: node.baseRefOid,
    headCommit: node.headRefOid,
    mergeCommit: node.mergeCommit.oid,
    mergedAt: new Date(mergedAt).toISOString(),
    number: node.number,
  });
}

function sameRecord(left, right) {
  return JSON.stringify(canonicalRecord(left)) === JSON.stringify(canonicalRecord(right));
}

export function createTeamUniverseResolver({
  repository,
  base = "main",
  fetchPage,
  searchLimit = 1000,
}) {
  validateRepository(repository);
  validateBase(base);
  if (typeof fetchPage !== "function" || !Number.isInteger(searchLimit) || searchLimit < 1) {
    fail("team-universe resolver options are invalid");
  }

  function resolveWindow(start, end) {
    const query = teamUniverseWindowQuery({ repository, base, start, end });
    const firstPage = fetchPage(query, undefined);
    validateSearchPage(firstPage, query);
    if (firstPage.issueCount > searchLimit) {
      const startTimestamp = utcSecond(start, "team-universe window start");
      const endTimestamp = utcSecond(end, "team-universe window end");
      const midpoint = Math.floor((startTimestamp + endTimestamp) / 2000) * 1000;
      if (midpoint <= startTimestamp || midpoint >= endTimestamp) {
        fail(`GitHub team-universe search window could not be subdivided: ${query}`);
      }

      // GitHub search ranges are inclusive, so adjacent windows share their
      // exact boundary second and the combined evidence must deduplicate it.
      const left = resolveWindow(start, isoSecond(midpoint));
      const right = resolveWindow(isoSecond(midpoint), end);
      const byNumber = new Map();
      for (const record of [...left.records, ...right.records]) {
        const existing = byNumber.get(record.number);
        if (existing && !sameRecord(existing, record)) {
          fail(`GitHub search returned conflicting team-universe metadata for #${record.number}`);
        }
        byNumber.set(record.number, record);
      }
      const records = [...byNumber.values()].toSorted((a, b) => a.number - b.number);
      if (records.length !== firstPage.issueCount) {
        fail(`GitHub search count did not match split team-universe members for ${query}`);
      }
      return {
        count: firstPage.issueCount,
        records,
        segments: [...left.segments, ...right.segments],
      };
    }

    const startTimestamp = utcSecond(start, "team-universe window start");
    const endTimestamp = utcSecond(end, "team-universe window end");
    const records = [];
    const seenCursors = new Set();
    const seenNumbers = new Set();
    let page = firstPage;
    while (true) {
      validateSearchPage(page, query, firstPage.issueCount);
      for (const node of page.nodes) {
        const record = normalizePullRequestNode(node, {
          base,
          endTimestamp,
          query,
          startTimestamp,
        });
        if (seenNumbers.has(record.number)) {
          fail(
            `GitHub search returned a duplicate team-universe PR #${record.number} for ${query}`,
          );
        }
        seenNumbers.add(record.number);
        records.push(record);
      }
      if (!page.pageInfo.hasNextPage) {
        break;
      }
      const cursor = page.pageInfo.endCursor;
      if (seenCursors.has(cursor)) {
        fail(`GitHub search pagination repeated cursor ${cursor} for ${query}`);
      }
      seenCursors.add(cursor);
      page = fetchPage(query, cursor);
    }

    records.sort((left, right) => left.number - right.number);
    if (records.length !== firstPage.issueCount) {
      fail(`GitHub search count did not match complete team-universe members for ${query}`);
    }
    const members = summarizeTeamUniverseMembers(records.map((record) => record.number));
    const recordSummary = summarizeTeamUniverseRecords(records);
    return {
      count: firstPage.issueCount,
      records,
      segments: [
        {
          count: members.count,
          pullRequests: members.members,
          query,
          recordsSha256: recordSummary.sha256,
          sha256: members.sha256,
          window: { endTimestamp, startTimestamp },
        },
      ],
    };
  }

  return function resolveTeamUniversePullRequests(query) {
    const { start, end } = parseTeamUniverseWindowQuery(query, { repository, base });
    const result = resolveWindow(start, end);
    const members = summarizeTeamUniverseMembers(result.records.map((record) => record.number));
    const recordSummary = summarizeTeamUniverseRecords(result.records);
    if (members.count !== result.count || recordSummary.count !== result.count) {
      fail(`GitHub search count did not match complete team-universe evidence for ${query}`);
    }
    return {
      baseBranch: base,
      count: result.count,
      pullRequests: members.members,
      query,
      records: recordSummary.records,
      recordsSha256: recordSummary.sha256,
      repository,
      segments: result.segments,
      sha256: members.sha256,
      window: {
        endTimestamp: utcSecond(end, "team-universe window end"),
        startTimestamp: utcSecond(start, "team-universe window start"),
      },
    };
  };
}
