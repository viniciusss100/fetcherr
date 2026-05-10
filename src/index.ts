import { Readable } from 'node:stream'
import Fastify from 'fastify'
import { config, normalizeSootioUrl, parseBooleanSetting, parseDirectPlaybackMode, parseEnglishStreamMode, parseMdblistLists, parseMovieReleaseMode, parseMusicAddonUrls, parseShowAddDefaultMode, parseStreamProviderUrls, parseTraktLists } from './config.js'
import { getDb, getAllSettings } from './db.js'
import { jellyfinRoutes, resolveJellyfinUser } from './jellyfin/index.js'
import { uiRoutes } from './ui/routes.js'
import { wrapFastifyLogger } from './logger.js'
import { markSyncComplete } from './sync-state.js'
import { cleanupRemovedTraktListSources, syncTraktWatchlist, syncTraktShowsWatchlist, syncTraktList, syncTraktWatchedStatus, startDeviceAuth, tokenStatus } from './trakt.js'
import { cleanupRemovedMdblistListSources, normalizeMdblistListUrls, syncMdblistList } from './mdblist.js'
import { fetchRankedStreams, fetchRankedEpisodeStreams, extractHashFromStream } from './sootio.js'
import { resolveStream, probeAudioLanguages, NotCachedError, ProviderUnavailableError, type ResolvedStream } from './rd.js'
import { resolveStream as tbResolveStream } from './torbox.js'
import { getMovieByTmdbId, getShowByImdbId, getEpisodesForSeason, getLatestSeasonNumberForShow, listLatestSeasonShowSubscriptions, listMovies, listShows, pruneAllOrphanedMovies, pruneAllOrphanedShows, removeSourceKey, upsertManualShowSubscription } from './db.js'
import { ensureShowSeasonsCached, refreshShowMetadataIfNeeded, refreshMovieMetadataIfNeeded } from './tmdb.js'
import { getSessionUser, getTokenFromCookie, isUiAuthConfigured, isValidSession } from './ui/auth.js'
import { verifySignedPlaybackPath } from './play-auth.js'
import { hasEnglishAudioMarker, hasNonEnglishAudioMarker } from './streamLanguage.js'
import { subsonicRoutes } from './music/subsonic.js'
import { bookRoutes } from './books/routes.js'
import { syncAbsLibrary } from './audiobookshelf.js'

const app = Fastify({
  logger: { level: 'info' },
  trustProxy: true,
  routerOptions: { ignoreTrailingSlash: true },
  rewriteUrl: (req) => req.url!.replace(/\/\/+/g, '/').replace(/\.view(\?|$)/, '$1'),
})

app.addHook('onRequest', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('X-Frame-Options', 'DENY')
  reply.header('Referrer-Policy', 'same-origin')
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: https://image.tmdb.org",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
  )
})

// Initialise DB
getDb()

// Apply any DB-persisted settings on top of env vars
{
  const s = getAllSettings()
  if (s.sootioUrl)          config.sootioUrl          = normalizeSootioUrl(s.sootioUrl)
  if (s.rdApiKey)           config.rdApiKey            = s.rdApiKey
  if (s.torBoxApiKey)       config.torBoxApiKey        = s.torBoxApiKey
  if (s.torBoxUserIp)       config.torBoxUserIp        = s.torBoxUserIp
  if (s.tmdbApiKey)         config.tmdbApiKey          = s.tmdbApiKey
  if (s.tvdbApiKey)         config.tvdbApiKey          = s.tvdbApiKey
  if (s.serverUrl)          config.serverUrl           = s.serverUrl
  if (s.traktClientId)      config.traktClientId       = s.traktClientId
  if (s.traktClientSecret)  config.traktClientSecret   = s.traktClientSecret
  if (s.traktLists != null) config.traktLists          = parseTraktLists(s.traktLists)
  if (s.traktWatchlistMovies != null) config.traktWatchlistMovies = parseBooleanSetting(s.traktWatchlistMovies, true)
  if (s.traktWatchlistShows != null)  config.traktWatchlistShows  = parseBooleanSetting(s.traktWatchlistShows, true)
  if (s.traktWatchHistory != null) config.traktWatchHistory = parseBooleanSetting(s.traktWatchHistory, false)
  if (s.traktCollections != null) config.traktCollections = parseBooleanSetting(s.traktCollections, false)
  if (s.mdblistApiKey)        config.mdblistApiKey       = s.mdblistApiKey
  if (s.mdblistLists != null) config.mdblistLists = normalizeMdblistListUrls(parseMdblistLists(s.mdblistLists))
  if (s.showAddDefaultMode != null) config.showAddDefaultMode = parseShowAddDefaultMode(s.showAddDefaultMode)
  if (s.movieReleaseMode != null) config.movieReleaseMode = parseMovieReleaseMode(s.movieReleaseMode)
  if (s.streamProviderUrls != null) config.streamProviderUrls = parseStreamProviderUrls(s.streamProviderUrls)
  if (s.musicAddonUrls != null) config.musicAddonUrls = parseMusicAddonUrls(s.musicAddonUrls)
  if (s.englishStreamMode != null) config.englishStreamMode = parseEnglishStreamMode(s.englishStreamMode)
  if (s.directPlaybackMode != null) config.directPlaybackMode = parseDirectPlaybackMode(s.directPlaybackMode)
}

