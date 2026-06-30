import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { Upload } from 'lucide-react'
import { cn } from '../lib/utils'

interface UploadZoneProps {
  children: React.ReactNode
}

const AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/x-flac',
  'audio/wav', 'audio/x-wav', 'audio/aiff', 'audio/x-aiff',
  'audio/mp4', 'audio/x-m4a', 'audio/ogg', 'audio/opus',
])

export default function UploadZone({ children }: UploadZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const { addToQueue, updateQueueItem, addLog, updateLog } = useStore()
  const qc = useQueryClient()

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const audioFiles = Array.from(files).filter(
      (f) => AUDIO_TYPES.has(f.type) || /\.(mp3|flac|wav|aiff|aif|m4a|ogg|opus|aac)$/i.test(f.name)
    )
    if (!audioFiles.length) return

    let completedSinceRefresh = 0
    const CONCURRENCY = 5

    const uploadOne = async (file: File) => {
      const queueId = addToQueue(file)
      updateQueueItem(queueId, { status: 'uploading' })
      addLog({ id: queueId, name: file.name, status: 'uploading', ts: Date.now() })
      try {
        const result = await api.tracks.uploadTrack(file, (pct) => updateQueueItem(queueId, { progress: pct }))
        updateQueueItem(queueId, { status: 'complete', progress: 100 })
        if (result?.duplicate) {
          updateLog(queueId, { status: 'complete', detail: 'Already in library (skipped)' })
        } else {
          updateLog(queueId, { status: 'complete' })
          completedSinceRefresh++
          if (completedSinceRefresh >= 5) {
            qc.invalidateQueries({ queryKey: ['tracks'] })
            completedSinceRefresh = 0
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed'
        updateQueueItem(queueId, { status: 'error', error: msg })
        updateLog(queueId, { status: 'error', detail: msg })
      }
    }

    // Process with a pool of CONCURRENCY slots — as each finishes the next starts,
    // never loading more than CONCURRENCY files into memory at once
    const queue = [...audioFiles]
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const file = queue.shift()!
        await uploadOne(file)
      }
    })
    await Promise.all(workers)

    if (completedSinceRefresh > 0) qc.invalidateQueries({ queryKey: ['tracks'] })
  }, [addToQueue, updateQueueItem, addLog, updateLog, qc])

  useEffect(() => {
    function isFileDrag(e: DragEvent) {
      const types = Array.from(e.dataTransfer?.types ?? [])
      // Internal track drags use 'trackids'; filesystem drags use 'Files'
      return types.includes('Files') && !types.includes('trackids')
    }
    function onDragOver(e: DragEvent) {
      e.preventDefault()
      if (isFileDrag(e)) setIsDragOver(true)
    }
    function onDragLeave(e: DragEvent) {
      // Only clear if leaving the window entirely
      if (!e.relatedTarget) setIsDragOver(false)
    }
    function onDrop(e: DragEvent) {
      e.preventDefault()
      setIsDragOver(false)
      if (isFileDrag(e) && e.dataTransfer?.files?.length) processFiles(e.dataTransfer.files)
    }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [processFiles])

  return (
    <div className="relative flex flex-col h-screen overflow-hidden">
      {children}

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 bg-xkc-accent/10 border-2 border-dashed border-xkc-accent rounded-lg flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-3 text-xkc-accent">
            <Upload size={48} />
            <div className="text-lg font-medium">Drop audio files to import</div>
          </div>
        </div>
      )}
    </div>
  )
}
