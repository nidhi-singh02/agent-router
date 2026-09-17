import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountSchema } from "../domain/account.js";
import { ConfigFileSchema, type ConfiguredAccount } from "./config-schema.js";

export interface LoadConfigOptions {
  env?: NodeJS.Dict<string>;
}

export interface AppConfig {
  home: string;
  accounts: ConfiguredAccount[];
  coordinator?: {
    url: string;
    readerCredentialRef: string;
    writerCredentialRef?: string;
  };
  typesafe?: {
    apiKeyRef: string;
  };
}

export function resolveHome(env: NodeJS.Dict<string> = process.env): string {
  // MODEL_ROUTER_HOME overrides on every platform; the defaults below follow each OS.
  if (env.MODEL_ROUTER_HOME && env.MODEL_ROUTER_HOME.length > 0) {
    return env.MODEL_ROUTER_HOME;
  }
  if (process.platform === "darwin") {
    return path.join(env.HOME ?? os.homedir(), "Library/Application Support/model-router");
  }
  if (process.platform === "win32") {
    const appData = env.APPDATA ?? path.join(env.USERPROFILE ?? os.homedir(), "AppData/Roaming");
    return path.join(appData, "model-router");
  }
  const xdg = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? os.homedir(), ".config");
  return path.join(xdg, "model-router");
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const home = resolveHome(env);
  const filePath = path.join(home, "config.json");
  const raw = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : { accounts: [] };
  const file = ConfigFileSchema.parse(raw);
  const coordinatorUrl = env.MODEL_ROUTER_COORDINATOR_URL ?? file.coordinator?.url;
  const accounts: ConfiguredAccount[] = file.accounts.map((account) => {
    const parsed = AccountSchema.parse(account);
    return {
      ...parsed,
      credentialRef: account.credentialRef,
    };
  });
  return {
    home,
    accounts,
    coordinator: coordinatorUrl
      ? {
          url: coordinatorUrl,
          readerCredentialRef:
            env.MODEL_ROUTER_COORDINATOR_READER_REF ??
            file.coordinator?.readerCredentialRef ??
            "env:COORDINATOR_READER_TOKEN",
          writerCredentialRef: file.coordinator?.writerCredentialRef,
        }
      : file.coordinator,
    typesafe: file.typesafe,
  };
}

export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(home, 0o700);
}
