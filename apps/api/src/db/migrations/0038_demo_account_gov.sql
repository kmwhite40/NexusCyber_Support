-- Working demo toggle account. One demo identity flips between an AGENT view (Tier2,
-- scoped to "Demo Corp") and a CUSTOMER view (OrgAdmin in Demo Corp) via /auth/demo/toggle.
-- Both sign in with password 'AnchorDemo!2026' (scrypt). Tier2 has NO org.manage, so the
-- demo cannot view or change real customer orgs (RLS + capability scope). Idempotent.
DO $$
DECLARE
  org uuid; admin_id uuid; cust_id uuid;
  pw text := 'scrypt$c52289c19d4e1262586eebfdb7f35ce0$fc15960eadd642f069a50768a1040e1a4f65ecf49ff671d01c29228b116588b7e6203f02248439050dc2a2089e11021c5c9b0e8921f5cc5020e8d4300fefb17d';
BEGIN
  SELECT id INTO org FROM organizations WHERE name = 'Demo Corp';
  IF org IS NULL THEN
    INSERT INTO organizations (name, cloud, enclave_id, status)
    VALUES ('Demo Corp', 'gcchigh', 'gov', 'active') RETURNING id INTO org;
  END IF;

  -- Customer view (OrgAdmin in Demo Corp)
  INSERT INTO users (plane, organization_id, email, display_name, password_hash, is_demo)
  VALUES ('customer', org, 'demo@anchor.us', 'Demo — Customer view', pw, true)
  ON CONFLICT (plane, email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
    is_demo = true, organization_id = EXCLUDED.organization_id, display_name = EXCLUDED.display_name
  RETURNING id INTO cust_id;
  INSERT INTO role_assignments (user_id, role_id, organization_id)
    SELECT cust_id, id, org FROM roles WHERE key = 'OrgAdmin' ON CONFLICT DO NOTHING;

  -- Agent view (nexus Tier2, scoped to Demo Corp)
  INSERT INTO users (plane, organization_id, email, display_name, password_hash, is_demo)
  VALUES ('nexus', NULL, 'demo-admin@anchor.us', 'Demo — Agent view', pw, true)
  ON CONFLICT (plane, email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
    is_demo = true, display_name = EXCLUDED.display_name
  RETURNING id INTO admin_id;
  INSERT INTO role_assignments (user_id, role_id, organization_id)
    SELECT admin_id, id, org FROM roles WHERE key = 'Tier2' ON CONFLICT DO NOTHING;

  -- Pair them for the toggle.
  UPDATE users SET demo_pair_user_id = admin_id WHERE id = cust_id;
  UPDATE users SET demo_pair_user_id = cust_id WHERE id = admin_id;
END $$;
