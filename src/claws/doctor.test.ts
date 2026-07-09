import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { installClawCronJobs } from "./cron.js";
import { collectClawStateHealthFindings } from "./doctor.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { installClawMcpServers } from "./mcp.js";
import { persistClawPackageRef } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

async function fixture(params: { withFile?: boolean; withMcp?: boolean; withCron?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claw-doctor-"));
  if (params.withFile) {
    await writeFile(join(root, "SOUL.md"), "managed\n", "utf8");
  }
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
    workspace: params.withFile ? { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } } : {},
    mcpServers: params.withMcp ? { docs: { command: "uvx", args: ["docs-mcp"] } } : {},
    cronJobs: params.withCron
      ? [
          {
            id: "daily-report",
            schedule: { cron: "0 9 * * *" },
            session: "isolated",
            message: "Prepare report",
          },
        ]
      : [],
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrity: "sha256:manifest",
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, "workspace-worker") },
  });
  const env = {
    OPENCLAW_STATE_DIR: join(root, "state"),
    OPENCLAW_EXPERIMENTAL_CLAWS: "1",
  };
  return { root, plan, env };
}

async function installFixture(
  params: { withFile?: boolean; withMcp?: boolean; withCron?: boolean } = {},
) {
  const current = await fixture(params);
  let config: OpenClawConfig = {};
  await applyClawAddPlan(current.plan, {
    env: current.env,
    commitConfig: async (transform) => {
      config = transform(config);
    },
    installMcpServers: async (plan, options) =>
      await installClawMcpServers(plan, {
        ...options,
        setMcpServer: async ({ name, server }) => {
          config.mcp = { ...config.mcp, servers: { ...config.mcp?.servers, [name]: server } };
          return { ok: true, path: "config", config, mcpServers: config.mcp.servers! };
        },
      }),
    cronGateway: { add: async () => ({ id: "scheduler-daily" }) },
  });
  return { ...current, getConfig: () => config };
}

describe("collectClawStateHealthFindings", () => {
  it("stays hidden when the experimental Claws surface is disabled", async () => {
    const current = await fixture();
    await expect(
      collectClawStateHealthFindings({
        env: { ...current.env, OPENCLAW_EXPERIMENTAL_CLAWS: "" },
        cfg: {},
      }),
    ).resolves.toEqual([]);
  });

  it("reports no findings for a complete unchanged install", async () => {
    const current = await installFixture({ withFile: true, withMcp: true, withCron: true });
    await expect(
      collectClawStateHealthFindings({ env: current.env, cfg: current.getConfig() }),
    ).resolves.toEqual([]);
  });

  it("projects agent and workspace drift from lifecycle status", async () => {
    const current = await installFixture({ withFile: true });
    current.getConfig().agents!.list![0] = {
      ...current.getConfig().agents!.list![0],
      name: "Operator edit",
    };
    await writeFile(join(current.plan.agent.workspace, "SOUL.md"), "local edit\n", "utf8");

    const findings = await collectClawStateHealthFindings({
      env: current.env,
      cfg: current.getConfig(),
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("changed after installation"),
          path: "agents.list.worker",
        }),
        expect.objectContaining({
          message: expect.stringContaining("workspace file changed"),
          path: "claws.worker.workspace.SOUL.md",
        }),
      ]),
    );
  });

  it("reports unsafe workspace targets and MCP config drift", async () => {
    const current = await installFixture({ withFile: true, withMcp: true });
    const target = join(current.plan.agent.workspace, "SOUL.md");
    await rm(target);
    await symlink(join(current.root, "SOUL.md"), target);
    current.getConfig().mcp!.servers!.docs = { command: "node", args: ["other.mjs"] };

    const findings = await collectClawStateHealthFindings({
      env: current.env,
      cfg: current.getConfig(),
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("unsafe to inspect") }),
        expect.objectContaining({
          message: expect.stringContaining("modified ownership state"),
          path: "mcp.servers.docs",
        }),
      ]),
    );
  });

  it("reports partial installs and unresolved cron ownership", async () => {
    const current = await fixture({ withCron: true });
    let config: OpenClawConfig = {};
    await applyClawAddPlan(current.plan, {
      env: current.env,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      installCronJobs: async (plan, options) =>
        await installClawCronJobs(plan, {
          ...options,
          gateway: {
            add: async () => {
              throw new Error("gateway unavailable");
            },
          },
        }),
    });

    const findings = await collectClawStateHealthFindings({ env: current.env, cfg: config });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("partial install record") }),
        expect.objectContaining({
          message: expect.stringContaining("failed ownership state"),
          path: "claws.worker.cronJobs.daily-report",
        }),
      ]),
    );
  });

  it("reports ownership references without a root install", async () => {
    const current = await fixture();
    persistClawPackageRef(
      current.plan,
      { kind: "skill", source: "clawhub", ref: "triage", version: "1.0.0" },
      { env: current.env },
    );

    const findings = await collectClawStateHealthFindings({ env: current.env, cfg: {} });
    expect(findings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("have no root install record"),
        path: "claws.worker",
      }),
    ]);
  });
});
