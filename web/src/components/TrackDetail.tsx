import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { Track, Cue, TagGroup } from '../lib/api'
import { X, Plus, Trash2, Loader2 } from 'lucide-react'
import { formatDuration, hexColor } from '../lib/utils'
import { cn } from '../lib/utils'

interface TrackDetailProps {
  trackId: string
  onClose: () => void
  tagGroups: TagGroup[]
}

function splitChips(str: string | null | undefined): string[] {
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

function mergeArtists(artist: string | null, albumArtist: string | null): string[] {
  const seen = new Set<string>()
  return [...splitChips(artist), ...splitChips(albumArtist)].filter(a => {
    const l = a.toLowerCase()
    if (seen.has(l)) return false
    seen.add(l)
    return true
  })
}

export default function TrackDetail({ trackId, onClose, tagGroups }: TrackDetailProps) {
  const qc = useQueryClient()
  const { data: track, isLoading } = useQuery({
    queryKey: ['track', trackId],
    queryFn: () => api.tracks.getTrack(trackId),
  })

  const [editData, setEditData] = useState<Partial<Track>>({})
  const [isDirty, setIsDirty] = useState(false)
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([])

  // Genre chip editing
  const [addingGenre, setAddingGenre] = useState(false)
  const [genreInput, setGenreInput] = useState('')

  // Per-group new tag creation
  const [addingTagToGroup, setAddingTagToGroup] = useState<string | null>(null)
  const [newTagName, setNewTagName] = useState('')

  useEffect(() => {
    if (track) {
      setEditData({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
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

  const createTag = useMutation({
    mutationFn: ({ groupId, name }: { groupId: string; name: string }) =>
      api.tags.createTag({ group_id: groupId, name }),
    onSuccess: (newTag) => {
      qc.invalidateQueries({ queryKey: ['tagGroups'] })
      const next = [...selectedTagIds, newTag.id]
      setSelectedTagIds(next)
      setTags.mutate(next)
      setAddingTagToGroup(null)
      setNewTagName('')
    },
  })

  function field(key: keyof Track, label: string, type = 'text') {
    return (
      <div key={key}>
        <label className="block text-xs text-xkc-muted mb-1">{label}</label>
        <input
          type={type}
          value={String(editData[key] ?? '')}
          onChange={e => {
            setEditData(d => ({ ...d, [key]: type === 'number' ? Number(e.target.value) : e.target.value }))
            setIsDirty(true)
          }}
          className="w-full bg-xkc-bg border border-xkc-border rounded px-2 py-1.5 text-xs text-xkc-text focus:outline-none focus:border-xkc-accent"
        />
      </div>
    )
  }

  function toggleTag(tagId: string) {
    const next = selectedTagIds.includes(tagId)
      ? selectedTagIds.filter(id => id !== tagId)
      : [...selectedTagIds, tagId]
    setSelectedTagIds(next)
    setTags.mutate(next)
  }

  // Genre chips (read from live track data, saved immediately)
  const genreChips = useMemo(() => splitChips(track?.genre), [track?.genre])

  function saveGenre(chips: string[]) {
    const genre = chips.join(', ') || null
    updateTrack.mutate({ genre } as Partial<Track>)
  }

  function addGenreChip(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    if (genreChips.some(g => g.toLowerCase() === trimmed.toLowerCase())) return
    saveGenre([...genreChips, trimmed])
    setAddingGenre(false)
    setGenreInput('')
  }

  function removeGenreChip(chip: string) {
    saveGenre(genreChips.filter(g => g.toLowerCase() !== chip.toLowerCase()))
  }

  // Merged artist chips for display
  const artistChips = useMemo(() => mergeArtists(track?.artist ?? null, track?.album_artist ?? null), [track?.artist, track?.album_artist])

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

        {/* Metadata */}
        <div className="px-3 pb-3 space-y-2 border-b border-xkc-border">
          <div className="text-xs text-xkc-muted uppercase tracking-wider mb-2 pt-2">Metadata</div>

          {field('title', 'Title')}

          {/* Artist — merged chips + editable field */}
          <div>
            <label className="block text-xs text-xkc-muted mb-1">Artists</label>
            {artistChips.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {artistChips.map(a => (
                  <span key={a} className="text-[11px] px-1.5 py-0.5 rounded-full border border-xkc-border/60 text-xkc-muted leading-tight">
                    {a}
                  </span>
                ))}
              </div>
            )}
            <input
              type="text"
              value={String(editData.artist ?? '')}
              onChange={e => { setEditData(d => ({ ...d, artist: e.target.value })); setIsDirty(true) }}
              placeholder="comma-separated artists"
              className="w-full bg-xkc-bg border border-xkc-border rounded px-2 py-1.5 text-xs text-xkc-text focus:outline-none focus:border-xkc-accent"
            />
          </div>

          {field('album', 'Album')}
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
              onClick={() => addCue.mutate({ position_ms: 0, type: 'hot', color: 0xCC0000, sort_order: track.cues?.length || 0 })}
            >
              <Plus size={14} />
            </button>
          </div>
          {(track.cues || []).map(cue => (
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
          <div className="text-xs text-xkc-muted uppercase tracking-wider mb-3">Tags</div>

          {/* Genre pseudo-group */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-xkc-muted">Genre</span>
              <button
                onClick={() => { setAddingGenre(true); setGenreInput('') }}
                className="text-xkc-muted hover:text-xkc-accent"
                title="Add genre"
              >
                <Plus size={12} />
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {genreChips.map(g => (
                <span
                  key={g}
                  className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-xkc-border text-xkc-muted group"
                >
                  {g}
                  <button
                    onClick={() => removeGenreChip(g)}
                    className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity leading-none"
                    title="Remove genre"
                  >
                    <X size={9} />
                  </button>
                </span>
              ))}
              {addingGenre && (
                <input
                  autoFocus
                  value={genreInput}
                  onChange={e => setGenreInput(e.target.value)}
                  onBlur={() => { if (genreInput.trim()) addGenreChip(genreInput); else setAddingGenre(false) }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') addGenreChip(genreInput)
                    if (e.key === 'Escape') { setAddingGenre(false); setGenreInput('') }
                    e.stopPropagation()
                  }}
                  placeholder="Genre name"
                  className="text-xs px-2 py-0.5 rounded-full border border-xkc-accent bg-xkc-bg text-xkc-text focus:outline-none w-24"
                />
              )}
              {genreChips.length === 0 && !addingGenre && (
                <button
                  onClick={() => { setAddingGenre(true); setGenreInput('') }}
                  className="text-[11px] text-xkc-border/50 hover:text-xkc-muted italic px-1"
                >
                  + add genre
                </button>
              )}
            </div>
          </div>

          {/* Real tag groups — skip any named "genre" since we handle it above */}
          {tagGroups.filter(g => g.name.toLowerCase() !== 'genre').map(group => (
            <div key={group.id} className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-xkc-muted">{group.name}</span>
                <button
                  onClick={() => { setAddingTagToGroup(group.id); setNewTagName('') }}
                  className="text-xkc-muted hover:text-xkc-accent"
                  title={`Add tag to ${group.name}`}
                >
                  <Plus size={12} />
                </button>
              </div>
              <div className="flex flex-wrap gap-1">
                {group.tags.map(tag => (
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
                {addingTagToGroup === group.id && (
                  <input
                    autoFocus
                    value={newTagName}
                    onChange={e => setNewTagName(e.target.value)}
                    onBlur={() => { if (!newTagName.trim()) setAddingTagToGroup(null) }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newTagName.trim()) {
                        createTag.mutate({ groupId: group.id, name: newTagName.trim() })
                      }
                      if (e.key === 'Escape') { setAddingTagToGroup(null); setNewTagName('') }
                      e.stopPropagation()
                    }}
                    placeholder="Tag name"
                    className="text-xs px-2 py-0.5 rounded-full border border-xkc-accent bg-xkc-bg text-xkc-text focus:outline-none w-20"
                  />
                )}
                {group.tags.length === 0 && addingTagToGroup !== group.id && (
                  <span className="text-[11px] text-xkc-border/50 italic">no tags yet</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
