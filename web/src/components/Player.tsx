import { useEffect, useRef, useCallback, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, Pause, Square, ChevronUp, ChevronDown, X, Plus } from 'lucide-react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { hexColor, formatDuration } from '../lib/utils'
import { cn } from '../lib/utils'
import type { Track, Cue } from '../lib/api'

// Singleton audio element — lives outside React so it never re-initialises
let _audio: HTMLAudioElement | null = null
function getAudio() {
  if (!_audio && typeof window !== 'undefined') {
    _audio = new Audio()
    _audio.preload = 'auto'
    _audio.crossOrigin = 'use-credentials'
  }
  return _audio!
}

const PX_PER_SEC = 120        // pixels per second at default zoom
const WAVEFORM_H = 96         // canvas height in px

interface WaveformData {
  detail: number[]
  beat_times_ms: number[]
}

export default function Player() {
  const { playerTrack, playerExpanded, setPlayerTrack, setPlayerExpanded } = useStore()
  const qc = useQueryClient()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)
  const [playing, setPlaying] = useState(false)
  const [currentMs, setCurrentMs] = useState(0)
  const [durationMs, setDurationMs] = useState(0)
  const [containerW, setContainerW] = useState(800)

  const { data: waveData } = useQuery({
    queryKey: ['waveform', playerTrack?.id],
    queryFn: () => api.tracks.getWaveform(playerTrack!.id),
    enabled: !!playerTrack,
    staleTime: Infinity,
  })

  // Always fetch full track (includes cues) so we have accurate cue data
  const { data: fullTrack } = useQuery({
    queryKey: ['track', playerTrack?.id],
    queryFn: () => api.tracks.getTrack(playerTrack!.id),
    enabled: !!playerTrack,
    staleTime: 30_000,
  })
  const trackWithCues = fullTrack ?? playerTrack

  const addCue = useMutation({
    mutationFn: (posMs: number) => api.tracks.addCue(playerTrack!.id, {
      position_ms: Math.round(posMs),
      type: 'hot',
      color: 0xCC2200,
      sort_order: (trackWithCues as unknown as { cues?: Cue[] }).cues?.length ?? 0,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['track', playerTrack?.id] }),
  })

  // Load track into audio element when playerTrack changes
  useEffect(() => {
    if (!playerTrack) return
    const audio = getAudio()
    const url = api.tracks.getStreamUrl(playerTrack.id)
    if (audio.src !== window.location.origin + url) {
      audio.src = url
      audio.load()
    }
    const onDuration = () => setDurationMs(audio.duration * 1000)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => setPlaying(false)
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

  // ResizeObserver for container width
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver((entries) => {
      setContainerW(entries[0].contentRect.width)
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // Animation loop — draws waveform centered on playhead each frame
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !waveData?.detail?.length) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const audio = getAudio()
    const nowMs = audio.currentTime * 1000
    setCurrentMs(nowMs)

    const W = containerW
    const H = WAVEFORM_H
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== W * dpr) {
      canvas.width = W * dpr
      canvas.height = H * dpr
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      ctx.scale(dpr, dpr)
    }

    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, W, H)

    const totalMs = durationMs || playerTrack?.duration_ms || 1
    const visMs = (W / PX_PER_SEC) * 1000   // ms visible in the window
    const startMs = nowMs - visMs / 2
    const msPerPx = visMs / W
    const detail = waveData.detail
    const N = detail.length
    const maxVal = Math.max(...detail, 0.001)
    const midY = H / 2

    // Background beat grid
    if (waveData.beat_times_ms?.length) {
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      for (const beatMs of waveData.beat_times_ms) {
        const px = (beatMs - startMs) / msPerPx
        if (px < 0 || px > W) continue
        ctx.beginPath()
        ctx.moveTo(px, 0)
        ctx.lineTo(px, H)
        ctx.stroke()
      }
    }

    // Waveform bars
    const barW = Math.max(W / N, 1)
    for (let i = 0; i < N; i++) {
      const tMs = (i / N) * totalMs
      const px = (tMs - startMs) / msPerPx
      if (px + barW < 0 || px > W) continue
      const norm = detail[i] / maxVal
      const barH = norm * midY * 0.9

      // Colour: past=blue, future=dark-blue
      const isPast = tMs <= nowMs
      ctx.fillStyle = isPast ? '#3b82f6' : '#1d3b6e'
      ctx.fillRect(px, midY - barH, barW - 0.5, barH * 2)
    }

    // Cue markers
    const cues: Cue[] = (trackWithCues as unknown as { cues?: Cue[] }).cues ?? []
    for (const cue of cues) {
      const px = (cue.position_ms - startMs) / msPerPx
      if (px < -10 || px > W + 10) continue
      const col = hexColor(cue.color)
      ctx.strokeStyle = col
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, H)
      ctx.stroke()
      // Triangle flag
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px + 14, 0)
      ctx.lineTo(px, 12)
      ctx.closePath()
      ctx.fill()
      if (cue.label) {
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 9px sans-serif'
        ctx.fillText(cue.label.slice(0, 4), px + 2, 9)
      }
    }

    // Centre playhead
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(W / 2, 0)
    ctx.lineTo(W / 2, H)
    ctx.stroke()

    // Time markers every 10s
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.font = '9px monospace'
    const stepMs = 10000
    const firstMark = Math.ceil(startMs / stepMs) * stepMs
    for (let ms = firstMark; ms < startMs + visMs; ms += stepMs) {
      const px = (ms - startMs) / msPerPx
      ctx.fillText(formatDuration(ms), px + 2, H - 3)
    }

    rafRef.current = requestAnimationFrame(draw)
  }, [waveData, durationMs, playerTrack, containerW])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect()
    const clickPx = e.clientX - rect.left
    const W = containerW
    const audio = getAudio()
    const nowMs = audio.currentTime * 1000
    const totalMs = durationMs || 1
    const visMs = (W / PX_PER_SEC) * 1000
    const startMs = nowMs - visMs / 2
    const msPerPx = visMs / W
    const targetMs = startMs + clickPx * msPerPx
    const clamped = Math.max(0, Math.min(targetMs, totalMs))
    audio.currentTime = clamped / 1000
  }

  function handleAddCue(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const clickPx = e.clientX - rect.left
    const W = containerW
    const audio = getAudio()
    const nowMs = audio.currentTime * 1000
    const visMs = (W / PX_PER_SEC) * 1000
    const startMs = nowMs - visMs / 2
    const msPerPx = visMs / W
    const targetMs = startMs + clickPx * msPerPx
    addCue.mutate(Math.max(0, targetMs))
  }

  function togglePlay() {
    const audio = getAudio()
    if (audio.paused) audio.play()
    else audio.pause()
  }
  function stop() {
    const audio = getAudio()
    audio.pause()
    audio.currentTime = 0
  }
  function unload() {
    const audio = getAudio()
    audio.pause()
    audio.src = ''
    setPlayerTrack(null)
    setPlaying(false)
    setCurrentMs(0)
    setDurationMs(0)
  }

  if (!playerTrack) return null

  const progressPct = durationMs > 0 ? (currentMs / durationMs) * 100 : 0

  return (
    <div className={cn(
      'flex-shrink-0 border-t border-xkc-border bg-xkc-surface transition-all duration-200',
      playerExpanded ? 'h-auto' : 'h-12'
    )}>
      {/* Collapsed bar — always visible */}
      <div className="flex items-center gap-3 px-3 h-12">
        <button onClick={togglePlay} className="flex-shrink-0 w-7 h-7 rounded-full bg-xkc-accent flex items-center justify-center hover:bg-blue-600">
          {playing ? <Pause size={13} className="text-white" /> : <Play size={13} className="text-white ml-0.5" />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-xkc-text truncate">
            {playerTrack.title || playerTrack.artist || 'Unknown'}
            {playerTrack.artist && playerTrack.title && (
              <span className="text-xkc-muted"> — {playerTrack.artist}</span>
            )}
          </div>
          {/* Progress bar */}
          <div
            className="mt-0.5 h-1 bg-xkc-border rounded-full cursor-pointer"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const pct = (e.clientX - rect.left) / rect.width
              getAudio().currentTime = (pct * durationMs) / 1000
            }}
          >
            <div className="h-1 bg-xkc-accent rounded-full transition-none" style={{ width: `${progressPct}%` }} />
          </div>
        </div>

        <div className="text-xs font-mono text-xkc-muted flex-shrink-0">
          {formatDuration(currentMs)} / {formatDuration(durationMs)}
        </div>

        {playerTrack.bpm && (
          <span className="text-xs text-xkc-muted flex-shrink-0">{playerTrack.bpm.toFixed(0)} BPM</span>
        )}
        {playerTrack.key_camelot && (
          <span className="text-xs text-xkc-muted flex-shrink-0">{playerTrack.key_camelot}</span>
        )}

        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={stop} className="p-1 text-xkc-muted hover:text-xkc-text" title="Stop"><Square size={13} /></button>
          <button onClick={unload} className="p-1 text-xkc-muted hover:text-red-400" title="Unload"><X size={13} /></button>
          <button
            onClick={() => setPlayerExpanded(!playerExpanded)}
            className="p-1 text-xkc-muted hover:text-xkc-text"
            title={playerExpanded ? 'Collapse waveform' : 'Expand waveform'}
          >
            {playerExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>
      </div>

      {/* Expanded waveform */}
      {playerExpanded && (
        <div className="border-t border-xkc-border/50">
          {/* Waveform canvas */}
          <div ref={containerRef} className="relative w-full cursor-crosshair" style={{ height: WAVEFORM_H }}>
            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              onContextMenu={handleAddCue}
              title="Click to seek · Right-click to add cue"
            />
            {!waveData?.detail?.length && (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-xkc-muted">
                {playerTrack.analysis_state === 'complete' ? 'No waveform data' : `Analysis ${playerTrack.analysis_state}…`}
              </div>
            )}
          </div>

          {/* Cue point list */}
          {((trackWithCues as unknown as { cues?: Cue[] }).cues ?? []).length > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-t border-xkc-border/50 overflow-x-auto">
              <span className="text-xs text-xkc-muted flex-shrink-0">Cues:</span>
              {((trackWithCues as unknown as { cues?: Cue[] }).cues ?? []).map((cue, i) => (
                <button
                  key={cue.id}
                  onClick={() => { getAudio().currentTime = cue.position_ms / 1000 }}
                  className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border flex-shrink-0"
                  style={{ borderColor: hexColor(cue.color), color: hexColor(cue.color) }}
                  title={formatDuration(cue.position_ms)}
                >
                  {cue.label || `Cue ${i + 1}`}
                </button>
              ))}
              <button
                onClick={() => addCue.mutate(currentMs)}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-xkc-border text-xkc-muted hover:text-xkc-text flex-shrink-0"
                title="Add cue at current position"
              >
                <Plus size={10} /> Add
              </button>
            </div>
          )}
          {((trackWithCues as unknown as { cues?: Cue[] }).cues ?? []).length === 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-t border-xkc-border/50">
              <span className="text-xs text-xkc-muted">Right-click waveform to add cue · or</span>
              <button
                onClick={() => addCue.mutate(currentMs)}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-xkc-border text-xkc-muted hover:text-xkc-text"
              >
                <Plus size={10} /> Add at {formatDuration(currentMs)}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
