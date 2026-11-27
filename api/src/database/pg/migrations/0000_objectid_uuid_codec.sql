-- Phase 0: Bijective MongoDB ObjectId <-> Postgres RFC 9562 UUIDv8 codec
--
-- Maps all 2^96 MongoDB ObjectIds (including SHA-1-derived 24-hex IDs) into a
-- disjoint millisecond-aligned UUIDv8 subspace (`version = 8`, `magic = 6d`,
-- `variant+tag = a`, `ts_ms = uint32(T) * 1000 <= 4294967295000`, `ts_ms % 1000 = 0`).
-- Strictly order-preserving (`oid1 < oid2 <=> objectid_to_uuid(oid1) < objectid_to_uuid(oid2)`).

CREATE OR REPLACE FUNCTION objectid_to_uuid(oid text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  h text;
  ts_ms bigint;
  ts_hex text;
  rest text;
BEGIN
  IF oid !~ '^[0-9a-fA-F]{24}$' THEN
    RAISE EXCEPTION 'Invalid MongoDB ObjectId: %', oid USING ERRCODE = '22P02';
  END IF;
  h := lower(oid);
  -- Zero-pad to 64 bits so bit 31 = 1 (e.g. 0xffffffff SHA-1 derived IDs) stays unsigned
  ts_ms := (('x' || lpad(substr(h, 1, 8), 16, '0'))::bit(64)::bigint) * 1000::bigint;
  ts_hex := lpad(to_hex(ts_ms), 12, '0');
  rest := substr(h, 9, 16);
  RETURN (
    substr(ts_hex, 1, 8) || '-' ||
    substr(ts_hex, 9, 4) || '-' ||
    '86d' || substr(rest, 1, 1) || '-' ||
    'a' || substr(rest, 2, 3) || '-' ||
    substr(rest, 5, 12)
  )::uuid;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION is_objectid_uuid(u uuid)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  s text := replace(u::text, '-', '');
  ts_ms bigint;
BEGIN
  IF substr(s, 13, 3) <> '86d' OR substr(s, 17, 1) <> 'a' THEN
    RETURN false;
  END IF;
  ts_ms := ('x' || lpad(substr(s, 1, 12), 16, '0'))::bit(64)::bigint;
  RETURN ts_ms >= 0 AND ts_ms <= 4294967295000::bigint AND (ts_ms % 1000) = 0;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION uuid_to_objectid(u uuid)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  s text := replace(u::text, '-', '');
  ts_ms bigint;
BEGIN
  IF NOT is_objectid_uuid(u) THEN
    RAISE EXCEPTION 'UUID is not in ObjectId subspace: %', u USING ERRCODE = '22P02';
  END IF;
  ts_ms := ('x' || lpad(substr(s, 1, 12), 16, '0'))::bit(64)::bigint;
  RETURN lpad(to_hex(ts_ms / 1000), 8, '0') || substr(s, 16, 1) || substr(s, 18, 15);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION objectid_uuid_timestamp(u uuid)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN is_objectid_uuid(u)
    THEN to_timestamp((('x' || lpad(substr(replace(u::text, '-', ''), 1, 12), 16, '0'))::bit(64)::bigint) / 1000.0)
    ELSE NULL
  END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION generate_objectid_uuid()
RETURNS uuid
LANGUAGE sql
VOLATILE
AS $$
  SELECT objectid_to_uuid(
    lpad(to_hex(floor(extract(epoch FROM clock_timestamp()))::bigint & 4294967295::bigint), 8, '0')
    || substr(md5(gen_random_uuid()::text), 1, 16)
  );
$$;
