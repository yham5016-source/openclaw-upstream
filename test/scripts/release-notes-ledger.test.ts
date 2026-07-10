import { describe, expect, it } from "vitest";
import {
  contributionRecordFor,
  exactShippedPullRequestExclusions,
  ledgerChecks,
  ledgerFor,
  ledgerReconciliationFor,
  renderContributionRecordEntry,
} from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";

const ledgerRange = { base: "v2026.6.11", target: "a".repeat(40) };

describe("renderContributionRecordEntry", () => {
  it("keeps source and linked issue references without repeating PR titles", () => {
    expect(
      renderContributionRecordEntry({
        number: 123,
        title: "Fix local openclaw/openclaw#45 and openclaw/imsg#141",
        linkedIssues: [{ number: 45 }, { number: 67 }],
        thanks: ["alice", "bob"],
      }),
    ).toBe("- **PR #123** Related #45, openclaw/imsg#141, #67. Thanks @alice and @bob.");
  });

  it("deduplicates title references and retains seeded cross-repository references", () => {
    expect(
      renderContributionRecordEntry({
        number: 124,
        title: "Fix #45, #45, and OpenClaw/imsg#141",
        externalReferences: ["openclaw/imsg#141"],
        priorReferences: [67],
        linkedIssues: [{ number: 45 }],
        thanks: [],
      }),
    ).toBe("- **PR #124** Related #45, OpenClaw/imsg#141, #67.");
  });

  it("renders every source PR even without issue references or credits", () => {
    expect(
      renderContributionRecordEntry({
        number: 456,
        title: "Internal cleanup",
        linkedIssues: [],
        thanks: [],
      }),
    ).toBe("- **PR #456**");
  });

  it("retains references and credits when a compact record is seeded again", () => {
    const line = "- **PR #125** Related #45, openclaw/imsg#141. Thanks @alice and @bob.";
    const record = contributionRecordFor({
      source: [
        "## 2026.7.1",
        "",
        "### Complete contribution record",
        "",
        "#### Pull requests",
        "",
        line,
      ].join("\n"),
    });
    const seeded = record.pullRequests.get(125);

    expect(seeded).toEqual({
      externalReferences: ["openclaw/imsg#141"],
      references: [45],
      thanks: ["alice", "bob"],
    });
    expect(
      renderContributionRecordEntry({
        number: 125,
        title: "Title changed after release",
        priorReferences: seeded?.references,
        externalReferences: seeded?.externalReferences,
        linkedIssues: [],
        thanks: seeded?.thanks ?? [],
      }),
    ).toBe(line);
  });

  it("retains seeded credits when the production ledger is rebuilt", () => {
    const priorRecord = contributionRecordFor({
      source: [
        "## 2026.7.1",
        "",
        "### Complete contribution record",
        "",
        "#### Pull requests",
        "",
        "- **PR #125** Thanks @alice and @bob.",
      ].join("\n"),
    });
    const nodes = new Map([
      [
        125,
        {
          __typename: "PullRequest",
          author: { __typename: "User", login: "carol" },
          closingIssuesReferences: { nodes: [] },
          mergedAt: "2026-07-08T00:00:00Z",
          title: "fix: keep release credits",
        },
      ],
    ]);

    const result = ledgerFor(
      "v2026.6.11",
      "HEAD",
      [125],
      nodes,
      new Map(),
      new Map(),
      { issuesByPullRequest: new Map() },
      priorRecord,
      new Set([125]),
      new Set(),
      [],
      Date.parse("2026-07-09T00:00:00Z"),
    );

    expect(result.ledger).toContain("- **PR #125** Thanks @carol and @alice and @bob.");
  });

  it("retains references from a verbose record when the source title changes", () => {
    const record = contributionRecordFor({
      source: [
        "## 2026.7.1",
        "",
        "### Complete contribution record",
        "",
        "#### Pull requests",
        "",
        "- **PR #126** Fix #46 and openclaw/imsg#142. Related #68. Thanks @alice.",
      ].join("\n"),
    });
    const seeded = record.pullRequests.get(126);

    expect(seeded).toEqual({
      externalReferences: ["openclaw/imsg#142"],
      references: [46, 68],
      thanks: ["alice"],
    });
  });

  it("requires complete reference tokens rather than matching substrings", () => {
    const source = [
      "## 2026.7.1",
      "",
      "### Highlights",
      "",
      "- Highlight one.",
      "- Highlight two.",
      "- Highlight three.",
      "- Highlight four.",
      "- Highlight five.",
      "",
      "### Changes",
      "",
      "### Fixes",
      "",
      "### Complete contribution record",
      "",
      `This audited record covers the complete v2026.6.11..${"a".repeat(40)} history: 1 merged PR.`,
      "",
      "#### Pull requests",
      "",
      "- **PR #456** Related openclaw/imsg#141.",
    ].join("\n");
    const entry = {
      number: 456,
      title: "Internal cleanup",
      editorialEligible: false,
      priorReferences: [45, 141],
      externalReferences: [],
      linkedIssues: [],
      thanks: [],
    };

    expect(
      ledgerChecks(
        { source },
        [entry],
        new Map([[456, { __typename: "PullRequest" }]]),
        [],
        [],
        ledgerRange,
      ),
    ).toEqual([
      "missing #45 on contribution record for PR #456",
      "missing #141 on contribution record for PR #456",
    ]);
  });

  it("accepts case-only differences in cross-repository references", () => {
    const line = "- **PR #127** Related OpenClaw/imsg#143.";
    const source = [
      "## 2026.7.1",
      "",
      "### Highlights",
      "",
      "- Highlight one.",
      "- Highlight two.",
      "- Highlight three.",
      "- Highlight four.",
      "- Highlight five.",
      "",
      "### Changes",
      "",
      "### Fixes",
      "",
      "### Complete contribution record",
      "",
      `This audited record covers the complete v2026.6.11..${"a".repeat(40)} history: 1 merged PR.`,
      "",
      "#### Pull requests",
      "",
      line,
    ].join("\n");
    const entry = {
      number: 127,
      title: "Internal cleanup",
      editorialEligible: false,
      priorReferences: [],
      externalReferences: ["openclaw/imsg#143"],
      linkedIssues: [],
      thanks: [],
    };

    expect(
      ledgerChecks(
        { source },
        [entry],
        new Map([[127, { __typename: "PullRequest" }]]),
        [],
        [],
        ledgerRange,
      ),
    ).toEqual([]);
  });

  it("rejects duplicate rows, dishonest declared counts, and contributor-prefix matches", () => {
    const section = (provenance: string, rows: string[]) => ({
      source: [
        "## 2026.7.1",
        "",
        "### Highlights",
        "",
        "- Highlight one.",
        "- Highlight two.",
        "- Highlight three.",
        "- Highlight four.",
        "- Highlight five.",
        "",
        "### Changes",
        "",
        "### Fixes",
        "",
        "### Complete contribution record",
        "",
        provenance,
        "",
        "#### Pull requests",
        "",
        ...rows,
      ].join("\n"),
    });
    const target = "a".repeat(40);
    const entry = {
      number: 127,
      title: "Internal cleanup",
      editorialEligible: false,
      priorReferences: [],
      externalReferences: [],
      linkedIssues: [],
      thanks: ["ann"],
    };
    const nodes = new Map([[127, { __typename: "PullRequest" }]]);

    expect(
      ledgerChecks(
        section(
          `This audited record covers the complete v2026.6.11..${target} history: 2 merged PRs.`,
          ["- **PR #127** Thanks @ann.", "- **PR #127** Thanks @ann."],
        ),
        [entry],
        nodes,
        [],
        [],
        ledgerRange,
      ),
    ).toContain("release section contains duplicate contribution record PR rows: #127");
    expect(
      ledgerChecks(
        section(
          `This audited record covers the complete v2026.6.11..${target} history: 999 merged PRs.`,
          ["- **PR #127** Thanks @ann."],
        ),
        [entry],
        nodes,
        [],
        [],
        ledgerRange,
      ),
    ).toContain("release section contribution record declares 999 PRs but contains 1");
    expect(
      ledgerChecks(
        section(
          `This audited record covers the complete v2026.6.11..${target} history: 1 merged PR.`,
          ["- **PR #127** Thanks @anna."],
        ),
        [entry],
        nodes,
        [],
        [],
        ledgerRange,
      ),
    ).toContain("missing Thanks @ann for #127");
    expect(
      ledgerChecks(
        section(
          `This audited record covers the complete v2026.6.11..${target} history: 1 merged PR.`,
          ["- **PR #127** Related @ann. Thanks @ann."],
        ),
        [entry],
        nodes,
        [],
        [],
        ledgerRange,
      ),
    ).not.toContain("missing Thanks @ann for #127");
    expect(
      ledgerChecks(
        section(`This audited record covers the complete WRONG..${target} history: 1 merged PR.`, [
          "- **PR #127** Thanks @ann.",
        ]),
        [entry],
        nodes,
        [],
        [],
        ledgerRange,
      ),
    ).toContain(
      `release section contribution record provenance mismatch: expected v2026.6.11..${target}, found WRONG..${target}`,
    );
    expect(
      ledgerChecks(
        section(
          `This audited record covers the complete v2026.6.11..${"b".repeat(40)} history: 1 merged PR.`,
          ["- **PR #127** Thanks @ann."],
        ),
        [entry],
        nodes,
        [],
        [],
        ledgerRange,
      ),
    ).toContain(
      `release section contribution record provenance mismatch: expected v2026.6.11..${target}, found v2026.6.11..${"b".repeat(40)}`,
    );
    const duplicateProvenance = section(
      `This audited record covers the complete v2026.6.11..${target} history: 1 merged PR.`,
      ["- **PR #127** Thanks @ann."],
    );
    duplicateProvenance.source = duplicateProvenance.source.replace(
      `history: 1 merged PR.`,
      `history: 1 merged PR.\nThis audited record covers the complete WRONG..${"b".repeat(40)} history: 999 merged PRs.`,
    );
    expect(ledgerChecks(duplicateProvenance, [entry], nodes, [], [], ledgerRange)).toContain(
      "release section must contain exactly one complete contribution record provenance line; found 2",
    );
    const duplicateHeading = section(
      `This audited record covers the complete v2026.6.11..${target} history: 1 merged PR.`,
      ["- **PR #127** Thanks @ann."],
    );
    duplicateHeading.source = duplicateHeading.source.replace(
      "#### Pull requests",
      "### Complete contribution record\n\n#### Pull requests",
    );
    expect(ledgerChecks(duplicateHeading, [entry], nodes, [], [], ledgerRange)).toContain(
      "release section must contain exactly one ### Complete contribution record heading; found 2",
    );
    const misplaced = section(
      `This audited record covers the complete v2026.6.11..${target} history: 1 merged PR.`,
      ["- **PR #127** Thanks @ann."],
    );
    misplaced.source = misplaced.source.replace("#### Pull requests", "#### Bogus");
    expect(ledgerChecks(misplaced, [entry], nodes, [], [], ledgerRange)).toContain(
      "release section contains unsupported contribution record subsection: #### Bogus",
    );
    expect(
      ledgerChecks(
        section(
          `This audited record covers the complete v2026.6.11..${target} history: 1 merged PR.`,
          ["- **PR #127** Thanks @ann.", "- Legacy duplicate (#127)."],
        ),
        [entry],
        nodes,
        [],
        [],
        ledgerRange,
      ),
    ).toContain(
      "release section contains invalid #### Pull requests row: - Legacy duplicate (#127).",
    );

    const inlineRecordMention = section(
      `This audited record covers the complete v2026.6.11..${target} history: 1 merged PR.`,
      ["- **PR #127** Thanks @ann."],
    );
    inlineRecordMention.source = inlineRecordMention.source.replace(
      "### Complete contribution record",
      [
        "This sentence says ### Complete contribution record inline.",
        "",
        "- Internal docs cleanup (#127). Thanks @ann.",
        "",
        "### Complete contribution record",
      ].join("\n"),
    );
    expect(
      ledgerChecks(inlineRecordMention, [{ ...entry, type: "docs" }], nodes, [], [], ledgerRange),
    ).toContain("editorial release prose references non-editorial docs PR #127 (docs)");

    const inlineRequiredHeadings = section(
      `This audited record covers the complete v2026.6.11..${target} history: 1 merged PR.`,
      ["- **PR #127** Thanks @ann."],
    );
    inlineRequiredHeadings.source = inlineRequiredHeadings.source
      .replace("### Changes", "Prose mentions ### Changes")
      .replace("### Fixes", "Prose mentions ### Fixes");
    const headingErrors = ledgerChecks(inlineRequiredHeadings, [entry], nodes, [], [], ledgerRange);
    expect(headingErrors).toContain("missing ### Changes");
    expect(headingErrors).toContain("missing ### Fixes");
  });

  it("requires an exact local issue reference on the credited line", () => {
    const source = [
      "## 2026.7.1",
      "",
      "### Highlights",
      "",
      "- Highlight one.",
      "- Highlight two.",
      "- Highlight three.",
      "- Highlight four.",
      "- Highlight five.",
      "",
      "### Changes",
      "",
      "### Fixes",
      "",
      "- Context #1.",
      "- Context #10. Thanks @bob.",
      "",
      "### Complete contribution record",
      "",
      `This audited record covers the complete v2026.6.11..${"a".repeat(40)} history: 0 merged PRs.`,
      "",
      "#### Pull requests",
    ].join("\n");
    const nodes = new Map([
      [
        1,
        {
          __typename: "Issue",
          author: { __typename: "User", login: "bob" },
        },
      ],
      [10, { __typename: "PullRequest" }],
    ]);

    expect(ledgerChecks({ source }, [], nodes, [], [], ledgerRange)).toContain(
      "missing Thanks @bob for issue #1",
    );
  });
});

