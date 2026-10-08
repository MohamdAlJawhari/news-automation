BEGIN;
ALTER TABLE campaign ADD COLUMN "autoSendEnabled" boolean NOT NULL DEFAULT false,
 ADD COLUMN "autoSendActivatedAt" timestamp(3),
 ADD COLUMN "autoSendGeneration" integer NOT NULL DEFAULT 0,
 ADD COLUMN "autoSendRevision" integer NOT NULL DEFAULT 1;
ALTER TABLE processing_job ADD COLUMN "autoSendGeneration" integer;
ALTER TABLE ai_draft ADD COLUMN "approvalMode" text,
 ADD COLUMN "autoSendGeneration" integer, ADD COLUMN "manualAttentionReason" text;
UPDATE ai_draft SET "approvalMode" = 'MANUAL' WHERE "reviewStatus" = 'APPROVED';
ALTER TABLE telegram_publication ADD COLUMN "deliveryMode" text NOT NULL DEFAULT 'MANUAL',
 ADD COLUMN "queuedAutomatically" boolean NOT NULL DEFAULT false,
 ADD COLUMN "autoSendGeneration" integer;
ALTER TABLE telegram_publication ADD CONSTRAINT publication_delivery_mode CHECK
 ("deliveryMode" IN ('MANUAL','AUTOMATIC') AND ("deliveryMode" <> 'AUTOMATIC' OR ("queuedAutomatically" AND "autoSendGeneration" IS NOT NULL)));
ALTER TABLE ai_draft ADD CONSTRAINT draft_approval_mode CHECK ("approvalMode" IN ('MANUAL','AUTOMATIC'));

CREATE FUNCTION campaign_auto_send_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
   NEW."autoSendEnabled" := false; NEW."autoSendActivatedAt" := NULL;
   NEW."autoSendGeneration" := 0; NEW."autoSendRevision" := 1;
 ELSE
   NEW."autoSendGeneration" := OLD."autoSendGeneration";
   NEW."autoSendActivatedAt" := OLD."autoSendActivatedAt";
   NEW."autoSendRevision" := OLD."autoSendRevision";
   IF NEW."autoSendEnabled" IS DISTINCT FROM OLD."autoSendEnabled" THEN
     NEW."autoSendRevision" := OLD."autoSendRevision" + 1;
     IF NEW."autoSendEnabled" THEN
       NEW."autoSendGeneration" := OLD."autoSendGeneration" + 1;
       NEW."autoSendActivatedAt" := timezone('UTC', clock_timestamp());
     END IF;
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_auto_send_transition BEFORE INSERT OR UPDATE ON campaign
 FOR EACH ROW EXECUTE FUNCTION campaign_auto_send_transition();

-- Stamp at original ingestion, never at AI claim/draft creation. Old jobs stay null.
CREATE FUNCTION stamp_job_auto_send() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
   IF NEW."autoSendGeneration" IS DISTINCT FROM OLD."autoSendGeneration" THEN
     RAISE EXCEPTION 'Job Auto-send generation is immutable';
   END IF;
 ELSE
   NEW."autoSendGeneration" := NULL;
   IF NEW.type = 'TELEGRAM_PREPARE' THEN
     SELECT c."autoSendGeneration" INTO NEW."autoSendGeneration"
       FROM campaign c JOIN original_post o ON o.id = NEW."originalPostId" AND o."workspaceId" = c."workspaceId"
       WHERE c.id = NEW."campaignId" AND c."workspaceId" = NEW."workspaceId"
       AND c."autoSendEnabled" AND o."receivedAt" > c."autoSendActivatedAt";
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stamp_job_auto_send BEFORE INSERT OR UPDATE ON processing_job
 FOR EACH ROW EXECUTE FUNCTION stamp_job_auto_send();

CREATE FUNCTION protect_auto_publication_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."queuedAutomatically" IS DISTINCT FROM OLD."queuedAutomatically" OR
    NEW."autoSendGeneration" IS DISTINCT FROM OLD."autoSendGeneration" THEN
   RAISE EXCEPTION 'Publication automatic origin is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_auto_publication_origin BEFORE UPDATE ON telegram_publication
 FOR EACH ROW EXECUTE FUNCTION protect_auto_publication_origin();
COMMIT;
