import { loadEnvConfig } from "@next/env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { catchUpDefaultCampaigns, inspectDefaultCampaignGaps } from "../src/lib/default-campaign-catchup";

loadEnvConfig(process.cwd());
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--check", "--apply", "--workers-stopped"].includes(arg)) ||
      (args.includes("--check") && args.includes("--apply")) ||
      (args.includes("--apply") && !args.includes("--workers-stopped"))) {
    throw new Error("Use --check or --apply --workers-stopped.");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const result = args.includes("--apply") ? await catchUpDefaultCampaigns(prisma) : await prisma.$transaction(inspectDefaultCampaignGaps);
    console.log(JSON.stringify(result, null, 2)); // Counts only; no credentials or post text.
  } finally { await prisma.$disconnect(); }
}
main().catch(() => { console.error("Default campaign catch-up failed. Check command flags, stopped workers, database connectivity and campaign lineage."); process.exitCode = 1; });
