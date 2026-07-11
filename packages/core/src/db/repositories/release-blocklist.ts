import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { sql, join, SqlFragment } from '../sql.js';
import {
  evaluateSourceVerdicts,
  type SourceVerdictRow,
} from '../../release-blocklist/evaluate.js';
import { dedupeRecords } from '../../release-blocklist/io.js';
import { isValidReleaseKey, releaseKeyKind } from '../../release-blocklist/keys.js';
import type {
  BlocklistEntry,
  BlocklistEvalOptions,
  BlocklistEvalResult,
  BlocklistRecord,
  BlocklistSource,
  BlocklistSourceKind,
  BlocklistTrust,
  BlocklistVerdict,
  ReleaseKeyKind,
} from '../../release-blocklist/types.js';
import {
  isBlocklistVerdict,
  LOCAL_SOURCE_ID,
  moreSevereVerdict,
  N_CAP,
} from '../../release-blocklist/types.js';

const KEY_CHUNK_SIZE = 500;
const INSERT_CHUNK_ROWS = 400;
const PRESENCE_TTL_MS = 30_000;

export const MIN_REFRESH_SECONDS = 60;
export const MAX_REFRESH_SECONDS = 30 * 24 * 3600;

type SourceRow = {
  id: string;
  kind: string;
  name: string;
  url: string | null;
  enabled: number | boolean;
  trust: string;
  refresh_seconds: number | string;
  etag: string | null;
  last_checked: number | string;
  last_updated: number | string;
  status: string | null;
  sort: number | string;
  count?: number | string;
};

type EntryRow = {
  source_id: string;
  k: string;
  kind: string;
  verdict: string;
  n: number | string;
  last_at: number | string;
  backbones: string;
  trust?: string;
  source_name?: string;
};

/** One release key aggregated across every source that flags it. */
export interface BlocklistAggregatedEntry {
  key: string;
  kind: ReleaseKeyKind;
  verdict: BlocklistVerdict;
  lastAt: number;
  overridden: boolean;
  sources: Array<{
    id: string;
    name: string;
    trust: BlocklistTrust;
    verdict: BlocklistVerdict;
    n: number;
    lastAt: number;
    backbones: string[];
  }>;
}

function num(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function csvToList(text: string | null | undefined): string[] {
  if (!text) return [];
  return [
    ...new Set(
      text
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    ),
  ];
}

function listToCsv(backbones: readonly string[]): string {
  return [...new Set(backbones.map((b) => b.trim()).filter(Boolean))].join(',');
}

/** Union that preserves "empty means applies everywhere". */
function mergeBackboneCsv(existing: string, incoming: readonly string[]): string {
  const current = csvToList(existing);
  const added = incoming.map((b) => b.trim()).filter(Boolean);
  if (current.length === 0 || added.length === 0) return '';
  return listToCsv([...current, ...added]);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function mapSource(row: SourceRow): BlocklistSource {
  return {
    id: row.id,
    kind: row.kind as BlocklistSourceKind,
    name: row.name,
    url: row.url,
    enabled: row.enabled === true || row.enabled === 1,
    trust: row.trust as BlocklistTrust,
    refreshSeconds: num(row.refresh_seconds),
    etag: row.etag,
    lastChecked: num(row.last_checked),
    lastUpdated: num(row.last_updated),
    status: row.status,
    sort: num(row.sort),
    count: num(row.count),
  };
}

function mapEntry(row: EntryRow): BlocklistEntry {
  return {
    key: row.k,
    kind: row.kind as ReleaseKeyKind,
    verdict: row.verdict as BlocklistVerdict,
    n: num(row.n),
    lastAt: num(row.last_at),
    backbones: csvToList(row.backbones),
  };
}

function requireValidKey(key: string): ReleaseKeyKind {
  const kind = releaseKeyKind(key);
  if (!kind) throw new Error(`invalid release key: ${key}`);
  return kind;
}

export function clampRefreshSeconds(value: number): number {
  if (!Number.isFinite(value)) return 86400;
  return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.floor(value)));
}

const SOURCE_COLUMNS = sql`id, kind, name, url, enabled, trust, refresh_seconds, etag, last_checked, last_updated, status, sort`;

export class ReleaseBlocklistRepository {
  private static presence: { value: boolean; at: number } | null = null;

  private static invalidatePresence(): void {
    this.presence = null;
  }

