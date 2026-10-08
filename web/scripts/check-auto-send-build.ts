// Build an isolated copy while the deployed client's schema remains unchanged.
import { cp, mkdir, symlink, writeFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

async function main() {
  const root = process.cwd();
  const target = path.resolve(root, ".campaign-settings-validation", `build-${randomUUID()}`);
  if (!target.startsWith(root + path.sep)) throw new Error("Unsafe build path.");
  await mkdir(target, { recursive: true });
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", "next-env.d.ts", "next.config.ts", "postcss.config.mjs", "prisma7.config.ts", ".env.local", ".env"]) {
    if (await stat(file).then(() => true, () => false)) await cp(file, path.join(target, file));
  }
  for (const dir of ["src", "public", "scripts", "prisma"]) await cp(dir, path.join(target, dir), { recursive: true, filter: source => !source.replaceAll("\\", "/").includes("src/generated/prisma") });
  await cp(".campaign-settings-validation/client", path.join(target, "src/generated/prisma"), { recursive: true });
  await symlink(path.join(root, "node_modules"), path.join(target, "node_modules"), "junction");
  // Explicit root prevents the outer repository's lockfile from selecting its build directory.
  await writeFile(path.join(target, "next.config.ts"), 'import type { NextConfig } from "next"; const config: NextConfig = { outputFileTracingRoot: process.cwd() }; export default config;\n');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build", "--webpack"], { cwd: target, stdio: "inherit" });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error("Isolated build failed.")));
  });
  // Browser checks consume the CSS from this copy without replacing the active .next.
  await writeFile(".campaign-ui-validation/build-path.txt", target);
  console.log("PASS: isolated production build; main client and application build untouched.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
