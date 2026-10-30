INSERT INTO buho.settings (key, value, updated_at)
VALUES (
  'alert_pack',
  '{"cache_hit":{"enabled":true,"warning":90,"critical":80}}'::jsonb,
  now()
)
ON CONFLICT (key) DO UPDATE
SET value = buho.settings.value || EXCLUDED.value,
    updated_at = now();

SELECT value FROM buho.settings WHERE key = 'alert_pack';
