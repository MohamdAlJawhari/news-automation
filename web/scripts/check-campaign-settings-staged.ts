import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import ts from "typescript";

async function run(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", () => reject(new Error("Staged check could not start.")));
    child.on("exit", code => code === 0 ? resolve() : reject(new Error("Staged check failed.")));
  });
}

async function main() {
  const stage = ".campaign-settings-validation";
  await mkdir(stage, { recursive: true });
  const sourceSchema = await readFile("prisma/schema.prisma", "utf8");
  const schema = sourceSchema.replace(/output\s*=\s*"\.\.\/src\/generated\/prisma"/, 'output = "./client"');
  if (schema === sourceSchema) throw new Error("Expected client output was not found; refusing to generate outside the staging directory.");
  await writeFile(`${stage}/schema.prisma`, schema);
  // Generate a separate client. Never regenerate the running application's client.
  await run(["node_modules/prisma/build/index.js", "generate", "--schema", `${stage}/schema.prisma`, "--config", "./prisma7.config.ts"]);
  const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
  if (config.error) throw new Error("Cannot read TypeScript configuration.");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const host = ts.createCompilerHost(parsed.options);
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    if (/[/\\]generated[/\\]prisma[/\\]client$/.test(name)) {
      return { resolvedFileName: path.resolve(stage, "client/client.ts"), extension: ts.Extension.Ts };
    }
    return ts.resolveModuleName(name, containingFile, parsed.options, host).resolvedModule;
  });
  const program = ts.createProgram(parsed.fileNames.filter(file => !file.includes(".campaign-settings-validation") && !file.replaceAll("\\", "/").includes("src/generated/prisma/")), { ...parsed.options, incremental: false, noEmit: true }, host);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: name => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }));
    throw new Error("Staged TypeScript validation failed.");
  }
  console.log("PASS: TypeScript against separate staged Prisma Client.");
  for (const script of ["check-campaign-migration.ts", "check-default-campaign-runtime.ts", "check-telegram-preparation.ts", "check-direct-publishing.ts"]) {
    await run(["--import", "./scripts/staged-campaign-client.mjs", "--import", "tsx", `scripts/${script}`]);
  }
  console.log("PASS: staged migration/runtime/preparation/publishing checks; application client and main schema untouched.");
}
main().catch(() => { console.error("Staged campaign settings validation failed; no main database migration was requested."); process.exitCode = 1; });
