import {
  ServiceId,
  createLogger,
  DistributedLock,
  Time,
} from '../utils/index.js';
import {
  DebridServiceConfig,
  DebridDownload,
  DebridFile,
  PlaybackInfo,
  DebridError,
  TorrentDebridService,
} from './base.js';
import { buildResolveKey } from './utils.js';

/**
 * Native Deepbrid (deepbrid.com) debrid service.
 *
 * Deepbrid is a premium link generator with a torrent cloud. Unlike RD/AD/etc.
 * it has NO infoHash cache-check endpoint and its torrent links come back
 * already-direct (no unrestrict step), so this service:
 *   - reports every magnet as uncached (checkMagnets), letting resolve() add+poll;
 *   - resolves by POST /torrents/add -> poll GET /torrents/info -> pick the video
 *     file's already-direct link.
 *
 * Ported in spirit from Cxsmo-ai/Deepbridge (Apache-2.0); see NOTICE-CURATIO.md.
 * Field names (`add.id`, torrents/info `status`/`links`) should be verified
 * against the live API — see https://www.deepbrid.com/api-docs.
 */

const logger = createLogger('debrid:deepbrid');
const BASE_URL = 'https://www.deepbrid.com/api/v1';
const VIDEO_RE = /\.(mkv|mp4|m4v|avi|mov|ts|m2ts|webm)(?:$|[?#])/i;
const READY_STATUSES = new Set(['ready', 'ready_missing_links', 'finished']);

interface DeepbridLink {
  url?: string;
  link?: string;
  name?: string;
  filename?: string;
  size?: number;
}
interface DeepbridTorrent {
  id?: string | number;
  hash?: string;
  name?: string;
  filename?: string;
  status?: string;
  size?: number;
  progress?: number;
  links?: (string | DeepbridLink)[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractHash(magnet: string): string | undefined {
  const m = magnet.match(/btih:([a-z0-9]+)/i);
  return m ? m[1].toLowerCase() : undefined;
}

/** Rebuild a magnet URI from the torrent playback info (hash + sources as trackers). */
function buildMagnet(playbackInfo: PlaybackInfo & { type: 'torrent' }): string {
  if (playbackInfo.downloadUrl) return playbackInfo.downloadUrl;
  const trackers = (playbackInfo.sources ?? [])
    .map((s) => `&tr=${encodeURIComponent(s)}`)
    .join('');
  return `magnet:?xt=urn:btih:${playbackInfo.hash}${trackers}`;
}

function linkUrl(link: string | DeepbridLink): string {
  return typeof link === 'string' ? link : (link.url ?? link.link ?? '');
}

function mapStatus(status?: string): DebridDownload['status'] {
  const s = (status ?? '').toLowerCase();
  if (READY_STATUSES.has(s)) return 'downloaded';
  if (s.includes('fail') || s.includes('dead')) return 'failed';
  if (s.includes('invalid')) return 'invalid';
  if (s.includes('download') || s.includes('process')) return 'downloading';
  if (s.includes('queue') || s.includes('wait')) return 'queued';
  return 'unknown';
}

function mapTorrent(raw: DeepbridTorrent): DebridDownload {
  const files: DebridFile[] = (raw.links ?? []).map((link, index) => {
    const url = linkUrl(link);
    const meta = typeof link === 'string' ? {} : link;
    return {
      id: index,
      name: meta.name ?? meta.filename ?? decodeURIComponent(url.split('/').pop() ?? ''),
      size: meta.size ?? 0,
      link: url,
      index,
    };
  });
  return {
    id: raw.id != null ? String(raw.id) : -1,
    hash: raw.hash,
    name: raw.name ?? raw.filename,
    size: raw.size,
    status: mapStatus(raw.status),
    files,
  };
}

function isReady(item: DebridDownload): boolean {
  return item.status === 'downloaded' && (item.files?.length ?? 0) > 0;
}

/** Pick the file link by explicit index, then filename match, then first video, then first. */
function selectLink(
  item: DebridDownload,
  playbackInfo: PlaybackInfo,
  filename: string
): string | undefined {
  const files = (item.files ?? []).filter((f) => f.link);
  if (files.length === 0) return undefined;
  if (playbackInfo.fileIndex !== undefined && files[playbackInfo.fileIndex]?.link) {
    return files[playbackInfo.fileIndex].link;
  }
  const want = (playbackInfo.filename ?? filename ?? '').toLowerCase();
  if (want) {
    const byName = files.find((f) => (f.name ?? '').toLowerCase() === want);
    if (byName?.link) return byName.link;
  }
  const video = files
    .filter((f) => VIDEO_RE.test(f.link ?? '') || VIDEO_RE.test(f.name ?? ''))
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
  return (video ?? files[0]).link;
}

export class DeepbridService implements TorrentDebridService {
  readonly serviceName: ServiceId = 'deepbrid';
  readonly capabilities = { torrents: true, usenet: false };
  private readonly pollInterval: number;
  private readonly maxWaitTime: number;

  constructor(
    private readonly config: DebridServiceConfig,
    options?: { pollInterval?: number; maxWaitTime?: number }
  ) {
    this.pollInterval = options?.pollInterval ?? Time.Second * 5;
    this.maxWaitTime = options?.maxWaitTime ?? Time.Minute * 2;
  }

  private async api(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) throw this.toError(res.status, res.statusText, body);
    return body;
  }

  private toError(statusCode: number, statusText: string, body: any): DebridError {
    let code: DebridError['code'] = 'UNKNOWN';
    if (statusCode === 401 || statusCode === 403) code = 'UNAUTHORIZED';
    else if (statusCode === 429) code = 'TOO_MANY_REQUESTS';
    else if (statusCode === 402) code = 'PAYMENT_REQUIRED';
    return new DebridError(body?.message || body?.error || statusText || 'Deepbrid error', {
      statusCode,
      statusText: statusText || 'Deepbrid error',
      code,
      headers: {},
      body,
      type: 'api_error',
    });
  }

  // Deepbrid has no batch cache-check. Report uncached so resolve() runs add+poll.
  async checkMagnets(magnets: string[]): Promise<DebridDownload[]> {
    return magnets.map((magnet) => ({
      id: -1,
      hash: extractHash(magnet),
      status: 'unknown' as const,
    }));
  }

  async listMagnets(): Promise<DebridDownload[]> {
    const body = await this.api('/torrents/info');
    const items: DeepbridTorrent[] = Array.isArray(body)
      ? body
      : Object.values(body ?? {});
    return items.map(mapTorrent);
  }

  async getMagnet(magnetId: string): Promise<DebridDownload> {
    const body = await this.api(`/torrents/info?id=${encodeURIComponent(magnetId)}`);
    const item: DeepbridTorrent = Array.isArray(body) ? body[0] : body;
    return mapTorrent(item ?? {});
  }

  async addMagnet(magnet: string): Promise<DebridDownload> {
    const body = await this.api('/torrents/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ magnet }).toString(),
    });
    const id = body?.add?.id ?? body?.id;
    if (id == null) throw this.toError(502, 'Bad Gateway', body);
    return { id: String(id), hash: extractHash(magnet), status: 'processing' };
  }

  async addTorrent(torrent: string): Promise<DebridDownload> {
    // Deepbrid's add expects a magnet; pass through (callers supply a magnet).
    return this.addMagnet(torrent);
  }

  async removeMagnet(magnetId: string): Promise<void> {
    try {
      await this.api(`/torrents/remove?id=${encodeURIComponent(magnetId)}`, {
        method: 'POST',
      });
    } catch (err) {
      logger.warn(`Deepbrid remove failed for ${magnetId}: ${(err as Error).message}`);
    }
  }

  // Deepbrid torrent links are already direct — nothing to unrestrict.
  async generateTorrentLink(link: string): Promise<string> {
    return link;
  }

  async resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    cacheAndPlay: boolean,
    autoRemoveDownloads?: boolean
  ): Promise<string | undefined> {
    if (playbackInfo.type !== 'torrent') return undefined;
    const { result } = await DistributedLock.getInstance().withLock(
      buildResolveKey(
        'db:lock',
        this.serviceName,
        playbackInfo,
        filename,
        this.config.token,
        this.config.clientIp,
        { cacheAndPlay, autoRemoveDownloads }
      ),
      () => this._resolve(playbackInfo, filename, cacheAndPlay, autoRemoveDownloads),
      {
        timeout: cacheAndPlay ? this.maxWaitTime + this.pollInterval : 30000,
        ttl: cacheAndPlay ? this.maxWaitTime + this.pollInterval + 10000 : 40000,
      }
    );
    return result;
  }

  private async _resolve(
    playbackInfo: PlaybackInfo & { type: 'torrent' },
    filename: string,
    cacheAndPlay: boolean,
    autoRemoveDownloads?: boolean
  ): Promise<string | undefined> {
    const added = await this.addMagnet(buildMagnet(playbackInfo));
    let item = await this.getMagnet(String(added.id));

    if (!isReady(item)) {
      if (!cacheAndPlay) return undefined;
      const maxPolls = Math.ceil(this.maxWaitTime / this.pollInterval);
      for (let i = 0; i < maxPolls; i++) {
        await sleep(this.pollInterval);
        item = await this.getMagnet(String(added.id));
        if (isReady(item)) break;
        if (item.status === 'failed' || item.status === 'invalid') {
          throw new DebridError(`Deepbrid torrent ${item.status}`, {
            statusCode: 400,
            statusText: `Deepbrid torrent ${item.status}`,
            code: 'UNKNOWN',
            headers: {},
            body: item,
            type: 'api_error',
          });
        }
      }
      if (!isReady(item)) {
        throw new DebridError(
          `Deepbrid torrent timed out waiting for completion (status: ${item.status})`,
          {
            statusCode: 408,
            statusText: 'Timeout',
            code: 'UNKNOWN',
            headers: {},
            body: item,
            type: 'api_error',
          }
        );
      }
    }

    const link = selectLink(item, playbackInfo, filename);
    if (!link) {
      throw new DebridError('No playable file in Deepbrid torrent', {
        statusCode: 400,
        statusText: 'No matching file',
        code: 'NO_MATCHING_FILE',
        headers: {},
        body: item,
        type: 'api_error',
      });
    }

    if (autoRemoveDownloads && item.id) {
      this.removeMagnet(String(item.id)).catch(() => {});
    }
    return link;
  }
}
