import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateName(name) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) throw new Error(`invalid source or report name: ${JSON.stringify(name)}`);
  return name;
}

/** Resolve a path within the output directory. */
export function outputPath(root, ...parts) {
  const path = resolve(root, ...parts);
  const relativePath = relative(resolve(root), path);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("path is outside its output directory");
  return path;
}

/** Write a temporary file, then rename it to replace the destination. */
export function replaceFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
