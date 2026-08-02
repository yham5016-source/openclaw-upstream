import { CAVEMAN_GENERIC_PAYLOAD_SCHEMA } from "./caveman-envelope.js";

/**
 * ASC §6: grades are computed by rule from worker-reported evidence, never
 * self-awarded. Grade 3 evaluation is disabled in v0.1 — the
 * preregisteredClaimId registry it depends on does not exist yet — so a
 * grade-3 derivation is always `provisional: true` and never counts as a
 * stop condition, budget/credit extension, or same_failure_confirmation.
 */
type ProgressGrade = 1 | 2 | 3 | 4;

interface GradeDerivation {
  grade: ProgressGrade;
  provisional: boolean;
}

type IndependenceAxisStrong =
  | "source_lineage"
  | "data_partition"
  | "verification_method"
  | "toolchain";

type IndependenceAxisWeak =
  | "model_provider"
  | "prompt_context"
  | "sampling_path"
  | "evaluator_instance";

type IndependenceAxis = IndependenceAxisStrong | IndependenceAxisWeak;

const STRONG_AXES = new Set<IndependenceAxis>([
  "source_lineage",
  "data_partition",
  "verification_method",
  "toolchain",
]);

/** ASC §6: one strong axis, or at least two distinct weak axes. */
export function isIndependentEvidence(differingAxes: IndependenceAxis[]): boolean {
  const distinctAxes = new Set(differingAxes);
  const hasStrongAxis = [...distinctAxes].some((axis) => STRONG_AXES.has(axis));
  if (hasStrongAxis) {
    return true;
  }
  return distinctAxes.size >= 2;
}

interface VerifierResult {
  independenceAxes: IndependenceAxis[];
}

export interface ProgressClaimEvidence {
  testResultsPresent?: boolean;
  counterexamplePresent?: boolean;
  candidateRegistryChanged?: boolean;
  verifierResult?: VerifierResult;
  preregisteredClaimId?: string;
}

export function deriveProgressGrade(evidence: ProgressClaimEvidence): GradeDerivation {
  if (
    evidence.testResultsPresent ||
    evidence.counterexamplePresent ||
    evidence.candidateRegistryChanged
  ) {
    return { grade: 1, provisional: false };
  }
  if (evidence.verifierResult && isIndependentEvidence(evidence.verifierResult.independenceAxes)) {
    return { grade: 2, provisional: false };
  }
  if (evidence.preregisteredClaimId) {
    return { grade: 3, provisional: true };
  }
  return { grade: 4, provisional: false };
}

/** ASC §4: full credit restoration requires non-provisional grade 1 or 2 evidence. */
function qualifiesForFullCreditRestore(derivation: GradeDerivation): boolean {
  return !derivation.provisional && (derivation.grade === 1 || derivation.grade === 2);
}

interface BudgetExtensionInput {
  payloadSchema: string;
  grade: GradeDerivation;
}

/**
 * Caveman + ASC's shared gate: generic_result.v1 never justifies a budget or
 * credit extension regardless of the evidence attached to it, and a
 * provisional grade 3 or a grade 4 claim never does either.
 */
export function canExtendBudget(input: BudgetExtensionInput): boolean {
  if (input.payloadSchema === CAVEMAN_GENERIC_PAYLOAD_SCHEMA) {
    return false;
  }
  return qualifiesForFullCreditRestore(input.grade);
}
