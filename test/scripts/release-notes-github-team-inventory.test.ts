import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createTeamUniverseResolver,
  summarizeTeamUniverseMembers,
  summarizeTeamUniverseRecords,
  teamUniverseWindowQuery,
} from "../../.agents/skills/openclaw-changelog-update/scripts/lib/github-team-inventory.mjs";

function node(number: number, mergedAt: string) {
  const suffix = number.toString(16).padStart(40, "0");
  return {
    baseRefName: "main",
    baseRefOid: createHash("sha1").update(`base:${number}`).digest("hex"),
    headRefOid: suffix,
    mergeCommit: { oid: createHash("sha1").update(`merge:${number}`).digest("hex") },
    mergedAt,
    number,
  };
}

describe("GitHub merged-main team inventory", () => {
  it("paginates exact records and hashes sorted newline-delimited members", () => {
    const first = node(2, "2026-07-01T00:00:02Z");
    const second = node(1, "2026-07-01T00:00:01Z");
    const fetchPage = (_query: string, cursor?: string) =>
      cursor
        ? {
            issueCount: 2,
            nodes: [second],
            pageInfo: { endCursor: null, hasNextPage: false },
          }
        : {
            issueCount: 2,
            nodes: [first],
            pageInfo: { endCursor: "next", hasNextPage: true },
          };
    const query = teamUniverseWindowQuery({
      repository: "openclaw/openclaw",
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T00:00:03Z",
    });
    const result = createTeamUniverseResolver({
      repository: "openclaw/openclaw",
      fetchPage,
    })(query);

    expect(result.pullRequests).toEqual([1, 2]);
    expect(result.sha256).toBe(createHash("sha256").update("1\n2\n").digest("hex"));
    expect(result.records).toEqual(
      summarizeTeamUniverseRecords(
        [second, first].map((entry) => ({
          baseBranch: entry.baseRefName,
          baseCommit: entry.baseRefOid,
          headCommit: entry.headRefOid,
          mergeCommit: entry.mergeCommit.oid,
          mergedAt: new Date(entry.mergedAt).toISOString(),
          number: entry.number,
        })),
      ).records,
    );
  });

  it("records merged PR snapshot OIDs instead of moving ref targets", () => {
    const snapshot = node(42, "2026-07-01T00:00:01Z");
    const movingBase = "f".repeat(40);
    const movingHead = "e".repeat(40);
    const query = teamUniverseWindowQuery({
      repository: "openclaw/openclaw",
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T00:00:02Z",
    });
    const result = createTeamUniverseResolver({
      repository: "openclaw/openclaw",
      fetchPage: () => ({
        issueCount: 1,
        nodes: [
          {
            ...snapshot,
            baseRef: { target: { oid: movingBase } },
            headRef: { target: { oid: movingHead } },
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      }),
    })(query);

    expect(result.records).toEqual([
      {
        baseBranch: "main",
        baseCommit: snapshot.baseRefOid,
        headCommit: snapshot.headRefOid,
        mergeCommit: snapshot.mergeCommit.oid,
        mergedAt: "2026-07-01T00:00:01.000Z",
        number: 42,
      },
    ]);
    expect(result.records[0].baseCommit).not.toBe(movingBase);
    expect(result.records[0].headCommit).not.toBe(movingHead);
  });

  it("splits an over-limit inclusive window and deduplicates only identical boundary records", () => {
    const boundary = node(2, "2026-07-01T00:00:02Z");
    const left = node(1, "2026-07-01T00:00:01Z");
    const right = node(3, "2026-07-01T00:00:03Z");
    const fetchPage = (query: string) => {
      if (query.endsWith("2026-07-01T00:00:00Z..2026-07-01T00:00:04Z")) {
        return {
          issueCount: 3,
          nodes: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (query.endsWith("2026-07-01T00:00:00Z..2026-07-01T00:00:02Z")) {
        return {
          issueCount: 2,
          nodes: [left, boundary],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      return {
        issueCount: 2,
        nodes: [boundary, right],
        pageInfo: { endCursor: null, hasNextPage: false },
      };
    };
    const query = teamUniverseWindowQuery({
      repository: "openclaw/openclaw",
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T00:00:04Z",
    });
    const result = createTeamUniverseResolver({
      repository: "openclaw/openclaw",
      fetchPage,
      searchLimit: 2,
    })(query);

    expect(result.pullRequests).toEqual([1, 2, 3]);
    expect(result.segments).toHaveLength(2);
    expect(summarizeTeamUniverseMembers(result.pullRequests)).toMatchObject({
      count: 3,
      sha256: result.sha256,
    });
  });

  it("fails closed on duplicate pagination members and malformed canonical queries", () => {
    const duplicate = node(1, "2026-07-01T00:00:01Z");
    const query = teamUniverseWindowQuery({
      repository: "openclaw/openclaw",
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T00:00:02Z",
    });
    const resolver = createTeamUniverseResolver({
      repository: "openclaw/openclaw",
      fetchPage: (_value, cursor) =>
        cursor
          ? {
              issueCount: 2,
              nodes: [duplicate],
              pageInfo: { endCursor: null, hasNextPage: false },
            }
          : {
              issueCount: 2,
              nodes: [duplicate],
              pageInfo: { endCursor: "next", hasNextPage: true },
            },
    });

    expect(() => resolver(query)).toThrow("duplicate team-universe PR #1");
    expect(() => resolver(query.replace("base:main", "base:release/2026.7.1"))).toThrow(
      "invalid canonical team-universe query",
    );
  });

  it("fails closed when pagination counts drift or cursors repeat", () => {
    const first = node(1, "2026-07-01T00:00:01Z");
    const second = node(2, "2026-07-01T00:00:02Z");
    const query = teamUniverseWindowQuery({
      repository: "openclaw/openclaw",
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T00:00:03Z",
    });
    const drift = createTeamUniverseResolver({
      repository: "openclaw/openclaw",
      fetchPage: (_value, cursor) =>
        cursor
          ? {
              issueCount: 3,
              nodes: [second],
              pageInfo: { endCursor: null, hasNextPage: false },
            }
          : {
              issueCount: 2,
              nodes: [first],
              pageInfo: { endCursor: "next", hasNextPage: true },
            },
    });
    expect(() => drift(query)).toThrow("issue count changed during pagination");

    let page = 0;
    const repeated = createTeamUniverseResolver({
      repository: "openclaw/openclaw",
      fetchPage: () => {
        page += 1;
        return {
          issueCount: 3,
          nodes: [page === 1 ? first : second],
          pageInfo: { endCursor: "next", hasNextPage: true },
        };
      },
    });
    expect(() => repeated(query)).toThrow("pagination repeated cursor next");
  });

  it("fails closed on conflicting inclusive-boundary metadata and unsplittable windows", () => {
    const boundary = node(2, "2026-07-01T00:00:02Z");
    const conflictingBoundary = {
      ...boundary,
      headRefOid: "f".repeat(40),
    };
    const query = teamUniverseWindowQuery({
      repository: "openclaw/openclaw",
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T00:00:04Z",
    });
    const conflict = createTeamUniverseResolver({
      repository: "openclaw/openclaw",
      searchLimit: 2,
      fetchPage: (value) => {
        if (value === query) {
          return {
            issueCount: 3,
            nodes: [],
            pageInfo: { endCursor: null, hasNextPage: false },
          };
        }
        return {
          issueCount: 1,
          nodes: [
            value.endsWith("2026-07-01T00:00:00Z..2026-07-01T00:00:02Z")
              ? boundary
              : conflictingBoundary,
          ],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      },
    });
    expect(() => conflict(query)).toThrow("conflicting team-universe metadata for #2");

    const oneSecondQuery = teamUniverseWindowQuery({
      repository: "openclaw/openclaw",
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T00:00:01Z",
    });
    const unsplittable = createTeamUniverseResolver({
      repository: "openclaw/openclaw",
      searchLimit: 1,
      fetchPage: () => ({
        issueCount: 2,
        nodes: [],
        pageInfo: { endCursor: null, hasNextPage: false },
      }),
    });
    expect(() => unsplittable(oneSecondQuery)).toThrow(
      "team-universe search window could not be subdivided",
    );
  });
});
