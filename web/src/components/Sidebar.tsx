import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { Playlist, TagGroup, StreamSource } from '../lib/api'
import { Plus, ChevronDown, ChevronRight, Music, RefreshCw, Radio, Trash2, X, Check } from 'lucide-react'
import { cn, hexColor } from '../lib/utils'

interface SidebarProps {
  selectedPlaylistId: string | null
  onPlaylistSelect: (id: string | null) => void
  selectedTagIds: string[]
  onTagSelect: (ids: string[]) => void
}

interface NewSource { display_name: string; service: string; source_type: string; source_url: string; sync_mode: string; auto_sync: boolean }
const BLANK_SOURCE: NewSource = { display_name: '', service: 'soundcloud', source_type: 'playlist', source_url: '', sync_mode: 'mirror', auto_sync: false }

export default function Sidebar({ selectedPlaylistId, onPlaylistSelect, selectedTagIds, onTagSelect }: SidebarProps) {
  const qc = useQueryClient()
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [addingPlaylist, setAddingPlaylist] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(true)
  const [streamOpen, setStreamOpen] = useState(true)
  const [addingSource, setAddingSource] = useState(false)
  const [newSource, setNewSource] = useState<NewSource>(BLANK_SOURCE)
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null)
  const [editSource, setEditSource] = useState<Partial<StreamSource>>({})
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [dragOverPlaylist, setDragOverPlaylist] = useState<string | null>(null)

  const { data: playlists = [] } = useQuery({ queryKey: ['playlists'], queryFn: api.playlists.getPlaylists })
  const { data: tagGroups = [] } = useQuery({ queryKey: ['tagGroups'], queryFn: api.tags.getTagGroups })
  const { data: sources = [] } = useQuery({ queryKey: ['streamSources'], queryFn: api.streamSources.getSources })

  const createPlaylist = useMutation({
    mutationFn: (name: string) => api.playlists.createPlaylist({ name }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['playlists'] }); setNewPlaylistName(''); setAddingPlaylist(false) },
  })

  const addTracksToPlaylist = useMutation({
    mutationFn: ({ plId, trackIds }: { plId: string; trackIds: string[] }) =>
      api.playlists.addTracks(plId, trackIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['playlists'] }),
  })

  const deletePlaylist = useMutation({
    mutationFn: (id: string) => api.playlists.deletePlaylist(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['playlists'] })
      if (selectedPlaylistId === id) onPlaylistSelect(null)
      setConfirmDelete(null)
    },
  })

  const syncSource = useMutation({
    mutationFn: (id: string) => api.streamSources.syncSource(id),
  })

  const createSource = useMutation({
    mutationFn: (data: NewSource) => api.streamSources.createSource(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['streamSources'] }); setAddingSource(false); setNewSource(BLANK_SOURCE) },
  })

  const updateSource = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<StreamSource> }) => api.streamSources.updateSource(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['streamSources'] }); setEditingSourceId(null) },
  })

  const deleteSource = useMutation({
    mutationFn: (id: string) => api.streamSources.deleteSource(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['streamSources'] }),
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
          <button className="text-xkc-muted hover:text-xkc-text" onClick={() => setAddingPlaylist(true)}>
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
          <div
            key={pl.id}
            className={cn('group flex items-center rounded-lg transition-colors', dragOverPlaylist === pl.id && 'bg-xkc-accent/20 ring-1 ring-xkc-accent')}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOverPlaylist(pl.id) }}
            onDragLeave={() => setDragOverPlaylist(null)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOverPlaylist(null)
              const raw = e.dataTransfer.getData('trackIds')
              if (raw) {
                const ids = JSON.parse(raw) as string[]
                addTracksToPlaylist.mutate({ plId: pl.id, trackIds: ids })
              }
            }}
          >
            <SidebarItem
              label={pl.name}
              count={pl.track_count}
              active={selectedPlaylistId === pl.id}
              onClick={() => onPlaylistSelect(pl.id)}
              dotColor={hexColor(pl.cover_color)}
              className="flex-1 min-w-0"
            />
            {confirmDelete === pl.id ? (
              <div className="flex items-center gap-1 ml-1 flex-shrink-0">
                <button className="text-red-400 hover:text-red-300" onClick={() => deletePlaylist.mutate(pl.id)} title="Confirm delete">
                  <Check size={11} />
                </button>
                <button className="text-xkc-muted hover:text-xkc-text" onClick={() => setConfirmDelete(null)} title="Cancel">
                  <X size={11} />
                </button>
              </div>
            ) : (
              <button
                className="opacity-0 group-hover:opacity-100 ml-1 flex-shrink-0 text-xkc-muted hover:text-red-400 transition-opacity"
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(pl.id) }}
                title="Delete playlist"
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
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
        <div className="flex items-center justify-between mb-2 px-1">
          <button
            className="flex items-center gap-1 text-xs text-xkc-muted uppercase tracking-wider hover:text-xkc-text"
            onClick={() => setStreamOpen(!streamOpen)}
          >
            {streamOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Streaming
          </button>
          <button
            className="text-xkc-muted hover:text-xkc-text"
            onClick={() => { setAddingSource(true); setStreamOpen(true) }}
            title="Add streaming source"
          >
            <Plus size={14} />
          </button>
        </div>

        {/* Add source form */}
        {streamOpen && addingSource && (
          <div className="bg-xkc-bg border border-xkc-border rounded-lg p-2 mb-2 text-xs space-y-1.5">
            <input
              autoFocus
              placeholder="Name (e.g. My SoundCloud)"
              value={newSource.display_name}
              onChange={(e) => setNewSource({ ...newSource, display_name: e.target.value })}
              className="w-full bg-xkc-surface border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none focus:border-xkc-accent"
            />
            <select
              value={newSource.service}
              onChange={(e) => setNewSource({ ...newSource, service: e.target.value })}
              className="w-full bg-xkc-surface border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none"
            >
              <option value="soundcloud">SoundCloud</option>
              <option value="spotify">Spotify</option>
              <option value="youtube">YouTube</option>
              <option value="mixcloud">Mixcloud</option>
            </select>
            <select
              value={newSource.source_type}
              onChange={(e) => setNewSource({ ...newSource, source_type: e.target.value })}
              className="w-full bg-xkc-surface border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none"
            >
              <option value="playlist">Playlist</option>
              <option value="artist">Artist/Channel</option>
              <option value="likes">Likes</option>
            </select>
            <input
              placeholder="Source URL"
              value={newSource.source_url}
              onChange={(e) => setNewSource({ ...newSource, source_url: e.target.value })}
              className="w-full bg-xkc-surface border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none focus:border-xkc-accent"
            />
            <select
              value={newSource.sync_mode}
              onChange={(e) => setNewSource({ ...newSource, sync_mode: e.target.value })}
              className="w-full bg-xkc-surface border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none"
            >
              <option value="mirror">Mirror (keep in sync)</option>
              <option value="import">One-time import</option>
            </select>
            <label className="flex items-center gap-2 px-1 text-xkc-muted cursor-pointer">
              <input
                type="checkbox"
                checked={newSource.auto_sync}
                onChange={(e) => setNewSource({ ...newSource, auto_sync: e.target.checked })}
                className="accent-xkc-accent"
              />
              Auto-sync
            </label>
            <div className="flex gap-1 pt-0.5">
              <button
                onClick={() => { if (newSource.display_name && newSource.source_url) createSource.mutate(newSource) }}
                disabled={!newSource.display_name || !newSource.source_url}
                className="flex-1 bg-xkc-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded px-2 py-1 text-xs"
              >
                Add
              </button>
              <button
                onClick={() => { setAddingSource(false); setNewSource(BLANK_SOURCE) }}
                className="px-2 py-1 rounded border border-xkc-border text-xkc-muted hover:text-xkc-text text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {streamOpen && (sources as StreamSource[]).map((src) => (
          <div key={src.id}>
            {editingSourceId === src.id ? (
              <div className="bg-xkc-bg border border-xkc-border rounded-lg p-2 mb-1 text-xs space-y-1.5">
                <input
                  autoFocus
                  value={editSource.display_name ?? src.display_name}
                  onChange={(e) => setEditSource({ ...editSource, display_name: e.target.value })}
                  className="w-full bg-xkc-surface border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none focus:border-xkc-accent"
                />
                <input
                  value={editSource.source_url ?? src.source_url}
                  onChange={(e) => setEditSource({ ...editSource, source_url: e.target.value })}
                  placeholder="Source URL"
                  className="w-full bg-xkc-surface border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none focus:border-xkc-accent"
                />
                <select
                  value={editSource.sync_mode ?? src.sync_mode}
                  onChange={(e) => setEditSource({ ...editSource, sync_mode: e.target.value })}
                  className="w-full bg-xkc-surface border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none"
                >
                  <option value="mirror">Mirror</option>
                  <option value="import">One-time import</option>
                </select>
                <label className="flex items-center gap-2 px-1 text-xkc-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editSource.auto_sync ?? src.auto_sync}
                    onChange={(e) => setEditSource({ ...editSource, auto_sync: e.target.checked })}
                    className="accent-xkc-accent"
                  />
                  Auto-sync
                </label>
                <div className="flex gap-1 pt-0.5">
                  <button
                    onClick={() => updateSource.mutate({ id: src.id, data: editSource })}
                    className="flex-1 bg-xkc-accent hover:bg-blue-600 text-white rounded px-2 py-1 text-xs"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => deleteSource.mutate(src.id)}
                    className="px-2 py-1 rounded border border-red-900 text-red-400 hover:text-red-300 text-xs"
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => { setEditingSourceId(null); setEditSource({}) }}
                    className="px-2 py-1 rounded border border-xkc-border text-xkc-muted hover:text-xkc-text text-xs"
                  >
                    <X size={10} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between px-1 py-1 text-xs text-xkc-muted hover:text-xkc-text group cursor-pointer"
                onClick={() => { setEditingSourceId(src.id); setEditSource({}) }}>
                <div className="flex items-center gap-1.5 truncate">
                  <Radio size={12} className="flex-shrink-0" />
                  <span className="truncate">{src.display_name}</span>
                </div>
                <button
                  className="opacity-0 group-hover:opacity-100 text-xkc-muted hover:text-xkc-accent flex-shrink-0"
                  onClick={(e) => { e.stopPropagation(); syncSource.mutate(src.id) }}
                  title="Sync now"
                >
                  <RefreshCw size={12} className={syncSource.isPending ? 'animate-spin' : ''} />
                </button>
              </div>
            )}
          </div>
        ))}
        {streamOpen && sources.length === 0 && !addingSource && (
          <div className="text-xs text-xkc-muted px-1">No sources yet. Click + to add.</div>
        )}
      </div>
    </aside>
  )
}

function SidebarItem({
  label, active, onClick, count, dotColor, icon, className
}: {
  label: string
  active?: boolean
  onClick: () => void
  count?: number
  dotColor?: string
  icon?: React.ReactNode
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left transition-colors w-full min-w-0',
        active ? 'bg-xkc-accent/20 text-xkc-accent' : 'text-xkc-muted hover:text-xkc-text hover:bg-xkc-border/50',
        className
      )}
    >
      {dotColor && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dotColor }} />}
      {icon}
      <span className="truncate flex-1">{label}</span>
      {count !== undefined && <span className="text-xkc-muted flex-shrink-0">{count}</span>}
    </button>
  )
}
