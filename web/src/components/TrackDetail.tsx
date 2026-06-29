import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { Track, Cue, TagGroup } from '../lib/api'
import Waveform from './Waveform'
import { X, Plus, Trash2, Loader2 } from 'lucide-react'
import { formatDuration, hexColor } from '../lib/utils'
import { cn } from '../lib/utils'

interface TrackDetailProps {
  trackId: string
  onClose: () => void
  tagGroups: TagGroup[]
}

export default function TrackDetail({ trackId, onClose, tagGroups }: TrackDetailProps) {
  const qc = useQueryClient()
  const { data: track, isLoading } = useQuery({
    queryKey: ['track', trackId],
    queryFn: () => api.tracks.getTrack(trackId),
  })
  const { data: waveform } = useQuery({
    queryKey: ['waveform', trackId],
    queryFn: () => api.tracks.getWaveform(trackId),
    enabled: !!track && track.analysis_state === 'complete',
  })

  const [editData, setEditData] = useState<Partial<Track>>({})
  const [isDirty, setIsDirty] = useState(false)
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([])

  useEffect(() => {
    if (track) {
      setEditData({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        album_artist: track.album_artist || '',
        genre: track.genre || '',
        label: track.label || '',
        remixer: track.remixer || '',
        year: track.year || undefined,
        bpm: track.bpm || undefined,
        key_camelot: track.key_camelot || '',
        rating: track.rating,
        comment: track.comment || '',
      })
      setSelectedTagIds(track.tag_ids || [])
      setIsDirty(false)
    }
  }, [track?.id])

  const updateTrack = useMutation({
    mutationFn: (data: Partial<Track>) => api.tracks.updateTrack(trackId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['track', trackId] })
      qc.invalidateQueries({ queryKey: ['tracks'] })
      setIsDirty(false)
    },
  })

  const addCue = useMutation({
    mutationFn: (data: Partial<Cue>) => api.tracks.addCue(trackId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['track', trackId] }),
  })

  const deleteCue = useMutation({
    mutationFn: (cueId: string) => api.tracks.deleteCue(trackId, cueId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['track', trackId] }),
  })

  const setTags = useMutation({
    mutationFn: (ids: string[]) => api.tracks.setTrackTags(trackId, ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['track', trackId] }),
  })

  function field(key: keyof Track, label: string, type = 'text') {
    return (
      <div key={key}>
        <label className="block text-xs text-xkc-muted mb-1">{label}</label>
        <input
          type={type}
          value={String(editData[key] ?? '')}
          onChange={(e) => { setEditData((d) => ({ ...d, [key]: type === 'number' ? Number(e.target.value) : e.target.value })); setIsDirty(true) }}
          className="w-full bg-xkc-bg border border-xkc-border rounded px-2 py-1.5 text-xs text-xkc-text focus:outline-none focus:border-xkc-accent"
        />
      </div>
    )
  }

  function toggleTag(tagId: string) {
    const next = selectedTagIds.includes(tagId)
      ? selectedTagIds.filter((id) => id !== tagId)
      : [...selectedTagIds, tagId]
    setSelectedTagIds(next)
    setTags.mutate(next)
  }

  if (isLoading) {
    return (
      <div className="w-80 flex-shrink-0 border-l border-xkc-border bg-xkc-surface flex items-center justify-center">
        <Loader2 size={24} className="text-xkc-muted animate-spin" />
      </div>
    )
  }

  if (!track) return null

  return (
    <div className="w-80 flex-shrink-0 border-l border-xkc-border bg-xkc-surface flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-xkc-border flex-shrink-0">
        <div className="text-sm font-medium text-xkc-text truncate">{track.title || 'Untitled'}</div>
        <button onClick={onClose} className="text-xkc-muted hover:text-xkc-text ml-2">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Analysis badge */}
        <div className="px-3 pt-3 pb-1">
          <span className={cn(
            'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full',
            track.analysis_state === 'complete' ? 'bg-green-900/50 text-green-400' :
            track.analysis_state === 'analyzing' ? 'bg-blue-900/50 text-blue-400' :
            track.analysis_state === 'failed' ? 'bg-red-900/50 text-red-400' :
            'bg-yellow-900/50 text-yellow-400'
          )}>
            {track.analysis_state}
          </span>
          {track.bpm && (
            <span className="ml-2 text-xs text-xkc-muted">{track.bpm.toFixed(1)} BPM · {track.key_camelot}</span>
          )}
          <span className="ml-2 text-xs text-xkc-muted">{formatDuration(track.duration_ms)}</span>
        </div>

        {/* Waveform */}
        {waveform?.overview && waveform.overview.length > 0 && (
          <div className="px-3 py-2">
            <Waveform data={waveform.overview} width={288} height={60} cues={track.cues} />
          </div>
        )}

        {/* Metadata */}
        <div className="px-3 pb-3 space-y-2 border-b border-xkc-border">
          <div className="text-xs text-xkc-muted uppercase tracking-wider mb-2">Metadata</div>
          {field('title', 'Title')}
          {field('artist', 'Artist')}
          {field('album', 'Album')}
          {field('album_artist', 'Album Artist')}
          {field('genre', 'Genre')}
          {field('label', 'Label')}
          {field('remixer', 'Remixer')}
          <div className="grid grid-cols-2 gap-2">
            {field('year', 'Year', 'number')}
            {field('bpm', 'BPM', 'number')}
          </div>
          {field('key_camelot', 'Key (Camelot)')}
          {field('comment', 'Comment')}

          {isDirty && (
            <button
              onClick={() => updateTrack.mutate(editData)}
              disabled={updateTrack.isPending}
              className="w-full bg-xkc-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded px-3 py-1.5 text-xs font-medium"
            >
              {updateTrack.isPending ? 'Saving…' : 'Save Changes'}
            </button>
          )}
        </div>

        {/* Cues */}
        <div className="px-3 py-3 border-b border-xkc-border">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-xkc-muted uppercase tracking-wider">Cue Points</div>
            <button
              className="text-xkc-muted hover:text-xkc-accent"
              onClick={() => addCue.mutate({ position_ms: 0, type: 'hot', color: 0xCC0000, sort_order: (track.cues?.length || 0) })}
            >
              <Plus size={14} />
            </button>
          </div>
          {(track.cues || []).map((cue) => (
            <div key={cue.id} className="flex items-center gap-2 py-1 text-xs">
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: hexColor(cue.color) }} />
              <span className="text-xkc-muted font-mono w-16">{formatDuration(cue.position_ms)}</span>
              <span className="text-xkc-text flex-1 truncate">{cue.label || cue.type}</span>
              <button className="text-xkc-muted hover:text-red-400" onClick={() => deleteCue.mutate(cue.id)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {(!track.cues || track.cues.length === 0) && (
            <div className="text-xs text-xkc-muted">No cues</div>
          )}
        </div>

        {/* Tags */}
        <div className="px-3 py-3">
          <div className="text-xs text-xkc-muted uppercase tracking-wider mb-2">Tags</div>
          {tagGroups.map((group) => (
            <div key={group.id} className="mb-3">
              <div className="text-xs text-xkc-muted mb-1">{group.name}</div>
              <div className="flex flex-wrap gap-1">
                {group.tags.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag.id)}
                    className={cn(
                      'text-xs px-2 py-0.5 rounded-full border transition-colors',
                      selectedTagIds.includes(tag.id)
                        ? 'border-transparent text-white'
                        : 'border-xkc-border text-xkc-muted hover:text-xkc-text'
                    )}
                    style={selectedTagIds.includes(tag.id) ? { backgroundColor: hexColor(tag.color) } : {}}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
