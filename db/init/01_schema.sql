CREATE TABLE IF NOT EXISTS criminals (
  id           SERIAL PRIMARY KEY,
  full_name    TEXT        NOT NULL,
  alias        TEXT,
  nationality  TEXT,
  crime        TEXT        NOT NULL,
  danger_level SMALLINT    NOT NULL DEFAULT 1 CHECK (danger_level BETWEEN 1 AND 5),
  captured     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_criminals_alias ON criminals (alias);
