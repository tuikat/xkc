import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Track, Tag } from '../lib/api'
import { api } from '../lib/api'
import { formatDuration, formatBpm, hexColor } from '../lib/utils'
import { Star, Play, Pause, Loader2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { useStore } from '../lib/store'
import { getAudio } from './Player'

interface ContextMenuState { x: number; y: number; trackIds: string[] }

interface TrackTableProps {
  tracks: Track[]
  onSelectTrack: (id: string) => void
  selectedTrackId: string | null
  tagGroups?: { id: string; name: string; tags: Tag[] }[]
  onAddToPlaylist?: (trackId: string) => void
  onDeleteTrack?: (trackId: string) => void
  onReanalyze?: (trackId: string) => void
}

const COL_STYLE = '32px 96px 1fr 1fr 58px 46px 52px 72px 90px 66px 82px'

function MiniWaveform({ trackId, isPlaying }: { trackId: string; isPlaying: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { data } = useQuery({
    queryKey: ['waveform', trackId],
    queryFn: () => api.tracks.getWaveform(trackId),
    staleTime: Infinity,
    gcTime: Infinity,
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data?.overview?.length) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = 96, H = 24, BAR_W = 2, GAP = 1
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)

    const pts = data.overview
    const numBars = Math.floor(W / (BAR_W + GAP))
    const maxVal = Math.max(...pts, 0.001)
    const midY = H / 2

    for (let i = 0; i < numBars; i++) {
      const srcIdx = Math.floor((i / numBars) * pts.length)
      const norm = pts[srcIdx] / maxVal
      const h = Math.max(norm * midY * 0.9, 1)
      const x = i * (BAR_W + GAP)
      ctx.fillStyle = isPlaying ? '#3b82f6' : '#334155'
      ctx.fillRect(x, midY - h, BAR_W, h * 2)
    }
  }, [data, isPlaying])

  // width/height attrs set intrinsic size immediately so the row doesn't jump from 150px default
  return <canvas ref={canvasRef} width={96} height={24} style={{ display: 'block', width: 96, height: 24 }} />
}

function Stars({ trackId, rating }: { trackId: string; rating: number }) {
  const qc = useQueryClient()
  function setRating(e: React.MouseEvent, stars: number) {
    e.stopPropagation()
    api.tracks.updateTrack(trackId, { rating: stars }).then(() => qc.invalidateQueries({ queryKey: ['tracks'] }))
  }
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <button key={i} onClick={(e) => setRating(e, i)} className="p-0 leading-none">
          <Star size={10} className={i <= rating ? 'text-yellow-400 fill-yellow-400' : 'text-xkc-border hover:text-yellow-300'} />
        </button>
      ))}
    </div>
  )
}

