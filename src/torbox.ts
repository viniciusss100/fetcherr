import { config } from './config.js'
import { NotCachedError, ProviderUnavailableError } from './rd.js'
import type { ResolvedStream } from './rd.js'

export { NotCachedError, ProviderUnavailableError }

const BASE = 'https://api.torbox.app/v1/api'

// ── Typed shapes ──────────────────────────────────────────────────────────────

interface TbResponse<T> {
  success:  boolean
  error?:   string | null
  detail?:  string
  data?:    T
}

interface TbCreateResult {
  torrent_id: number
  name?:      string
  hash:       string
  auth_id?:   string
}

interface TbCachedTorrent {
  hash: string
  name?: string
  size?: number
}

type TbCachedTorrentEntry = TbCachedTorrent | TbCachedTorrent[]

interface TbTorrentFile {
  id:             number
  name:           string
  size:           number
  absolute_path?: string
}

interface TbTorrentInfo {
  id:             number
  hash:           string
  name:           string
  download_state: string
  files:          TbTorrentFile[]
}

// ── Low-level fetch ───────────────────────────────────────────────────────────

function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause
  if (cause instanceof Error && cause.message) {
    const causeWithCode = cause as Error & { code?: unknown }
    const code = typeof causeWithCode.code === 'string' ? ` ${causeWithCode.code}` : ''
    return `${err.name}: ${err.message}; cause${code}: ${cause.message}`
  }
  return `${err.name}: ${err.message}`
}

