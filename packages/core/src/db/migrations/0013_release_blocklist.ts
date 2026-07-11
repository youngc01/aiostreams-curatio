import type { Migration } from './types.js';

/**
 * Release blocklist: shareable verdicts about known-bad releases, keyed by
 * a provider/indexer-agnostic release key (`wd1:` usenet fingerprint,
 * `nh1:` NZB content hash or `btih:` torrent infohash). One entry per
 * (source, key); sources are the
 * always-present local list plus subscribed/imported lists. Overrides
 * suppress remote verdicts for releases this instance proved working.
 * `usenet_library.release_key` links library rows to their release key for
 * dashboard block/unblock actions.
 */
export const releaseBlocklist: Migration = {
  id: 13,
  name: 'release_blocklist',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS release_blocklist_sources (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        name            TEXT NOT NULL,
        url             TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        trust           TEXT NOT NULL DEFAULT 'full',
        refresh_seconds INTEGER NOT NULL DEFAULT 86400,
        etag            TEXT,
        last_checked    INTEGER NOT NULL DEFAULT 0,
        last_updated    INTEGER NOT NULL DEFAULT 0,
        status          TEXT,
        sort            INTEGER NOT NULL DEFAULT 0,
        CHECK (kind IN ('local','remote','imported')),
        CHECK (enabled IN (0,1)),
        CHECK (trust IN ('full','corroborate','observe')),
        CHECK (refresh_seconds >= 60),
        CHECK (kind <> 'remote' OR (url IS NOT NULL AND trim(url) <> ''))
      );

      CREATE TABLE IF NOT EXISTS release_blocklist_entries (
        source_id TEXT NOT NULL REFERENCES release_blocklist_sources(id) ON DELETE CASCADE,
        k         TEXT NOT NULL,
        kind      TEXT NOT NULL,
        verdict   TEXT NOT NULL,
        n         INTEGER NOT NULL DEFAULT 1,
        last_at   INTEGER NOT NULL DEFAULT 0,
        backbones TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, k),
        CHECK ((kind = 'torrent' AND substr(k,1,5) = 'btih:') OR (kind = 'usenet' AND substr(k,1,4) IN ('wd1:','nh1:'))),
        CHECK (verdict IN ('dead','defective','fake','mislabeled')),
        CHECK (n >= 0),
        CHECK (last_at >= 0)
      );

      CREATE INDEX IF NOT EXISTS idx_release_blocklist_entries_k
        ON release_blocklist_entries (k);

      CREATE TABLE IF NOT EXISTS release_blocklist_overrides (
        k          TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL DEFAULT 0
      );

      INSERT OR IGNORE INTO release_blocklist_sources
        (id, kind, name, url, enabled, trust, refresh_seconds)
        VALUES ('local', 'local', 'This instance', NULL, 1, 'full', 86400);

      ALTER TABLE usenet_library ADD COLUMN release_key TEXT;
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS release_blocklist_sources (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        name            TEXT NOT NULL,
        url             TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        trust           TEXT NOT NULL DEFAULT 'full',
        refresh_seconds BIGINT NOT NULL DEFAULT 86400,
        etag            TEXT,
        last_checked    BIGINT NOT NULL DEFAULT 0,
        last_updated    BIGINT NOT NULL DEFAULT 0,
        status          TEXT,
        sort            INTEGER NOT NULL DEFAULT 0,
        CHECK (kind IN ('local','remote','imported')),
        CHECK (enabled IN (0,1)),
        CHECK (trust IN ('full','corroborate','observe')),
        CHECK (refresh_seconds >= 60),
        CHECK (kind <> 'remote' OR (url IS NOT NULL AND trim(url) <> ''))
      );

      CREATE TABLE IF NOT EXISTS release_blocklist_entries (
        source_id TEXT NOT NULL REFERENCES release_blocklist_sources(id) ON DELETE CASCADE,
        k         TEXT NOT NULL,
        kind      TEXT NOT NULL,
        verdict   TEXT NOT NULL,
        n         BIGINT NOT NULL DEFAULT 1,
        last_at   BIGINT NOT NULL DEFAULT 0,
        backbones TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, k),
        CHECK ((kind = 'torrent' AND substr(k,1,5) = 'btih:') OR (kind = 'usenet' AND substr(k,1,4) IN ('wd1:','nh1:'))),
        CHECK (verdict IN ('dead','defective','fake','mislabeled')),
        CHECK (n >= 0),
        CHECK (last_at >= 0)
      );

      CREATE INDEX IF NOT EXISTS idx_release_blocklist_entries_k
        ON release_blocklist_entries (k);

      CREATE TABLE IF NOT EXISTS release_blocklist_overrides (
        k          TEXT PRIMARY KEY,
        created_at BIGINT NOT NULL DEFAULT 0
      );

      INSERT INTO release_blocklist_sources
        (id, kind, name, url, enabled, trust, refresh_seconds)
        VALUES ('local', 'local', 'This instance', NULL, 1, 'full', 86400)
        ON CONFLICT (id) DO NOTHING;

      ALTER TABLE usenet_library ADD COLUMN IF NOT EXISTS release_key TEXT;
    `,
  },
};
