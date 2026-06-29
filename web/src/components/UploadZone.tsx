import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { Upload, X, CheckCircle, AlertCircle, Loader2 } from 'lucide-react'
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
  const { uploadQueue, addToQueue, updateQueueItem, clearCompleted } = useStore()
  const qc = useQueryClient()

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const audioFiles = Array.from(files).filter(
      (f) => AUDIO_TYPES.has(f.type) || /\.(mp3|flac|wav|aiff|aif|m4a|ogg|opus|aac)$/i.test(f.name)
    )
    if (!audioFiles.length) return

    for (const file of audioFiles) {
      const queueId = addToQueue(file)
      updateQueueItem(queueId, { status: 'uploading' })
      try {
        await api.tracks.uploadTrack(file, (pct) => updateQueueItem(queueId, { progress: pct }))
        updateQueueItem(queueId, { status: 'complete', progress: 100 })
        qc.invalidateQueries({ queryKey: ['tracks'] })
      } catch (err) {
        updateQueueItem(queueId, {
          status: 'error',
          error: err instanceof Error ? err.message : 'Upload failed',
        })
      }
    }
  }, [addToQueue, updateQueueItem, qc])

  useEffect(() => {
    function onDragOver(e: DragEvent) { e.preventDefault(); setIsDragOver(true) }
    function onDragLeave() { setIsDragOver(false) }
    function onDrop(e: DragEvent) {
      e.preventDefault()
      setIsDragOver(false)
      if (e.dataTransfer?.files) processFiles(e.dataTransfer.files)
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

  const hasQueue = uploadQueue.length > 0
  const allDone = uploadQueue.every((i) => i.status === 'complete' || i.status === 'error')

  return (
    <div className="relative flex flex-col h-full">
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

      {/* Upload queue bar */}
      {hasQueue && (
        <div className="border-t border-xkc-border bg-xkc-surface px-3 py-2 flex-shrink-0">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-xs text-xkc-muted">
              {uploadQueue.filter((i) => i.status === 'complete').length}/{uploadQueue.length} uploaded
            </div>
            {allDone && (
              <button onClick={clearCompleted} className="text-xs text-xkc-muted hover:text-xkc-text">
                Clear
              </button>
            )}
          </div>
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {uploadQueue.map((item) => (
              <div key={item.id} className="flex items-center gap-2 text-xs">
                <div className="flex-shrink-0">
                  {item.status === 'complete' && <CheckCircle size={12} className="text-green-400" />}
                  {item.status === 'error' && <AlertCircle size={12} className="text-red-400" />}
                  {item.status === 'uploading' && <Loader2 size={12} className="text-xkc-accent animate-spin" />}
                  {item.status === 'pending' && <div className="w-3 h-3 rounded-full border border-xkc-muted" />}
                </div>
                <div className="flex-1 truncate text-xkc-muted">{item.file.name}</div>
                {item.status === 'uploading' && (
                  <div className="w-16 bg-xkc-border rounded-full h-1">
                    <div
                      className="bg-xkc-accent h-1 rounded-full transition-all"
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>
                )}
                {item.status === 'error' && <span className="text-red-400 text-xs">{item.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
