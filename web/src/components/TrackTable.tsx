import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Track, Tag } from '../lib/api'
import { api } from '../lib/api'
import { formatDuration, formatBpm, hexColor } from '../lib/utils'
import { Star, Play, Pause, Loader2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { useStore } from '../lib/store'

interface ContextMenuState { x: number; y: number; trackId: string }

interface TrackTableProps {
  tracks: Track[]
  onSelectTrack: (id: string) => void
  selectedTrackId: string | null
  tagGroups?: { id: string; name: string; tags: Tag[] }[]
  onAddToPlaylist?: (trackId: string) => void
  onDeleteTrack?: (trackId: string) => void
  onReanalyze?: (trackId: string) => void
}

// cols: play | mini-wave | title | artist | bpm | key | time | genre | tags | rating | added
const COLS = '[32px_100px_1fr_1fr_58px_46px_52px_72px_90px_66px_82px]'

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
    const W = 100, H = 24
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr; canvas.height = H * dpr
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)
    const pts = data.overview
    const max = Math.max(...pts, 0.001)
    const midY = H / 2
    const bw = W / pts.length
    ctx.fillStyle = isPlaying ? '#3b82f6' : '#334155'
    pts.forEach((v, i) => {
      const h = (v / max) * midY * 0.85
      ctx.fillRect(i * bw, midY - h, Math.max(bw - 0.5, 1), h * 2)
    })
  }, [data, isPlaying])

  return (
    <canvas
      ref={canvasRef}
      className="opacity-80"
      style={{ display: 'block' }}
    />
  )
}

function Stars({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={10} className={i <= rating ? 'text-yellow-400 fill-yellow-400' : 'text-xkc-border'} />
      ))}
    </div>
  )
}

export default function TrackTable({
  tracks, onSelectTrack, selectedTrackId, tagGroups = [],
  onAddToPlaylist, onDeleteTrack, onReanalyze,
}: TrackTableProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const { playerTrack, setPlayerTrack } = useStore()
  const allTags = tagGroups.flatMap((g) => g.tags)
  const tagById = Object.fromEntries(allTags.map((t) => [t.id, t]))

  function handlePlay(e: React.MouseEvent, track: Track) {
    e.stopPropagation()
    if (track.analysis_state !== 'complete') return
    if (playerTrack?.id === track.id) {
      // toggle play/pause via audio singleton
      const audio = (window as unknown as { _xkcAudio?: HTMLAudioElement })._xkcAudio
      if (audio) {
        if (audio.paused) audio.play()
        else audio.pause()
      }
    } else {
      setPlayerTrack(track)
    }
  }

  // After Player sets the audio element on window, we use it for pause detection
  const [playingId, setPlayingId] = useState<string | null>(null)
  useEffect(() => {
    setPlayingId(playerTrack?.id ?? null)
  }, [playerTrack])

  return (
    <div className="relative flex flex-col h-full" onClick={() => setContextMenu(null)}>
      {/* Header */}
      <div className={cn('grid gap-x-2 px-3 py-2 border-b border-xkc-border text-xs text-xkc-muted uppercase tracking-wider bg-xkc-surface sticky top-0 z-10', `grid-cols-${COLS}`)}>
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
        {tracks.map((track) => {
          const isSelected = selectedTrackId === track.id
          const isPlaying = playingId === track.id
          const canPlay = track.analysis_state === 'complete'
          return (
            <div
              key={track.id}
              onClick={() => onSelectTrack(track.id)}
              onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, trackId: track.id }) }}
              className={cn(
                `grid gap-x-2 px-3 py-1.5 border-b border-xkc-border/50 cursor-pointer hover:bg-xkc-surface text-sm items-center grid-cols-${COLS}`,
                isSelected && 'bg-xkc-surface border-l-2 border-l-xkc-accent',
                isPlaying && 'bg-blue-950/30'
              )}
            >
              {/* Play button */}
              <button
                onClick={(e) => handlePlay(e, track)}
                className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center transition-colors flex-shrink-0',
                  canPlay
                    ? isPlaying
                      ? 'bg-xkc-accent text-white hover:bg-blue-600'
                      : 'text-xkc-muted hover:bg-xkc-accent/20 hover:text-xkc-accent'
                    : 'text-xkc-border cursor-default',
                  track.analysis_state === 'analyzing' && 'text-yellow-500'
                )}
                title={!canPlay ? `Analysis ${track.analysis_state}` : isPlaying ? 'Playing' : 'Play'}
              >
                {track.analysis_state === 'analyzing' ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : track.analysis_state === 'failed' ? (
                  <span className="text-red-400 text-xs">✗</span>
                ) : isPlaying ? (
                  <Pause size={11} />
                ) : (
                  <Play size={11} className="ml-0.5" />
                )}
              </button>

              {/* Mini waveform */}
              <div className="flex items-center">
                {canPlay ? (
                  <MiniWaveform trackId={track.id} isPlaying={isPlaying} />
                ) : (
                  <div className="w-[100px] h-6 rounded bg-xkc-border/30 flex items-center justify-center">
                    <span className="text-[9px] text-xkc-muted">{track.analysis_state}</span>
                  </div>
                )}
              </div>

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
                    <span key={tid} className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: hexColor(tag.color) }} title={tag.name} />
                  )
                })}
              </div>
              <Stars rating={track.rating} />
              <div className="text-xkc-muted text-xs">{new Date(track.date_added).toLocaleDateString()}</div>
            </div>
          )
        })}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-xkc-surface border border-xkc-border rounded-lg shadow-xl py-1 min-w-[160px] text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {onAddToPlaylist && (
            <button className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-xkc-text"
              onClick={() => { onAddToPlaylist(contextMenu.trackId); setContextMenu(null) }}>
              Add to Playlist
            </button>
          )}
          {onReanalyze && (
            <button className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-xkc-text"
              onClick={() => { onReanalyze(contextMenu.trackId); setContextMenu(null) }}>
              Re-analyze
            </button>
          )}
          {onDeleteTrack && (
            <>
              <div className="border-t border-xkc-border my-1" />
              <button className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-red-400"
                onClick={() => { onDeleteTrack(contextMenu.trackId); setContextMenu(null) }}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