async function tbFetch<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options?: {
    form?: Record<string, string>
    json?: Record<string, string | number | boolean>
    query?: Record<string, string>
  },
): Promise<T> {
  let res: Response
  const { form, json, query } = options ?? {}
  const url = new URL(`${BASE}${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  }
  const formBody = form ? new URLSearchParams(form) : undefined
  const jsonBody = json ? JSON.stringify(json) : undefined

  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.torBoxApiKey}`,
        ...(formBody ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(jsonBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: formBody ?? jsonBody,
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new ProviderUnavailableError(`TB ${method} ${path} failed: ${formatFetchError(err)}`)
  }

  if (res.status === 204) return null as T
  const text = await res.text()
  if (!res.ok) {
    const message = `TB ${method} ${path} → ${res.status}: ${text}`
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
      throw new ProviderUnavailableError(message, res.status)
    }
    throw new Error(message)
  }
  if (!text) return null as T
  const parsed = JSON.parse(text) as TbResponse<T>
  if (!parsed.success) {
    throw new Error(`TB ${method} ${path} error: ${parsed.error ?? parsed.detail ?? 'unknown'}`)
  }
  return parsed.data as T
}

// ── API operations ────────────────────────────────────────────────────────────

async function checkCached(hash: string): Promise<boolean> {
  const data = await tbFetch<Record<string, TbCachedTorrentEntry>>('GET', '/torrents/checkcached', {
    query: { hash, format: 'object' },
  })
  const normalizedHash = hash.toLowerCase()
  const entry = data[normalizedHash] ?? data[hash]
  if (!entry) return false
  return Array.isArray(entry) ? entry.length > 0 : true
}

async function createTorrent(magnet: string): Promise<TbCreateResult> {
  return tbFetch<TbCreateResult>('POST', '/torrents/createtorrent', {
    form: { magnet, add_only_if_cached: 'true' },
  })
}

async function getTorrentInfo(torrentId: number): Promise<TbTorrentInfo> {
  return tbFetch<TbTorrentInfo>('GET', '/torrents/mylist', {
    query: { id: String(torrentId), bypass_cache: 'true' },
  })
}

async function requestDownloadLink(torrentId: number, fileId: number): Promise<string> {
  return tbFetch<string>('GET', '/torrents/requestdl', {
    query: {
      token:      config.torBoxApiKey,
      torrent_id: String(torrentId),
      file_id:    String(fileId),
      zip_link:   'false',
    },
  })
}

async function deleteTorrent(torrentId: number): Promise<void> {
  await tbFetch('POST', '/torrents/controltorrent', {
    json: { torrent_id: torrentId, operation: 'delete' },
  })
}

// ── Poll until ready ──────────────────────────────────────────────────────────

const DOWNLOADING_STATES = new Set(['downloading', 'uploading', 'stalled (no seeds)', 'forced_start', 'paused'])
const READY_STATES       = new Set(['cached', 'completed'])

async function waitReady(
  torrentId: number,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<TbTorrentInfo> {
  const { pollMs = 500, timeoutMs = 8_000 } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = await getTorrentInfo(torrentId)
    if (READY_STATES.has(info.download_state)) return info
    if (['error', 'torrent_error'].includes(info.download_state)) {
      throw new Error(`TorBox torrent ${torrentId} entered state: ${info.download_state}`)
    }
    if (DOWNLOADING_STATES.has(info.download_state)) {
      throw new NotCachedError(`Torrent ${torrentId} is not cached on TorBox (state: ${info.download_state})`)
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
  throw new Error(`TorBox torrent ${torrentId} did not become ready within ${timeoutMs}ms`)
}

// ── File selection ────────────────────────────────────────────────────────────

const SELECTABLE_VIDEO_EXTS = new Set(['mkv', 'mp4', 'avi', 'mov', 'm4v', 'ts', 'm2ts', 'wmv', 'flv', 'webm'])

function fileExt(name: string): string {
  return name.split('?')[0]?.split('.').pop()?.toLowerCase() ?? ''
}

function isLikelyPlayableFile(f: TbTorrentFile): boolean {
  const lower = f.name.toLowerCase()
  if (/\bsample\b|\btrailer\b|\bextras?\b|\bfeaturette\b/.test(lower)) return false
  return SELECTABLE_VIDEO_EXTS.has(fileExt(lower))
}

function similarity(a: string, b: string): number {
  const shorter = a.length < b.length ? a : b
  const longer  = a.length < b.length ? b : a
  if (longer.length === 0) return 1
  if (longer.includes(shorter)) return shorter.length / longer.length
  const tokA = new Set(a.split(/\W+/).filter(Boolean))
  const tokB = new Set(b.split(/\W+/).filter(Boolean))
  let common = 0
  for (const t of tokA) if (tokB.has(t)) common++
  return common / Math.max(tokA.size, tokB.size, 1)
}

function episodeMarker(value: string): string | null {
  const match = value.toLowerCase().match(/\bs(\d{1,2})\s*e(\d{1,2})\b/)
  if (!match) return null
  return `s${match[1].padStart(2, '0')}e${match[2].padStart(2, '0')}`
}

function pickBestFile(files: TbTorrentFile[], filePathHint?: string): TbTorrentFile {
  const candidates = files.filter(f => f.size > 0 && isLikelyPlayableFile(f))
  const pool = candidates.length ? candidates : files.filter(f => f.size > 0)
  if (!pool.length) throw new Error('TorBox torrent has no selectable files')

  if (filePathHint && pool.length > 1) {
    const hint = filePathHint.toLowerCase()
    const hintEpisode = episodeMarker(hint)
    if (hintEpisode) {
      const episodeMatches = pool.filter(f => episodeMarker(f.name) === hintEpisode)
      if (episodeMatches.length === 1) return episodeMatches[0]
      if (episodeMatches.length > 1) {
        return [...episodeMatches].sort(
          (a, b) => similarity(b.name.toLowerCase(), hint) - similarity(a.name.toLowerCase(), hint),
        )[0]
      }
    }
    return [...pool].sort(
      (a, b) => similarity(b.name.toLowerCase(), hint) - similarity(a.name.toLowerCase(), hint),
    )[0]
  }

  return pool.reduce((best, f) => (f.size > best.size ? f : best))
}

// ── Resolved-stream cache ─────────────────────────────────────────────────────

interface ResolvedCacheEntry extends ResolvedStream {
  expiresAt: number
}

const RESOLVED_CACHE_TTL_MS = 3 * 60 * 1000
const resolvedStreamCache   = new Map<string, ResolvedCacheEntry>()
const CLEANUP_DELAY_MS      = 4 * 60 * 60 * 1000

function resolveCacheKey(hash: string, filePathHint?: string): string {
  return `tb:${hash}|${(filePathHint ?? '').toLowerCase()}`
}

function getCachedResolvedStream(hash: string, filePathHint?: string): ResolvedStream | null {
  const key   = resolveCacheKey(hash, filePathHint)
  const entry = resolvedStreamCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { resolvedStreamCache.delete(key); return null }
  return { url: entry.url, filename: entry.filename, bytes: entry.bytes }
}

function setCachedResolvedStream(hash: string, filePathHint: string | undefined, value: ResolvedStream): void {
  resolvedStreamCache.set(resolveCacheKey(hash, filePathHint), {
    ...value,
    expiresAt: Date.now() + RESOLVED_CACHE_TTL_MS,
  })
}

function scheduleDeleteTorrent(torrentId: number): void {
  const timer = setTimeout(() => {
    void deleteTorrent(torrentId)
      .then(() => console.log(`torbox: deleted torrent ${torrentId}`))
      .catch((err: unknown) => console.warn(`torbox: failed to delete torrent ${torrentId}: ${String(err)}`))
  }, CLEANUP_DELAY_MS)
  timer.unref()
}

// ── Public resolver ───────────────────────────────────────────────────────────

/**
 * Given a torrent hash, verify TorBox has it cached, add it, request a
 * direct-download link, and return the resolved stream. Torrent is deleted
 * after a delay so the CDN URL remains valid during playback.
 */
export async function resolveStream(
  hash: string,
  filePathHint?: string,
): Promise<ResolvedStream> {
  if (!config.torBoxApiKey) throw new Error('TORBOX_API_KEY not configured')

  const cached = getCachedResolvedStream(hash, filePathHint)
  if (cached) {
    console.log(`torbox: cache hit for ${hash.slice(0, 8)}… → ${cached.filename}`)
    return cached
  }

  const magnet = hash.startsWith('magnet:') ? hash : `magnet:?xt=urn:btih:${hash}`
  const cacheHash = hash.startsWith('magnet:') ? hash.match(/btih:([^&]+)/i)?.[1] ?? hash : hash
  if (!await checkCached(cacheHash)) {
    throw new NotCachedError(`Torrent ${cacheHash.slice(0, 8)} is not cached on TorBox`)
  }

  console.log(`torbox: adding magnet ${hash.slice(0, 8)}… to TorBox`)
  const created = await createTorrent(magnet)
  console.log(`torbox: added magnet ${hash.slice(0, 8)}… as torrent ${created.torrent_id}`)

  const info = await waitReady(created.torrent_id)
  const file = pickBestFile(info.files, filePathHint)
  const url  = await requestDownloadLink(created.torrent_id, file.id)
  console.log(`torbox: resolved torrent ${created.torrent_id} → ${file.name}`)
  scheduleDeleteTorrent(created.torrent_id)
  const resolved: ResolvedStream = { url, filename: file.name, bytes: file.size }
  setCachedResolvedStream(hash, filePathHint, resolved)
  return resolved
}
