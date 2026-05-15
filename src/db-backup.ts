import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { config } from './config.js'
import { getDb } from './db.js'

const BACKUP_DEBOUNCE_MS = 15_000

let backupTimer: NodeJS.Timeout | null = null
let backupInterval: NodeJS.Timeout | null = null
let fileWatcher: FSWatcher | null = null
let backupRunning = false
let backupQueued = false
let databaseDirty = false

function isBackupConfigured(): boolean {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey)
}

function getBackupObjectPath(): string {
  return config.supabaseBackupObject.trim() || 'fetcherr.db'
}

function getSupabaseHeaders(contentType?: string): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    apikey: config.supabaseServiceRoleKey,
  }
  if (contentType) headers['Content-Type'] = contentType
  return headers
}

function buildStorageUrl(path: string): string {
  return `${config.supabaseUrl}/storage/v1/${path.replace(/^\/+/, '')}`
}

function buildObjectUrl(bucketName: string, objectPath: string): string {
  const encodedObjectPath = objectPath.split('/').map(segment => encodeURIComponent(segment)).join('/')
  return buildStorageUrl(`object/${encodeURIComponent(bucketName)}/${encodedObjectPath}`)
}

function getDbTempPath(): string {
  return join(tmpdir(), `fetcherr-${randomUUID()}.db`)
}

function getRestoreTempPath(): string {
  return join(dirname(config.dbPath), `.fetcherr-restore-${randomUUID()}.db`)
}

function markDatabaseDirty(): void {
  databaseDirty = true
  if (backupTimer) clearTimeout(backupTimer)
  backupTimer = setTimeout(() => {
    backupTimer = null
    void flushDatabaseBackup().catch(() => {})
  }, BACKUP_DEBOUNCE_MS)
}

async function uploadDatabaseBackup(): Promise<void> {
  if (!isBackupConfigured()) return

  const tempPath = getDbTempPath()
  try {
    await getDb().backup(tempPath)
    const snapshot = await readFile(tempPath)
    const response = await fetch(buildObjectUrl(config.supabaseBackupBucket, getBackupObjectPath()), {
      method: 'PUT',
      headers: getSupabaseHeaders('application/x-sqlite3'),
      body: snapshot,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Supabase backup upload failed with HTTP ${response.status}: ${text}`)
    }

    databaseDirty = false
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

async function flushDatabaseBackup(force = false): Promise<void> {
  if (!isBackupConfigured()) return
  if (!force && !databaseDirty) return
  if (backupRunning) {
    backupQueued = true
    return
  }

  backupRunning = true
  try {
    await uploadDatabaseBackup()
  } finally {
    backupRunning = false
    if (backupQueued) {
      backupQueued = false
      void flushDatabaseBackup().catch(() => {})
    }
  }
}

export async function restoreDatabaseBackupIfNeeded(): Promise<boolean> {
  if (!isBackupConfigured()) return false

  await mkdir(dirname(config.dbPath), { recursive: true })

  try {
    const existing = await stat(config.dbPath)
    if (existing.size > 0) return false
  } catch {
    // No local database yet, continue with restore.
  }

  const response = await fetch(buildObjectUrl(config.supabaseBackupBucket, getBackupObjectPath()), {
    headers: getSupabaseHeaders(),
  })
  if (!response.ok) return false

  const tempPath = getRestoreTempPath()
  try {
    const bytes = await response.arrayBuffer()
    await writeFile(tempPath, Buffer.from(bytes))
    await rm(config.dbPath, { force: true }).catch(() => {})
    await rename(tempPath, config.dbPath)
    return true
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

export function startDatabaseBackupSync(): () => Promise<void> {
  if (!isBackupConfigured()) {
    return async () => {}
  }

  const dbBaseName = config.dbPath.split(/[\\/]/).pop() ?? 'fetcherr.db'
  const dbDir = dirname(config.dbPath)

  fileWatcher = watch(dbDir, (_eventType, filename) => {
    const changed = String(filename ?? '')
    if (!changed) return
    if (changed !== dbBaseName && changed !== `${dbBaseName}-wal` && changed !== `${dbBaseName}-shm`) return
    databaseDirty = true
    markDatabaseDirty()
  })

  backupInterval = setInterval(() => {
    if (databaseDirty) void flushDatabaseBackup().catch(() => {})
  }, config.supabaseBackupIntervalMinutes * 60 * 1000)

  return async () => {
    if (backupTimer) clearTimeout(backupTimer)
    backupTimer = null
    if (backupInterval) clearInterval(backupInterval)
    backupInterval = null
    const watcher = fileWatcher
    fileWatcher = null
    if (watcher) watcher.close()
    await flushDatabaseBackup(true).catch(() => {})
  }
}

export async function backupDatabaseNow(): Promise<void> {
  await flushDatabaseBackup(true)
}
