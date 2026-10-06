import { loadEnvConfig } from "@next/env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

// Read-only after cutover. Never copy the obsolete source automation flag.
loadEnvConfig(process.cwd());
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const [counts] = await db.$queryRaw<Record<string, number>[]>`SELECT
      (SELECT count(*)::int FROM workspace w WHERE NOT EXISTS (SELECT 1 FROM campaign c WHERE c."workspaceId"=w.id AND c."isDefault")) AS "defaultsMissing",
      (SELECT count(*)::int FROM source_channel s WHERE NOT EXISTS (SELECT 1 FROM campaign_source m JOIN campaign c ON c.id=m."campaignId" AND c."workspaceId"=m."workspaceId" WHERE c."isDefault" AND m."sourceChannelId"=s.id AND m."workspaceId"=s."workspaceId")) AS "defaultMembershipsMissing",
      (SELECT count(*)::int FROM ai_draft WHERE "campaignId" IS NULL) AS "draftsUnassigned",
      (SELECT count(*)::int FROM processing_job WHERE (type='TELEGRAM_PREPARE' AND "campaignId" IS NULL) OR (type='RSS_PREPARE' AND "campaignId" IS NOT NULL)) AS "invalidJobCampaigns",
      (SELECT count(*)::int FROM campaign c WHERE NOT EXISTS (SELECT 1 FROM campaign_ai_settings s WHERE s."campaignId"=c.id AND s."workspaceId"=c."workspaceId") OR NOT EXISTS (SELECT 1 FROM campaign_publishing_settings s WHERE s."campaignId"=c.id AND s."workspaceId"=c."workspaceId")) AS "settingsMissing",
      (SELECT count(*)::int FROM workspace w WHERE NOT EXISTS (SELECT 1 FROM workspace_telegram_state s WHERE s."workspaceId"=w.id)) AS "coordinationMissing"`;
    console.log(JSON.stringify(counts, null, 2)); // Counts only.
    if (["defaultsMissing", "defaultMembershipsMissing", "draftsUnassigned", "invalidJobCampaigns"].some(key => counts[key] !== 0)) process.exitCode = 1;
  } finally { await db.$disconnect(); }
}
main().catch(() => { console.error("Read-only execution audit failed. Keep services stopped and investigate deployment or missing campaign records."); process.exitCode = 1; });
