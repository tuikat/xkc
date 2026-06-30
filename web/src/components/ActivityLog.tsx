import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ScrollText, CheckCircle, XCircle, Loader, RefreshCw, Trash2 } from 'lucide-react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { cn } from '../lib/utils'

export default function ActivityLog() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { log, clearLog } = useStore()
  const qc = useQueryClient()

  const { data: failedTracks = [] } = useQuery({
    queryKey: ['failed-tracks'],
    queryFn: () => api.tracks.getTracks({ analysis_state: 'failed', limit: 50 }),
    enabled: open,
    refetchOnWindowFocus: false,
  })

  const reanalyze = useMutation({
    mutationFn: api.tracks.reanalyze,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['failed-tracks'] })
      qc.invalidateQueries({ queryKey: ['tracks'] })
    },
  })

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const activeCount = log.filter(e => e.status === 'uploading').length
  const errorCount = log.filter((e) => e.status === 'error').length + failedTracks.length
  const hasActivity = log.length > 0 || failedTracks.length > 0

  // Auto-open when a new active job starts
  useEffect(() => {
    if (activeCount > 0) setOpen(true)
  }, [activeCount])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'relative flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors',
          open
            ? 'border-xkc-accent text-xkc-accent bg-xkc-accent/10'
            : activeCount > 0
            ? 'border-xkc-accent/60 text-xkc-accent hover:border-xkc-accent'
            : errorCount > 0
            ? 'border-red-500/40 text-red-400 hover:border-red-500/60'
            : 'border-xkc-border text-xkc-muted hover:text-xkc-text'
        )}
        title="Activity log"
      >
        {activeCount > 0 ? <Loader size={13} className="animate-spin" /> : <ScrollText size={13} />}
        {activeCount > 0 && (
          <span className="text-[10px]">{activeCount} active</span>
        )}
        {activeCount === 0 && errorCount > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] flex items-center justify-center font-bold">
            {errorCount > 9 ? '9+' : errorCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 bg-xkc-surface border border-xkc-border rounded-xl shadow-2xl z-50 flex flex-col max-h-[480px]">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-xkc-border flex-shrink-0">
            <span className="text-sm font-medium text-xkc-text">Activity Log</span>
            <div className="flex items-center gap-2">
              {log.length > 0 && (
                <button onClick={clearLog} className="flex items-center gap-1 text-xs text-xkc-muted hover:text-xkc-text">
                  <Trash2 size={11} /> Clear
                </button>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="overflow-y-auto flex-1">
            {!hasActivity && (
              <div className="flex flex-col items-center justify-center py-12 text-xkc-muted">
                <ScrollText size={28} className="mb-2 opacity-30" />
                <span className="text-sm">No activity yet</span>
              </div>
            )}

            {/* Failed analysis tracks (server-side) */}
            {failedTracks.length > 0 && (
              <section>
                <div className="px-4 py-2 text-xs font-medium text-xkc-muted uppercase tracking-wide bg-xkc-bg/50 border-b border-xkc-border">
                  Analysis failures ({failedTracks.length})
                </div>
                {failedTracks.map((track) => (
                  <div key={track.id} className="px-4 py-3 border-b border-xkc-border/50 last:border-b-0">
                    <div className="flex items-start gap-2">
                      <XCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-xkc-text truncate">
                          {track.title || track.artist || 'Unknown track'}
                        </div>
                        {(track as unknown as { analysis_error?: string }).analysis_error && (
                          <div className="text-xs text-red-400/80 mt-0.5 break-words line-clamp-3">
                            {(track as unknown as { analysis_error?: string }).analysis_error}
                          </div>
                        )}
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="text-xs text-xkc-muted">
                            {new Date(track.date_added).toLocaleDateString()} {new Date(track.date_added).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <button
                            onClick={() => reanalyze.mutate(track.id)}
                            disabled={reanalyze.isPending}
                            className="flex items-center gap-1 text-xs text-xkc-accent hover:text-blue-400 disabled:opacity-50"
                          >
                            <RefreshCw size={10} className={reanalyze.isPending ? 'animate-spin' : ''} />
                            Retry
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </section>
            )}

            {/* Upload log (client-side) */}
            {log.length > 0 && (
              <section>
                <div className="px-4 py-2 text-xs font-medium text-xkc-muted uppercase tracking-wide bg-xkc-bg/50 border-b border-xkc-border">
                  Upload history ({log.length})
                </div>
                {log.map((entry) => {
                  const stageLabel: Record<string, string> = {
                    preparing: 'Preparing',
                    uploading: typeof entry.pct === 'number' ? `Uploading ${entry.pct}%` : 'Uploading',
                    saved: 'Saved',
                    analyzing: 'Indexing',
                    complete: 'Done',
                    duplicate: 'Duplicate',
                    error: 'Failed',
                  }
                  const label = (entry.stage && stageLabel[entry.stage]) || entry.status
                  return (
                    <div key={entry.id} className="px-4 py-2.5 border-b border-xkc-border/50 last:border-b-0 flex items-start gap-2">
                      {entry.status === 'complete' && <CheckCircle size={13} className="text-green-400 flex-shrink-0 mt-0.5" />}
                      {entry.status === 'error' && <XCircle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />}
                      {entry.status === 'uploading' && <Loader size={13} className="text-xkc-accent flex-shrink-0 mt-0.5 animate-spin" />}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-xkc-text truncate">{entry.name}</div>
                        {entry.detail && (
                          <div className={`text-xs mt-0.5 break-words ${entry.status === 'error' ? 'text-red-400/80' : 'text-yellow-400/80'}`}>{entry.detail}</div>
                        )}
                        {entry.stage === 'uploading' && typeof entry.pct === 'number' && (
                          <div className="h-1 mt-1.5 rounded-full bg-xkc-bg overflow-hidden">
                            <div className="h-full bg-xkc-accent transition-all" style={{ width: `${entry.pct}%` }} />
                          </div>
                        )}
                        <div className="text-[10px] text-xkc-muted mt-0.5">
                          {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </div>
                      </div>
                      <span className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 whitespace-nowrap',
                        entry.status === 'complete' && 'bg-green-900/30 text-green-400',
                        entry.status === 'error' && 'bg-red-900/30 text-red-400',
                        entry.status === 'uploading' && 'bg-xkc-accent/10 text-xkc-accent',
                      )}>
                        {label}
                      </span>
                    </div>
                  )
                })}
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