// Wrap Fastify logger so UI log viewer captures it
wrapFastifyLogger(app)

// Healthcheck
app.get('/healthz', async () => ({ status: 'ok' }))

function requireUiSession(
  req: { headers: Record<string, string | undefined> },
  reply: { code: (n: number) => { send: (v: unknown) => unknown } },
): boolean {
  if (!isUiAuthConfigured()) {
    reply.code(503).send({ error: 'UI auth is not configured. Create an admin account first.' })
    return false
  }
  const token = getTokenFromCookie(req.headers.cookie)
  if (!token || !isValidSession(token) || !getSessionUser(token)) {
    reply.code(401).send({ error: 'Unauthorized' })
    return false
  }
  return true
}

function requireAdminUiSession(
  req: { headers: Record<string, string | undefined> },
  reply: { code: (n: number) => { send: (v: unknown) => unknown } },
): boolean {
  if (!requireUiSession(req, reply)) return false
  const token = getTokenFromCookie(req.headers.cookie)
  const user = token ? getSessionUser(token) : null
  if (!user || user.role !== 'admin') {
    reply.code(403).send({ error: 'Admin access required' })
    return false
  }
  return true
}

function requestPlaybackUser(headers: Record<string, string | string[] | undefined>) {
  const cookieHeader = Array.isArray(headers.cookie) ? headers.cookie[0] : headers.cookie
  const token = getTokenFromCookie(cookieHeader)
  if (token && isValidSession(token)) {
    const uiUser = getSessionUser(token)
    if (uiUser) return uiUser
  }
  return resolveJellyfinUser(headers)
}

// ── Play endpoint ─────────────────────────────────────────────────────────────
// Called by Infuse when it follows the URL returned from PlaybackInfo.
// Queries AIOStreams for the best RD-cached stream and 302s to the direct URL.

function pad2(n: number) { return n.toString().padStart(2, '0') }

const FAILED_PLAY_TTL_MS = 3 * 60 * 1000
const PLAYBACK_PREWARM_TTL_MS = 5 * 60 * 1000
const MAX_RD_TRANSIENT_FAILURES = 3
type FailedPlayCacheEntry = { expiresAt: number; reason: string }
const failedPlayCache = new Map<string, FailedPlayCacheEntry>()
type PlayResolution = { url: string; filename?: string; sourceHash?: string }
type PlaybackPrewarmEntry = { expiresAt: number; promise: Promise<PlayResolution> }
const playbackPrewarmCache = new Map<string, PlaybackPrewarmEntry>()

class PlaybackResolutionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly response: { error: string; message: string },
  ) {
    super(message)
  }
}

function getFailedPlayReason(cacheKey: string): string | null {
  const entry = failedPlayCache.get(cacheKey)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    failedPlayCache.delete(cacheKey)
    return null
  }
  return entry.reason
}

function cacheFailedPlay(cacheKey: string, reason: string) {
  failedPlayCache.set(cacheKey, {
    expiresAt: Date.now() + FAILED_PLAY_TTL_MS,
    reason,
  })
}

function clearFailedPlay(cacheKey: string) {
  failedPlayCache.delete(cacheKey)
}

function cleanupPlaybackPrewarmCache() {
  const now = Date.now()
  for (const [key, entry] of playbackPrewarmCache) {
    if (entry.expiresAt <= now) playbackPrewarmCache.delete(key)
  }
}

function getOrCreatePlaybackResolution(
  cacheKey: string,
  label: string,
  resolver: () => Promise<PlayResolution>,
): { promise: Promise<PlayResolution>; reused: boolean } {
  cleanupPlaybackPrewarmCache()
  const existing = playbackPrewarmCache.get(cacheKey)
  if (existing && existing.expiresAt > Date.now()) {
    return { promise: existing.promise, reused: true }
  }

  const promise = resolver().catch(err => {
    const current = playbackPrewarmCache.get(cacheKey)
    if (current?.promise === promise) playbackPrewarmCache.delete(cacheKey)
    throw err
  })
  playbackPrewarmCache.set(cacheKey, {
    expiresAt: Date.now() + PLAYBACK_PREWARM_TTL_MS,
    promise,
  })
  app.log.info(`play: started resolver for ${label}`)
  return { promise, reused: false }
}

