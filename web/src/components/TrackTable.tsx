import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Track, Tag } from '../lib/api'
import { api } from '../lib/api'
import { formatDuration, formatBpm, hexColor } from '../lib/utils'
import { Star, Play, Pause, Loader2, ChevronUp, ChevronDown, Settings2 } from 'lucide-react'
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
  onFilterByArtist?: (artist: string) => void
}

// ---- Column definitions ----
interface ColDef {
  id: string
  label: string
  width: string
  sortKey?: keyof Track
  render: (track: Track, tagById: Record<string, Tag>, trackId: string, onFilterByArtist?: (a: string) => void) => React.ReactNode
}

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
    canvas.width = W * dpr; canvas.height = H * dpr
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H)
    const pts = data.overview
    const numBars = Math.floor(W / (BAR_W + GAP))
    const maxVal = Math.max(...pts, 0.001)
    const midY = H / 2
    for (let i = 0; i < numBars; i++) {
      const srcIdx = Math.floor((i / numBars) * pts.length)
      const norm = pts[srcIdx] / maxVal
      const h = Math.max(norm * midY * 0.9, 1)
      ctx.fillStyle = isPlaying ? '#3b82f6' : '#334155'
      ctx.fillRect(i * (BAR_W + GAP), midY - h, BAR_W, h * 2)
    }
  }, [data, isPlaying])
  return <canvas ref={canvasRef} width={96} height={24} style={{ display: 'block', width: 96, height: 24 }} />
}

function StarCell({ trackId, rating }: { trackId: string; rating: number }) {
  const qc = useQueryClient()
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <button key={i} onClick={(e) => {
          e.stopPropagation()
          api.tracks.updateTrack(trackId, { rating: i }).then(() => qc.invalidateQueries({ queryKey: ['tracks'] }))
        }} className="p-0 leading-none">
          <Star size={10} className={i <= rating ? 'text-yellow-400 fill-yellow-400' : 'text-xkc-border hover:text-yellow-300'} />
        </button>
      ))}
    </div>
  )
}

const ALL_COLS: ColDef[] = [
  { id: 'wave', label: 'Wave', width: '100px',
    render: (t, _, id) => t.analysis_state === 'complete'
      ? <MiniWaveform trackId={id} isPlaying={false /* updated by parent */} />
      : <div className="h-6 rounded bg-xkc-border/20 flex items-center px-1"><span className="text-[9px] text-xkc-muted">{t.analysis_state}</span></div>
  },
  { id: 'title', label: 'Title', width: '180px', sortKey: 'title',
    render: (t) => <span className="truncate text-xkc-text">{t.title || '—'}</span> },
  { id: 'artist', label: 'Artist', width: '140px', sortKey: 'artist',
    render: (t, _tb, _id, onFilterByArtist) => t.artist
      ? <button
          onClick={(e) => { e.stopPropagation(); onFilterByArtist?.(t.artist!) }}
          className="truncate text-xkc-muted hover:text-xkc-accent hover:underline text-left max-w-full"
          title={`Filter by ${t.artist}`}
        >{t.artist}</button>
      : <span className="text-xkc-muted">—</span> },
  { id: 'album', label: 'Album', width: '130px', sortKey: 'album',
    render: (t) => <span className="truncate text-xkc-muted">{t.album || '—'}</span> },
  { id: 'bpm', label: 'BPM', width: '58px', sortKey: 'bpm',
    render: (t) => <span className="text-xkc-text font-mono text-xs">{formatBpm(t.bpm)}</span> },
  { id: 'key', label: 'Key', width: '46px', sortKey: 'key_camelot',
    render: (t) => <span className="text-xkc-text text-xs">{t.key_camelot || '—'}</span> },
  { id: 'duration', label: 'Time', width: '52px', sortKey: 'duration_ms',
    render: (t) => <span className="text-xkc-muted text-xs font-mono">{formatDuration(t.duration_ms)}</span> },
  { id: 'genre', label: 'Genre', width: '80px', sortKey: 'genre',
    render: (t) => <span className="truncate text-xkc-muted text-xs">{t.genre || '—'}</span> },
  { id: 'label', label: 'Label', width: '80px', sortKey: 'label',
    render: (t) => <span className="truncate text-xkc-muted text-xs">{t.label || '—'}</span> },
  { id: 'year', label: 'Year', width: '52px', sortKey: 'year',
    render: (t) => <span className="text-xkc-muted text-xs">{t.year || '—'}</span> },
  { id: 'tags', label: 'Tags', width: '72px',
    render: (t, tagById) => (
      <div className="flex gap-1 flex-wrap">
        {(t.tag_ids || []).slice(0, 4).map((tid) => {
          const tag = tagById[tid]
          return tag ? <span key={tid} className="w-2 h-2 rounded-full flex-shrink-0 mt-0.5" style={{ backgroundColor: hexColor(tag.color) }} title={tag.name} /> : null
        })}
      </div>
    )},
  { id: 'rating', label: 'Rating', width: '70px', sortKey: 'rating',
    render: (t, _, id) => <StarCell trackId={id} rating={t.rating} /> },
  { id: 'date_added', label: 'Added', width: '82px', sortKey: 'date_added',
    render: (t) => <span className="text-xkc-muted text-xs">{new Date(t.date_added).toLocaleDateString()}</span> },
  { id: 'play_count', label: 'Plays', width: '52px', sortKey: 'play_count',
    render: (t) => <span className="text-xkc-muted text-xs">{t.play_count}</span> },
  { id: 'bitrate', label: 'kbps', width: '52px', sortKey: 'bitrate',
    render: (t) => <span className="text-xkc-muted text-xs">{t.bitrate ? Math.round(t.bitrate / 1000) : '—'}</span> },
  { id: 'format', label: 'Format', width: '60px',
    render: (t) => <span className="text-xkc-muted text-xs uppercase">{t.file_format || '—'}</span> },
]

