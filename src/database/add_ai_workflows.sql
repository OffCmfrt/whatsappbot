-- AI Workflows table for the Copilot Pro automation builder
-- Run this once on the Supabase PostgreSQL database.

CREATE TABLE IF NOT EXISTS ai_workflows (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL DEFAULT 'Untitled workflow',
    trigger_type    TEXT NOT NULL,
    trigger_config  JSONB NOT NULL DEFAULT '{}',
    action_type     TEXT NOT NULL,
    action_config   JSONB NOT NULL DEFAULT '{}',
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    fire_count      INTEGER NOT NULL DEFAULT 0,
    last_fired_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_workflows_trigger ON ai_workflows (trigger_type, enabled);
