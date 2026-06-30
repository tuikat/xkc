import { useEffect, useRef, useCallback, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, Pause, Square, ChevronUp, ChevronDown, X, Plus, ZoomIn, ZoomOut } from 'lucide-react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { hexColor, formatDuration } from '../lib/utils'
import type { Cue } from '../lib/api'

let _audio: HTMLAudioElement | null = null
export function getAudio() {
  if (!_audio && typeof window !== 'undefined') {
    _audio = new Audio()
    _audio.preload = 'auto'
    _audio.crossOrigin = 'use-credentials'
    ;(window as any).__xkcAudio = _audio
  }
  return _audio!
}

const WAVEFORM_H = 108
const BAR_W = 3
const BAR_GAP = 1
const MIN_VIS_MS = 500     // maximum zoom-in: 500ms window
const CUE_HIT_PX = 10     // pixels tolerance for cue detection

interface CtxMenu { x: number; y: number; ms: number; nearCueId?: string }

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  pts: number[],
  currentMs: number,
  durationMs: number,
  viewStartMs: number,
  visMs: number,
  beatTimesMs: number[],
  cues: Cue[],
  pxPerMs: number,
) {
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(0, 0, W, H)
  if (!durationMs || !pts.length) return

  const maxVal = Math.max(...pts, 0.001)
  const midY = H / 2
  const numBars = Math.floor(W / (BAR_W + BAR_GAP))

  // Beat grid — show labels at high enough zoom
  const showBeatLabels = pxPerMs > 0.3 // ~300px/sec
  const showBeats = pxPerMs > 0.05
  if (showBeats) {
    for (let bi = 0; bi < beatTimesMs.length; bi++) {
      const bms = beatTimesMs[bi]
      const bx = ((bms - viewStartMs) / visMs) * W
      if (bx < -2 || bx > W + 2) continue
      // every 4th beat = bar line (brighter)
      const isBar = bi % 4 === 0
      ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)'
      ctx.lineWidth = isBar ? 1.5 : 1
      ctx.beginPath()
      ctx.moveTo(bx, 0)
      ctx.lineTo(bx, H)
      ctx.stroke()
      if (showBeatLabels && isBar) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.font = '9px monospace'
        ctx.fillText(String(Math.round(bi / 4 + 1)), bx + 3, 11)
      }
    }
  }

  // Waveform bars
  for (let i = 0; i < numBars; i++) {
    const barMs = viewStartMs + (i / numBars) * visMs
    if (barMs < 0 || barMs > durationMs) continue
    const srcIdx = Math.min(Math.floor((barMs / durationMs) * pts.length), pts.length - 1)
    const norm = pts[srcIdx] / maxVal
    const h = Math.max(norm * midY * 0.92, 2)
    const x = i * (BAR_W + BAR_GAP)
    ctx.fillStyle = barMs <= currentMs ? '#2563eb' : '#1a3460'
    ctx.fillRect(x, midY - h, BAR_W, h * 2)
  }

  // Time ruler at bottom
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.fillRect(0, H - 14, W, 14)
  const rulerStep = pickRulerStep(visMs)
  const firstTick = Math.ceil(viewStartMs / rulerStep) * rulerStep
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.font = '9px monospace'
  for (let t = firstTick; t < viewStartMs + visMs; t += rulerStep) {
    const rx = ((t - viewStartMs) / visMs) * W
    if (rx < 0 || rx > W) continue
    ctx.fillRect(rx, H - 14, 1, 4)
    ctx.fillText(formatMs(t), rx + 3, H - 3)
  }

  // Cue markers
  for (const cue of cues) {
    const cx = ((cue.position_ms - viewStartMs) / visMs) * W
    if (cx < -20 || cx > W + 20) continue
    const col = hexColor(cue.color)
    ctx.strokeStyle = col
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(cx, 14); ctx.lineTo(cx, H - 14); ctx.stroke()
    ctx.fillStyle = col
    ctx.beginPath(); ctx.moveTo(cx, 14); ctx.lineTo(cx + 12, 14); ctx.lineTo(cx, 26); ctx.closePath(); ctx.fill()
    if (cue.label) {
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 8px sans-serif'
      ctx.fillText(cue.label.slice(0, 5), cx + 2, 24)
    }
  }

  // Playhead
  const playX = ((currentMs - viewStartMs) / visMs) * W
  if (playX >= 0 && playX <= W) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(playX, 0); ctx.lineTo(playX, H); ctx.stroke()
    // playhead triangle at top
    ctx.fillStyle = '#fff'
    ctx.beginPath(); ctx.moveTo(playX - 5, 0); ctx.lineTo(playX + 5, 0); ctx.lineTo(playX, 8); ctx.closePath(); ctx.fill()
  }
}

