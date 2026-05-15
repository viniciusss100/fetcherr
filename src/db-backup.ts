import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '@supabase/supabase-js'
import { config } from './config.js'
import { getDb } from './db.js'

const BACKUP_DEBOUNCE_MS = 15_000

let backupClient: ReturnType<typeof createClient> | null = null
let backupTimer: NodeJS.Timeout | null = null
let backupInterval: NodeJS.Timeout | null = null
let fileWatcher: FSWatcher | null = null
let backupRunning = false
let backupQueued = false
let databaseDirty = false

function isBackupConfigured(): boolean {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey)
}

function getBackupClient() {
  if (!isBackupConfigured()) return null
  if (!backupClient) {
    backupClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  }
  return backupClient
}

async function ensureBackupBucket(): Promise<void> {
  const client = getBackupClient()
  if (!client) return

  const { data, error } = await client.storage.listBuckets()
  if (error) throw error
  if (data.some(bucket => bucket.name === config.supabaseBackupBucket)) return

  const { error: createError } = await client.storage.createBucket(config.supabaseBackupBucket, {
    public: false,
  })
  if (createError && !String(createError.message ?? '').toLowerCase().includes('already exists')) {
    throw createError
  }
}

function getBackupObjectPath(): string {
  return config.supabaseBackupObject.trim() || 'fetcherr.db'
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
  const client = getBackupClient()
  if (!client) return

  await ensureBackupBucket()

  const tempPath = getDbTempPath()
  try {
    await getDb().backup(tempPath)
    const snapshot = await readFile(tempPath)
    const { error } = await client.storage.from(config.supabaseBackupBucket).upload(getBackupObjectPath(), snapshot, {
      contentType: 'application/x-sqlite3',
      upsert: true,
    })
    if (error) throw error
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

  const client = getBackupClient()
  if (!client) return false

  await mkdir(dirname(config.dbPath), { recursive: true })

  try {
    const existing = await stat(config.dbPath)
    if (existing.size > 0) return false
  } catch {
    // No local database yet, continue with restore.
  }

  await ensureBackupBucket()

  const { data, error } = await client.storage.from(config.supabaseBackupBucket).download(getBackupObjectPath())
  if (error || !data) return false

  const tempPath = getRestoreTempPath()
  try {
    const bytes = await data.arrayBuffer()
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
    if (watcher && 'close' in watcher) {
      watcher.close()
    }
    await flushDatabaseBackup(true).catch(() => {})
  }
}

export async function backupDatabaseNow(): Promise<void> {
  await flushDatabaseBackup(true)
}
