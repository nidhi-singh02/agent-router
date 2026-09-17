import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelCatalogSchema, type ModelCatalog } from "../config/config-schema.js";

export function defaultCatalogPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../config/models.json");
}

export function loadModelCatalog(catalogPath: string = defaultCatalogPath()): ModelCatalog {
  const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
  return ModelCatalogSchema.parse(raw);
}