const DEFAULT_COL_IDS = ['wave', 'title', 'artist', 'bpm', 'key', 'duration', 'genre', 'tags', 'rating', 'date_added']

export default function TrackTable({
  tracks, onSelectTrack, selectedTrackId, tagGroups = [],
  onAddToPlaylist, onDeleteTrack, onReanalyze, onFilterByArtist,
}: TrackTableProps) {
  const qc = useQueryClient()
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null)
  const [sortCol, setSortCol] = useState<string>('date_added')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [visibleColIds, setVisibleColIds] = useState<string[]>(DEFAULT_COL_IDS)
  const [colPickerOpen, setColPickerOpen] = useState(false)
  const { playerTrack, playerPlaying, setPlayerTrack } = useStore()
  const allTags = tagGroups.flatMap((g) => g.tags)
  const tagById = Object.fromEntries(allTags.map((t) => [t.id, t]))

  const visibleCols = ALL_COLS.filter((c) => visibleColIds.includes(c.id))
  const gridTemplate = `32px ${visibleCols.map((c) => c.width).join(' ')}`

  // Sort tracks
  const sorted = [...tracks].sort((a, b) => {
    const col = ALL_COLS.find((c) => c.id === sortCol)
    if (!col?.sortKey) return 0
    const va = a[col.sortKey] ?? ''
    const vb = b[col.sortKey] ?? ''
    const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number)
    return sortDir === 'asc' ? cmp : -cmp
  })

  function toggleSort(colId: string) {
    if (sortCol === colId) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(colId); setSortDir('asc') }
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault(); setSelectedIds(tracks.map((t) => t.id))
      }
      if (e.key === 'Escape') { setSelectedIds([]); setColPickerOpen(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tracks])

  function handleRowClick(e: React.MouseEvent, track: Track, idx: number) {
    if (e.shiftKey && lastSelectedIdx !== null) {
      const lo = Math.min(lastSelectedIdx, idx), hi = Math.max(lastSelectedIdx, idx)
      setSelectedIds((prev) => Array.from(new Set([...prev, ...sorted.slice(lo, hi + 1).map((t) => t.id)])))
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedIds((prev) => prev.includes(track.id) ? prev.filter((x) => x !== track.id) : [...prev, track.id])
      setLastSelectedIdx(idx)
    } else {
      setSelectedIds([track.id]); setLastSelectedIdx(idx); onSelectTrack(track.id)
    }
  }

  function handlePlay(e: React.MouseEvent, track: Track) {
    e.stopPropagation()
    if (track.analysis_state !== 'complete') return
    if (playerTrack?.id === track.id) {
      const a = getAudio(); if (a.paused) a.play(); else a.pause()
    } else {
      setPlayerTrack(track); setTimeout(() => getAudio().play().catch(() => {}), 100)
    }
  }

  function handleDragStart(e: React.DragEvent, track: Track) {
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

  function toggleCol(colId: string) {
    setVisibleColIds((prev) =>
      prev.includes(colId)
        ? prev.filter((id) => id !== colId)
        : [...prev, colId]
    )
  }

  return (
    <div className="relative flex flex-col h-full" onClick={() => { setContextMenu(null); setColPickerOpen(false) }}>
      {/* Single scroll container — header + rows scroll together horizontally */}
      <div className="overflow-auto flex-1">
        {/* Sticky header row */}
        <div
          className="grid gap-x-2 px-3 py-2 border-b border-xkc-border text-xs text-xkc-muted uppercase tracking-wider bg-xkc-surface sticky top-0 z-10"
          style={{ gridTemplateColumns: gridTemplate, minWidth: 'max-content' }}
        >
          {/* Column picker button */}
          <div className="flex items-center justify-center">
            <button
              onClick={(e) => { e.stopPropagation(); setColPickerOpen(!colPickerOpen) }}
              className="text-xkc-muted hover:text-xkc-text p-0.5"
              title="Show/hide columns"
            >
              <Settings2 size={12} />
            </button>
          </div>
          {visibleCols.map((col) => (
            <button
              key={col.id}
              className={cn(
                'flex items-center gap-0.5 text-left hover:text-xkc-text transition-colors',
                sortCol === col.id && 'text-xkc-accent',
                !col.sortKey && 'cursor-default'
              )}
              onClick={() => col.sortKey && toggleSort(col.id)}
            >
              {col.label}
              {col.sortKey && sortCol === col.id && (
                sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />
              )}
            </button>
          ))}
        </div>

        {/* Rows */}
        {sorted.length === 0 && (
          <div className="flex items-center justify-center h-32 text-xkc-muted text-sm">No tracks found</div>
        )}
        {sorted.map((track, idx) => {
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
                'grid gap-x-2 px-3 py-1.5 border-b border-xkc-border/50 cursor-pointer text-sm items-center select-none',
                'hover:bg-xkc-surface',
                isSelected && 'bg-blue-900/40',
                isDetailOpen && !isSelected && 'border-l-2 border-l-xkc-accent',
                isLoaded && !isSelected && 'bg-blue-950/30',
              )}
              style={{ gridTemplateColumns: gridTemplate, minWidth: 'max-content' }}
            >
              {/* Play button */}
              <button
                onClick={(e) => handlePlay(e, track)}
                className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center transition-colors flex-shrink-0',
                  canPlay
                    ? isLoaded ? 'bg-xkc-accent text-white hover:bg-blue-600' : 'text-xkc-muted hover:bg-xkc-accent/20 hover:text-xkc-accent'
                    : 'text-xkc-border cursor-default',
                )}
                title={!canPlay ? `Analysis: ${track.analysis_state}` : isPlaying ? 'Pause' : isLoaded ? 'Play' : 'Load & Play'}
              >
                {track.analysis_state === 'analyzing' ? <Loader2 size={11} className="animate-spin" />
                  : track.analysis_state === 'failed' ? <span className="text-red-400 text-[10px]">✗</span>
                  : isPlaying ? <Pause size={11} />
                  : <Play size={11} className="ml-0.5" />}
              </button>

              {/* Visible columns */}
              {visibleCols.map((col) => (
                <div key={col.id} className="min-w-0 overflow-hidden flex items-center">
                  {col.id === 'wave' && canPlay
                    ? <MiniWaveform trackId={track.id} isPlaying={isPlaying} />
                    : col.render(track, tagById, track.id, onFilterByArtist)}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {/* Column picker dropdown */}
      {colPickerOpen && (
        <div
          className="absolute top-9 left-3 z-50 bg-xkc-surface border border-xkc-border rounded-lg shadow-xl p-3 min-w-[180px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-xs text-xkc-muted mb-2 font-medium uppercase tracking-wider">Columns</div>
          {ALL_COLS.map((col) => (
            <label key={col.id} className="flex items-center gap-2 py-1 text-xs text-xkc-text cursor-pointer hover:text-white">
              <input
                type="checkbox"
                checked={visibleColIds.includes(col.id)}
                onChange={() => toggleCol(col.id)}
                className="accent-xkc-accent"
              />
              {col.label}
            </label>
          ))}
          <button
            onClick={() => setVisibleColIds(DEFAULT_COL_IDS)}
            className="mt-2 text-xs text-xkc-muted hover:text-xkc-text w-full text-left"
          >
            Reset to default
          </button>
        </div>
      )}

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
