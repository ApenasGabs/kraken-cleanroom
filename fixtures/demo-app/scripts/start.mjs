import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(currentDir, "..");
const cliDistPath = resolve(pkgRoot, "dist", "cli.js");

if (!existsSync(cliDistPath)) {
  execFileSync("pnpm", ["build"], { cwd: pkgRoot, stdio: "inherit" });
}

await import(pathToFileURL(cliDistPath).href);
