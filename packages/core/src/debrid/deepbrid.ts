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
  UsenetDebridService,
} from './base.js';
import { buildResolveKey } from './utils.js';

/**
 * Native Deepbrid (deepbrid.com) debrid service — torrents AND usenet.
 *
 * Deepbrid is a premium link generator with a torrent + usenet cloud. Unlike
 * RD/AD/etc. it has NO cache-check endpoint and its links come back
 * already-direct (no unrestrict step), so this service:
 *   - reports every magnet/nzb as cached (checkMagnets/checkNzbs) so results are
 *     shown and survive cached-only filters — Deepbrid has no availability
 *     indicator, and resolve() performs the real add + poll on play regardless;
 *   - resolves torrents by POST /torrents/add and usenet by POST /usenet/add
 *     (nzb_url), then polls GET /torrents/info until ready and picks the video
 *     file's already-direct link.
 *
 * Because Deepbrid is download-first (never instantly available), resolve()
 * always runs the add + poll flow, ignoring the caller's cacheAndPlay flag.
 *
 * Ported in spirit from Cxsmo-ai/Deepbridge (Apache-2.0); see NOTICE-CURATIO.md.
 * Field names (`add.id`, torrents/info `status`/`links`, the usenet status
 * endpoint) should be verified against the live API — see
 * https://www.deepbrid.com/api-docs.
 */

const logger = createLogger('debrid:deepbrid');
const BASE_URL = 'https://www.deepbrid.com/api/v1';
const VIDEO_RE = /\.(mkv|mp4|m4v|avi|mov|ts|m2ts|webm)(?:$|[?#])/i;
const READY_STATUSES = new Set([
  'ready',
  'ready_missing_links',
  'finished',
  'completed',
  'done',
  'success',
]);

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

export class DeepbridService
  implements TorrentDebridService, UsenetDebridService
{
  readonly serviceName: ServiceId = 'deepbrid';
  readonly capabilities = { torrents: true, usenet: true };
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

  // Deepbrid has no cache-check. Report cached so results are shown and pass
  // cached-only filters; resolve() still performs the real add + poll on play.
  async checkMagnets(magnets: string[]): Promise<DebridDownload[]> {
    return magnets.map((magnet) => ({
      id: -1,
      hash: extractHash(magnet),
      status: 'cached' as const,
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

  // ---- Usenet ----------------------------------------------------------------
  // Deepbrid resolves NZBs the same way it resolves magnets: submit the NZB URL
  // (POST /usenet/add), then poll the shared status endpoint for the direct
  // link. It has no cache-check, so checkNzbs reports cached (see checkMagnets).

  async checkNzbs(
    nzbs: { name?: string; hash?: string }[]
  ): Promise<DebridDownload[]> {
    return nzbs.map((nzb) => ({
      id: -1,
      hash: nzb.hash,
      status: 'cached' as const,
    }));
  }

  async addNzb(nzb: string, _name: string): Promise<DebridDownload> {
    const body = await this.api('/usenet/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ nzb_url: nzb }).toString(),
    });
    const id = body?.add?.id ?? body?.usenet?.id ?? body?.id;
    if (id == null) throw this.toError(502, 'Bad Gateway', body);
    return { id: String(id), status: 'processing' };
  }

  // Deepbrid exposes usenet items through the same /torrents/info status
  // endpoint as torrents. If a future API split moves them under /downloads,
  // adjust getNzb / listNzbs / removeNzb here.
  async getNzb(nzbId: string): Promise<DebridDownload> {
    return this.getMagnet(nzbId);
  }

  async listNzbs(): Promise<DebridDownload[]> {
    return this.listMagnets();
  }

  async removeNzb(nzbId: string): Promise<void> {
    return this.removeMagnet(nzbId);
  }

  // Usenet links are already direct; resolve() returns them straight from the
  // status endpoint. This only surfaces a link for an already-known id.
  async generateUsenetLink(downloadId: string): Promise<string> {
    const item = await this.getNzb(downloadId);
    const link = (item.files ?? []).find((f) => f.link)?.link;
    if (!link) {
      throw new DebridError('No Deepbrid usenet link available', {
        statusCode: 400,
        statusText: 'No matching file',
        code: 'NO_MATCHING_FILE',
        headers: {},
        body: item,
        type: 'api_error',
      });
    }
    return link;
  }

  // ---- Resolve (torrent + usenet) --------------------------------------------

  async resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    cacheAndPlay: boolean,
    autoRemoveDownloads?: boolean
  ): Promise<string | undefined> {
    if (playbackInfo.type !== 'torrent' && playbackInfo.type !== 'usenet') {
      return undefined;
    }
    // Deepbrid is download-first (no cache-check, no instant link), so a
    // playback is always an add + poll regardless of the caller's cacheAndPlay.
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
      () => this._resolve(playbackInfo, filename, autoRemoveDownloads),
      {
        timeout: this.maxWaitTime + this.pollInterval,
        ttl: this.maxWaitTime + this.pollInterval + 10000,
      }
    );
    return result;
  }

  private async _resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    autoRemoveDownloads?: boolean
  ): Promise<string | undefined> {
    const type = playbackInfo.type;
    const added =
      playbackInfo.type === 'usenet'
        ? await this.addNzb(playbackInfo.nzb, filename)
        : await this.addMagnet(buildMagnet(playbackInfo));
    const id = String(added.id);
    const getItem = () =>
      type === 'usenet' ? this.getNzb(id) : this.getMagnet(id);
    let item = await getItem();

    if (!isReady(item)) {
      const maxPolls = Math.ceil(this.maxWaitTime / this.pollInterval);
      for (let i = 0; i < maxPolls; i++) {
        await sleep(this.pollInterval);
        item = await getItem();
        if (isReady(item)) break;
        if (item.status === 'failed' || item.status === 'invalid') {
          throw new DebridError(`Deepbrid ${type} ${item.status}`, {
            statusCode: 400,
            statusText: `Deepbrid ${type} ${item.status}`,
            code: 'UNKNOWN',
            headers: {},
            body: item,
            type: 'api_error',
          });
        }
      }
      if (!isReady(item)) {
        throw new DebridError(
          `Deepbrid ${type} timed out waiting for completion (status: ${item.status})`,
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
      throw new DebridError(`No playable file in Deepbrid ${type}`, {
        statusCode: 400,
        statusText: 'No matching file',
        code: 'NO_MATCHING_FILE',
        headers: {},
        body: item,
        type: 'api_error',
      });
    }

    if (autoRemoveDownloads && item.id) {
      (type === 'usenet'
        ? this.removeNzb(String(item.id))
        : this.removeMagnet(String(item.id))
      ).catch(() => {});
    }
    return link;
  }
}
