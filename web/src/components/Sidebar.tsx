import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { Playlist, TagGroup, StreamSource } from '../lib/api'
import { Plus, ChevronDown, ChevronRight, Music, RefreshCw, Radio } from 'lucide-react'
import { cn, hexColor } from '../lib/utils'

interface SidebarProps {
  selectedPlaylistId: string | null
  onPlaylistSelect: (id: string | null) => void
  selectedTagIds: string[]
  onTagSelect: (ids: string[]) => void
}

export default function Sidebar({ selectedPlaylistId, onPlaylistSelect, selectedTagIds, onTagSelect }: SidebarProps) {
  const qc = useQueryClient()
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [addingPlaylist, setAddingPlaylist] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(true)
  const [streamOpen, setStreamOpen] = useState(false)

  const { data: playlists = [] } = useQuery({ queryKey: ['playlists'], queryFn: api.playlists.getPlaylists })
  const { data: tagGroups = [] } = useQuery({ queryKey: ['tagGroups'], queryFn: api.tags.getTagGroups })
  const { data: sources = [] } = useQuery({ queryKey: ['streamSources'], queryFn: api.streamSources.getSources })

  const createPlaylist = useMutation({
    mutationFn: (name: string) => api.playlists.createPlaylist({ name }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['playlists'] }); setNewPlaylistName(''); setAddingPlaylist(false) },
  })

  const syncSource = useMutation({
    mutationFn: (id: string) => api.streamSources.syncSource(id),
  })

  function toggleTag(tagId: string) {
    if (selectedTagIds.includes(tagId)) {
      onTagSelect(selectedTagIds.filter((id) => id !== tagId))
    } else {
      onTagSelect([...selectedTagIds, tagId])
    }
  }

  return (
    <aside className="w-56 flex-shrink-0 bg-xkc-surface border-r border-xkc-border flex flex-col h-full overflow-y-auto">
      {/* Library */}
      <div className="p-3 border-b border-xkc-border">
        <div className="text-xs text-xkc-muted uppercase tracking-wider mb-2 px-1">Library</div>
        <SidebarItem
          label="All Tracks"
          icon={<Music size={14} />}
          active={selectedPlaylistId === null}
          onClick={() => onPlaylistSelect(null)}
        />
      </div>

      {/* Playlists */}
      <div className="p-3 border-b border-xkc-border flex-1">
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="text-xs text-xkc-muted uppercase tracking-wider">Playlists</span>
          <button
            className="text-xkc-muted hover:text-xkc-text"
            onClick={() => setAddingPlaylist(true)}
          >
            <Plus size={14} />
          </button>
        </div>

        {addingPlaylist && (
          <form
            onSubmit={(e) => { e.preventDefault(); if (newPlaylistName.trim()) createPlaylist.mutate(newPlaylistName.trim()) }}
            className="mb-2"
          >
            <input
              autoFocus
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              onBlur={() => { if (!newPlaylistName.trim()) setAddingPlaylist(false) }}
              placeholder="Playlist name…"
              className="w-full bg-xkc-bg border border-xkc-accent rounded px-2 py-1 text-xs text-xkc-text focus:outline-none"
            />
          </form>
        )}

        {playlists.map((pl) => (
          <SidebarItem
            key={pl.id}
            label={pl.name}
            count={pl.track_count}
            active={selectedPlaylistId === pl.id}
            onClick={() => onPlaylistSelect(pl.id)}
            dotColor={hexColor(pl.cover_color)}
          />
        ))}

        {playlists.length === 0 && !addingPlaylist && (
          <div className="text-xs text-xkc-muted px-1">No playlists yet</div>
        )}
      </div>

      {/* My Tags */}
      <div className="p-3 border-b border-xkc-border">
        <button
          className="flex items-center justify-between w-full mb-2 px-1"
          onClick={() => setTagsOpen(!tagsOpen)}
        >
          <span className="text-xs text-xkc-muted uppercase tracking-wider">My Tags</span>
          {tagsOpen ? <ChevronDown size={12} className="text-xkc-muted" /> : <ChevronRight size={12} className="text-xkc-muted" />}
        </button>
        {tagsOpen && (tagGroups as TagGroup[]).map((group) => (
          <div key={group.id} className="mb-2">
            <div className="text-xs text-xkc-muted px-1 mb-1">{group.name}</div>
            <div className="flex flex-wrap gap-1 px-1">
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

      {/* Streaming Sources */}
      <div className="p-3">
        <button
          className="flex items-center justify-between w-full mb-2 px-1"
          onClick={() => setStreamOpen(!streamOpen)}
        >
          <span className="text-xs text-xkc-muted uppercase tracking-wider">Streaming</span>
          {streamOpen ? <ChevronDown size={12} className="text-xkc-muted" /> : <ChevronRight size={12} className="text-xkc-muted" />}
        </button>
        {streamOpen && (sources as StreamSource[]).map((src) => (
          <div key={src.id} className="flex items-center justify-between px-1 py-1 text-xs text-xkc-muted hover:text-xkc-text group">
            <div className="flex items-center gap-1.5 truncate">
              <Radio size={12} />
              <span className="truncate">{src.display_name}</span>
            </div>
            <button
              className="opacity-0 group-hover:opacity-100 text-xkc-muted hover:text-xkc-accent"
              onClick={() => syncSource.mutate(src.id)}
              title="Sync now"
            >
              <RefreshCw size={12} className={syncSource.isPending ? 'animate-spin' : ''} />
            </button>
          </div>
        ))}
        {streamOpen && sources.length === 0 && (
          <div className="text-xs text-xkc-muted px-1">No sources. Add in Settings.</div>
        )}
      </div>
    </aside>
  )
}

function SidebarItem({
  label, active, onClick, count, dotColor, icon
}: {
  label: string
  active?: boolean
  onClick: () => void
  count?: number
  dotColor?: string
  icon?: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left transition-colors',
        active ? 'bg-xkc-accent/20 text-xkc-accent' : 'text-xkc-muted hover:text-xkc-text hover:bg-xkc-border/50'
      )}
    >
      {dotColor && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dotColor }} />}
      {icon}
      <span className="truncate flex-1">{label}</span>
      {count !== undefined && <span className="text-xkc-muted">{count}</span>}
    </button>
  )
}
