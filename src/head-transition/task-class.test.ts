import { describe, expect, it } from "vitest";
import {
  TASK_BUDGETS,
  checkBudget,
  classifyTask,
  createTaskClassLineageRegistry,
  type TaskSignals,
} from "./task-class.js";

describe("classifyTask — priority-ordered, first match wins (ASC §9)", () => {
  it("classifies plain read/summarize/simple-answer as simple_query", () => {
    expect(classifyTask({})).toBe("simple_query");
  });

  it("classifies a repository/config write as code_change", () => {
    expect(classifyTask({ repositoryOrConfigWrite: true })).toBe("code_change");
  });

  it("classifies multi-source investigation as investigation", () => {
    expect(classifyTask({ multiSourceInvestigation: true })).toBe("investigation");
  });

  it("classifies irreversible execution as high_risk_action", () => {
    expect(classifyTask({ irreversibleExecution: true })).toBe("high_risk_action");
  });

  it("a task spanning two classes takes the higher-priority match", () => {
    const signals: TaskSignals = { repositoryOrConfigWrite: true, irreversibleExecution: true };
    expect(classifyTask(signals)).toBe("high_risk_action");
  });

  it("ambiguous cases round up to investigation, never down to simple_query", () => {
    expect(classifyTask({ ambiguous: true })).toBe("investigation");
  });

  it("ambiguous never overrides a higher-priority explicit signal", () => {
    expect(classifyTask({ ambiguous: true, irreversibleExecution: true })).toBe("high_risk_action");
  });
});

describe("TASK_BUDGETS — v0.1 resolved numbers (ASC §9)", () => {
  it("matches the exact simple_query budget", () => {
    expect(TASK_BUDGETS.simple_query).toEqual({
      maxTokens: 8000,
      maxWallSeconds: 45,
      maxCostUsd: 0.15,
      maxToolCalls: 4,
      maxStrategySwitches: 1,
    });
  });

  it("matches the exact code_change budget", () => {
    expect(TASK_BUDGETS.code_change).toEqual({
      maxTokens: 64000,
      maxWallSeconds: 900,
      maxCostUsd: 2.0,
      maxToolCalls: 40,
      maxStrategySwitches: 2,
    });
  });

  it("matches the exact investigation budget", () => {
    expect(TASK_BUDGETS.investigation).toEqual({
      maxTokens: 96000,
      maxWallSeconds: 1500,
      maxCostUsd: 3.0,
      maxToolCalls: 30,
      maxStrategySwitches: 4,
    });
  });

  it("matches the exact high_risk_action budget, including its gating flags", () => {
    expect(TASK_BUDGETS.high_risk_action).toEqual({
      maxTokens: 32000,
      maxWallSeconds: 600,
      maxCostUsd: 1.5,
      maxToolCalls: 15,
      maxStrategySwitches: 1,
      requiresGrade2: true,
      requiresApproval: true,
    });
  });
});

describe("checkBudget", () => {
  it("passes when usage is within every dimension", () => {
    const result = checkBudget("simple_query", {
      tokens: 100,
      wallSeconds: 1,
      costUsd: 0.01,
      toolCalls: 1,
      strategySwitches: 0,
    });
    expect(result).toEqual({ withinBudget: true, violations: [] });
  });

  it("flags a single-dimension violation", () => {
    const result = checkBudget("simple_query", {
      tokens: 9000,
      wallSeconds: 1,
      costUsd: 0.01,
      toolCalls: 1,
      strategySwitches: 0,
    });
    expect(result.withinBudget).toBe(false);
    expect(result.violations).toContain("tokens");
  });

  it("flags every dimension that is over its cap", () => {
    const result = checkBudget("simple_query", {
      tokens: 9000,
      wallSeconds: 999,
      costUsd: 99,
      toolCalls: 99,
      strategySwitches: 99,
    });
    expect(result.withinBudget).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining(["tokens", "wallSeconds", "costUsd", "toolCalls", "strategySwitches"]),
    );
  });

  it("is exactly at the cap counts as within budget (caps are inclusive ceilings)", () => {
    const result = checkBudget("simple_query", {
      tokens: 8000,
      wallSeconds: 45,
      costUsd: 0.15,
      toolCalls: 4,
      strategySwitches: 1,
    });
    expect(result.withinBudget).toBe(true);
  });
});

describe("createTaskClassLineageRegistry — classification frozen at lineage start (ASC §9)", () => {
  it("classifies a new lineageId normally", () => {
    const registry = createTaskClassLineageRegistry();
    expect(registry.classify("lineage-1", { repositoryOrConfigWrite: true })).toBe("code_change");
  });

  it("freezes the class: a later call with escalated signals for the same lineageId does not upgrade it", () => {
    const registry = createTaskClassLineageRegistry();
    const first = registry.classify("lineage-1", { repositoryOrConfigWrite: true });
    expect(first).toBe("code_change");

    const second = registry.classify("lineage-1", { irreversibleExecution: true });
    expect(second).toBe("code_change");
  });

  it("different lineageIds classify independently", () => {
    const registry = createTaskClassLineageRegistry();
    registry.classify("lineage-1", { repositoryOrConfigWrite: true });
    const other = registry.classify("lineage-2", { irreversibleExecution: true });
    expect(other).toBe("high_risk_action");
  });
});
