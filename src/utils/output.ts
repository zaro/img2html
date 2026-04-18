import * as fs from "fs";
import * as path from "path";

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function writeFile(filePath: string, content: string): void {
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);
  ensureDir(dir);
  fs.writeFileSync(resolvedPath, content, "utf-8");
}

export function getOutputPath(baseDir: string, variantIndex?: number): string {
  if (variantIndex !== undefined && variantIndex > 1) {
    return path.join(baseDir, `variant-${variantIndex}`, "index.html");
  }
  return path.join(baseDir, "index.html");
}