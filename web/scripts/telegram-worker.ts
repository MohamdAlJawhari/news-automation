import { loadEnvConfig } from "@next/env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { setTimeout as delay } from "node:timers/promises";
import { processTelegramJob } from "./telegram-processing";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
if (!process.env.DATABASE_URL || !process.env.INGEST_WORKSPACE_ID?.trim()) {
  throw new Error("DATABASE_URL and INGEST_WORKSPACE_ID must be configured.");
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const once = process.argv.includes("--once");
let stopping = false;
const stop = () => { stopping = true; };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function main() {
  console.log(once ? "Telegram preparation: checking one job." : "Telegram preparation worker running. Ctrl+C stops.");
  try {
    while (!stopping) {
      try {
        const found = await processTelegramJob(prisma);
        if (once) { if (!found) console.log("No eligible Telegram preparation jobs (check connection, access, activation and settings)."); break; }
        if (!found) await delay(2000);
      } catch {
        console.error("Telegram preparation database operation failed; claims recover after lease expiry.");
        if (once) { process.exitCode = 1; break; }
        await delay(5000);
      }
    }
  } finally {
    await prisma.$disconnect();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
main().catch(() => { console.error("Telegram preparation worker stopped."); process.exitCode = 1; });
