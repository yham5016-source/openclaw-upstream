import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "../agents/stable-stringify.js";
import { canonicalizeConfiguredMcpServer } from "../config/mcp-config-normalize.js";
import { setConfiguredMcpServer } from "../config/mcp-config.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan, ClawMcpServer } from "./types.js";

export const CLAW_MCP_REF_SCHEMA_VERSION = "openclaw.clawMcpServerRef.v1" as const;

export type PersistedClawMcpServerRef = {
  schemaVersion: typeof CLAW_MCP_REF_SCHEMA_VERSION;
  agentId: string;
  name: string;
  configDigest: string;
  status: "pending" | "complete" | "failed";
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

type McpRefRow = {
  schema_version: string;
  agent_id: string;
  name: string;
  config_digest: string;
  status: PersistedClawMcpServerRef["status"];
  error: string | null;
  created_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

export class ClawMcpInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly mcpServers: PersistedClawMcpServerRef[],
  ) {
    super(message);
    this.name = "ClawMcpInstallError";
  }
}

function ensureMcpRefTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claw_mcp_server_refs (
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL UNIQUE,
      schema_version TEXT NOT NULL,
      config_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (agent_id, name)
    );
  `);
}

function rowToRef(row: McpRefRow): PersistedClawMcpServerRef {
  return {
    schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
    agentId: row.agent_id,
    name: row.name,
    configDigest: row.config_digest,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export function digestClawMcpServer(server: Record<string, unknown>): string {
  const canonical = canonicalizeConfiguredMcpServer(server);
  return `sha256:${createHash("sha256").update(stableStringify(canonical)).digest("hex")}`;
}

function persistPendingRef(
  plan: ClawAddPlan,
  name: string,
  server: ClawMcpServer,
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawMcpServerRef {
  const nowMs = options.nowMs ?? Date.now();
  const ref: PersistedClawMcpServerRef = {
    schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    name,
    configDigest: digestClawMcpServer(server),
    status: "pending",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureMcpRefTable(db);
    db.prepare(
      `INSERT INTO claw_mcp_server_refs (
         agent_id, name, schema_version, config_digest, status, error,
         created_at_ms, updated_at_ms
       ) VALUES (
         @agent_id, @name, @schema_version, @config_digest, @status, NULL,
         @created_at_ms, @updated_at_ms
       )`,
    ).run({
      agent_id: ref.agentId,
      name: ref.name,
      schema_version: ref.schemaVersion,
      config_digest: ref.configDigest,
      status: ref.status,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
    });
  }, options);
  return ref;
}

function updateRef(
  ref: PersistedClawMcpServerRef,
  update: { status: "complete" | "failed"; error?: string },
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawMcpServerRef {
  const updated = { ...ref, ...update, updatedAtMs: options.nowMs ?? Date.now() };
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureMcpRefTable(db);
    db.prepare(
      `UPDATE claw_mcp_server_refs
          SET status = @status, error = @error, updated_at_ms = @updated_at_ms
        WHERE agent_id = @agent_id AND name = @name`,
    ).run({
      agent_id: ref.agentId,
      name: ref.name,
      status: update.status,
      error: update.error ?? null,
      updated_at_ms: updated.updatedAtMs,
    });
  }, options);
  return updated;
}

export async function installClawMcpServers(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    setMcpServer?: typeof setConfiguredMcpServer;
    nowMs?: number;
  } = {},
): Promise<PersistedClawMcpServerRef[]> {
  const setMcpServer = options.setMcpServer ?? setConfiguredMcpServer;
  const refs: PersistedClawMcpServerRef[] = [];
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    const server = action.details as ClawMcpServer | undefined;
    if (!server?.command) {
      throw new ClawMcpInstallError(
        "mcp_plan_invalid",
        `MCP server action ${JSON.stringify(action.id)} is invalid.`,
        refs,
      );
    }
    const pending = persistPendingRef(plan, action.id, server, options);
    refs.push(pending);
    let result: Awaited<ReturnType<typeof setConfiguredMcpServer>>;
    try {
      result = await setMcpServer({ name: action.id, server, createOnly: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ClawMcpInstallError("mcp_install_uncertain", message, refs);
    }
    if (!result.ok) {
      refs[refs.length - 1] = updateRef(
        pending,
        { status: "failed", error: result.error },
        options,
      );
      throw new ClawMcpInstallError("mcp_install_failed", result.error, refs);
    }
    try {
      refs[refs.length - 1] = updateRef(pending, { status: "complete" }, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ClawMcpInstallError(
        "mcp_provenance_failed",
        `MCP server was configured, but ownership could not be persisted: ${message}`,
        refs,
      );
    }
  }
  return refs;
}

export function readClawMcpServerRefs(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawMcpServerRef[] {
  const database = openOpenClawStateDatabase(options);
  ensureMcpRefTable(database.db);
  const rows = database.db
    .prepare(
      `SELECT schema_version, agent_id, name, config_digest, status, error,
              created_at_ms, updated_at_ms
         FROM claw_mcp_server_refs
        WHERE agent_id = ?
        ORDER BY name`,
    )
    .all(agentId) as McpRefRow[];
  return rows.map(rowToRef);
}

export function deleteClawMcpServerRef(
  agentId: string,
  name: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureMcpRefTable(db);
    db.prepare("DELETE FROM claw_mcp_server_refs WHERE agent_id = ? AND name = ?").run(
      agentId,
      name,
    );
  }, options);
}
