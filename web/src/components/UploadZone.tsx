import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { enqueueUpload } from '../lib/uploadQueue'
import { Upload } from 'lucide-react'
import { cn } from '../lib/utils'

interface UploadZoneProps {
  children: React.ReactNode
}

export default function UploadZone({ children }: UploadZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const qc = useQueryClient()

  const processFiles = useCallback((files: FileList | File[]) => {
    return enqueueUpload(files, () => qc.invalidateQueries({ queryKey: ['tracks'] }))
  }, [qc])

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
