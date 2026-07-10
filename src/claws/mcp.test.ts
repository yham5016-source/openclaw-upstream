import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { installClawMcpServers, readClawMcpServerRefs } from "./mcp.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claw-mcp-"));
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker" },
    mcpServers: {
      docs: {
        command: "uvx",
        args: ["docs-mcp"],
        env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
      },
    },
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
    context: { workspace: join(root, "workspace") },
  });
  return { plan, env: { OPENCLAW_STATE_DIR: join(root, "state") } };
}

describe("installClawMcpServers", () => {
  it("uses create-only config writes and stores digest-only ownership", async () => {
    const current = await fixture();
    const setMcpServer = vi
      .fn()
      .mockResolvedValue({ ok: true, path: "config", config: {}, mcpServers: {} });

    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      nowMs: 42,
    });

    expect(setMcpServer).toHaveBeenCalledWith({
      name: "docs",
      server: {
        command: "uvx",
        args: ["docs-mcp"],
        env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
      },
      createOnly: true,
    });
    expect(refs).toMatchObject([
      {
        schemaVersion: "openclaw.clawMcpServerRef.v1",
        agentId: "worker",
        name: "docs",
        configDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        status: "complete",
      },
    ]);
    expect(JSON.stringify(refs)).not.toContain("DOCS_TOKEN");
    expect(readClawMcpServerRefs("worker", { env: current.env })).toEqual(refs);
  });

  it("marks a structured collision as a non-owning failure", async () => {
    const current = await fixture();
    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        setMcpServer: vi.fn().mockResolvedValue({
          ok: false,
          path: "config",
          error: "MCP server already exists.",
        }),
      }),
    ).rejects.toMatchObject({
      code: "mcp_install_failed",
      mcpServers: [{ name: "docs", status: "failed" }],
    });
  });

  it("leaves ownership pending when a config write throws", async () => {
    const current = await fixture();
    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        setMcpServer: vi.fn().mockRejectedValue(new Error("write result unknown")),
      }),
    ).rejects.toMatchObject({
      code: "mcp_install_uncertain",
      mcpServers: [{ name: "docs", status: "pending" }],
    });
    expect(readClawMcpServerRefs("worker", { env: current.env })).toMatchObject([
      { name: "docs", status: "pending" },
    ]);
  });
});
