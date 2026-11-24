-- Versioned scoring methodology for risks.
--
-- The bands that turn a 1-25 score into a rating live in code (risk-scoring.ts METHODOLOGIES), one
-- immutable entry per version. Each risk, and each history snapshot, records the version that
-- scored it, so moving the default to new bands never silently re-rates an existing assessment.
--
-- Existing rows were scored under the original bands: they get 'nexus-5x5@1'. Everything created
-- from now on defaults to 'nexus-5x5@2' (Anchor default: 1-4 Low, 5-9 Moderate, 10-14 High,
-- 15-19 Very High, 20-25 Critical); a re-scored risk is moved to the active version by the app.
-- Non-destructive: two added columns, no data rewritten beyond filling them.
ALTER TABLE risks ADD COLUMN IF NOT EXISTS methodology text NOT NULL DEFAULT 'nexus-5x5@1';
ALTER TABLE risks ALTER COLUMN methodology SET DEFAULT 'nexus-5x5@2';
ALTER TABLE risks DROP CONSTRAINT IF EXISTS risks_methodology_known;
ALTER TABLE risks ADD CONSTRAINT risks_methodology_known CHECK (methodology IN ('nexus-5x5@1', 'nexus-5x5@2'));

ALTER TABLE risk_history ADD COLUMN IF NOT EXISTS methodology text;
UPDATE risk_history SET methodology = 'nexus-5x5@1' WHERE methodology IS NULL;
