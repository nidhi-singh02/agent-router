import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, resolveHome } from "../../src/config/config-loader.js";
import { loadModelCatalog } from "../../src/catalog/model-catalog.js";

function tempHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), "model-router-config-"));
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("resolveHome", () => {
  it("prefers MODEL_ROUTER_HOME on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
      const home = withPlatform(platform, () =>
        resolveHome({
          MODEL_ROUTER_HOME: "/explicit/home",
          HOME: "/home/u",
          APPDATA: "C:/AppData",
        }),
      );
      expect(home).toBe("/explicit/home");
    }
  });

  it("uses Application Support on macOS", () => {
    const home = withPlatform("darwin", () => resolveHome({ HOME: "/Users/u" }));
    expect(home).toBe(path.join("/Users/u", "Library/Application Support/model-router"));
  });

  it("uses XDG_CONFIG_HOME on Linux", () => {
    const home = withPlatform("linux", () => resolveHome({ HOME: "/home/u" }));
    expect(home).toBe(path.join("/home/u", ".config", "model-router"));

    const xdg = withPlatform("linux", () =>
      resolveHome({ HOME: "/home/u", XDG_CONFIG_HOME: "/home/u/xdg" }),
    );
    expect(xdg).toBe(path.join("/home/u/xdg", "model-router"));
  });

  it("uses APPDATA on Windows, falling back to the user profile", () => {
    const appData = withPlatform("win32", () =>
      resolveHome({ APPDATA: "C:/Users/u/AppData/Roaming" }),
    );
    expect(appData).toBe(path.join("C:/Users/u/AppData/Roaming", "model-router"));

    const profile = withPlatform("win32", () => resolveHome({ USERPROFILE: "C:/Users/u" }));
    expect(profile).toBe(path.join("C:/Users/u", "AppData/Roaming", "model-router"));
  });
});

describe("config loader", () => {
  it("prefers MODEL_ROUTER_HOME over the platform config directory", () => {
    const home = tempHome();
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        accounts: [
          {
            id: "acct_personal_cursor",
            label: "personal cursor",
            provider: "cursor",
            agent: "cursor",
            ownership: "personal",
            collectorPreference: ["official-cli"],
            enabledModels: ["cursor:grok-4.6"],
            enabled: true,
            credentialRef: "env:CURSOR_API_KEY",
          },
        ],
      }),
    );

    const config = loadConfig({
      env: { MODEL_ROUTER_HOME: home, HOME: "/tmp/should-not-use" },
    });

    expect(config.home).toBe(home);
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0]?.credentialRef).toBe("env:CURSOR_API_KEY");
    expect(JSON.stringify(config)).not.toMatch(/sk-|cookie|password/i);
  });

  it("lets environment variables override file values", () => {
    const home = tempHome();
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        accounts: [],
        coordinator: {
          url: "https://file.example",
          readerCredentialRef: "env:COORDINATOR_READER_TOKEN",
        },
      }),
    );

    const config = loadConfig({
      env: {
        MODEL_ROUTER_HOME: home,
        MODEL_ROUTER_COORDINATOR_URL: "https://env.example",
      },
    });

    expect(config.coordinator?.url).toBe("https://env.example");
    expect(config.coordinator?.readerCredentialRef).toBe("env:COORDINATOR_READER_TOKEN");
  });

  it("rejects a shared reserve floor below 0.40", () => {
    const home = tempHome();
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        accounts: [
          {
            id: "acct_shared",
            label: "shared",
            provider: "anthropic",
            agent: "claude-code",
            ownership: "shared",
            reserveFloor: 0.3,
            collectorPreference: ["official-cli"],
            enabledModels: ["anthropic:claude-opus"],
            enabled: true,
            credentialRef: "keychain:anthropic",
          },
        ],
      }),
    );

    expect(() => loadConfig({ env: { MODEL_ROUTER_HOME: home } })).toThrow(/reserve/i);
  });

  it("rejects a remote plaintext coordinator URL", () => {
    const home = tempHome();
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        accounts: [],
        coordinator: { url: "http://example.com", readerCredentialRef: "env:TOKEN" },
      }),
    );
    expect(() => loadConfig({ env: { MODEL_ROUTER_HOME: home } })).toThrow(/https|loopback/i);
  });

  it("allows plaintext coordinator URLs on loopback", () => {
    for (const url of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const home = tempHome();
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ accounts: [], coordinator: { url, readerCredentialRef: "env:TOKEN" } }),
      );
      expect(loadConfig({ env: { MODEL_ROUTER_HOME: home } }).coordinator?.url).toBe(url);
    }
  });
});

describe("model catalog", () => {
  it("requires provenance and an update timestamp without claiming live availability", () => {
    const catalog = loadModelCatalog();
    expect(catalog.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(catalog.provenance).toMatch(/collector/i);
    expect(catalog.models.length).toBeGreaterThan(0);
    for (const model of catalog.models) {
      expect(model).not.toHaveProperty("available");
    }
  });

  it("loads a catalog from an explicit path for tests", () => {
    const dir = tempHome();
    mkdirSync(dir, { recursive: true });
    const catalogPath = path.join(dir, "models.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        updatedAt: "2026-09-17T00:00:00.000Z",
        provenance: "test fixture; availability comes from collectors",
        models: [
          {
            id: "cursor:grok-4.6",
            provider: "cursor",
            agent: "cursor",
            launchName: "grok-4.6",
            supportedEfforts: ["medium"],
            capabilities: {
              planning: 0.5,
              coding: 0.5,
              debugging: 0.5,
              creativity: 0.5,
              research: 0.5,
            },
            relativeQuotaCost: 1,
            relativeLatency: 1,
          },
        ],
      }),
    );

    const catalog = loadModelCatalog(catalogPath);
    expect(catalog.updatedAt).toBe("2026-09-17T00:00:00.000Z");
    expect(catalog.models[0]?.id).toBe("cursor:grok-4.6");
  });
});
