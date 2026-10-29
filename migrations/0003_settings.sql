-- Site settings. Holds the SHA-256 of the admin key ('admin_key_sha256'), never the key itself.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
