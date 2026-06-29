import { useEffect, useRef, useCallback, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, Pause, Square, ChevronUp, ChevronDown, X, Plus } from 'lucide-react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { hexColor, formatDuration } from '../lib/utils'
import type { Cue } from '../lib/api'

// Module-level singleton audio element
let _audio: HTMLAudioElement | null = null
export function getAudio() {
  if (!_audio && typeof window !== 'undefined') {
    _audio = new Audio()
    _audio.preload = 'auto'
    _audio.crossOrigin = 'use-credentials'
  }
  return _audio!
}

const BAR_W = 3
const BAR_GAP = 1
const WAVEFORM_H = 100

// Draw waveform bars downsampled to fit the canvas
function drawWaveform(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  pts: number[],
  currentMs: number,
  durationMs: number,
  beatTimesMs: number[],
  cues: Cue[],
) {
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = '#0d0d0d'
  ctx.fillRect(0, 0, W, H)

  const numBars = Math.floor(W / (BAR_W + BAR_GAP))
  const maxVal = Math.max(...pts, 0.001)
  const midY = H / 2
  const progress = durationMs > 0 ? currentMs / durationMs : 0

  // Beat grid lines
  if (beatTimesMs.length && durationMs > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = 1
    for (const bms of beatTimesMs) {
      const x = (bms / durationMs) * W
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
      ctx.stroke()
    }
  }

  // Waveform bars — two passes: past (bright) then future (dark)
  for (let i = 0; i < numBars; i++) {
    const srcIdx = Math.floor((i / numBars) * pts.length)
    const norm = pts[srcIdx] / maxVal
    const h = Math.max(norm * midY * 0.92, 2)
    const x = i * (BAR_W + BAR_GAP)
    const barProgress = i / numBars
    ctx.fillStyle = barProgress <= progress ? '#3b82f6' : '#1e3a5f'
    ctx.fillRect(x, midY - h, BAR_W, h * 2)
  }

  // Playhead
  const playX = progress * W
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(playX, 0)
  ctx.lineTo(playX, H)
  ctx.stroke()

  // Cue markers
  if (durationMs > 0) {
    for (const cue of cues) {
      const cx = (cue.position_ms / durationMs) * W
      const col = hexColor(cue.color)
      ctx.strokeStyle = col
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(cx, 4)
      ctx.lineTo(cx, H - 4)
      ctx.stroke()
      // small flag top
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.moveTo(cx, 4)
      ctx.lineTo(cx + 10, 4)
      ctx.lineTo(cx, 14)
      ctx.closePath()
      ctx.fill()
      if (cue.label) {
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 8px sans-serif'
        ctx.fillText(cue.label.slice(0, 4), cx + 2, 12)
      }
    }
  }
}