  /** Cheap gate for the stream hot path: does any entry exist at all? */
  static async hasEntries(): Promise<boolean> {
    const cached = this.presence;
    if (cached && Date.now() - cached.at < PRESENCE_TTL_MS) {
      return cached.value;
    }
    const count = await getDb().count(
      sql`SELECT COUNT(*) FROM (SELECT 1 FROM release_blocklist_entries LIMIT 1) t`
    );
    const value = count > 0;
    this.presence = { value, at: Date.now() };
    return value;
  }

  /**
   * Evaluate keys against all enabled non-observe sources. Entries whose
   * key has an override row are suppressed unless they are local. The
   * result map only contains keys that had at least one row.
   */
  static async evaluateKeys(
    keys: string[],
    opts: BlocklistEvalOptions
  ): Promise<Map<string, BlocklistEvalResult>> {
    const result = new Map<string, BlocklistEvalResult>();
    const unique = [...new Set(keys.filter((k) => isValidReleaseKey(k)))];
    if (unique.length === 0) return result;

    const rowsByKey = new Map<string, SourceVerdictRow[]>();
    for (let i = 0; i < unique.length; i += KEY_CHUNK_SIZE) {
      const chunk = unique.slice(i, i + KEY_CHUNK_SIZE);
      const placeholders = join(chunk.map((k) => sql`${k}`));
      const rows = await getDb().query<EntryRow>(
        sql`SELECT e.source_id, e.k, e.kind, e.verdict, e.n, e.last_at, e.backbones, s.trust
            FROM release_blocklist_entries e
            JOIN release_blocklist_sources s ON s.id = e.source_id
            LEFT JOIN release_blocklist_overrides o ON o.k = e.k
            WHERE e.k IN (${placeholders})
              AND s.enabled = 1
              AND s.trust IN ('full','corroborate')
              AND (o.k IS NULL OR e.source_id = ${LOCAL_SOURCE_ID})`
      );
      for (const row of rows) {
        const list = rowsByKey.get(row.k) ?? [];
        list.push({
          sourceId: row.source_id,
          isLocal: row.source_id === LOCAL_SOURCE_ID,
          trust: row.trust as BlocklistTrust,
          verdict: row.verdict as BlocklistVerdict,
          backbones: csvToList(row.backbones),
        });
        rowsByKey.set(row.k, list);
      }
    }

    for (const [key, rows] of rowsByKey) {
      result.set(key, evaluateSourceVerdicts(rows, opts));
    }
    return result;
  }

  /** Whether this instance's own list flags the key, any verdict. */
  static async isLocallyBlocked(key: string): Promise<boolean> {
    if (!isValidReleaseKey(key)) return false;
    const row = await getDb().maybeOne(
      sql`SELECT 1 AS present FROM release_blocklist_entries
          WHERE source_id = ${LOCAL_SOURCE_ID} AND k = ${key} LIMIT 1`
    );
    return row !== null;
  }

  /**
   * Record a local verdict. Re-marking keeps the most severe verdict,
   * bumps the observation count and unions the backbone scope (an empty
   * scope on either side widens to "applies everywhere"). Clears any
   * override for the key.
   */
  static async markVerdict(
    key: string,
    verdict: BlocklistVerdict,
    backbones: readonly string[] = []
  ): Promise<void> {
    const kind = requireValidKey(key);
    if (!isBlocklistVerdict(verdict)) {
      throw new Error(`invalid verdict: ${verdict}`);
    }
    const now = nowSeconds();
    await getDb().tx(async (tx) => {
      await tx.exec(
        sql`DELETE FROM release_blocklist_overrides WHERE k = ${key}`
      );
      const existing = await tx.maybeOne<EntryRow>(
        sql`SELECT source_id, k, kind, verdict, n, last_at, backbones
            FROM release_blocklist_entries
            WHERE source_id = ${LOCAL_SOURCE_ID} AND k = ${key}`
      );
      const merged = existing
        ? {
            verdict: moreSevereVerdict(
              existing.verdict as BlocklistVerdict,
              verdict
            ),
            n: Math.min(N_CAP, num(existing.n) + 1),
            lastAt: Math.max(num(existing.last_at), now),
            backbones: mergeBackboneCsv(existing.backbones, backbones),
          }
        : {
            verdict,
            n: 1,
            lastAt: now,
            backbones: listToCsv(backbones),
          };
      await tx.exec(
        sql`INSERT INTO release_blocklist_entries (source_id, k, kind, verdict, n, last_at, backbones)
            VALUES (${LOCAL_SOURCE_ID}, ${key}, ${kind}, ${merged.verdict}, ${merged.n}, ${merged.lastAt}, ${merged.backbones})
            ON CONFLICT (source_id, k) DO UPDATE SET
              verdict = EXCLUDED.verdict,
              n = EXCLUDED.n,
              last_at = EXCLUDED.last_at,
              backbones = EXCLUDED.backbones`
      );
    });
    this.invalidatePresence();
  }