function prewarmPlayback(playPath: string, label: string) {
  if (getFailedPlayReason(playPath)) return
  const resolver = playbackResolverForPath(playPath)
  if (!resolver) return
  const { promise, reused } = getOrCreatePlaybackResolution(playPath, label, resolver)
  if (reused) {
    app.log.info(`play: prewarm already active for ${label}`)
    return
  }
  app.log.info(`play: prewarming ${label}`)
  void promise
    .then(result => app.log.info(`play: prewarm ready for ${label}${result.filename ? ` → ${result.filename}` : ''}`))
    .catch(err => app.log.info(`play: prewarm ended for ${label}: ${err}`))
}

function isNonRetryableRdError(err: ProviderUnavailableError): boolean {
  return err.status === 401 || err.status === 403 || err.status === 429
}

function isTorBoxCdnUrl(url: string): boolean {
  try { return new URL(url).hostname.endsWith('.tb-cdn.io') } catch { return false }
}

async function proxyTorBoxStream(
  cdnUrl: string,
  req: { method: string; headers: Record<string, string | string[] | undefined> },
  reply: { code: (n: number) => typeof reply; header: (k: string, v: string) => typeof reply; send: (b?: unknown) => unknown },
): Promise<unknown> {
  const rangeHeader = req.headers['range']
  const range = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader
  const isHead = req.method === 'HEAD'
  let upstream: Response
  try {
    upstream = await fetch(cdnUrl, {
      method: isHead ? 'HEAD' : 'GET',
      headers: range ? { Range: range } : {},
    })
  } catch (err) {
    app.log.warn(`play: TorBox proxy fetch failed: ${err}`)
    return reply.code(502).send({ error: 'Upstream fetch failed' })
  }
  reply.header('Accept-Ranges', 'bytes')
  const ct = upstream.headers.get('Content-Type')
  if (ct) reply.header('Content-Type', ct)
  const cl = upstream.headers.get('Content-Length')
  if (cl) reply.header('Content-Length', cl)
  const cr = upstream.headers.get('Content-Range')
  if (cr) reply.header('Content-Range', cr)
  reply.code(upstream.status)
  if (isHead || !upstream.body) return reply.send()
  return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream))
}

const VIDEO_EXTS = new Set(['mkv','mp4','avi','mov','m4v','ts','m2ts','wmv','flv','webm'])

function isVideoFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTS.has(ext)
}

function isLikelyBadResolvedFilename(filename: string): boolean {
  const lower = filename.toLowerCase()
  const ext = lower.split('.').pop() ?? ''
  if (/\bsample\b|\btrailer\b|\bextras?\b|\bfeaturette\b/.test(lower)) return true
  if (ext === 'm2ts' || ext === 'ts') return true
  if (/^\d{4,6}\.(m2ts|ts)$/.test(lower)) return true
  return false
}

function streamMetadataText(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): string {
  const filename = typeof stream.behaviorHints?.filename === 'string' ? stream.behaviorHints.filename : ''
  return `${stream.name ?? ''} ${stream.title ?? ''} ${stream.description ?? ''} ${filename}`.toLowerCase()
}

function streamFilenameHint(stream: { behaviorHints?: Record<string, unknown> }): string | undefined {
  const filename = stream.behaviorHints?.filename
  return typeof filename === 'string' && filename.trim() ? filename : undefined
}

function streamClearlyEnglish(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  const text = streamMetadataText(stream)
  const hasEnglish = hasEnglishAudioMarker(text)
  const hasNonEnglish = hasNonEnglishAudioMarker(text)
  return hasEnglish && !hasNonEnglish
}

function streamClearlyNonEnglish(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  const text = streamMetadataText(stream)
  const hasEnglish = hasEnglishAudioMarker(text)
  const hasNonEnglish = hasNonEnglishAudioMarker(text)
  return hasNonEnglish && !hasEnglish
}

function streamClearlyUsenetBacked(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> }): boolean {
  const text = streamMetadataText(stream)
  return /\busenet\b|\bnewznab\b/.test(text)
}

function directPlaybackPenalty(stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown>; url?: string }): number {
  if (!isDirectPlaybackUrl(stream.url)) return 0
  const text = streamMetadataText(stream)
  // Debrid-resolved CDN streams (TB+, RD+) are already optimal — trust original quality ranking
  if (/\[rd\+\]|\[rd ⚡\]|\[rd⚡\]|\brd\+\b|\[tb\+\]|\[tb ⚡\]|\[tb⚡\]|\btb\+\b/.test(text)) return 0
  const size = typeof stream.behaviorHints?.videoSize === 'number' ? stream.behaviorHints.videoSize : 0
  let penalty = 0
  if (/\b(2160p|4k|uhd)\b/.test(text)) penalty += 100
  if (/\bremux\b/.test(text)) penalty += 80
  if (/\b(dv|dolby[ ._-]*vision|hdr10?|hdr)\b/.test(text)) penalty += 50
  if (/\b(atmos|truehd|dts[ ._-]*hd|dts-hd)\b/.test(text)) penalty += 40
  if (/\b(hevc|h\.?265|x265|10bit)\b/.test(text)) penalty += 30
  if (size > 20_000_000_000) penalty += 80
  else if (size > 10_000_000_000) penalty += 40
  else if (size > 5_000_000_000) penalty += 20
  if (/\b(h\.?264|x264|avc)\b/.test(text)) penalty -= 20
  return penalty
}