function pickRulerStep(visMs: number): number {
  const steps = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000]
  const target = visMs / 8
  return steps.find((s) => s >= target) ?? 60000
}
function formatMs(ms: number): string {
  const s = ms / 1000
  const m = Math.floor(s / 60)
  const sec = (s % 60).toFixed(s < 60 ? 1 : 0)
  return m > 0 ? `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}` : `${sec}s`
}

export default function Player() {
  const { playerTrack, playerExpanded, setPlayerTrack, setPlayerExpanded, setPlayerPlaying } = useStore()
  const qc = useQueryClient()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const progressBarRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const rafRef = useRef<number>(0)

  // Zoom / pan state (refs to avoid React re-renders in rAF)
  const viewStartMsRef = useRef(0)
  // visMsRef = the span of time (ms) currently visible in the canvas.
  // 0 = auto (full track). Stored as a TIME RANGE, not pixels-per-ms,
  // so resizing the canvas just rescales the same range rather than
  // showing blank space or clipping.
  const visMsRef = useRef(0)
  const manualScrollRef = useRef(false)  // suppress auto-follow when user panned
  const dragRef = useRef<{ startX: number; startViewMs: number; moved: boolean } | null>(null)

  const [playing, setPlaying] = useState(false)
  const [durationMs, setDurationMs] = useState(0)
  const durationMsRef = useRef(0)

  // Right-click context menu state
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const [cueLabel, setCueLabel] = useState('')

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
  const beatTimesMs: number[] = waveData?.beat_times_ms ?? []

  const addCue = useMutation({
    mutationFn: ({ posMs, label }: { posMs: number; label: string }) =>
      api.tracks.addCue(playerTrack!.id, {
        position_ms: Math.round(posMs), type: 'hot',
        color: [0xCC2200, 0x0066CC, 0x00AA44, 0xCC8800, 0xAA00CC][cues.length % 5],
        sort_order: cues.length, label: label || null,
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['track', playerTrack?.id] }); setCtxMenu(null); setCueLabel('') },
  })

  const deleteCue = useMutation({
    mutationFn: (cueId: string) => api.tracks.deleteCue(playerTrack!.id, cueId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['track', playerTrack?.id] }); setCtxMenu(null) },
  })

  const nudgeBeats = useMutation({
    mutationFn: (offset_ms: number) => api.tracks.updateBeats(playerTrack!.id, { offset_ms }),
    onSuccess: (data) => qc.setQueryData(['waveform', playerTrack?.id], (old: typeof waveData) =>
      old ? { ...old, beat_times_ms: data.beat_positions_ms } : old
    ),
  })

  // Load track into audio element
  useEffect(() => {
    if (!playerTrack) return
    const audio = getAudio()
    const url = api.tracks.getStreamUrl(playerTrack.id)
    if (!audio.src.endsWith(playerTrack.id + '/stream')) {
      audio.src = url
      audio.load()
      viewStartMsRef.current = 0
      visMsRef.current = 0
      manualScrollRef.current = false
    }
    const onDuration = () => { setDurationMs(audio.duration * 1000); durationMsRef.current = audio.duration * 1000 }
    const onPlay = () => { setPlaying(true); setPlayerPlaying(true) }
    const onPause = () => { setPlaying(false); setPlayerPlaying(false) }
    const onEnded = () => { setPlaying(false); setPlayerPlaying(false) }
    audio.addEventListener('durationchange', onDuration)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    if (audio.duration) { setDurationMs(audio.duration * 1000); durationMsRef.current = audio.duration * 1000 }
    return () => {
      audio.removeEventListener('durationchange', onDuration)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
    }
  }, [playerTrack, setPlayerPlaying])

  // rAF draw loop
  const draw = useCallback(() => {
    const audio = getAudio()
    const nowMs = audio.currentTime * 1000
    const durMs = durationMsRef.current || durationMs

    // Progress bar + time (direct DOM)
    if (progressBarRef.current && durMs > 0) {
      progressBarRef.current.style.width = ((nowMs / durMs) * 100) + '%'
    }
    if (timeRef.current) timeRef.current.textContent = formatDuration(nowMs)

    const canvas = canvasRef.current
    if (!canvas || !playerExpanded) {
      rafRef.current = requestAnimationFrame(draw)
      return
    }

    // Resize canvas buffer to actual displayed size
    const W = canvas.clientWidth || 800
    const H = WAVEFORM_H
    const dpr = window.devicePixelRatio || 1
    const bw = Math.round(W * dpr)
    const bh = Math.round(H * dpr)
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
      const c = canvas.getContext('2d')
      c?.scale(dpr, dpr)
    }

    const ctx = canvas.getContext('2d')
    if (!ctx || !durMs) {
      rafRef.current = requestAnimationFrame(draw)
      return
    }

    // visMs is the time-range stored by the user; W/visMs gives pxPerMs for THIS frame's canvas width.
    // When the canvas resizes, W changes but visMs stays the same → the range stretches to fit.
    const visMs = visMsRef.current > 0 ? visMsRef.current : durMs
    const pxPerMs = W / visMs

    // Auto-follow playhead while playing (unless user has manually scrolled)
    if (!manualScrollRef.current) {
      viewStartMsRef.current = nowMs - visMs / 2
    }
    viewStartMsRef.current = Math.max(0, Math.min(viewStartMsRef.current, Math.max(0, durMs - visMs)))

    if (waveData?.detail?.length) {
      drawWaveform(
        ctx, W, H,
        waveData.detail, nowMs, durMs,
        viewStartMsRef.current, visMs,
        beatTimesMs, cues, pxPerMs,
      )
    } else {
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#0a0a0a'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(
        playerTrack?.analysis_state !== 'complete' ? `Analysis ${playerTrack?.analysis_state}…` : 'Loading waveform…',
        W / 2, H / 2
      )
      ctx.textAlign = 'left'
    }

    rafRef.current = requestAnimationFrame(draw)
  }, [waveData, durationMs, beatTimesMs, cues, playerExpanded, playerTrack])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  // Scroll wheel: zoom centered on cursor
  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault()
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const W = rect.width
    const durMs = durationMsRef.current || durationMs
    if (!durMs) return

    const visMs = visMsRef.current > 0 ? visMsRef.current : durMs
    const mouseFrac = (e.clientX - rect.left) / W
    const msAtMouse = viewStartMsRef.current + mouseFrac * visMs

    const factor = e.deltaY < 0 ? 0.7 : 1.43
    const newVisMs = Math.max(MIN_VIS_MS, Math.min(durMs, visMs * factor))

    viewStartMsRef.current = Math.max(0, Math.min(msAtMouse - mouseFrac * newVisMs, durMs - newVisMs))
    // Store time-range, not pixels-per-ms — resize-safe
    visMsRef.current = newVisMs >= durMs ? 0 : newVisMs
    manualScrollRef.current = true
  }

  // Click/drag on canvas: click=seek, drag=pan
  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return
    dragRef.current = { startX: e.clientX, startViewMs: viewStartMsRef.current, moved: false }
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!dragRef.current || e.buttons !== 1) return
    const dx = e.clientX - dragRef.current.startX
    if (Math.abs(dx) > 4) {
      dragRef.current.moved = true
      manualScrollRef.current = true
      const canvas = canvasRef.current!
      const W = canvas.clientWidth
      const durMs = durationMsRef.current || durationMs
      const visMs = visMsRef.current > 0 ? visMsRef.current : durMs
      const pxPerMs = W / visMs
      viewStartMsRef.current = Math.max(0, Math.min(
        dragRef.current.startViewMs - dx / pxPerMs,
        durMs - visMs
      ))
    }
  }

  function handleMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!dragRef.current) return
    const wasDrag = dragRef.current.moved
    dragRef.current = null
    if (!wasDrag && e.button === 0) {
      // It was a click — seek
      seekAtX(e.clientX)
    }
  }

  function getVisMs(W: number, durMs: number) {
    return visMsRef.current > 0 ? visMsRef.current : durMs
  }

  function seekAtX(clientX: number) {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const durMs = durationMsRef.current || durationMs
    const visMs = getVisMs(rect.width, durMs)
    const ms = viewStartMsRef.current + ((clientX - rect.left) / rect.width) * visMs
    getAudio().currentTime = Math.max(0, Math.min(ms, durMs)) / 1000
  }

  function msAtClientX(clientX: number): number {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const durMs = durationMsRef.current || durationMs
    const visMs = getVisMs(rect.width, durMs)
    return viewStartMsRef.current + ((clientX - rect.left) / rect.width) * visMs
  }

  function findNearestCue(clientX: number): Cue | undefined {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const durMs = durationMsRef.current || durationMs
    const visMs = getVisMs(rect.width, durMs)
    const msPx = (ms: number) => ((ms - viewStartMsRef.current) / visMs) * rect.width + rect.left
    return cues.find((c) => Math.abs(msPx(c.position_ms) - clientX) < CUE_HIT_PX)
  }

  function handleContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
    const ms = msAtClientX(e.clientX)
    const near = findNearestCue(e.clientX)
    setCtxMenu({ x: e.clientX, y: e.clientY, ms, nearCueId: near?.id })
    setCueLabel('')
  }

  function resetZoom() {
    visMsRef.current = 0           // 0 = auto (full track)
    viewStartMsRef.current = 0
    manualScrollRef.current = false
  }

  function zoomIn() {
    const canvas = canvasRef.current
    if (!canvas) return
    const durMs = durationMsRef.current || durationMs
    const visMs = visMsRef.current > 0 ? visMsRef.current : durMs
    const nowMs = getAudio().currentTime * 1000
    const newVisMs = Math.max(MIN_VIS_MS, visMs * 0.5)
    visMsRef.current = newVisMs >= durMs ? 0 : newVisMs
    viewStartMsRef.current = Math.max(0, Math.min(nowMs - newVisMs / 2, durMs - newVisMs))
    manualScrollRef.current = false // re-engage auto-follow
  }

  function zoomOut() {
    const durMs = durationMsRef.current || durationMs
    const visMs = visMsRef.current > 0 ? visMsRef.current : durMs
    const newVisMs = Math.min(durMs, visMs * 2)
    visMsRef.current = newVisMs >= durMs ? 0 : newVisMs
    if (newVisMs >= durMs) {
      viewStartMsRef.current = 0
      manualScrollRef.current = false
    }
  }

  function togglePlay() {
    const a = getAudio()
    if (a.paused) { a.play(); manualScrollRef.current = false }
    else a.pause()
  }
  function stop() {
    const a = getAudio()
    a.pause(); a.currentTime = 0
    viewStartMsRef.current = 0
    manualScrollRef.current = false
  }
  function unload() {
    const a = getAudio()
    a.pause(); a.src = ''
    setPlayerTrack(null); setPlaying(false); setDurationMs(0)
    durationMsRef.current = 0
  }

  if (!playerTrack) return null

  return (
    <div className="flex-shrink-0 border-b border-xkc-border bg-[#0a0a0a]">
      {/* Waveform canvas */}
      {playerExpanded && (
        <div className="relative w-full" style={{ height: WAVEFORM_H }}>
          <canvas
            ref={canvasRef}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => { dragRef.current = null }}
            onContextMenu={handleContextMenu}
            title="Scroll to zoom · Drag to pan · Click to seek · Right-click for cue options"
            style={{ display: 'block', width: '100%', height: WAVEFORM_H, cursor: 'crosshair' }}
          />
          {/* Zoom controls overlay */}
          <div className="absolute top-1 right-1 flex gap-1">
            <button onClick={zoomIn} className="p-1 bg-black/50 rounded text-xkc-muted hover:text-white" title="Zoom in"><ZoomIn size={11} /></button>
            <button onClick={zoomOut} className="p-1 bg-black/50 rounded text-xkc-muted hover:text-white" title="Zoom out"><ZoomOut size={11} /></button>
            <button onClick={resetZoom} className="px-1.5 py-0.5 bg-black/50 rounded text-[9px] text-xkc-muted hover:text-white" title="Reset zoom">1:1</button>
          </div>
          {/* Beat nudge controls overlay (visible only when beat data exists) */}
          {beatTimesMs.length > 0 && (
            <div className="absolute bottom-16 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-black/70 rounded-lg px-2 py-1">
              <span className="text-[9px] text-xkc-muted mr-1">Beats</span>
              {([-10, -2, -0.5, 0.5, 2, 10] as const).map((n) => (
                <button key={n} onClick={() => nudgeBeats.mutate(n)}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-xkc-surface border border-xkc-border text-xkc-muted hover:text-white hover:border-xkc-accent font-mono">
                  {n > 0 ? `+${n}` : n}ms
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Control bar */}
      <div className="flex items-center gap-2 px-3 h-12 border-t border-xkc-border/30">
        <button onClick={togglePlay}
          className="w-8 h-8 rounded-full bg-xkc-accent flex items-center justify-center hover:bg-blue-600 flex-shrink-0">
          {playing ? <Pause size={14} className="text-white" /> : <Play size={14} className="text-white ml-0.5" />}
        </button>
        <button onClick={stop} className="p-1.5 text-xkc-muted hover:text-xkc-text flex-shrink-0" title="Stop">
          <Square size={12} />
        </button>

        <span ref={timeRef} className="text-xs font-mono text-xkc-text flex-shrink-0 w-12">0:00</span>
        <span className="text-xs font-mono text-xkc-muted flex-shrink-0">/</span>
        <span className="text-xs font-mono text-xkc-muted flex-shrink-0">{formatDuration(durationMs)}</span>

        <div className="flex-1 h-1.5 bg-xkc-border rounded-full cursor-pointer relative"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const pct = (e.clientX - r.left) / r.width
            const durMs = durationMsRef.current || durationMs
            getAudio().currentTime = pct * durMs / 1000
            manualScrollRef.current = false
          }}>
          <div ref={progressBarRef} className="h-full bg-xkc-accent rounded-full" style={{ width: '0%' }} />
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 min-w-0 max-w-xs">
          <span className="text-xs text-xkc-text truncate">
            {playerTrack.artist && `${playerTrack.artist} — `}{playerTrack.title || 'Unknown'}
          </span>
          {playerTrack.bpm && <span className="text-xs text-xkc-muted flex-shrink-0">{Math.round(playerTrack.bpm)} BPM</span>}
          {playerTrack.key_camelot && <span className="text-xs text-xkc-muted flex-shrink-0">{playerTrack.key_camelot}</span>}
        </div>

        {/* Add cue at playhead */}
        <button
          onClick={() => { const a = getAudio(); addCue.mutate({ posMs: a.currentTime * 1000, label: '' }) }}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-xkc-border text-xkc-muted hover:text-xkc-text hover:border-xkc-accent flex-shrink-0"
          title="Add cue at playhead"
        >
          <Plus size={10} /> Cue
        </button>

        {/* Cue jump buttons */}
        {cues.slice(0, 6).map((cue, i) => (
          <button
            key={cue.id}
            onClick={() => { getAudio().currentTime = cue.position_ms / 1000; manualScrollRef.current = false }}
            className="text-xs px-1.5 py-0.5 rounded flex-shrink-0 font-mono"
            style={{ borderWidth: 1, borderStyle: 'solid', borderColor: hexColor(cue.color), color: hexColor(cue.color) }}
            title={`${cue.label || `Cue ${i + 1}`} — ${formatDuration(cue.position_ms)}`}
          >{i + 1}</button>
        ))}

        <button onClick={unload} className="p-1.5 text-xkc-muted hover:text-red-400 flex-shrink-0" title="Unload"><X size={13} /></button>
        <button
          onClick={() => setPlayerExpanded(!playerExpanded)}
          className="p-1.5 text-xkc-muted hover:text-xkc-text flex-shrink-0"
          title={playerExpanded ? 'Collapse' : 'Show waveform'}
        >
          {playerExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Right-click context menu on waveform */}
      {ctxMenu && (
        <div
          className="fixed z-50 bg-xkc-surface border border-xkc-border rounded-lg shadow-xl py-1 min-w-[200px] text-sm"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-xs text-xkc-muted border-b border-xkc-border mb-1">
            {formatDuration(ctxMenu.ms)}
          </div>
          <div className="px-3 py-1.5">
            <div className="text-xs text-xkc-muted mb-1">Add hot cue</div>
            <div className="flex gap-1">
              <input
                autoFocus
                value={cueLabel}
                onChange={(e) => setCueLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addCue.mutate({ posMs: ctxMenu.ms, label: cueLabel }) }}
                placeholder="Label (optional)"
                className="flex-1 bg-xkc-bg border border-xkc-border rounded px-2 py-1 text-xs text-xkc-text focus:outline-none focus:border-xkc-accent"
              />
              <button
                onClick={() => addCue.mutate({ posMs: ctxMenu.ms, label: cueLabel })}
                className="px-2 py-1 bg-xkc-accent hover:bg-blue-600 text-white rounded text-xs"
              >Add</button>
            </div>
          </div>
          {ctxMenu.nearCueId && (
            <>
              <div className="border-t border-xkc-border my-1" />
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-red-400 text-sm"
                onClick={() => deleteCue.mutate(ctxMenu.nearCueId!)}
              >Remove nearest cue</button>
            </>
          )}
          <div className="border-t border-xkc-border my-1" />
          <button className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-xkc-muted text-sm"
            onClick={() => { getAudio().currentTime = ctxMenu.ms / 1000; setCtxMenu(null) }}>
            Seek here
          </button>
        </div>
      )}

      {/* Dismiss context menu on click elsewhere */}
      {ctxMenu && <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} />}
    </div>
  )
}
