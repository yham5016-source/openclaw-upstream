/**
 * ASC §9: classification runs per dispatched task unit, before budget
 * allocation, and is frozen at lineage start — a run cannot re-classify
 * itself upward mid-flight to unlock a larger budget.
 */
type TaskClass = "simple_query" | "code_change" | "investigation" | "high_risk_action";

export interface TaskSignals {
  /** external send/delete/deploy/payment/permission change, any irreversible execution */
  irreversibleExecution?: boolean;
  /** repository/config/document write, build, test run */
  repositoryOrConfigWrite?: boolean;
  /** multi-source investigation, cause-unknown debugging, design exploration */
  multiSourceInvestigation?: boolean;
  /** ambiguous case: rounds up to investigation, never down */
  ambiguous?: boolean;
}

/** ASC §9 decision rule, checked in this order; first match wins. */
export function classifyTask(signals: TaskSignals): TaskClass {
  if (signals.irreversibleExecution) {
    return "high_risk_action";
  }
  if (signals.repositoryOrConfigWrite) {
    return "code_change";
  }
  if (signals.multiSourceInvestigation || signals.ambiguous) {
    return "investigation";
  }
  return "simple_query";
}

interface TaskBudget {
  maxTokens: number;
  maxWallSeconds: number;
  maxCostUsd: number;
  maxToolCalls: number;
  maxStrategySwitches: number;
  requiresGrade2?: boolean;
  requiresApproval?: boolean;
}

/** ASC §9 v0.1 budgets — absolute hard caps, not usage targets. */
export const TASK_BUDGETS: Record<TaskClass, TaskBudget> = {
  simple_query: {
    maxTokens: 8000,
    maxWallSeconds: 45,
    maxCostUsd: 0.15,
    maxToolCalls: 4,
    maxStrategySwitches: 1,
  },
  code_change: {
    maxTokens: 64000,
    maxWallSeconds: 900,
    maxCostUsd: 2.0,
    maxToolCalls: 40,
    maxStrategySwitches: 2,
  },
  investigation: {
    maxTokens: 96000,
    maxWallSeconds: 1500,
    maxCostUsd: 3.0,
    maxToolCalls: 30,
    maxStrategySwitches: 4,
  },
  high_risk_action: {
    maxTokens: 32000,
    maxWallSeconds: 600,
    maxCostUsd: 1.5,
    maxToolCalls: 15,
    maxStrategySwitches: 1,
    requiresGrade2: true,
    requiresApproval: true,
  },
};

interface TaskUsage {
  tokens: number;
  wallSeconds: number;
  costUsd: number;
  toolCalls: number;
  strategySwitches: number;
}

interface BudgetCheck {
  withinBudget: boolean;
  violations: string[];
}

/** Caps are inclusive ceilings: usage exactly at the cap is still within budget. */
export function checkBudget(taskClass: TaskClass, usage: TaskUsage): BudgetCheck {
  const budget = TASK_BUDGETS[taskClass];
  const violations: string[] = [];
  if (usage.tokens > budget.maxTokens) violations.push("tokens");
  if (usage.wallSeconds > budget.maxWallSeconds) violations.push("wallSeconds");
  if (usage.costUsd > budget.maxCostUsd) violations.push("costUsd");
  if (usage.toolCalls > budget.maxToolCalls) violations.push("toolCalls");
  if (usage.strategySwitches > budget.maxStrategySwitches) violations.push("strategySwitches");
  return { withinBudget: violations.length === 0, violations };
}

interface TaskClassLineageRegistry {
  /** First classification for a lineageId wins; later calls return the frozen class. */
  classify(lineageId: string, signals: TaskSignals): TaskClass;
}

export function createTaskClassLineageRegistry(): TaskClassLineageRegistry {
  const frozen = new Map<string, TaskClass>();
  return {
    classify(lineageId, signals) {
      const existing = frozen.get(lineageId);
      if (existing) {
        return existing;
      }
      const computed = classifyTask(signals);
      frozen.set(lineageId, computed);
      return computed;
    },
  };
}