function isRemoteAudioProbeUnreliable(filename: string): boolean {
  return /\.(mp4|m4v)$/i.test(filename)
}

function isDirectPlaybackUrl(url?: string): url is string {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function filenameFromDirectPlaybackUrl(url?: string): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop()
    return lastSegment ? decodeURIComponent(lastSegment) : undefined
  } catch {
    return undefined
  }
}

async function resolveDirectPlaybackUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok && res.status !== 206) {
      throw new Error(`direct playback probe returned ${res.status}`)
    }
    if (res.url && res.url !== url) {
      let host = 'unknown host'
      try { host = new URL(res.url).host } catch { /* ignore */ }
      app.log.info(`play: direct playback URL resolved to ${host}`)
    }
    return res.url || url
  } catch (err) {
    app.log.warn(`play: direct playback URL probe failed: ${summarizeProbeError(err)}`)
    return url
  }
}

function shouldProbeEnglishAudio(
  stream: { name?: string; title?: string; description?: string; behaviorHints?: Record<string, unknown> },
  filename: string,
): boolean {
  if (config.englishStreamMode !== 'require') return false
  if (streamClearlyEnglish(stream)) return false
  if (streamClearlyNonEnglish(stream)) return false
  if (isRemoteAudioProbeUnreliable(filename)) return false
  return true
}

function hasEnglishAudio(languages: string[]): boolean {
  return languages.some(lang =>
    /^(en|eng|english)$/.test(lang) || /\beng(lish)?\b/.test(lang),
  )
}

function hasOnlyUndeterminedAudio(languages: string[]): boolean {
  const normalized = languages
    .map(lang => lang.trim().toLowerCase())
    .filter(Boolean)
  // 'und' = undetermined, 'zxx' = no linguistic content (dialogue-free / language-neutral media)
  return normalized.length > 0 && normalized.every(lang => lang === 'und' || lang === 'undetermined' || lang === 'zxx')
}

function summarizeProbeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message
    .replace(/https?:\/\/\S+/g, '[url]')
    .split('\n')[0]
    .slice(0, 500)
}

