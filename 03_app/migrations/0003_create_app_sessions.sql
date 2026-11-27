-- Migration 0003: login sessions for the shared team password.
--
-- One row per successful login. Only the SHA-256 hash of the random session token is stored; the
-- token itself lives only in the browser's HttpOnly cookie. No name, email, IP address or other
-- personal data is stored. Logging out deletes the row; expired rows are removed on the next login.
-- The Better Auth tables from 0002 and every analysis_history row are left untouched.

CREATE TABLE app_session (
  token_hash TEXT    PRIMARY KEY NOT NULL,   -- hex SHA-256 of the cookie token
  created_at INTEGER NOT NULL,               -- Unix epoch milliseconds (UTC)
  expires_at INTEGER NOT NULL                -- Unix epoch milliseconds (UTC)
);

CREATE INDEX idx_app_session_expires ON app_session (expires_at);
