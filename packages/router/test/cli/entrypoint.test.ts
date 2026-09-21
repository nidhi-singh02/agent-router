import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isEntrypoint, runCli } from "../../src/cli.js";

function capture() {
  const chunks = { out: "", err: "" };
  return {
    chunks,
    stdout: {
      write(chunk: string) {
        chunks.out += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk: string) {
        chunks.err += chunk;
        return true;
      },
    },
  };
}

function tempHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), "router-entry-"));
}

describe("cli entrypoint", () => {
  it("prints help and exits 0 without throwing", async () => {
    const io = capture();
    const code = await runCli(["node", "router", "--help"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: { MODEL_ROUTER_HOME: tempHome() },
    });
    expect(code).toBe(0);
    expect(io.chunks.out).toMatch(/Usage: router/);
  });

  it("returns a non-zero exit code for an unknown command", async () => {
    const io = capture();
    const code = await runCli(["node", "router", "nope"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: { MODEL_ROUTER_HOME: tempHome() },
    });
    expect(code).toBe(1);
    expect(io.chunks.err).toMatch(/unknown command/);
  });

  it("treats a symlinked bin path as the entrypoint", () => {
    const dir = realpathSync(tempHome());
    const target = path.join(dir, "cli.js");
    writeFileSync(target, "");
    const link = path.join(dir, "router");
    symlinkSync(target, link);
    const metaUrl = pathToFileURL(target).href;
    expect(isEntrypoint(metaUrl, target)).toBe(true);
    expect(isEntrypoint(metaUrl, link)).toBe(true);
    expect(isEntrypoint(metaUrl, path.join(dir, "other.js"))).toBe(false);
    expect(isEntrypoint(metaUrl, undefined)).toBe(false);
  });

  it("passes --no-enrich through to executeRun", async () => {
    const io = capture();
    const run = vi.fn().mockResolvedValue({ code: 0, output: "", json: {} });
    await runCli(["node", "router", "run", "refactor PR 9", "--dry-run", "--no-enrich"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: { MODEL_ROUTER_HOME: tempHome() },
      run,
      runDeps: {} as never,
    });
    expect(run).toHaveBeenCalledWith(
      "refactor PR 9",
      expect.objectContaining({ noEnrich: true }),
      expect.anything(),
    );
  });
});