async function resolvePlayableStream(
  streams: Awaited<ReturnType<typeof fetchRankedStreams>>,
  label: string,
  cacheKey: string,
  fileHint?: string,
): Promise<PlayResolution> {
  if (config.rdApiKey || config.torBoxApiKey) {
    let rdTransientFailures = 0
    let tbTransientFailures = 0
    app.log.info(`play: trying ${streams.length} ranked candidate${streams.length === 1 ? '' : 's'} for ${label}`)
    const orderedStreams = streams
      .map((stream, index) => ({ stream, index }))
      .sort((a, b) => {
        const aHash = extractHashFromStream(a.stream)
        const bHash = extractHashFromStream(b.stream)
        const aDirect = !aHash && isDirectPlaybackUrl(a.stream.url)
        const bDirect = !bHash && isDirectPlaybackUrl(b.stream.url)
        if (aHash && !bHash) return -1
        if (!aHash && bHash) return 1
        if (aDirect && bDirect) {
          return directPlaybackPenalty(a.stream) - directPlaybackPenalty(b.stream) || a.index - b.index
        }
        return a.index - b.index
      })
      .map(entry => entry.stream)
    for (const stream of orderedStreams) {
      const providerOrder = stream.providerOrder ?? 999
      const hash = extractHashFromStream(stream)
      const hashLabel = hash ? hash.slice(0, 8) : 'direct-url'
      try {
        if (config.englishStreamMode === 'require' && streamClearlyNonEnglish(stream)) {
          app.log.info(`play: skipping stream metadata for ${label}, clearly non-English`)
          continue
        }

        const hint = streamFilenameHint(stream) ?? fileHint
        if (!hash) {
          if (!config.torBoxApiKey || config.directPlaybackMode !== 'all' || !isDirectPlaybackUrl(stream.url)) {
            app.log.info(`play: skipping providerOrder=${providerOrder} for ${label}, no torrent hash exposed`)
            continue
          }

          const directFilename = hint ?? filenameFromDirectPlaybackUrl(stream.url)
          if (directFilename && !isVideoFile(directFilename)) {
            app.log.info(`play: skipping non-video direct stream ${directFilename}, trying next`)
            continue
          }
          if (directFilename && isLikelyBadResolvedFilename(directFilename)) {
            app.log.info(`play: skipping suspicious direct stream ${directFilename}, trying next`)
            continue
          }
          if (
            directFilename
            && config.englishStreamMode === 'require'
            && isRemoteAudioProbeUnreliable(directFilename)
            && !streamClearlyEnglish(stream)
          ) {
            app.log.info(`play: skipping unprobeable ${directFilename}, no confirmed English metadata`)
            continue
          }
          const isDebridCachedStream = /\[rd\+\]|\[rd ⚡\]|\[rd⚡\]|\brd\+\b|\[tb\+\]|\[tb ⚡\]|\[tb⚡\]|\btb\+\b/.test(streamMetadataText(stream))
          // Skip ffprobe for debrid-cached streams — their proxy URLs will be resolved to
          // CDN URLs at play-time; probing here would waste a TorBox add/delete cycle.
          if (!isDebridCachedStream && directFilename && shouldProbeEnglishAudio(stream, directFilename)) {
            try {
              const audioLanguages = await probeAudioLanguages(stream.url)
              app.log.info(`play: ffprobe audio languages for ${directFilename}: ${audioLanguages.join(', ') || 'none'}`)
              const noLanguageInfo = audioLanguages.length === 0
              const allowsUndetermined = (hasOnlyUndeterminedAudio(audioLanguages) || noLanguageInfo) && !streamClearlyNonEnglish(stream)
              if (config.englishStreamMode === 'require' && !hasEnglishAudio(audioLanguages) && !allowsUndetermined) {
                app.log.info(`play: skipping ${directFilename}, no English audio detected`)
                continue
              }
            } catch (err) {
              app.log.warn(`play: ffprobe failed for ${directFilename}: ${summarizeProbeError(err)}`)
            }
          }

          app.log.info(`play: direct stream selected for ${label}${directFilename ? ` → ${directFilename}` : ''}`)
          clearFailedPlay(cacheKey)
          return { url: stream.url, filename: directFilename }
        }

        app.log.info(`play: trying providerOrder=${providerOrder} hash ${hash.slice(0, 8)}… for ${label}`)
        let resolved: ResolvedStream | null = null
        let provider = ''

        if (config.rdApiKey) {
          try {
            resolved = await resolveStream(hash, hint)
            provider = 'RD'
          } catch (rdErr) {
            if (rdErr instanceof NotCachedError) {
              app.log.info(`play: hash ${hashLabel}… not cached on RD${config.torBoxApiKey ? ', trying TorBox' : ''}`)
            } else if (rdErr instanceof ProviderUnavailableError) {
              rdTransientFailures += 1
              const retryable = !isNonRetryableRdError(rdErr) && rdTransientFailures < MAX_RD_TRANSIENT_FAILURES
              if (retryable) {
                app.log.warn(
                  `play: RD error for providerOrder=${providerOrder} hash ${hashLabel}…: ${rdErr}; ` +
                  `trying next candidate (${rdTransientFailures}/${MAX_RD_TRANSIENT_FAILURES})`
                )
              } else {
                app.log.warn(
                  `play: RD unavailable for ${label} after ${rdTransientFailures} failure${rdTransientFailures === 1 ? '' : 's'}: ${rdErr}` +
                  (config.torBoxApiKey ? '; falling back to TorBox' : '; not caching playback miss')
                )
                if (!config.torBoxApiKey) {
                  throw new PlaybackResolutionError(
                    'Real-Debrid unavailable',
                    503,
                    { error: 'Real-Debrid unavailable', message: 'Real-Debrid Unavailable' },
                  )
                }
              }
            } else {
              app.log.warn(`play: hash ${hashLabel}… RD failed: ${rdErr}`)
            }
          }
        }

        if (!resolved && config.torBoxApiKey) {
          try {
            resolved = await tbResolveStream(hash, hint)
            provider = 'TorBox'
          } catch (tbErr) {
            if (tbErr instanceof NotCachedError) {
              app.log.info(`play: hash ${hashLabel}… not cached on TorBox, trying next`)
              continue
            }
            if (tbErr instanceof ProviderUnavailableError) {
              tbTransientFailures += 1
              const retryable = !isNonRetryableRdError(tbErr) && tbTransientFailures < MAX_RD_TRANSIENT_FAILURES
              if (retryable) {
                app.log.warn(
                  `play: TorBox error for providerOrder=${providerOrder} hash ${hashLabel}…: ${tbErr}; ` +
                  `trying next candidate (${tbTransientFailures}/${MAX_RD_TRANSIENT_FAILURES})`
                )
                continue
              }
              app.log.warn(
                `play: TorBox unavailable for ${label} after ${tbTransientFailures} failure${tbTransientFailures === 1 ? '' : 's'}: ${tbErr}; ` +
                'not caching playback miss'
              )
              throw new PlaybackResolutionError(
                'Debrid provider unavailable',
                503,
                { error: 'Debrid provider unavailable', message: 'Debrid Unavailable' },
              )
            }
            app.log.warn(`play: hash ${hashLabel}… TorBox failed: ${tbErr}; trying next`)
            continue
          }
        }

        if (!resolved) continue

        if (!isVideoFile(resolved.filename)) {
          app.log.info(`play: skipping non-video file ${resolved.filename}, trying next`)
          continue
        }
        if (isLikelyBadResolvedFilename(resolved.filename)) {
          app.log.info(`play: skipping suspicious file ${resolved.filename}, trying next`)
          continue
        }
        if (
          config.englishStreamMode === 'require'
          && isRemoteAudioProbeUnreliable(resolved.filename)
          && !streamClearlyEnglish(stream)
        ) {
          app.log.info(`play: skipping unprobeable ${resolved.filename}, no confirmed English metadata`)
          continue
        }
        if (shouldProbeEnglishAudio(stream, resolved.filename)) {
          try {
            const audioLanguages = await probeAudioLanguages(resolved.url)
            app.log.info(`play: ffprobe audio languages for ${resolved.filename}: ${audioLanguages.join(', ') || 'none'}`)
            const noLanguageInfo = audioLanguages.length === 0
            const allowsUndetermined = (hasOnlyUndeterminedAudio(audioLanguages) || noLanguageInfo) && !streamClearlyNonEnglish(stream)
            if (config.englishStreamMode === 'require' && !hasEnglishAudio(audioLanguages) && !allowsUndetermined) {
              app.log.info(`play: skipping ${resolved.filename}, no English audio detected`)
              continue
          }
        } catch (err) {
            app.log.warn(`play: ffprobe failed for ${resolved.filename}: ${summarizeProbeError(err)}`)
          }
        }
        app.log.info(`play: ${provider} resolved ${resolved.filename} from hash ${hash.slice(0, 8)}…`)
        clearFailedPlay(cacheKey)
        return { url: resolved.url, filename: resolved.filename, sourceHash: hash }
      } catch (err) {
        if (err instanceof PlaybackResolutionError) throw err
        app.log.warn(`play: hash ${hashLabel}… failed: ${err}; trying next`)
      }
    }
    app.log.warn(`play: no usable cached stream found for ${label}`)
    cacheFailedPlay(cacheKey, 'No cached stream available')
    throw new PlaybackResolutionError(
      'No cached stream available',
      404,
      { error: 'No cached stream available', message: 'No Cached Streams Found' },
    )
  }
  const best = config.englishStreamMode === 'require'
    ? (streams.find(stream => streamClearlyEnglish(stream)) ?? streams.find(stream => !streamClearlyNonEnglish(stream)))
    : streams[0]
  if (!best?.url) {
    cacheFailedPlay(cacheKey, 'No streams found')
    throw new PlaybackResolutionError(
      'No usable stream available',
      404,
      { error: 'No usable stream available', message: 'No Streams Found' },
    )
  }
  app.log.info(`play: fallback direct stream selected for ${label}`)
  clearFailedPlay(cacheKey)
  return { url: best.url }
}

