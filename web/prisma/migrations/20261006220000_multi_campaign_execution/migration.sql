-- Checked catch-up and stopped services are required. Existing history is not rewritten.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE workspace, campaign, source_channel, campaign_source, ai_draft, processing_job IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM ai_draft WHERE "campaignId" IS NULL)
 OR EXISTS (SELECT 1 FROM processing_job WHERE type = 'TELEGRAM_PREPARE' AND "campaignId" IS NULL)
 OR EXISTS (SELECT 1 FROM processing_job j JOIN ai_draft d ON d."originalPostId" = j."originalPostId" AND d."workspaceId" = j."workspaceId"
   WHERE j.type = 'TELEGRAM_PREPARE' AND j."campaignId" IS DISTINCT FROM d."campaignId")
 OR EXISTS (SELECT 1 FROM workspace w WHERE NOT EXISTS (SELECT 1 FROM campaign c WHERE c."workspaceId" = w.id AND c."isDefault"))
 OR EXISTS (SELECT 1 FROM source_channel s WHERE NOT EXISTS (SELECT 1 FROM campaign_source m JOIN campaign c ON c.id = m."campaignId" AND c."workspaceId" = m."workspaceId" WHERE c."isDefault" AND m."sourceChannelId" = s.id AND m."workspaceId" = s."workspaceId"))
 THEN RAISE EXCEPTION 'Run checked pre-execution Default catch-up before this migration'; END IF;
END $$;
ALTER TABLE campaign ADD COLUMN "executionStartsAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', clock_timestamp());
ALTER TABLE campaign_source ADD COLUMN "eligibleAfter" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', clock_timestamp()),
 ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
-- Non-Default rows retain their original configuration/join times. No historical
-- originals are swept, and already queued campaign jobs retain their identity.
UPDATE campaign SET "executionStartsAt" = "createdAt" WHERE NOT "isDefault";
UPDATE campaign_source m SET "eligibleAfter" = m."createdAt"
 FROM campaign c WHERE c.id = m."campaignId" AND c."workspaceId" = m."workspaceId" AND NOT c."isDefault";
-- Default's existing receivedAt > activatedAt rule remains the only old boundary.
UPDATE campaign SET "executionStartsAt" = TIMESTAMP '0001-01-01' WHERE "isDefault";
UPDATE campaign_source m SET "eligibleAfter" = TIMESTAMP '0001-01-01'
 FROM campaign c WHERE c.id = m."campaignId" AND c."workspaceId" = m."workspaceId" AND c."isDefault";
ALTER TABLE ai_draft ALTER COLUMN "campaignId" SET NOT NULL;
DROP INDEX "ai_draft_originalPostId_workspaceId_key";
CREATE UNIQUE INDEX "ai_draft_originalPostId_campaignId_key" ON ai_draft ("originalPostId", "campaignId");
DROP INDEX "processing_job_originalPostId_type_key";
CREATE UNIQUE INDEX "processing_job_originalPostId_type_campaignId_key" ON processing_job ("originalPostId", type, "campaignId");
CREATE UNIQUE INDEX processing_job_one_rss_original ON processing_job ("originalPostId", type) WHERE type = 'RSS_PREPARE';
ALTER TABLE processing_job DROP CONSTRAINT processing_job_campaign_telegram_only;
ALTER TABLE processing_job ADD CONSTRAINT processing_job_campaign_type_required CHECK
 ((type = 'TELEGRAM_PREPARE' AND "campaignId" IS NOT NULL) OR (type = 'RSS_PREPARE' AND "campaignId" IS NULL));
CREATE FUNCTION protect_processing_job_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id, NEW."workspaceId", NEW."originalPostId", NEW.type, NEW."campaignId")
  IS DISTINCT FROM ROW(OLD.id, OLD."workspaceId", OLD."originalPostId", OLD.type, OLD."campaignId")
  THEN RAISE EXCEPTION 'Assigned processing job lineage is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER processing_job_lineage_immutable BEFORE UPDATE ON processing_job FOR EACH ROW EXECUTE FUNCTION protect_processing_job_lineage();
CREATE FUNCTION protect_ai_draft_original_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id, NEW."workspaceId", NEW."originalPostId") IS DISTINCT FROM ROW(OLD.id, OLD."workspaceId", OLD."originalPostId")
  THEN RAISE EXCEPTION 'Assigned draft original lineage is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_draft_original_lineage_immutable BEFORE UPDATE ON ai_draft FOR EACH ROW EXECUTE FUNCTION protect_ai_draft_original_lineage();
CREATE FUNCTION protect_campaign_execution_boundary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."executionStartsAt" IS DISTINCT FROM OLD."executionStartsAt" THEN RAISE EXCEPTION 'Campaign execution boundary is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_execution_boundary_immutable BEFORE UPDATE ON campaign FOR EACH ROW EXECUTE FUNCTION protect_campaign_execution_boundary();
CREATE FUNCTION protect_campaign_membership_authority() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF NEW."eligibleAfter" IS DISTINCT FROM OLD."eligibleAfter" OR ROW(NEW."campaignId", NEW."sourceChannelId", NEW."workspaceId") IS DISTINCT FROM ROW(OLD."campaignId", OLD."sourceChannelId", OLD."workspaceId")
   THEN RAISE EXCEPTION 'Membership identity and eligibility boundary are immutable'; END IF;
  IF NEW."telegramAutomationEnabled" IS DISTINCT FROM OLD."telegramAutomationEnabled" THEN
   IF current_setting('app.campaign_membership_writer', true) IS DISTINCT FROM 'campaign-execution' THEN RAISE EXCEPTION 'Use campaign membership helpers; legacy synchronization is retired'; END IF;
   NEW.revision := OLD.revision + 1;
  ELSIF NEW.revision IS DISTINCT FROM OLD.revision THEN RAISE EXCEPTION 'Membership revision is managed by participation changes'; END IF;
 ELSIF NEW."telegramAutomationEnabled" AND current_setting('app.campaign_membership_writer', true) IS DISTINCT FROM 'campaign-execution' THEN
  RAISE EXCEPTION 'Use campaign membership helpers';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_membership_authority BEFORE INSERT OR UPDATE ON campaign_source FOR EACH ROW EXECUTE FUNCTION protect_campaign_membership_authority();
CREATE FUNCTION reject_obsolete_source_automation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."telegramAutomationEnabled" IS DISTINCT FROM OLD."telegramAutomationEnabled" THEN RAISE EXCEPTION 'Source automation flag is obsolete; configure campaign membership'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_automation_retired BEFORE UPDATE ON source_channel FOR EACH ROW EXECUTE FUNCTION reject_obsolete_source_automation();
COMMIT;
