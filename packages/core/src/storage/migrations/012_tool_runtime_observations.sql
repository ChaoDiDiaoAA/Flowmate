BEGIN IMMEDIATE;
ALTER TABLE tool_calls
ADD COLUMN runtime_observation_json TEXT NULL
CHECK (
  runtime_observation_json IS NULL
  OR CASE
    WHEN json_valid(runtime_observation_json) THEN
      COALESCE(
        json_type(runtime_observation_json, '$.version') = 'integer'
        AND json_extract(runtime_observation_json, '$.version') = 1,
        0
      )
    ELSE 0
  END
);

CREATE INDEX tool_calls_runtime_observation_recent
ON tool_calls (
  json_extract(runtime_observation_json, '$.groupKey'),
  id DESC
)
WHERE runtime_observation_json IS NOT NULL;

INSERT INTO schema_migrations(version, applied_at)
VALUES(12, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
