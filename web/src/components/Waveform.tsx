import { useEffect, useRef } from 'react'
import type { Cue } from '../lib/api'
import { hexColor } from '../lib/utils'

interface WaveformProps {
  data: number[]
  width?: number
  height?: number
  color?: string
  cues?: Cue[]
  onCueClick?: (positionMs: number) => void
}

export default function Waveform({ data, width = 600, height = 80, color = '#3b82f6', cues = [] }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data.length) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    ctx.scale(dpr, dpr)

    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#1a1a1a'
    ctx.fillRect(0, 0, width, height)

    const barWidth = width / data.length
    const maxVal = Math.max(...data, 0.001)
    const midY = height / 2

    ctx.fillStyle = color
    data.forEach((val, i) => {
      const normalized = val / maxVal
      const barH = normalized * midY
      const x = i * barWidth
      ctx.fillRect(x, midY - barH, Math.max(barWidth - 0.5, 1), barH * 2)
    })

    // Draw cue markers
    cues.forEach((cue) => {
      // We don't know duration here so skip positioning; caller should supply duration for accurate positions
      const cueColor = hexColor(cue.color)
      ctx.strokeStyle = cueColor
      ctx.lineWidth = 1.5
      // Placeholder: draw at 10% position per sort_order
      const x = (cue.sort_order / 8) * width
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()

      if (cue.label) {
        ctx.fillStyle = cueColor
        ctx.font = '9px sans-serif'
        ctx.fillText(cue.label.slice(0, 6), x + 2, 10)
      }
    })
  }, [data, width, height, color, cues])

  return <canvas ref={canvasRef} style={{ display: 'block', borderRadius: 4 }} />
}