async function resolveMoviePlayback(imdbId: string): Promise<PlayResolution> {
  const playPath = `/play/${imdbId}`
  const streams = await fetchRankedStreams(imdbId)
  return resolvePlayableStream(streams, imdbId, playPath)
}

async function resolveEpisodePlayback(imdbId: string, season: number, episodeNumber: number): Promise<PlayResolution> {
  const playPath = `/play/${imdbId}/${season}/${episodeNumber}`
  const show = getShowByImdbId(imdbId)
  const episode = show
    ? getEpisodesForSeason(show.tmdbId, season).find(ep => ep.episodeNumber === episodeNumber)
    : null
  const episodeAirYear = episode?.airDate ? Number.parseInt(episode.airDate.slice(0, 4), 10) : undefined
  const streams = await fetchRankedEpisodeStreams(
    imdbId,
    season,
    episodeNumber,
    show?.year || undefined,
    Number.isFinite(episodeAirYear) ? episodeAirYear : undefined,
  )
  return resolvePlayableStream(
    streams,
    `${imdbId} S${season}E${episodeNumber}`,
    playPath,
    `s${pad2(season)}e${pad2(episodeNumber)}`,
  )
}

function playbackResolverForPath(playPath: string): (() => Promise<PlayResolution>) | null {
  const movieMatch = playPath.match(/^\/play\/([^/]+)$/)
  if (movieMatch) return () => resolveMoviePlayback(movieMatch[1])

  const episodeMatch = playPath.match(/^\/play\/([^/]+)\/(\d+)\/(\d+)$/)
  if (episodeMatch) {
    const imdbId = episodeMatch[1]
    const season = Number.parseInt(episodeMatch[2], 10)
    const episode = Number.parseInt(episodeMatch[3], 10)
    if (Number.isFinite(season) && Number.isFinite(episode)) {
      return () => resolveEpisodePlayback(imdbId, season, episode)
    }
  }

  return null
}

