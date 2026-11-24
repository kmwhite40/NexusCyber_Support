-- Link risks imported from the SBSFederal risk-register spreadsheet to the controls their
-- "Impacted controls:" line names, now that 0088 loaded the full NIST SP 800-53 Rev. 5 catalog.
--
-- The importer only links a control that exists in compliance_controls; before 0088 the catalog
-- held 10 controls, so most imported risks kept their controls as text only. This reads that
-- line back, normalizes each id exactly as the importer does ("CM-06" -> "CM-6",
-- "SC-07(10)" -> "SC-7(10)"), and adds the missing links.
--
-- Scope: only risks with external_source = 'sharepoint-legacy' (a format this migration knows).
-- Idempotent: ON CONFLICT DO NOTHING on risk_links (risk_id, kind, ref); ids that are not in the
-- catalog are skipped, never invented. A no-op on any database without imported risks.
INSERT INTO risk_links (organization_id, risk_id, kind, ref, label)
SELECT DISTINCT r.organization_id, r.id, 'control', c.control_id, c.control_id || ' · ' || c.title
  FROM risks r
  CROSS JOIN LATERAL regexp_matches(
         upper(coalesce(substring(r.description FROM 'Impacted controls: ([^\n]*)'), '')),
         '([A-Z]{2})-0*([0-9]{1,2})(\s*\(0*([0-9]{1,2})\))?', 'g') AS m
  JOIN compliance_controls c
    ON c.control_id = m[1] || '-' || m[2] || coalesce('(' || m[4] || ')', '')
 WHERE r.external_source = 'sharepoint-legacy'
ON CONFLICT (risk_id, kind, ref) DO NOTHING;
