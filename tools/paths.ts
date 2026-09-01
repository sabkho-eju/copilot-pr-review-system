/**
 * Resolves the project root at runtime so that JSON assets (config, MCP
 * registries) and markdown files are found both when running the TypeScript
 * sources and when running the compiled output from `dist/`.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function findProjectRoot(startDir: string): string {
  let current = startDir;
  while (true) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
}

export const projectRoot = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

/** Resolves a path relative to the project root. */
export function fromProjectRoot(...segments: string[]): string {
  return path.resolve(projectRoot, ...segments);
}