export default function TrackTable({
  tracks, onSelectTrack, selectedTrackId, tagGroups = [],
  onAddToPlaylist, onDeleteTrack, onReanalyze,
}: TrackTableProps) {
  const qc = useQueryClient()
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null)
  const { playerTrack, playerPlaying, setPlayerTrack } = useStore()
  const allTags = tagGroups.flatMap((g) => g.tags)
  const tagById = Object.fromEntries(allTags.map((t) => [t.id, t]))

  // Cmd+A to select all
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        setSelectedIds(tracks.map((t) => t.id))
      }
      if (e.key === 'Escape') setSelectedIds([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tracks])

  function handleRowClick(e: React.MouseEvent, track: Track, idx: number) {
    const id = track.id
    if (e.shiftKey && lastSelectedIdx !== null) {
      // Range select
      const lo = Math.min(lastSelectedIdx, idx)
      const hi = Math.max(lastSelectedIdx, idx)
      const rangeIds = tracks.slice(lo, hi + 1).map((t) => t.id)
      setSelectedIds((prev) => Array.from(new Set([...prev, ...rangeIds])))
    } else if (e.metaKey || e.ctrlKey) {
      // Toggle individual
      setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
      setLastSelectedIdx(idx)
    } else {
      // Normal click — open detail, reset multi-select
      setSelectedIds([id])
      setLastSelectedIdx(idx)
      onSelectTrack(id)
    }
  }

  function handlePlay(e: React.MouseEvent, track: Track) {
    e.stopPropagation()
    if (track.analysis_state !== 'complete') return
    if (playerTrack?.id === track.id) {
      const a = getAudio()
      if (a.paused) a.play()
      else a.pause()
    } else {
      setPlayerTrack(track)
      setTimeout(() => getAudio().play().catch(() => {}), 100)
    }
  }

  function handleDragStart(e: React.DragEvent, track: Track) {
    // Drag all selected tracks, or just this one if not in selection
    const ids = selectedIds.includes(track.id) ? selectedIds : [track.id]
    e.dataTransfer.setData('trackIds', JSON.stringify(ids))
    e.dataTransfer.setData('text/plain', ids.join(','))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const handleContextMenu = useCallback((e: React.MouseEvent, track: Track) => {
    e.preventDefault()
    const ids = selectedIds.includes(track.id) ? selectedIds : [track.id]
    setContextMenu({ x: e.clientX, y: e.clientY, trackIds: ids })
  }, [selectedIds])

  return (
    <div className="relative flex flex-col h-full" onClick={() => { setContextMenu(null) }}>
      {/* Header */}
      <div
        className="grid gap-x-2 px-3 py-2 border-b border-xkc-border text-xs text-xkc-muted uppercase tracking-wider bg-xkc-surface sticky top-0 z-10"
        style={{ gridTemplateColumns: COL_STYLE }}
      >
        <div />
        <div>Wave</div>
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
          <div className="flex items-center justify-center h-32 text-xkc-muted text-sm">No tracks found</div>
        )}
        {tracks.map((track, idx) => {
          const isSelected = selectedIds.includes(track.id)
          const isDetailOpen = selectedTrackId === track.id
          const isLoaded = playerTrack?.id === track.id
          const isPlaying = isLoaded && playerPlaying
          const canPlay = track.analysis_state === 'complete'
          return (
            <div
              key={track.id}
              draggable={canPlay}
              onDragStart={(e) => handleDragStart(e, track)}
              onClick={(e) => handleRowClick(e, track, idx)}
              onContextMenu={(e) => handleContextMenu(e, track)}
              className={cn(
                'grid gap-x-2 px-3 py-1.5 border-b border-xkc-border/50 cursor-pointer hover:bg-xkc-surface text-sm items-center select-none',
                isSelected && 'bg-blue-900/40',
                isDetailOpen && !isSelected && 'border-l-2 border-l-xkc-accent',
                isLoaded && !isSelected && 'bg-blue-950/30',
              )}
              style={{ gridTemplateColumns: COL_STYLE }}
            >
              {/* Play button */}
              <button
                onClick={(e) => handlePlay(e, track)}
                className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center transition-colors flex-shrink-0',
                  canPlay
                    ? isLoaded
                      ? 'bg-xkc-accent text-white hover:bg-blue-600'
                      : 'text-xkc-muted hover:bg-xkc-accent/20 hover:text-xkc-accent'
                    : 'text-xkc-border cursor-default',
                )}
                title={!canPlay ? `Analysis: ${track.analysis_state}` : isPlaying ? 'Pause' : isLoaded ? 'Play' : 'Load & Play'}
              >
                {track.analysis_state === 'analyzing' ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : track.analysis_state === 'failed' ? (
                  <span className="text-red-400 text-[10px]">✗</span>
                ) : isPlaying ? (
                  <Pause size={11} />
                ) : (
                  <Play size={11} className="ml-0.5" />
                )}
              </button>

              {/* Mini waveform */}
              {canPlay ? (
                <MiniWaveform trackId={track.id} isPlaying={isPlaying} />
              ) : (
                <div className="h-6 rounded bg-xkc-border/20 flex items-center px-1">
                  <span className="text-[9px] text-xkc-muted">{track.analysis_state}</span>
                </div>
              )}

              <div className="truncate text-xkc-text">{track.title || '—'}</div>
              <div className="truncate text-xkc-muted">{track.artist || '—'}</div>
              <div className="text-xkc-text font-mono text-xs">{formatBpm(track.bpm)}</div>
              <div className="text-xkc-text text-xs">{track.key_camelot || '—'}</div>
              <div className="text-xkc-muted text-xs font-mono">{formatDuration(track.duration_ms)}</div>
              <div className="truncate text-xkc-muted text-xs">{track.genre || '—'}</div>
              <div className="flex gap-1 flex-wrap">
                {(track.tag_ids || []).slice(0, 4).map((tid) => {
                  const tag = tagById[tid]
                  return tag ? (
                    <span key={tid} className="w-2 h-2 rounded-full flex-shrink-0 mt-0.5"
                      style={{ backgroundColor: hexColor(tag.color) }} title={tag.name} />
                  ) : null
                })}
              </div>
              <Stars trackId={track.id} rating={track.rating} />
              <div className="text-xkc-muted text-xs">{new Date(track.date_added).toLocaleDateString()}</div>
            </div>
          )
        })}
      </div>

      {/* Selection count badge */}
      {selectedIds.length > 1 && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-xkc-accent text-white text-xs rounded-full px-3 py-1 shadow-lg pointer-events-none">
          {selectedIds.length} tracks selected
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-xkc-surface border border-xkc-border rounded-lg shadow-xl py-1 min-w-[180px] text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-xs text-xkc-muted border-b border-xkc-border mb-1">
            {contextMenu.trackIds.length} track{contextMenu.trackIds.length > 1 ? 's' : ''} selected
          </div>
          {onAddToPlaylist && (
            <button className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-xkc-text"
              onClick={() => { contextMenu.trackIds.forEach((id) => onAddToPlaylist(id)); setContextMenu(null) }}>
              Add to Playlist
            </button>
          )}
          {onReanalyze && contextMenu.trackIds.length === 1 && (
            <button className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-xkc-text"
              onClick={() => { onReanalyze(contextMenu.trackIds[0]); setContextMenu(null) }}>
              Re-analyze
            </button>
          )}
          {onDeleteTrack && (
            <>
              <div className="border-t border-xkc-border my-1" />
              <button className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-red-400"
                onClick={() => { contextMenu.trackIds.forEach((id) => onDeleteTrack(id)); setContextMenu(null) }}>
                Delete {contextMenu.trackIds.length > 1 ? `${contextMenu.trackIds.length} tracks` : 'track'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