  /**
   * The release was proven working: drop the local verdict and write an
   * override that suppresses remote verdicts for the key.
   */
  static async retract(key: string): Promise<void> {
    requireValidKey(key);
    const now = nowSeconds();
    await getDb().tx(async (tx) => {
      await tx.exec(
        sql`DELETE FROM release_blocklist_entries
            WHERE source_id = ${LOCAL_SOURCE_ID} AND k = ${key}`
      );
      await tx.exec(
        sql`INSERT INTO release_blocklist_overrides (k, created_at)
            VALUES (${key}, ${now})
            ON CONFLICT (k) DO UPDATE SET created_at = EXCLUDED.created_at`
      );
    });
    this.invalidatePresence();
  }

  /**
   * Replace a source's entries with a fetched/imported list. Records are
   * deduplicated and validated first; a non-empty payload that yields zero
   * valid rows throws so a bad fetch cannot wipe a good source.
   */
  static async bulkReplace(
    sourceId: string,
    records: readonly BlocklistRecord[]
  ): Promise<number> {
    const valid = dedupeRecords(
      records.filter(
        (r) => isValidReleaseKey(r.k) && isBlocklistVerdict(r.v)
      )
    );
    if (records.length > 0 && valid.length === 0) {
      throw new Error('payload contains no valid blocklist records');
    }
    await getDb().tx(async (tx) => {
      await tx.exec(
        sql`DELETE FROM release_blocklist_entries WHERE source_id = ${sourceId}`
      );
      for (let i = 0; i < valid.length; i += INSERT_CHUNK_ROWS) {
        const chunk = valid.slice(i, i + INSERT_CHUNK_ROWS);
        const values = join(
          chunk.map(
            (r) =>
              sql`(${sourceId}, ${r.k}, ${releaseKeyKind(r.k)}, ${r.v}, ${Math.min(N_CAP, Math.max(1, r.n))}, ${Math.max(0, r.at)}, ${listToCsv(r.bk ?? [])})`
          )
        );
        await tx.exec(
          sql`INSERT INTO release_blocklist_entries (source_id, k, kind, verdict, n, last_at, backbones)
              VALUES ${values}`
        );
      }
    });
    this.invalidatePresence();
    return valid.length;
  }

  static async getSources(): Promise<BlocklistSource[]> {
    const rows = await getDb().query<SourceRow>(
      sql`SELECT ${SOURCE_COLUMNS},
             (SELECT COUNT(*) FROM release_blocklist_entries e WHERE e.source_id = s.id) AS count
          FROM release_blocklist_sources s
          ORDER BY CASE WHEN s.id = ${LOCAL_SOURCE_ID} THEN 0 ELSE 1 END, s.sort, s.name`
    );
    return rows.map(mapSource);
  }

  static async getSource(id: string): Promise<BlocklistSource | undefined> {
    const row = await getDb().maybeOne<SourceRow>(
      sql`SELECT ${SOURCE_COLUMNS},
             (SELECT COUNT(*) FROM release_blocklist_entries e WHERE e.source_id = s.id) AS count
          FROM release_blocklist_sources s WHERE s.id = ${id}`
    );
    return row ? mapSource(row) : undefined;
  }

  static async addSource(input: {
    kind: Exclude<BlocklistSourceKind, 'local'>;
    name: string;
    url?: string;
    trust?: BlocklistTrust;
    refreshSeconds?: number;
  }): Promise<BlocklistSource> {
    const id = randomUUID();
    await getDb().exec(
      sql`INSERT INTO release_blocklist_sources
            (id, kind, name, url, enabled, trust, refresh_seconds)
          VALUES (${id}, ${input.kind}, ${input.name}, ${input.url ?? null}, 1,
                  ${input.trust ?? 'full'},
                  ${clampRefreshSeconds(input.refreshSeconds ?? 86400)})`
    );
    const source = await this.getSource(id);
    if (!source) throw new Error('source insert failed');
    return source;
  }

