import { loadEnvConfig } from "@next/env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

// Read-only parity check immediately after migration, before settings can change.
loadEnvConfig(process.cwd());
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const [counts] = await prisma.$queryRaw<Record<string, number>[]>`SELECT
      (SELECT count(*)::int FROM workspace w WHERE NOT EXISTS (SELECT 1 FROM campaign c WHERE c."workspaceId" = w.id AND c."isDefault")) AS "defaultsMissing",
      (SELECT count(*)::int FROM campaign c WHERE c."isDefault" AND (NOT EXISTS (SELECT 1 FROM campaign_ai_settings s WHERE s."campaignId" = c.id AND s."workspaceId" = c."workspaceId") OR NOT EXISTS (SELECT 1 FROM campaign_publishing_settings s WHERE s."campaignId" = c.id AND s."workspaceId" = c."workspaceId"))) AS "settingsMissing",
      (SELECT count(*)::int FROM workspace w WHERE NOT EXISTS (SELECT 1 FROM workspace_telegram_state s WHERE s."workspaceId" = w.id)) AS "coordinationMissing",
      (SELECT count(*)::int FROM campaign_ai_settings a JOIN campaign c ON c.id = a."campaignId" AND c."workspaceId" = a."workspaceId" JOIN workspace_ai_settings old ON old."workspaceId" = a."workspaceId"
        WHERE c."isDefault" AND (to_jsonb(a) - 'campaignId') IS DISTINCT FROM to_jsonb(old)) AS "aiCopyDifferences",
      (SELECT count(*)::int FROM campaign_publishing_settings p JOIN campaign c ON c.id = p."campaignId" AND c."workspaceId" = p."workspaceId" JOIN workspace_publishing_settings old ON old."workspaceId" = p."workspaceId"
        WHERE c."isDefault" AND (to_jsonb(p) - 'campaignId') IS DISTINCT FROM (to_jsonb(old) - 'floodWaitUntil')) AS "publishingCopyDifferences",
      (SELECT count(*)::int FROM workspace_telegram_state s JOIN workspace_publishing_settings old ON old."workspaceId" = s."workspaceId" WHERE s."floodWaitUntil" IS DISTINCT FROM old."floodWaitUntil") AS "floodWaitCopyDifferences"`;
    console.log(JSON.stringify(counts, null, 2));
    if (Object.values(counts).some(count => count !== 0)) process.exitCode = 1;
  } finally { await prisma.$disconnect(); }
}
main().catch(() => { console.error("Cutover verification failed. Check migration deployment and database connectivity while services remain stopped."); process.exitCode = 1; });
