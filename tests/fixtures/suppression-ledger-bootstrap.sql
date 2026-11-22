-- Initialize only the disposable authority cluster. Runtime logins have no
-- ownership; the fixture administrator is reserved for coverage and fault injection.
\getenv reader_password FL_SUPPRESSION_READER_PASSWORD
\getenv writer_password FL_SUPPRESSION_WRITER_PASSWORD
BEGIN;
REVOKE ALL ON DATABASE suppression_proof FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE ROLE ledger_owner NOLOGIN NOINHERIT;
CREATE ROLE ledger_reader LOGIN NOINHERIT PASSWORD :'reader_password';
CREATE ROLE ledger_writer LOGIN NOINHERIT PASSWORD :'writer_password';
GRANT CONNECT ON DATABASE suppression_proof TO ledger_reader, ledger_writer;
CREATE SCHEMA authority AUTHORIZATION ledger_owner;
SET LOCAL ROLE ledger_owner;
-- No initial coverage row. A fresh cluster must not clear any scope until sealed.
CREATE TABLE authority.coverage (
  singleton boolean PRIMARY KEY CHECK (singleton),
  epoch uuid NOT NULL,
  integrity text NOT NULL CHECK (integrity ~ '^[0-9a-f]{64}$'),
  subject_versions integer[] NOT NULL CHECK (cardinality(subject_versions) BETWEEN 1 AND 16)
);
-- Independent uniqueness constraints arbitrate competing operations and scopes.
CREATE TABLE authority.intent (
  operation_id uuid PRIMARY KEY,
  scope_key text NOT NULL UNIQUE CHECK (length(scope_key) BETWEEN 1 AND 512),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-zA-Z0-9_-]{1,60}$'),
  integrity text NOT NULL CHECK (integrity ~ '^[0-9a-f]{64}$')
);
CREATE TABLE authority.inventory_count (
  singleton boolean PRIMARY KEY CHECK (singleton),
  total bigint NOT NULL CHECK (total >= 0)
);
INSERT INTO authority.inventory_count VALUES (true, 0);
-- Count committed inserts in the same transaction. The fixed search path and
-- qualified target keep the trigger independent of caller-controlled names.
CREATE FUNCTION authority.count_intent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE authority.inventory_count SET total = total + 1 WHERE singleton;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION authority.count_intent() FROM PUBLIC;
CREATE TRIGGER count_intent AFTER INSERT ON authority.intent
FOR EACH ROW EXECUTE FUNCTION authority.count_intent();
GRANT USAGE ON SCHEMA authority TO ledger_reader, ledger_writer;
-- Both roles need the proof inventory for verification. Only the writer can
-- append; neither can alter coverage, the count, or existing history.
GRANT SELECT ON authority.coverage, authority.intent, authority.inventory_count TO ledger_reader, ledger_writer;
GRANT INSERT ON authority.intent TO ledger_writer;
COMMIT;
