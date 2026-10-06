import { mkdir, readFile, writeFile, cp, rename, rm, stat } from "node:fs/promises";
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

async function stagedBuild(stage: string) {
  const root = path.resolve(process.cwd());
  const client = path.resolve(root, "src/generated/prisma");
  const backup = path.resolve(root, stage, "build-original");
  if (!client.startsWith(root + path.sep) || !backup.startsWith(root + path.sep)) throw new Error("Unsafe staged build paths.");
  if (await stat(backup).then(() => true, () => false)) throw new Error("A previous build backup exists; restore it before retrying.");
  // Services must be stopped for this optional build. Restore the running
  // client's entire directory in finally, including on compiler failure.
  await rename(client, backup);
  try {
    await cp(path.resolve(root, stage, "client"), client, { recursive: true });
    await run(["node_modules/next/dist/bin/next", "build"]);
  } finally {
    await rm(client, { recursive: true, force: true });
    await rename(backup, client);
  }
  console.log("PASS: staged production build; original application client restored.");
}

async function main() {
  const stage = ".campaign-settings-validation";
  await mkdir(stage, { recursive: true });
  const sourceSchema = (await readFile("prisma/schema.prisma", "utf8")).replaceAll("\r\n", "\n");
  const schema = sourceSchema.replace(/output\s*=\s*"\.\.\/src\/generated\/prisma"/, 'output = "./client"');
  if (schema === sourceSchema) throw new Error("Expected client output was not found; refusing to generate outside the staging directory.");
  await writeFile(`${stage}/schema.prisma`, schema);
  // Generate a separate client. Never regenerate the running application's client.
  await run(["node_modules/prisma/build/index.js", "generate", "--schema", `${stage}/schema.prisma`, "--config", "./prisma7.config.ts"]);
  const legacySchema = schema
    .replace('output = "./client"', 'output = "./legacy-client"')
    .replace('  aiDrafts AiDraft[]\n  rssItem', '  aiDraft AiDraft?\n  rssItem')
    .replace(/  executionStartsAt[^\n]*\n/, '')
    .replace(/  eligibleAfter[^\n]*\n/, '')
    .replace('  revision Int @default(1)\n  createdAt DateTime @default(now())\n  updatedAt DateTime @default(now()) @updatedAt\n  @@id([campaignId, sourceChannelId])', '  createdAt DateTime @default(now())\n  updatedAt DateTime @default(now()) @updatedAt\n  @@id([campaignId, sourceChannelId])')
    .replace('  campaignId String\n  campaign Campaign @relation', '  campaignId String?\n  campaign Campaign? @relation')
    .replace('@@unique([originalPostId, campaignId])', '@@unique([originalPostId, workspaceId])')
    .replace('@@unique([originalPostId, type, campaignId])', '@@unique([originalPostId, type])');
  await writeFile(`${stage}/legacy-schema.prisma`, legacySchema);
  await run(["node_modules/prisma/build/index.js", "generate", "--schema", `${stage}/legacy-schema.prisma`, "--config", "./prisma7.config.ts"]);
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
  if (process.argv.includes("--types-only")) return;
  for (const script of ["check-multi-campaign-execution.ts", "check-telegram-preparation.ts", "check-direct-publishing.ts"]) {
    await run(["--import", "./scripts/staged-campaign-client.mjs", "--import", "tsx", `scripts/${script}`]);
  }
  if (process.argv.includes("--build")) await stagedBuild(stage);
  console.log("PASS: staged migration/runtime/preparation/publishing checks; application client and main schema untouched.");
}
main().catch(() => { console.error("Staged campaign settings validation failed; no main database migration was requested."); process.exitCode = 1; });
