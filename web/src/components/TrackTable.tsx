import { useState } from 'react'
import type { Track, Tag } from '../lib/api'
import { formatDuration, formatBpm, hexColor } from '../lib/utils'
import { Star } from 'lucide-react'
import { cn } from '../lib/utils'

interface ContextMenuState {
  x: number
  y: number
  trackId: string
}

interface TrackTableProps {
  tracks: Track[]
  onSelectTrack: (id: string) => void
  selectedTrackId: string | null
  tagGroups?: { id: string; name: string; tags: Tag[] }[]
  onAddToPlaylist?: (trackId: string) => void
  onDeleteTrack?: (trackId: string) => void
  onReanalyze?: (trackId: string) => void
}

function AnalysisBadge({ state }: { state: string }) {
  const map: Record<string, { color: string; label: string }> = {
    pending: { color: 'bg-yellow-700', label: '⏳' },
    analyzing: { color: 'bg-blue-700 animate-pulse', label: '⚙' },
    complete: { color: 'bg-green-700', label: '✓' },
    failed: { color: 'bg-red-700', label: '✗' },
  }
  const info = map[state] || map.pending
  return (
    <span className={cn('inline-flex items-center justify-center w-4 h-4 rounded-full text-white text-xs', info.color)}>
      {info.label}
    </span>
  )
}

function Stars({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          size={10}
          className={i <= rating ? 'text-yellow-400 fill-yellow-400' : 'text-xkc-border'}
        />
      ))}
    </div>
  )
}

export default function TrackTable({
  tracks,
  onSelectTrack,
  selectedTrackId,
  tagGroups = [],
  onAddToPlaylist,
  onDeleteTrack,
  onReanalyze,
}: TrackTableProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const allTags = tagGroups.flatMap((g) => g.tags)
  const tagById = Object.fromEntries(allTags.map((t) => [t.id, t]))

  function handleContextMenu(e: React.MouseEvent, trackId: string) {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, trackId })
  }

  function closeMenu() {
    setContextMenu(null)
  }

  return (
    <div className="relative flex flex-col h-full" onClick={closeMenu}>
      {/* Header */}
      <div className="grid grid-cols-[20px_1fr_1fr_60px_60px_60px_80px_120px_80px_90px] gap-x-2 px-3 py-2 border-b border-xkc-border text-xs text-xkc-muted uppercase tracking-wider bg-xkc-surface sticky top-0 z-10">
        <div />
        <div>Title</div>
        <div>Artist</div>
        <div>BPM</div>
        <div>Key</div>
        <div>Time</div>
        <div>Genre</div>
        <div>Tags</div>
        <div>Rating</div>
        <div>Added</div>
      </div>

      {/* Rows */}
      <div className="overflow-y-auto flex-1">
        {tracks.length === 0 && (
          <div className="flex items-center justify-center h-32 text-xkc-muted text-sm">
            No tracks found
          </div>
        )}
        {tracks.map((track) => (
          <div
            key={track.id}
            onClick={() => onSelectTrack(track.id)}
            onContextMenu={(e) => handleContextMenu(e, track.id)}
            className={cn(
              'grid grid-cols-[20px_1fr_1fr_60px_60px_60px_80px_120px_80px_90px] gap-x-2 px-3 py-1.5 border-b border-xkc-border/50 cursor-pointer hover:bg-xkc-surface text-sm items-center',
              selectedTrackId === track.id && 'bg-xkc-surface border-l-2 border-l-xkc-accent'
            )}
          >
            <AnalysisBadge state={track.analysis_state} />
            <div className="truncate text-xkc-text">{track.title || '—'}</div>
            <div className="truncate text-xkc-muted">{track.artist || '—'}</div>
            <div className="text-xkc-text font-mono text-xs">{formatBpm(track.bpm)}</div>
            <div className="text-xkc-text text-xs">{track.key_camelot || '—'}</div>
            <div className="text-xkc-muted text-xs font-mono">{formatDuration(track.duration_ms)}</div>
            <div className="truncate text-xkc-muted text-xs">{track.genre || '—'}</div>
            <div className="flex gap-1 flex-wrap">
              {(track.tag_ids || []).slice(0, 4).map((tid) => {
                const tag = tagById[tid]
                if (!tag) return null
                return (
                  <span
                    key={tid}
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: hexColor(tag.color) }}
                    title={tag.name}
                  />
                )
              })}
            </div>
            <Stars rating={track.rating} />
            <div className="text-xkc-muted text-xs">
              {new Date(track.date_added).toLocaleDateString()}
            </div>
          </div>
        ))}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-xkc-surface border border-xkc-border rounded-lg shadow-xl py-1 min-w-[160px] text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {onAddToPlaylist && (
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-xkc-text"
              onClick={() => { onAddToPlaylist(contextMenu.trackId); closeMenu() }}
            >
              Add to Playlist
            </button>
          )}
          {onReanalyze && (
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-xkc-text"
              onClick={() => { onReanalyze(contextMenu.trackId); closeMenu() }}
            >
              Re-analyze
            </button>
          )}
          {onDeleteTrack && (
            <>
              <div className="border-t border-xkc-border my-1" />
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-red-400"
                onClick={() => { onDeleteTrack(contextMenu.trackId); closeMenu() }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
