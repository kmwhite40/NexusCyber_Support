-- Demo accounts: a single demo identity can toggle between an admin (control-plane) view
-- and a customer (portal) view. The two linked identities are flagged is_demo and point at
-- each other via demo_pair_user_id; an authenticated demo user can swap to its pair.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_pair_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
