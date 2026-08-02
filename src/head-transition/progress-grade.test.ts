import { describe, expect, it } from "vitest";
import {
  canExtendBudget,
  deriveProgressGrade,
  isIndependentEvidence,
  type ProgressClaimEvidence,
} from "./progress-grade.js";

describe("deriveProgressGrade", () => {
  it("grades 1 when test results are present", () => {
    const result = deriveProgressGrade({ testResultsPresent: true });
    expect(result).toEqual({ grade: 1, provisional: false });
  });

  it("grades 1 when a counterexample is present", () => {
    const result = deriveProgressGrade({ counterexamplePresent: true });
    expect(result.grade).toBe(1);
  });

  it("grades 1 when the candidate registry changed", () => {
    const result = deriveProgressGrade({ candidateRegistryChanged: true });
    expect(result.grade).toBe(1);
  });

  it("grades 2 when a verifier result satisfies independence (one strong axis)", () => {
    const result = deriveProgressGrade({
      verifierResult: { independenceAxes: ["source_lineage"] },
    });
    expect(result).toEqual({ grade: 2, provisional: false });
  });

  it("grades 2 when a verifier result satisfies independence (two weak axes)", () => {
    const result = deriveProgressGrade({
      verifierResult: { independenceAxes: ["model_provider", "prompt_context"] },
    });
    expect(result.grade).toBe(2);
  });

  it("does not grade 2 on a single weak axis alone", () => {
    const result = deriveProgressGrade({
      verifierResult: { independenceAxes: ["model_provider"] },
    });
    expect(result.grade).not.toBe(2);
  });

  it("grade 1 takes priority over a present but insufficient verifier", () => {
    const result = deriveProgressGrade({
      testResultsPresent: true,
      verifierResult: { independenceAxes: ["model_provider"] },
    });
    expect(result.grade).toBe(1);
  });

  it("grades 3 as provisional when a preregisteredClaimId is present (v0.1: registry does not exist)", () => {
    const result = deriveProgressGrade({ preregisteredClaimId: "claim-1" });
    expect(result).toEqual({ grade: 3, provisional: true });
  });

  it("everything else falls to grade 4, non-provisional", () => {
    const result = deriveProgressGrade({});
    expect(result).toEqual({ grade: 4, provisional: false });
  });
});

describe("isIndependentEvidence — fixed axis enum", () => {
  it("one strong axis is sufficient", () => {
    expect(isIndependentEvidence(["source_lineage"])).toBe(true);
    expect(isIndependentEvidence(["data_partition"])).toBe(true);
    expect(isIndependentEvidence(["verification_method"])).toBe(true);
    expect(isIndependentEvidence(["toolchain"])).toBe(true);
  });

  it("a single weak axis is insufficient", () => {
    expect(isIndependentEvidence(["model_provider"])).toBe(false);
  });

  it("two distinct weak axes are sufficient", () => {
    expect(isIndependentEvidence(["model_provider", "prompt_context"])).toBe(true);
  });

  it("the same weak axis repeated (e.g. two temperature runs) is insufficient", () => {
    expect(isIndependentEvidence(["sampling_path", "sampling_path"])).toBe(false);
  });

  it("no axes is insufficient", () => {
    expect(isIndependentEvidence([])).toBe(false);
  });
});

describe("canExtendBudget — the budget/credit-extension gate", () => {
  const grade1: ProgressClaimEvidence = { testResultsPresent: true };
  const grade2: ProgressClaimEvidence = {
    verifierResult: { independenceAxes: ["toolchain"] },
  };
  const grade3Provisional: ProgressClaimEvidence = { preregisteredClaimId: "claim-1" };
  const grade4: ProgressClaimEvidence = {};

  it("allows extension on grade 1 evidence for a non-generic payload", () => {
    expect(
      canExtendBudget({ payloadSchema: "code_result.v1", grade: deriveProgressGrade(grade1) }),
    ).toBe(true);
  });

  it("allows extension on grade 2 evidence for a non-generic payload", () => {
    expect(
      canExtendBudget({ payloadSchema: "code_result.v1", grade: deriveProgressGrade(grade2) }),
    ).toBe(true);
  });

  it("blocks extension on a provisional grade 3 claim, even for a non-generic payload", () => {
    expect(
      canExtendBudget({
        payloadSchema: "code_result.v1",
        grade: deriveProgressGrade(grade3Provisional),
      }),
    ).toBe(false);
  });

  it("blocks extension on grade 4 evidence for a non-generic payload", () => {
    expect(
      canExtendBudget({ payloadSchema: "code_result.v1", grade: deriveProgressGrade(grade4) }),
    ).toBe(false);
  });

  it("blocks extension for a generic_result.v1 payload even carrying grade 1 evidence", () => {
    expect(
      canExtendBudget({ payloadSchema: "generic_result.v1", grade: deriveProgressGrade(grade1) }),
    ).toBe(false);
  });

  it("blocks extension for a generic_result.v1 payload even carrying grade 2 evidence", () => {
    expect(
      canExtendBudget({ payloadSchema: "generic_result.v1", grade: deriveProgressGrade(grade2) }),
    ).toBe(false);
  });
});
