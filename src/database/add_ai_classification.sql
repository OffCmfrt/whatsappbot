-- Add AI classification columns to support_tickets
-- sentiment: positive | neutral | negative | frustrated
-- ai_confidence: 0.0 - 1.0 from the LLM intent classifier
-- ai_scenario: classified SOP scenario (tracking, refund_policy, etc.)

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sentiment VARCHAR(20);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_confidence DECIMAL(3,2);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_scenario VARCHAR(50);

-- Index for sentiment-based filtering in the dashboard
CREATE INDEX IF NOT EXISTS idx_tickets_sentiment ON support_tickets(sentiment) WHERE sentiment IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_ai_scenario ON support_tickets(ai_scenario) WHERE ai_scenario IS NOT NULL;