app.get('/play/:imdbId', async (req, reply) => {
  const { imdbId } = req.params as { imdbId: string }
  const query = req.query as { token?: string; expires?: string } | undefined
  const playPath = `/play/${imdbId}`
  if (!verifySignedPlaybackPath(playPath, query?.token, query?.expires)) {
    if (!requestPlaybackUser(req.headers)) {
      app.log.warn(`play: rejected unauthenticated playback request for ${imdbId}`)
    } else {
      app.log.warn(`play: rejected unsigned or expired playback request for ${imdbId}`)
    }
    return reply.code(401).send({ error: 'Unauthorized' })
  }
  const failedReason = getFailedPlayReason(playPath)
  if (failedReason) {
    app.log.info(`play: cached miss for ${imdbId} (${failedReason})`)
    return reply.code(404).send({ error: failedReason, message: 'No Streams Found' })
  }
  app.log.info(`play: resolving stream for ${imdbId}`)
  try {
    const { promise, reused } = getOrCreatePlaybackResolution(playPath, imdbId, () => resolveMoviePlayback(imdbId))
    if (reused) app.log.info(`play: using prewarmed resolver for ${imdbId}`)
    const resolved = await promise
    if (isTorBoxCdnUrl(resolved.url)) return proxyTorBoxStream(resolved.url, req, reply as never)
    return reply.redirect(resolved.url, 302)
  } catch (err) {
    if (err instanceof PlaybackResolutionError) {
      return reply.code(err.statusCode).send(err.response)
    }
    app.log.warn(`play: no stream for ${imdbId}: ${err}`)
    cacheFailedPlay(playPath, 'No streams found')
    return reply.code(404).send({ error: 'No stream available', message: 'No Streams Found' })
  }
})

app.get('/play/:imdbId/:season/:episode', async (req, reply) => {
  const { imdbId, season, episode } = req.params as { imdbId: string; season: string; episode: string }
  const query = req.query as { token?: string; expires?: string } | undefined
  const playPath = `/play/${imdbId}/${season}/${episode}`
  if (!verifySignedPlaybackPath(playPath, query?.token, query?.expires)) {
    if (!requestPlaybackUser(req.headers)) {
      app.log.warn(`play: rejected unauthenticated episode playback request for ${imdbId} S${season}E${episode}`)
    } else {
      app.log.warn(`play: rejected unsigned or expired episode playback request for ${imdbId} S${season}E${episode}`)
    }
    return reply.code(401).send({ error: 'Unauthorized' })
  }
  const failedReason = getFailedPlayReason(playPath)
  if (failedReason) {
    app.log.info(`play: cached miss for ${imdbId} S${season}E${episode} (${failedReason})`)
    return reply.code(404).send({ error: failedReason, message: 'No Streams Found' })
  }
  const s = parseInt(season)
  const e = parseInt(episode)
  app.log.info(`play: resolving episode stream for ${imdbId} S${s}E${e}`)
  try {
    const label = `${imdbId} S${s}E${e}`
    const { promise, reused } = getOrCreatePlaybackResolution(playPath, label, () => resolveEpisodePlayback(imdbId, s, e))
    if (reused) app.log.info(`play: using prewarmed resolver for ${label}`)
    const resolved = await promise
    if (isTorBoxCdnUrl(resolved.url)) return proxyTorBoxStream(resolved.url, req, reply as never)
    return reply.redirect(resolved.url, 302)
  } catch (err) {
    if (err instanceof PlaybackResolutionError) {
      return reply.code(err.statusCode).send(err.response)
    }
    app.log.warn(`play: no stream for ${imdbId} S${s}E${e}: ${err}`)
    cacheFailedPlay(playPath, 'No streams found')
    return reply.code(404).send({ error: 'No stream available', message: 'No Streams Found' })
  }
})

// Register routes after playback helpers are initialized so Jellyfin can prewarm them.
await app.register(jellyfinRoutes, { prewarmPlayback })
await app.register(jellyfinRoutes, { prefix: '/emby', prewarmPlayback })
await app.register(uiRoutes)
await app.register(subsonicRoutes)
await app.register(bookRoutes)

// ── Trakt auth ────────────────────────────────────────────────────────────────

// GET /trakt/auth — check auth status
app.get('/trakt/auth', async (req, reply) => {
  if (!requireAdminUiSession(req as never, reply as never)) return
  return tokenStatus()
})

// POST /trakt/auth — start device flow
// Returns the code + URL to visit. Polls in background; token saved when approved.
app.post('/trakt/auth', async (req, reply) => {
  if (!requireAdminUiSession(req as never, reply as never)) return
  try {
    const { instructions, approved } = await startDeviceAuth()
    app.log.info(`trakt: device auth started — visit ${instructions.verificationUrl} and enter code: ${instructions.userCode}`)
    // Background: save token when user approves
    approved
      .then(async () => {
        app.log.info('trakt: OAuth approved, starting watchlist sync')
        await runSync()
      })
      .catch(err => app.log.error(`trakt: device auth failed: ${err}`))
    return {
      message:         `Visit ${instructions.verificationUrl} and enter this code`,
      code:            instructions.userCode,
      verificationUrl: instructions.verificationUrl,
      expiresInSecs:   instructions.expiresIn,
    }
  } catch (err) {
    return reply.code(500).send({ error: String(err) })
  }
})

