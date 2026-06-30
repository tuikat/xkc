import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Track, Tag } from '../lib/api'
import { api } from '../lib/api'
import { formatDuration, formatBpm, hexColor } from '../lib/utils'
import { Star, Play, Pause, Loader2, ChevronUp, ChevronDown, Settings2, Filter } from 'lucide-react'
import { cn } from '../lib/utils'
import { useStore } from '../lib/store'
import { getAudio, requestAutoPlay } from './Player'

interface ContextMenuState { x: number; y: number; trackIds: string[] }

interface TrackTableProps {
  tracks: Track[]
  onSelectTrack: (id: string) => void
  selectedTrackId: string | null
  tagGroups?: { id: string; name: string; tags: Tag[] }[]
  playlists?: { id: string; name: string }[]
  onAddToPlaylist?: (trackId: string, playlistId: string) => void
  onDeleteTrack?: (trackId: string) => void
  onReanalyze?: (trackId: string) => void
  isSharedPlaylist?: boolean
}

interface ColDef {
  id: string
  label: string
  width: string
  sortKey?: keyof Track
  filterable?: boolean
}

const ALL_COLS: ColDef[] = [
  { id: 'wave',       label: 'Wave',   width: '100px' },
  { id: 'title',      label: 'Title',  width: '180px', sortKey: 'title' },
  { id: 'artist',     label: 'Artist', width: '160px', sortKey: 'artist', filterable: true },
  { id: 'bpm',        label: 'BPM',    width: '58px',  sortKey: 'bpm',   filterable: true },
  { id: 'key',        label: 'Key',    width: '50px',  sortKey: 'key_camelot', filterable: true },
  { id: 'duration',   label: 'Time',   width: '52px',  sortKey: 'duration_ms' },
  { id: 'genre',      label: 'Genre',  width: '100px', sortKey: 'genre', filterable: true },
  { id: 'album',      label: 'Album',  width: '130px', sortKey: 'album' },
  { id: 'label',      label: 'Label',  width: '90px',  sortKey: 'label' },
  { id: 'year',       label: 'Year',   width: '52px',  sortKey: 'year' },
  { id: 'tags',       label: 'Tags',   width: '72px' },
  { id: 'rating',     label: 'Rating', width: '70px',  sortKey: 'rating' },
  { id: 'date_added', label: 'Added',  width: '82px',  sortKey: 'date_added' },
  { id: 'play_count', label: 'Plays',  width: '52px',  sortKey: 'play_count' },
  { id: 'bitrate',    label: 'kbps',   width: '52px',  sortKey: 'bitrate' },
  { id: 'format',     label: 'Format', width: '60px' },
]

const DEFAULT_COL_IDS = ['wave', 'title', 'artist', 'bpm', 'key', 'duration', 'genre', 'tags', 'rating', 'date_added']

// Split a comma-separated string into unique trimmed chips, preserving order
function splitChips(str: string | null): string[] {
  if (!str) return []
  const seen = new Set<string>()
  return str.split(',').map(s => s.trim()).filter(s => {
    if (!s) return false
    const l = s.toLowerCase()
    if (seen.has(l)) return false
    seen.add(l)
    return true
  })
}

function drawMiniWave(canvas: HTMLCanvasElement, pts: number[], isPlaying: boolean) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = 96, H = 24, BAR_W = 2, GAP = 1
  const dpr = window.devicePixelRatio || 1
  canvas.width = W * dpr; canvas.height = H * dpr
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H)
  const numBars = Math.floor(W / (BAR_W + GAP))
  const maxVal = Math.max(...pts, 0.001)
  const midY = H / 2
  for (let i = 0; i < numBars; i++) {
    const norm = pts[Math.floor((i / numBars) * pts.length)] / maxVal
    const h = Math.max(norm * midY * 0.9, 1)
    ctx.fillStyle = isPlaying ? '#3b82f6' : '#334155'
    ctx.fillRect(i * (BAR_W + GAP), midY - h, BAR_W, h * 2)
  }
}

