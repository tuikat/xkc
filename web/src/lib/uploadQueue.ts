// Shared upload pipeline used by both the drag-drop UploadZone and the
// Library "Import" file picker. Centralised so both entry points get the
// same bounded concurrency and the same staged status reporting — a past
// bug had the Import button fire every selected file's upload at once with
// no cap, which is what made large (1000+ track) imports fall over.
import { api } from './api'
import { useStore } from './store'

const AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/x-flac',
  'audio/wav', 'audio/x-wav', 'audio/aiff', 'audio/x-aiff',
  'audio/mp4', 'audio/x-m4a', 'audio/ogg', 'audio/opus',
])

export function isAudioFile(f: File): boolean {
  return AUDIO_TYPES.has(f.type) || /\.(mp3|flac|wav|aiff|aif|m4a|ogg|opus|aac)$/i.test(f.name)
}

const CONCURRENCY = 5
// If no upload-progress event has fired this long after we start sending,
// the browser is likely still materialising the file (e.g. an iCloud Drive /
// OneDrive placeholder that hasn't downloaded yet) rather than us actually
// being stalled on the network.
const STALL_MS = 2500
const POLL_MS = 3000
const POLL_BATCH = 200
// Stop polling an individual track's analysis state after this long so a
// stuck/lost track can't keep the poll loop alive forever; it keeps
// whatever was its last-known stage.
const PENDING_TTL_MS = 30 * 60 * 1000

interface PendingEntry { logId: string; since: number }
const pendingAnalysis = new Map<string, PendingEntry>()
let pollHandle: ReturnType<typeof setInterval> | null = null

function startPolling() {
  if (pollHandle) return
  pollHandle = setInterval(async () => {
    if (pendingAnalysis.size === 0) {
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null }
      return
    }
    const now = Date.now()
    const ids: string[] = []
    for (const [id, entry] of pendingAnalysis) {
      if (now - entry.since > PENDING_TTL_MS) { pendingAnalysis.delete(id); continue }
      ids.push(id)
      if (ids.length >= POLL_BATCH) break
    }
    if (!ids.length) return
    try {
      const rows = await api.tracks.getTrackStatus(ids)
      const { updateLog } = useStore.getState()
      for (const row of rows) {
        const entry = pendingAnalysis.get(row.id)
        if (!entry) continue
        if (row.analysis_state === 'analyzing') {
          updateLog(entry.logId, { stage: 'analyzing', detail: 'Indexing — BPM, key & waveform…' })
        } else if (row.analysis_state === 'complete') {
          updateLog(entry.logId, { status: 'complete', stage: 'complete', detail: undefined })
          pendingAnalysis.delete(row.id)
        } else if (row.analysis_state === 'failed') {
          updateLog(entry.logId, { status: 'error', stage: 'error', detail: row.analysis_error || 'Analysis failed' })
          pendingAnalysis.delete(row.id)
        }
      }
    } catch {
      // transient network hiccup while polling — just retry on the next tick
    }
  }, POLL_MS)
}

/**
 * Enqueue a batch of files for upload with bounded concurrency and staged
 * status reporting into the activity log. `onLibraryChanged` is called
 * periodically (not after every single file) as new tracks land, so a
 * 3000-track import doesn't trigger 3000 separate track-list refetches.
 */
export function enqueueUpload(fileList: FileList | File[], onLibraryChanged?: () => void): Promise<void> {
  const files = Array.from(fileList).filter(isAudioFile)
  if (!files.length) return Promise.resolve()

  const { addToQueue, updateQueueItem, addLog, updateLog } = useStore.getState()
  let completedSinceRefresh = 0

  const uploadOne = (file: File): Promise<void> =>
    new Promise((resolveOne) => {
      const id = addToQueue(file)
      updateQueueItem(id, { status: 'uploading' })
      addLog({ id, name: file.name, status: 'uploading', stage: 'preparing', detail: 'Preparing…', ts: Date.now() })

      let started = false
      const stallTimer = window.setTimeout(() => {
        if (!started) updateLog(id, { detail: 'Waiting on file (large file, slow disk, or still downloading from cloud storage)…' })
      }, STALL_MS)

      api.tracks.uploadTrack(file, (pct) => {
        started = true
        clearTimeout(stallTimer)
        updateQueueItem(id, { progress: pct })
        updateLog(id, { stage: 'uploading', pct, detail: undefined })
      })
        .then((result) => {
          clearTimeout(stallTimer)
          updateQueueItem(id, { status: 'complete', progress: 100 })
          if (result?.duplicate) {
            updateLog(id, { status: 'complete', stage: 'duplicate', pct: 100, detail: 'Already in library (skipped)' })
          } else {
            updateLog(id, { status: 'uploading', stage: 'saved', pct: 100, detail: 'Saved — queued for analysis…' })
            if (result?.id) {
              pendingAnalysis.set(result.id, { logId: id, since: Date.now() })
              startPolling()
            }
            completedSinceRefresh++
            if (completedSinceRefresh >= 5) {
              onLibraryChanged?.()
              completedSinceRefresh = 0
            }
          }
        })
        .catch((err) => {
          clearTimeout(stallTimer)
          const msg = err instanceof Error ? err.message : 'Upload failed'
          updateQueueItem(id, { status: 'error', error: msg })
          updateLog(id, { status: 'error', stage: 'error', detail: msg })
        })
        .finally(() => resolveOne())
    })

  // Bounded-concurrency pool: never more than CONCURRENCY files in flight
  // (being read/uploaded) at once, regardless of how many were selected.
  const queue = [...files]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const file = queue.shift()!
      await uploadOne(file)
    }
  })

  return Promise.all(workers).then(() => {
    if (completedSinceRefresh > 0) onLibraryChanged?.()
  })
}