// ── Manual sync ───────────────────────────────────────────────────────────────
// POST /sync  — re-fetch Trakt watchlist and update the DB in the background.

app.post('/sync', async (req, reply) => {
  if (!requireAdminUiSession(req as never, reply as never)) return
  runSync().catch(err => app.log.error(`Manual sync failed: ${err}`))
  return { status: 'sync started' }
})

let currentSync: Promise<void> | null = null

// Sync on startup, then every 60 minutes
async function runSyncInternal() {
  if (config.traktWatchlistMovies) {
    await syncTraktWatchlist()
  } else {
    const removed = removeSourceKey('trakt:watchlist:movies', 'movie')
    const pruned = pruneAllOrphanedMovies()
    if (removed.length || pruned) {
      app.log.info(`sync: movie watchlist disabled; removed ${removed.length} source items and pruned ${pruned} movies`)
    }
  }

  if (config.traktWatchlistShows) {
    await syncTraktShowsWatchlist()
  } else {
    const removed = removeSourceKey('trakt:watchlist:shows', 'show')
    const pruned = pruneAllOrphanedShows()
    if (removed.length || pruned) {
      app.log.info(`sync: show watchlist disabled; removed ${removed.length} source items and pruned ${pruned} shows`)
    }
  }

  for (const slug of config.traktLists) {
    await syncTraktList(slug).catch(err => app.log.error(`List sync "${slug}" failed: ${err}`))
  }
  if (config.traktWatchHistory) {
    await syncTraktWatchedStatus().catch(err => app.log.error(`Watched-status sync failed: ${err}`))
  }
  const staleListCleanup = cleanupRemovedTraktListSources(config.traktLists)
  if (staleListCleanup.removedSourceKeys.length) {
    app.log.warn(
      `sync: removed stale Trakt list sources — ${staleListCleanup.removedSourceKeys.join(', ')}; ` +
      `${staleListCleanup.prunedMovies} movies pruned, ${staleListCleanup.prunedShows} shows pruned`
    )
  }

  for (const listUrl of config.mdblistLists) {
    await syncMdblistList(listUrl).catch(err => app.log.error(`MDBList sync "${listUrl}" failed: ${err}`))
  }
  const staleMdblistCleanup = cleanupRemovedMdblistListSources(config.mdblistLists)
  if (staleMdblistCleanup.removedSourceKeys.length) {
    app.log.warn(
      `sync: removed stale MDBList sources — ${staleMdblistCleanup.removedSourceKeys.join(', ')}; ` +
      `${staleMdblistCleanup.prunedMovies} movies pruned, ${staleMdblistCleanup.prunedShows} shows pruned`
    )
  }

  // Refresh metadata (e.g. backdrop_path) for movies missing it
  const movies = listMovies({ limit: 100_000 })
  for (const movie of movies) {
    await refreshMovieMetadataIfNeeded(movie).catch(() => {})
  }

  // Also refresh metadata (e.g. backdrop_path) for shows missing it
  const shows = listShows({ limit: 100_000 })
  for (const show of shows) {
    await refreshShowMetadataIfNeeded(show).catch(() => {})
    await ensureShowSeasonsCached(show).catch(err =>
      app.log.warn(`Season fetch failed for "${show.title}": ${err}`)
    )
  }

  const latestSeasonSubs = listLatestSeasonShowSubscriptions()
  for (const sub of latestSeasonSubs) {
    const latestSeasonNumber = getLatestSeasonNumberForShow(sub.showTmdbId)
    if (latestSeasonNumber && latestSeasonNumber !== sub.activeSeasonNumber) {
      upsertManualShowSubscription(sub.showTmdbId, 'latest', latestSeasonNumber)
    }
  }

  const prunedMovies = pruneAllOrphanedMovies()
  const prunedShows = pruneAllOrphanedShows()
  if (prunedMovies || prunedShows) {
    app.log.warn(`sync: pruned orphaned rows — ${prunedMovies} movies, ${prunedShows} shows`)
  }

  markSyncComplete()

  // Sync AudioBookShelf library (best-effort)
  if (config.absUrl && config.absApiKey) {
    await syncAbsLibrary().catch(err => app.log.error(`ABS sync failed: ${err}`))
  }
}

function runSync(): Promise<void> {
  if (currentSync) {
    app.log.info('sync: already in progress, reusing existing run')
    return currentSync
  }
  currentSync = runSyncInternal()
    .catch(err => {
      app.log.error(`Sync failed: ${err}`)
      throw err
    })
    .finally(() => {
      currentSync = null
    })
  return currentSync
}

runSync().catch(err => app.log.error(`Startup sync failed: ${err}`))
setInterval(
  () => runSync().catch(err => app.log.error(`Scheduled sync failed: ${err}`)),
  60 * 60 * 1000,
)

await app.listen({ port: config.port, host: config.host })
