-- Init schema for contest
CREATE TABLE IF NOT EXISTS contest_state (
  id integer PRIMARY KEY CHECK (id = 1),
  winner_actor_hash text,
  winner_claimed_at timestamptz,
  contact_submitted boolean NOT NULL DEFAULT false
);

INSERT INTO contest_state (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS attempt_locks (
  actor_hash text PRIMARY KEY,
  failed_count integer NOT NULL DEFAULT 0,
  blocked_until timestamptz
);

CREATE TABLE IF NOT EXISTS winner_claim_tokens (
  token_hash text PRIMARY KEY,
  actor_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE IF NOT EXISTS winner_contacts (
  id bigserial PRIMARY KEY,
  actor_hash text NOT NULL UNIQUE,
  name text NOT NULL,
  email text NOT NULL,
  phone text
);
