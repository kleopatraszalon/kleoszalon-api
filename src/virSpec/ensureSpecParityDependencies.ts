import pool from "../db";

let ensurePromise: Promise<void> | null = null;

/**
 * Tables used across the legacy-spec parity modules that must exist even when
 * optional workers/pages have not been opened yet. This runs before app.listen,
 * so complaint attachments and review moderation cannot race first-use schema creation.
 */
export function ensureSpecParityDependencies(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = pool.query(`
      CREATE TABLE IF NOT EXISTS operations_quality_records(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        module_key text NOT NULL,
        title text NOT NULL,
        description text,
        location_name text,
        department text,
        assignee text,
        priority text DEFAULT 'normal',
        status text DEFAULT 'open',
        due_at timestamptz,
        recurrence text,
        requires_approval boolean DEFAULT false,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS complaint_mail_messages(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        complaint_id uuid NOT NULL REFERENCES operations_quality_records(id) ON DELETE CASCADE,
        mailbox_key text NOT NULL,
        imap_uid bigint NOT NULL,
        message_id text,
        sender_email text,
        sender_name text,
        recipient text,
        subject text,
        received_at timestamptz,
        raw_sha256 text NOT NULL,
        created_at timestamptz DEFAULT now(),
        UNIQUE(mailbox_key, imap_uid)
      );
      CREATE INDEX IF NOT EXISTS idx_complaint_mail_message_id
        ON complaint_mail_messages(message_id);

      CREATE TABLE IF NOT EXISTS complaint_attachments(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        complaint_id uuid NOT NULL REFERENCES operations_quality_records(id) ON DELETE CASCADE,
        mail_message_id uuid REFERENCES complaint_mail_messages(id) ON DELETE CASCADE,
        filename text NOT NULL,
        content_type text,
        byte_size bigint NOT NULL DEFAULT 0,
        sha256 text NOT NULL,
        content bytea NOT NULL,
        source text NOT NULL DEFAULT 'email',
        created_at timestamptz DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_complaint_attachments_complaint
        ON complaint_attachments(complaint_id, created_at);

      CREATE TABLE IF NOT EXISTS social_campaigns (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_type text NOT NULL DEFAULT 'manual',
        source_id uuid,
        name text NOT NULL,
        headline text NOT NULL,
        description text NOT NULL DEFAULT '',
        image_url text,
        video_url text,
        link_url text,
        platform_payloads jsonb NOT NULL DEFAULT '{}'::jsonb,
        scheduled_at timestamptz,
        status text NOT NULL DEFAULT 'draft',
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS social_publications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id uuid NOT NULL REFERENCES social_campaigns(id) ON DELETE CASCADE,
        platform text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'draft',
        scheduled_at timestamptz,
        attempts integer NOT NULL DEFAULT 0,
        external_id text,
        external_container_id text,
        external_url text,
        response jsonb,
        error text,
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(campaign_id, platform)
      );
    `).then(() => undefined).catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

export default ensureSpecParityDependencies;