export default function Player() {
  const { playerTrack, playerExpanded, setPlayerTrack, setPlayerExpanded, setPlayerPlaying } = useStore()
  const qc = useQueryClient()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const progressBarRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const rafRef = useRef<number>(0)

  const [playing, setPlaying] = useState(false)
  const [durationMs, setDurationMs] = useState(0)
  const [containerW, setContainerW] = useState(800)

  const { data: waveData } = useQuery({
    queryKey: ['waveform', playerTrack?.id],
    queryFn: () => api.tracks.getWaveform(playerTrack!.id),
    enabled: !!playerTrack,
    staleTime: Infinity,
  })

  const { data: fullTrack } = useQuery({
    queryKey: ['track', playerTrack?.id],
    queryFn: () => api.tracks.getTrack(playerTrack!.id),
    enabled: !!playerTrack,
    staleTime: 30_000,
  })

  const cues: Cue[] = (fullTrack as unknown as { cues?: Cue[] })?.cues ?? []

  const addCue = useMutation({
    mutationFn: (posMs: number) => api.tracks.addCue(playerTrack!.id, {
      position_ms: Math.round(posMs),
      type: 'hot',
      color: 0xCC2200,
      sort_order: cues.length,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['track', playerTrack?.id] }),
  })

  // Load new track
  useEffect(() => {
    if (!playerTrack) return
    const audio = getAudio()
    const url = api.tracks.getStreamUrl(playerTrack.id)
    if (!audio.src.endsWith(playerTrack.id + '/stream')) {
      audio.src = url
      audio.load()
    }
    const onDuration = () => setDurationMs(audio.duration * 1000)
    const onPlay = () => { setPlaying(true); setPlayerPlaying(true) }
    const onPause = () => { setPlaying(false); setPlayerPlaying(false) }
    const onEnded = () => { setPlaying(false); setPlayerPlaying(false) }
    audio.addEventListener('durationchange', onDuration)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    if (audio.duration) setDurationMs(audio.duration * 1000)
    return () => {
      audio.removeEventListener('durationchange', onDuration)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
    }
  }, [playerTrack])

  // ResizeObserver
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver((e) => setContainerW(e[0].contentRect.width))
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // Animation loop — updates progress bar and waveform via direct DOM/canvas (no React state)
  const draw = useCallback(() => {
    const audio = getAudio()
    const nowMs = audio.currentTime * 1000
    const durMs = audio.duration ? audio.duration * 1000 : durationMs
    const pct = durMs > 0 ? (nowMs / durMs) * 100 : 0

    // Direct DOM updates — avoids 60fps React re-renders
    if (progressBarRef.current) {
      progressBarRef.current.style.width = pct + '%'
    }
    if (timeRef.current) {
      timeRef.current.textContent = formatDuration(nowMs)
    }

    // Redraw waveform canvas
    const canvas = canvasRef.current
    if (canvas && waveData?.detail?.length) {
      const ctx = canvas.getContext('2d')
      const W = containerW
      const H = WAVEFORM_H
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(W * dpr)) {
        canvas.width = Math.round(W * dpr)
        canvas.height = Math.round(H * dpr)
        canvas.style.width = W + 'px'
        canvas.style.height = H + 'px'
        ctx!.scale(dpr, dpr)
      }
      if (ctx) {
        drawWaveform(ctx, W, H, waveData.detail, nowMs, durMs, waveData.beat_times_ms ?? [], cues)
      }
    }

    rafRef.current = requestAnimationFrame(draw)
  }, [waveData, durationMs, cues, containerW])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    const audio = getAudio()
    const durMs = audio.duration ? audio.duration * 1000 : durationMs
    audio.currentTime = Math.max(0, Math.min(pct * durMs, durMs)) / 1000
  }

  function seekFromProgressBar(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    const audio = getAudio()
    const durMs = audio.duration ? audio.duration * 1000 : durationMs
    audio.currentTime = Math.max(0, pct * durMs) / 1000
  }

  function togglePlay() {
    const a = getAudio()
    if (a.paused) a.play()
    else a.pause()
  }
  function stop() {
    const a = getAudio()
    a.pause()
    a.currentTime = 0
  }
  function unload() {
    const a = getAudio()
    a.pause()
    a.src = ''
    setPlayerTrack(null)
    setPlaying(false)
    setDurationMs(0)
  }

  if (!playerTrack) return null

  return (
    <div className="flex-shrink-0 border-b border-xkc-border bg-[#0d0d0d]">
      {/* Waveform canvas — only when expanded */}
      {playerExpanded && (
        <div ref={containerRef} className="relative w-full cursor-crosshair" style={{ height: WAVEFORM_H }}>
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            title="Click to seek"
            style={{ display: 'block', width: '100%', height: WAVEFORM_H }}
          />
          {!waveData?.detail?.length && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-xkc-muted pointer-events-none">
              {playerTrack.analysis_state !== 'complete' ? `Analysis ${playerTrack.analysis_state}…` : 'Loading waveform…'}
            </div>
          )}
        </div>
      )}

      {/* Control bar */}
      <div className="flex items-center gap-2 px-3 h-12 border-t border-xkc-border/30">
        {/* Transport */}
        <button onClick={togglePlay}
          className="w-8 h-8 rounded-full bg-xkc-accent flex items-center justify-center hover:bg-blue-600 flex-shrink-0">
          {playing ? <Pause size={14} className="text-white" /> : <Play size={14} className="text-white ml-0.5" />}
        </button>
        <button onClick={stop} className="p-1.5 text-xkc-muted hover:text-xkc-text flex-shrink-0" title="Stop">
          <Square size={12} />
        </button>

        {/* Time */}
        <span ref={timeRef} className="text-xs font-mono text-xkc-text flex-shrink-0 w-12">0:00</span>
        <span className="text-xs font-mono text-xkc-muted flex-shrink-0">/</span>
        <span className="text-xs font-mono text-xkc-muted flex-shrink-0">{formatDuration(durationMs)}</span>

        {/* Progress bar */}
        <div
          className="flex-1 h-1.5 bg-xkc-border rounded-full cursor-pointer relative"
          onClick={seekFromProgressBar}
        >
          <div ref={progressBarRef} className="h-full bg-xkc-accent rounded-full" style={{ width: '0%' }} />
        </div>

        {/* Track info */}
        <div className="flex items-center gap-2 flex-shrink-0 min-w-0 max-w-xs">
          <span className="text-xs text-xkc-text truncate">
            {playerTrack.artist && `${playerTrack.artist} — `}{playerTrack.title || 'Unknown'}
          </span>
          {playerTrack.bpm && <span className="text-xs text-xkc-muted flex-shrink-0">{Math.round(playerTrack.bpm)} BPM</span>}
          {playerTrack.key_camelot && <span className="text-xs text-xkc-muted flex-shrink-0">{playerTrack.key_camelot}</span>}
        </div>

        {/* Add cue at current position */}
        <button
          onClick={() => {
            const a = getAudio()
            addCue.mutate(a.currentTime * 1000)
          }}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-xkc-border text-xkc-muted hover:text-xkc-text hover:border-xkc-accent flex-shrink-0"
          title="Add cue at playhead"
        >
          <Plus size={10} /> Cue
        </button>

        {/* Cue buttons */}
        {cues.slice(0, 6).map((cue, i) => (
          <button
            key={cue.id}
            onClick={() => { getAudio().currentTime = cue.position_ms / 1000 }}
            className="text-xs px-1.5 py-0.5 rounded flex-shrink-0 font-mono"
            style={{ borderWidth: 1, borderStyle: 'solid', borderColor: hexColor(cue.color), color: hexColor(cue.color) }}
            title={`${cue.label || `Cue ${i + 1}`} — ${formatDuration(cue.position_ms)}`}
          >
            {i + 1}
          </button>
        ))}

        <button onClick={unload} className="p-1.5 text-xkc-muted hover:text-red-400 flex-shrink-0" title="Unload">
          <X size={13} />
        </button>
        <button
          onClick={() => setPlayerExpanded(!playerExpanded)}
          className="p-1.5 text-xkc-muted hover:text-xkc-text flex-shrink-0"
          title={playerExpanded ? 'Collapse' : 'Show waveform'}
        >
          {playerExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
    </div>
  )
}