  static async updateSource(
    id: string,
    fields: {
      name?: string;
      url?: string;
      enabled?: boolean;
      trust?: BlocklistTrust;
      refreshSeconds?: number;
    }
  ): Promise<void> {
    if (id === LOCAL_SOURCE_ID) {
      const touchesProtected =
        fields.trust !== undefined ||
        fields.url !== undefined ||
        fields.enabled !== undefined;
      if (touchesProtected) {
        throw new Error('the local source cannot be disabled or re-trusted');
      }
    }
    const sets: SqlFragment[] = [];
    if (fields.name !== undefined) sets.push(sql`name = ${fields.name}`);
    if (fields.url !== undefined) sets.push(sql`url = ${fields.url}`);
    if (fields.enabled !== undefined) {
      sets.push(sql`enabled = ${fields.enabled ? 1 : 0}`);
    }
    if (fields.trust !== undefined) sets.push(sql`trust = ${fields.trust}`);
    if (fields.refreshSeconds !== undefined) {
      sets.push(
        sql`refresh_seconds = ${clampRefreshSeconds(fields.refreshSeconds)}`
      );
    }
    if (sets.length === 0) return;
    await getDb().exec(
      sql`UPDATE release_blocklist_sources SET ${join(sets)} WHERE id = ${id}`
    );
    this.invalidatePresence();
  }

  static async removeSource(id: string): Promise<void> {
    if (id === LOCAL_SOURCE_ID) {
      throw new Error('the local source cannot be removed');
    }
    await getDb().exec(
      sql`DELETE FROM release_blocklist_sources WHERE id = ${id}`
    );
    this.invalidatePresence();
  }

  static async clearSource(id: string): Promise<void> {
    await getDb().exec(
      sql`DELETE FROM release_blocklist_entries WHERE source_id = ${id}`
    );
    this.invalidatePresence();
  }

  static async setSourceStatus(
    id: string,
    fields: {
      status?: string | null;
      etag?: string | null;
      lastChecked?: number;
      lastUpdated?: number;
    }
  ): Promise<void> {
    const sets: SqlFragment[] = [];
    if (fields.status !== undefined) sets.push(sql`status = ${fields.status}`);
    if (fields.etag !== undefined) sets.push(sql`etag = ${fields.etag}`);
    if (fields.lastChecked !== undefined) {
      sets.push(sql`last_checked = ${fields.lastChecked}`);
    }
    if (fields.lastUpdated !== undefined) {
      sets.push(sql`last_updated = ${fields.lastUpdated}`);
    }
    if (sets.length === 0) return;
    await getDb().exec(
      sql`UPDATE release_blocklist_sources SET ${join(sets)} WHERE id = ${id}`
    );
  }

  static async deleteLocalEntry(key: string): Promise<void> {
    await getDb().exec(
      sql`DELETE FROM release_blocklist_entries
          WHERE source_id = ${LOCAL_SOURCE_ID} AND k = ${key}`
    );
    this.invalidatePresence();
  }

  static async listEntries(params: {
    search?: string;
    sourceId?: string;
    verdict?: BlocklistVerdict;
    kind?: ReleaseKeyKind;
    limit: number;
    offset: number;
  }): Promise<{ entries: BlocklistAggregatedEntry[]; total: number }> {
    const filters: SqlFragment[] = [];
    if (params.search) {
      const escaped = params.search.replace(/[\\%_]/g, (c) => `\\${c}`);
      filters.push(sql`e.k LIKE ${`%${escaped}%`} ESCAPE '\\'`);
    }
    if (params.sourceId) filters.push(sql`e.source_id = ${params.sourceId}`);
    if (params.verdict) filters.push(sql`e.verdict = ${params.verdict}`);
    if (params.kind) filters.push(sql`e.kind = ${params.kind}`);
    const where =
      filters.length > 0
        ? sql`WHERE ${join(filters, ' AND ')}`
        : sql``;

    const total = await getDb().count(
      sql`SELECT COUNT(DISTINCT e.k) FROM release_blocklist_entries e ${where}`
    );
    const keyRows = await getDb().query<{ k: string }>(
      sql`SELECT e.k, MAX(e.last_at) AS max_at
          FROM release_blocklist_entries e ${where}
          GROUP BY e.k
          ORDER BY max_at DESC
          LIMIT ${params.limit} OFFSET ${params.offset}`
    );
    const keys = keyRows.map((r) => r.k);
    if (keys.length === 0) return { entries: [], total };

    const placeholders = join(keys.map((k) => sql`${k}`));
    const rows = await getDb().query<EntryRow>(
      sql`SELECT e.source_id, e.k, e.kind, e.verdict, e.n, e.last_at, e.backbones,
                 s.trust, s.name AS source_name
          FROM release_blocklist_entries e
          JOIN release_blocklist_sources s ON s.id = e.source_id
          WHERE e.k IN (${placeholders})`
    );
    const overrideRows = await getDb().query<{ k: string }>(
      sql`SELECT k FROM release_blocklist_overrides WHERE k IN (${placeholders})`
    );
    const overridden = new Set(overrideRows.map((r) => r.k));

    const byKey = new Map<string, BlocklistAggregatedEntry>();
    for (const row of rows) {
      const entry = mapEntry(row);
      let aggregate = byKey.get(row.k);
      if (!aggregate) {
        aggregate = {
          key: row.k,
          kind: entry.kind,
          verdict: entry.verdict,
          lastAt: 0,
          overridden: overridden.has(row.k),
          sources: [],
        };
        byKey.set(row.k, aggregate);
      }
      aggregate.sources.push({
        id: row.source_id,
        name: row.source_name ?? row.source_id,
        trust: (row.trust ?? 'full') as BlocklistTrust,
        verdict: entry.verdict,
        n: entry.n,
        lastAt: entry.lastAt,
        backbones: entry.backbones,
      });
      aggregate.verdict = moreSevereVerdict(aggregate.verdict, entry.verdict);
      aggregate.lastAt = Math.max(aggregate.lastAt, entry.lastAt);
    }
    const entries = keys
      .map((key) => byKey.get(key))
      .filter((entry): entry is BlocklistAggregatedEntry => Boolean(entry));
    return { entries, total };
  }

