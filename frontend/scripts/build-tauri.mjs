import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `next build` for the Tauri bundle.
 *
 * next.config.mjs switches on TAURI_BUILD to select distDir "out" and to drop
 * the "/static" basePath. tauri.conf.json expressed that as
 * `TAURI_BUILD=true npm run build`, which is POSIX shell syntax: the Tauri CLI
 * hands beforeBuildCommand to the host shell, so on Windows the variable never
 * reaches the build, the export lands in ../static with a /static basePath, and
 * the bundled app comes up with no assets. Exporting it from node works on
 * every platform.
 */
export function buildNextEnv(baseEnv = process.env) {
  return { ...baseEnv, TAURI_BUILD: "true" };
}

export function runBuild(args = process.argv.slice(2)) {
  const env = buildNextEnv();
  const nextEntry = path.resolve("node_modules", "next", "dist", "bin", "next");

  const child = spawn(process.execPath, [nextEntry, "build", ...args], {
    stdio: "inherit",
    env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBuild();
}
