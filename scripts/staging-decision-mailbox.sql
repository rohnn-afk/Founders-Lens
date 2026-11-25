-- Review and apply separately as the authority operator. The two logins must
-- already exist. The writer must be dedicated and must not own the schema.
BEGIN;
CREATE SCHEMA staging_release;
REVOKE ALL ON SCHEMA staging_release FROM PUBLIC;
CREATE TABLE staging_release.read_decisions (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  issued_at bigint NOT NULL CHECK (issued_at >= 0),
  pair jsonb CHECK (pair IS NULL OR (jsonb_typeof(pair) = 'object' AND octet_length(pair::text) <= 5000)),
  CHECK ((issued_at = 0) = (pair IS NULL))
);
INSERT INTO staging_release.read_decisions (issued_at, pair) VALUES (0, NULL);
REVOKE ALL ON staging_release.read_decisions FROM PUBLIC;
GRANT USAGE ON SCHEMA staging_release TO ledger_reader, staging_decision_writer;
GRANT SELECT (singleton, pair) ON staging_release.read_decisions TO ledger_reader;
GRANT SELECT (singleton, issued_at), UPDATE (issued_at, pair)
  ON staging_release.read_decisions TO staging_decision_writer;
COMMIT;