describe("generated contribution reconciliation", () => {
  const source = {
    inventory: {
      commits: [
        {
          body: "",
          commit: "a".repeat(40),
          pullRequests: [1],
          references: [],
          subject: "fix: canonical work",
        },
      ],
      partitions: {
        pullRequests: {
          included: { members: [1] },
        },
      },
    },
  };
  const renderedRecord = { pullRequests: new Map([[9, {}]]) };

  it("reports missing and unexpected generated rows independently of the current record", () => {
    const reconciliation = ledgerReconciliationFor(source, renderedRecord, [2]);

    expect(reconciliation).toMatchObject({
      canonicalRows: { members: [1] },
      currentRows: { members: [9] },
      generatedMissingRows: { members: [1] },
      generatedRows: { members: [2] },
      generatedUnexpectedRows: { members: [2] },
      missingRowEvidence: {
        records: [
          {
            number: 1,
            reason: "canonical-source-row-missing-from-current-record",
            targetCommits: ["a".repeat(40)],
          },
        ],
      },
      staleRowEvidence: {
        records: [
          expect.objectContaining({
            category: "non-pull-request-or-unresolved-row",
            number: 9,
          }),
        ],
      },
    });
  });

  it("accepts exact canonical rows and an explicit historical seed only", () => {
    expect(ledgerReconciliationFor(source, renderedRecord, [1])).toMatchObject({
      generatedCoverage: 1,
      generatedMissingRows: { count: 0 },
      generatedUnexpectedRows: { count: 0 },
    });
    expect(ledgerReconciliationFor(source, renderedRecord, [1, 2], [2])).toMatchObject({
      generatedCoverage: 1,
      generatedMissingRows: { count: 0 },
      generatedUnexpectedRows: { count: 0 },
    });
  });

  it("categorizes cross-repository collisions and local historical context", () => {
    const crossRepositoryCommit = "b".repeat(40);
    const historicalContextCommit = "c".repeat(40);
    const contextualSource = {
      inventory: {
        commits: [
          {
            body: "See openclaw/imsg#155 for the external implementation.",
            commit: crossRepositoryCommit,
            pullRequests: [100105],
            references: [],
            subject: "docs: external context",
          },
          {
            body: "PR #87085 was historical foundation and did not include this work.",
            commit: historicalContextCommit,
            pullRequests: [62682],
            references: [87085],
            subject: "fix: historical context",
          },
        ],
        partitions: { pullRequests: { included: { members: [] } } },
        range: { mergeBaseTimestamp: Date.parse("2026-06-24T00:00:00Z") },
      },
    };
    const contextualRecord = {
      pullRequests: new Map([
        [155, { references: [] }],
        [87085, { references: [] }],
      ]),
    };
    const nodes = new Map([
      [
        155,
        {
          __typename: "PullRequest",
          mergedAt: "2026-01-03T21:21:55Z",
          number: 155,
          title: "old external-number collision",
        },
      ],
      [
        87085,
        {
          __typename: "PullRequest",
          mergedAt: "2026-05-27T02:54:45Z",
          number: 87085,
          title: "old historical foundation",
        },
      ],
    ]);

    expect(
      ledgerReconciliationFor(contextualSource, contextualRecord, [], [], nodes).staleRowEvidence
        .records,
    ).toEqual([
      expect.objectContaining({
        category: "cross-repository-reference-number-collision",
        crossRepositoryReferences: ["openclaw/imsg#155"],
        number: 155,
      }),
      expect.objectContaining({
        category: "historical-context-reference-without-ownership",
        number: 87085,
        sourceContextCommits: [historicalContextCommit],
      }),
    ]);
  });
});

describe("shipped contribution exclusions", () => {
  it("uses exact shipped proof despite missing historical credit and keeps active PR work", () => {
    const source = {
      inventory: {
        commits: [
          {
            disposition: "shipped",
            pullRequests: [1, 2],
            shippedEvidence: [{ ref: "v1" }, { ref: "v2" }],
          },
        ],
        partitions: {
          pullRequests: {
            included: { members: [2] },
            shipped: { members: [1, 2] },
          },
        },
      },
    };

    expect(
      exactShippedPullRequestExclusions(source, [
        { pullRequests: new Set(), ref: "v2" },
        { pullRequests: new Set(), ref: "v1" },
      ]),
    ).toEqual({
      baselines: [
        { count: 1, pullRequests: [1], ref: "v1" },
        { count: 0, pullRequests: [], ref: "v2" },
      ],
      pullRequests: new Set([1]),
    });
  });
});
