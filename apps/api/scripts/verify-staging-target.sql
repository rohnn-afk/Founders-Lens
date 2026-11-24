\set ON_ERROR_STOP on
-- Run over verify-full with independently reviewed system identifier and OID pairs.
SELECT current_database() = 'founders_lens_staging'
  AND NOT pg_catalog.pg_is_in_recovery()
  AND EXISTS (SELECT FROM pg_catalog.pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl)
  AND system_identifier::text || ':' || d.oid::text = :'expected_identity'
  AND system_identifier::text <> split_part(:'authority_identity', ':', 1)
  AND :'authority_identity' ~ '^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$'
  AND to_regnamespace('authority') IS NULL AS target_verified
FROM pg_catalog.pg_control_system(), pg_catalog.pg_database d
WHERE d.datname = current_database()
\gset

\if :target_verified
\else
  \echo STAGING_PRIMARY_TARGET_DENIED
  SELECT 1 / 0;
\endif