  static async getEntries(
    sourceIds?: string[],
    dedup = false
  ): Promise<BlocklistRecord[]> {
    let where = sql``;
    if (sourceIds && sourceIds.length > 0) {
      const placeholders = join(sourceIds.map((id) => sql`${id}`));
      where = sql`WHERE source_id IN (${placeholders})`;
    }
    const rows = await getDb().query<EntryRow>(
      sql`SELECT source_id, k, kind, verdict, n, last_at, backbones
          FROM release_blocklist_entries ${where}`
    );
    const records = rows.map((row) => {
      const entry = mapEntry(row);
      return {
        k: entry.key,
        v: entry.verdict,
        n: entry.n,
        at: entry.lastAt,
        bk: entry.backbones,
      };
    });
    return dedup ? dedupeRecords(records) : records;
  }

  static async getCounts(): Promise<{
    total: number;
    overrides: number;
  }> {
    const total = await getDb().count(
      sql`SELECT COUNT(*) FROM release_blocklist_entries`
    );
    const overrides = await getDb().count(
      sql`SELECT COUNT(*) FROM release_blocklist_overrides`
    );
    return { total, overrides };
  }

  /** Distinct backbone root domains observed across all entries. */
  static async getDistinctBackbones(): Promise<string[]> {
    const rows = await getDb().query<{ backbones: string }>(
      sql`SELECT DISTINCT backbones FROM release_blocklist_entries
          WHERE backbones <> ''`
    );
    const set = new Set<string>();
    for (const row of rows) {
      for (const backbone of csvToList(row.backbones)) set.add(backbone);
    }
    return [...set].sort();
  }

  /** Cheap change marker for export ETags. */
  static async getExportRevision(scope: 'local' | 'all'): Promise<string> {
    const where =
      scope === 'local' ? sql`WHERE source_id = ${LOCAL_SOURCE_ID}` : sql``;
    const row = await getDb().maybeOne<{
      c: number | string;
      m: number | string;
    }>(
      sql`SELECT COUNT(*) AS c, COALESCE(MAX(last_at), 0) AS m
          FROM release_blocklist_entries ${where}`
    );
    return `${num(row?.c)}:${num(row?.m)}`;
  }

  static async listOverrides(
    limit: number,
    offset: number
  ): Promise<{ overrides: Array<{ key: string; createdAt: number }>; total: number }> {
    const total = await getDb().count(
      sql`SELECT COUNT(*) FROM release_blocklist_overrides`
    );
    const rows = await getDb().query<{ k: string; created_at: number | string }>(
      sql`SELECT k, created_at FROM release_blocklist_overrides
          ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
    );
    return {
      overrides: rows.map((row) => ({
        key: row.k,
        createdAt: num(row.created_at),
      })),
      total,
    };
  }

  static async clearOverride(key: string): Promise<void> {
    await getDb().exec(
      sql`DELETE FROM release_blocklist_overrides WHERE k = ${key}`
    );
  }

  static async clearAllOverrides(): Promise<void> {
    await getDb().exec(sql`DELETE FROM release_blocklist_overrides`);
  }
}