function MiniWaveform({ trackId, isPlaying }: { trackId: string; isPlaying: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { data } = useQuery({
    queryKey: ['waveform', trackId],
    queryFn: () => api.tracks.getWaveform(trackId),
    staleTime: Infinity, gcTime: Infinity,
    retry: 2,
  })

  // useLayoutEffect so we draw synchronously after paint — prevents the "cached
  // data arrives, effect hasn't fired yet" miss that leaves canvases blank.
  useLayoutEffect(() => {
    if (canvasRef.current && data?.overview?.length) {
      drawMiniWave(canvasRef.current, data.overview, isPlaying)
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

export default function TrackTable({
  tracks, onSelectTrack, selectedTrackId, tagGroups = [],
  playlists = [], onAddToPlaylist, onDeleteTrack, onReanalyze, isSharedPlaylist = false,
}: TrackTableProps) {
  const qc = useQueryClient()
  const { filters, setFilters, playerTrack, playerPlaying, setPlayerTrack } = useStore()

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null)
  const [sortCol, setSortCol] = useState<string>('date_added')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [visibleColIds, setVisibleColIds] = useState<string[]>(DEFAULT_COL_IDS)
  const [colPickerOpen, setColPickerOpen] = useState(false)
  const [activeFilterCol, setActiveFilterCol] = useState<string | null>(null)
  // BPM filter local state (applied on blur/enter)
  const [bpmMin, setBpmMin] = useState(filters.minBpm?.toString() ?? '')
  const [bpmMax, setBpmMax] = useState(filters.maxBpm?.toString() ?? '')
  // Genre inline edit state
  const [editGenreId, setEditGenreId] = useState<string | null>(null)
  const [editGenreVal, setEditGenreVal] = useState('')

  const allTags = tagGroups.flatMap((g) => g.tags)
  const tagById = Object.fromEntries(allTags.map((t) => [t.id, t]))
  const visibleCols = ALL_COLS.filter((c) => visibleColIds.includes(c.id))
  const gridTemplate = `32px ${visibleCols.map((c) => c.width).join(' ')}`

  const sorted = [...tracks].sort((a, b) => {
    const col = ALL_COLS.find((c) => c.id === sortCol)
    if (!col?.sortKey) return 0
    const va = a[col.sortKey] ?? ''
    const vb = b[col.sortKey] ?? ''
    const cmp = typeof va === 'string' ? (va as string).localeCompare(vb as string) : (va as number) - (vb as number)
    return sortDir === 'asc' ? cmp : -cmp
  })

  function toggleSort(colId: string) {
    if (sortCol === colId) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(colId); setSortDir('asc') }
  }

  function applyBpmFilter() {
    setFilters({ ...filters, minBpm: bpmMin ? Number(bpmMin) : undefined, maxBpm: bpmMax ? Number(bpmMax) : undefined })
  }

  function saveGenre(trackId: string, genre: string) {
    api.tracks.updateTrack(trackId, { genre: genre || null } as Partial<Track>)
      .then(() => qc.invalidateQueries({ queryKey: ['tracks'] }))
    setEditGenreId(null)
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault(); setSelectedIds(tracks.map(t => t.id))
      }
      if (e.key === 'Escape') { setSelectedIds([]); setColPickerOpen(false); setActiveFilterCol(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tracks])

  function handleRowClick(e: React.MouseEvent, track: Track, idx: number) {
    if (e.shiftKey && lastSelectedIdx !== null) {
      const lo = Math.min(lastSelectedIdx, idx), hi = Math.max(lastSelectedIdx, idx)
      setSelectedIds(prev => Array.from(new Set([...prev, ...sorted.slice(lo, hi + 1).map(t => t.id)])))
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedIds(prev => prev.includes(track.id) ? prev.filter(x => x !== track.id) : [...prev, track.id])
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
      requestAutoPlay()
      setPlayerTrack(track)
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

  function closeAll() { setContextMenu(null); setColPickerOpen(false); setActiveFilterCol(null) }

  // ---- Cell renderers ----
  function renderCell(col: ColDef, track: Track, isPlaying: boolean, canPlay: boolean) {
    switch (col.id) {
      case 'wave':
        return canPlay
          ? <MiniWaveform trackId={track.id} isPlaying={isPlaying} />
          : <div className="h-6 rounded bg-xkc-border/20 flex items-center px-1"><span className="text-[9px] text-xkc-muted">{track.analysis_state}</span></div>

      case 'title':
        return (
          <div className="flex flex-col min-w-0">
            <span className="truncate text-xkc-text">{track.title || '—'}</span>
            {isSharedPlaylist && track.added_by_username && (
              <span className="text-[10px] text-xkc-muted truncate">by {track.added_by_username}</span>
            )}
          </div>
        )

      case 'artist': {
        const chips = splitChips(track.artist)
        if (!chips.length) return <span className="text-xkc-muted">—</span>
        return (
          <div className="chip-row w-full">
            {chips.map(a => (
              <button
                key={a}
                onClick={e => { e.stopPropagation(); setFilters({ ...filters, artist: a }) }}
                className={cn(
                  'text-[11px] px-1.5 py-0.5 rounded-full border transition-colors leading-tight flex-shrink-0',
                  filters.artist?.toLowerCase() === a.toLowerCase()
                    ? 'bg-xkc-accent/20 border-xkc-accent text-xkc-accent'
                    : 'border-xkc-border/60 text-xkc-muted hover:border-xkc-accent hover:text-xkc-accent'
                )}
                title={`Filter by ${a}`}
              >{a}</button>
            ))}
          </div>
        )
      }

      case 'bpm':
        return <span className="text-xkc-text font-mono text-xs">{formatBpm(track.bpm)}</span>

      case 'key':
        return track.key_camelot
          ? <button
              onClick={e => { e.stopPropagation(); setFilters({ ...filters, keyCamelot: track.key_camelot! }) }}
              className={cn(
                'text-xs px-1.5 py-0.5 rounded border transition-colors',
                filters.keyCamelot === track.key_camelot
                  ? 'bg-xkc-accent/20 border-xkc-accent text-xkc-accent'
                  : 'border-transparent text-xkc-text hover:border-xkc-accent hover:text-xkc-accent'
              )}
            >{track.key_camelot}</button>
          : <span className="text-xkc-muted">—</span>

      case 'duration':
        return <span className="text-xkc-muted text-xs font-mono">{formatDuration(track.duration_ms)}</span>

      case 'genre': {
        const chips = splitChips(track.genre)
        if (editGenreId === track.id) {
          return (
            <input
              autoFocus
              value={editGenreVal}
              onChange={e => setEditGenreVal(e.target.value)}
              onBlur={() => saveGenre(track.id, editGenreVal)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveGenre(track.id, editGenreVal)
                if (e.key === 'Escape') setEditGenreId(null)
                e.stopPropagation()
              }}
              onClick={e => e.stopPropagation()}
              placeholder="e.g. Techno"
              className="w-full bg-xkc-bg border border-xkc-accent rounded px-1.5 py-0.5 text-xs text-xkc-text focus:outline-none"
            />
          )
        }
        if (!chips.length) {
          return (
            <button
              onClick={e => { e.stopPropagation(); setEditGenreId(track.id); setEditGenreVal('') }}
              className="text-xkc-border/40 hover:text-xkc-muted text-xs italic"
            >+ genre</button>
          )
        }
        return (
          <div className="chip-row w-full">
            {chips.map(g => (
              <button
                key={g}
                onClick={e => { e.stopPropagation(); setFilters({ ...filters, genre: g }) }}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setEditGenreId(track.id); setEditGenreVal(track.genre ?? '') }}
                className={cn(
                  'text-[11px] px-1.5 py-0.5 rounded-full border transition-colors leading-tight flex-shrink-0',
                  filters.genre?.toLowerCase() === g.toLowerCase()
                    ? 'bg-xkc-accent/20 border-xkc-accent text-xkc-accent'
                    : 'border-xkc-border/60 text-xkc-muted hover:border-xkc-accent hover:text-xkc-accent'
                )}
                title={`Filter by ${g} — right-click to edit`}
              >{g}</button>
            ))}
          </div>
        )
      }

      case 'album':
        return <span className="truncate text-xkc-muted text-xs">{track.album || '—'}</span>
      case 'label':
        return <span className="truncate text-xkc-muted text-xs">{track.label || '—'}</span>
      case 'year':
        return <span className="text-xkc-muted text-xs">{track.year || '—'}</span>

      case 'tags':
        return (
          <div className="flex gap-1 flex-wrap">
            {(track.tag_ids || []).slice(0, 5).map(tid => {
              const tag = tagById[tid]
              return tag ? <span key={tid} className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: hexColor(tag.color) }} title={tag.name} /> : null
            })}
          </div>
        )

      case 'rating':
        return <StarCell trackId={track.id} rating={track.rating} />

      case 'date_added':
        return <span className="text-xkc-muted text-xs">{new Date(track.date_added).toLocaleDateString()}</span>

      case 'play_count':
        return <span className="text-xkc-muted text-xs">{track.play_count}</span>

      case 'bitrate':
        return <span className="text-xkc-muted text-xs">{track.bitrate ? Math.round(track.bitrate / 1000) : '—'}</span>

      case 'format':
        return <span className="text-xkc-muted text-xs uppercase">{track.file_format || '—'}</span>

      default:
        return null
    }
  }

  // Is a filter active for this column?
  function colFilterActive(colId: string): boolean {
    switch (colId) {
      case 'artist': return !!filters.artist
      case 'genre': return !!filters.genre
      case 'bpm': return !!(filters.minBpm || filters.maxBpm)
      case 'key': return !!filters.keyCamelot
      default: return false
    }
  }

  return (
    <div className="relative flex flex-col h-full" onClick={closeAll}>
      {/* Single scroll container — header sticky, rows scroll with it horizontally */}
      <div className="overflow-auto flex-1">
        {/* Sticky header */}
        <div
          className="grid gap-x-2 px-3 py-2 border-b border-xkc-border text-xs text-xkc-muted uppercase tracking-wider bg-xkc-surface sticky top-0 z-10"
          style={{ gridTemplateColumns: gridTemplate, minWidth: 'max-content' }}
        >
          {/* Column picker */}
          <div className="flex items-center justify-center">
            <button
              onClick={e => { e.stopPropagation(); setColPickerOpen(!colPickerOpen); setActiveFilterCol(null) }}
              className="text-xkc-muted hover:text-xkc-text p-0.5" title="Show/hide columns"
            >
              <Settings2 size={12} />
            </button>
          </div>

          {visibleCols.map(col => (
            <div key={col.id} className="flex items-center gap-0.5 min-w-0 relative">
              {/* Sort button */}
              <button
                className={cn(
                  'flex items-center gap-0.5 hover:text-xkc-text transition-colors truncate',
                  sortCol === col.id && 'text-xkc-accent',
                  !col.sortKey && 'cursor-default',
                )}
                onClick={e => { e.stopPropagation(); if (col.sortKey) toggleSort(col.id) }}
              >
                <span className="truncate">{col.label}</span>
                {col.sortKey && sortCol === col.id && (sortDir === 'asc' ? <ChevronUp size={9} /> : <ChevronDown size={9} />)}
              </button>

              {/* Filter toggle */}
              {col.filterable && (
                <button
                  onClick={e => { e.stopPropagation(); setActiveFilterCol(activeFilterCol === col.id ? null : col.id); setColPickerOpen(false) }}
                  className={cn('ml-0.5 flex-shrink-0 p-0.5 rounded', colFilterActive(col.id) ? 'text-xkc-accent' : 'text-xkc-border/50 hover:text-xkc-muted')}
                  title={`Filter by ${col.label}`}
                >
                  <Filter size={9} />
                </button>
              )}

              {/* Filter popover */}
              {activeFilterCol === col.id && (
                <div
                  className="absolute top-6 left-0 z-50 bg-xkc-surface border border-xkc-border rounded-lg shadow-xl p-3 min-w-[160px]"
                  onClick={e => e.stopPropagation()}
                >
                  {col.id === 'bpm' && (
                    <>
                      <div className="text-[10px] text-xkc-muted mb-1.5 uppercase tracking-wider">BPM Range</div>
                      <div className="flex items-center gap-1.5 mb-2">
                        <input type="number" placeholder="Min" value={bpmMin}
                          onChange={e => setBpmMin(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') { applyBpmFilter(); setActiveFilterCol(null) } }}
                          className="w-16 bg-xkc-bg border border-xkc-border rounded px-2 py-1 text-xs text-xkc-text focus:outline-none focus:border-xkc-accent"
                        />
                        <span className="text-xkc-muted text-xs">–</span>
                        <input type="number" placeholder="Max" value={bpmMax}
                          onChange={e => setBpmMax(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') { applyBpmFilter(); setActiveFilterCol(null) } }}
                          className="w-16 bg-xkc-bg border border-xkc-border rounded px-2 py-1 text-xs text-xkc-text focus:outline-none focus:border-xkc-accent"
                        />
                      </div>
                      <div className="flex gap-1">
                        <button onClick={() => { applyBpmFilter(); setActiveFilterCol(null) }}
                          className="flex-1 bg-xkc-accent hover:bg-blue-600 text-white rounded px-2 py-1 text-xs">Apply</button>
                        <button onClick={() => { setBpmMin(''); setBpmMax(''); setFilters({ ...filters, minBpm: undefined, maxBpm: undefined }); setActiveFilterCol(null) }}
                          className="px-2 py-1 border border-xkc-border rounded text-xs text-xkc-muted hover:text-xkc-text">Clear</button>
                      </div>
                    </>
                  )}
                  {col.id === 'key' && (
                    <>
                      <div className="text-[10px] text-xkc-muted mb-1.5 uppercase tracking-wider">Key (Camelot)</div>
                      <input autoFocus type="text" placeholder="e.g. 8A, 11B…" value={filters.keyCamelot ?? ''}
                        onChange={e => setFilters({ ...filters, keyCamelot: e.target.value || undefined })}
                        onKeyDown={e => { if (e.key === 'Enter') setActiveFilterCol(null); if (e.key === 'Escape') { setFilters({ ...filters, keyCamelot: undefined }); setActiveFilterCol(null) } }}
                        className="w-full bg-xkc-bg border border-xkc-border rounded px-2 py-1 text-xs text-xkc-text focus:outline-none focus:border-xkc-accent mb-1.5"
                      />
                      {filters.keyCamelot && (
                        <button onClick={() => { setFilters({ ...filters, keyCamelot: undefined }); setActiveFilterCol(null) }}
                          className="text-xs text-xkc-muted hover:text-red-400">Clear</button>
                      )}
                    </>
                  )}
                  {col.id === 'artist' && (
                    <>
                      <div className="text-[10px] text-xkc-muted mb-1.5 uppercase tracking-wider">Artist</div>
                      <input autoFocus type="text" placeholder="Search artist…" value={filters.artist ?? ''}
                        onChange={e => setFilters({ ...filters, artist: e.target.value || undefined })}
                        onKeyDown={e => { if (e.key === 'Enter') setActiveFilterCol(null) }}
                        className="w-full bg-xkc-bg border border-xkc-border rounded px-2 py-1 text-xs text-xkc-text focus:outline-none focus:border-xkc-accent mb-1.5"
                      />
                      {filters.artist && (
                        <button onClick={() => { setFilters({ ...filters, artist: undefined }); setActiveFilterCol(null) }}
                          className="text-xs text-xkc-muted hover:text-red-400">Clear</button>
                      )}
                    </>
                  )}
                  {col.id === 'genre' && (
                    <>
                      <div className="text-[10px] text-xkc-muted mb-1.5 uppercase tracking-wider">Genre</div>
                      <input autoFocus type="text" placeholder="Search genre…" value={filters.genre ?? ''}
                        onChange={e => setFilters({ ...filters, genre: e.target.value || undefined })}
                        onKeyDown={e => { if (e.key === 'Enter') setActiveFilterCol(null) }}
                        className="w-full bg-xkc-bg border border-xkc-border rounded px-2 py-1 text-xs text-xkc-text focus:outline-none focus:border-xkc-accent mb-1.5"
                      />
                      {filters.genre && (
                        <button onClick={() => { setFilters({ ...filters, genre: undefined }); setActiveFilterCol(null) }}
                          className="text-xs text-xkc-muted hover:text-red-400">Clear</button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Rows */}
        {sorted.length === 0 && (
          <div className="flex items-center justify-center h-32 text-xkc-muted text-sm" style={{ minWidth: 'max-content' }}>No tracks found</div>
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
              onDragStart={e => handleDragStart(e, track)}
              onClick={e => handleRowClick(e, track, idx)}
              onContextMenu={e => handleContextMenu(e, track)}
              className={cn(
                'grid gap-x-2 px-3 py-1.5 border-b border-xkc-border/50 cursor-pointer text-sm items-center select-none hover:bg-xkc-surface',
                isSelected && 'bg-blue-900/40',
                isDetailOpen && !isSelected && 'border-l-2 border-l-xkc-accent',
                isLoaded && !isSelected && 'bg-blue-950/30',
              )}
              style={{ gridTemplateColumns: gridTemplate, minWidth: 'max-content' }}
            >
              {/* Play button */}
              <button
                onClick={e => handlePlay(e, track)}
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

              {visibleCols.map(col => (
                <div key={col.id} className="min-w-0 flex items-center overflow-hidden">
                  {renderCell(col, track, isPlaying, canPlay)}
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
          onClick={e => e.stopPropagation()}
        >
          <div className="text-xs text-xkc-muted mb-2 font-medium uppercase tracking-wider">Columns</div>
          {ALL_COLS.map(col => (
            <label key={col.id} className="flex items-center gap-2 py-1 text-xs text-xkc-text cursor-pointer hover:text-white">
              <input type="checkbox" checked={visibleColIds.includes(col.id)}
                onChange={() => setVisibleColIds(prev => prev.includes(col.id) ? prev.filter(id => id !== col.id) : [...prev, col.id])}
                className="accent-xkc-accent" />
              {col.label}
            </label>
          ))}
          <button onClick={() => setVisibleColIds(DEFAULT_COL_IDS)}
            className="mt-2 text-xs text-xkc-muted hover:text-xkc-text w-full text-left">
            Reset to default
          </button>
        </div>
      )}

      {/* Selection badge */}
      {selectedIds.length > 1 && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-xkc-accent text-white text-xs rounded-full px-3 py-1 shadow-lg pointer-events-none">
          {selectedIds.length} tracks selected
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-xkc-surface border border-xkc-border rounded-lg shadow-xl py-1 min-w-[180px] text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-xs text-xkc-muted border-b border-xkc-border mb-1">
            {contextMenu.trackIds.length} track{contextMenu.trackIds.length > 1 ? 's' : ''} selected
          </div>
          {onAddToPlaylist && (
            <button className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-xkc-text"
              onClick={() => { contextMenu.trackIds.forEach(id => onAddToPlaylist(id)); setContextMenu(null) }}>
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
                onClick={() => { contextMenu.trackIds.forEach(id => onDeleteTrack(id)); setContextMenu(null) }}>
                Delete {contextMenu.trackIds.length > 1 ? `${contextMenu.trackIds.length} tracks` : 'track'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
