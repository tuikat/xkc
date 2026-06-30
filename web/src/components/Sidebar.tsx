import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { Playlist, TagGroup, StreamSource, SyncLog } from '../lib/api'
import { Plus, ChevronDown, ChevronRight, Music, RefreshCw, Radio, X } from 'lucide-react'
import { cn, hexColor } from '../lib/utils'
import { useStore } from '../lib/store'

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
  const { addLog, updateLog } = useStore()
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
  const [plCtxMenu, setPlCtxMenu] = useState<{ x: number; y: number; pl: Playlist } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')

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

  const renamePlaylist = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.playlists.updatePlaylist(id, { name } as Partial<Playlist>),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['playlists'] }); setRenamingId(null); setPlCtxMenu(null) },
  })

  const sharePlaylist = useMutation({
    mutationFn: ({ id, shared }: { id: string; shared: boolean }) =>
      api.playlists.updatePlaylist(id, { is_shared: shared } as Partial<Playlist>),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['playlists'] }); setPlCtxMenu(null) },
  })
  const deletePlaylist = useMutation({
    mutationFn: (id: string) => api.playlists.deletePlaylist(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['playlists'] })
      // Always fall back to All Tracks when deleted playlist was active or it was the last one
      if (selectedPlaylistId === id) onPlaylistSelect(null)
      setConfirmDelete(null)
      setPlCtxMenu(null)
    },
  })

  // Track active poll intervals so we don't double-poll
  const activePolls = useRef<Set<string>>(new Set())

  function startPolling(logId: string, displayName: string) {
    if (activePolls.current.has(logId)) return
    activePolls.current.add(logId)
    addLog({ id: logId, name: `Sync: ${displayName}`, status: 'uploading', ts: Date.now() })

    const poll = setInterval(async () => {
      try {
        const log: SyncLog = await api.streamSources.getSyncLog(logId)
        if (log.status === 'complete') {
          clearInterval(poll)
          activePolls.current.delete(logId)
          updateLog(logId, {
            status: 'complete',
            detail: `${log.tracks_downloaded ?? 0} downloaded, ${log.tracks_skipped ?? 0} skipped`,
          })
          qc.invalidateQueries({ queryKey: ['tracks'] })
          qc.invalidateQueries({ queryKey: ['playlists'] })
        } else if (log.status === 'failed') {
          clearInterval(poll)
          activePolls.current.delete(logId)
          updateLog(logId, { status: 'error', detail: log.error ?? 'Sync failed' })
        } else {
          // Show phase-appropriate progress
          let progress: string
          if (log.tracks_found === -1 || log.tracks_found === 0) {
            progress = 'Searching...'
          } else if (log.tracks_downloaded === 0) {
            progress = `Found ${log.tracks_found} · starting downloads`
          } else {
            progress = `${log.tracks_downloaded}/${log.tracks_found} downloaded`
          }
          updateLog(logId, { name: `Sync: ${displayName} · ${progress}` })
        }
      } catch {
        clearInterval(poll)
        activePolls.current.delete(logId)
        updateLog(logId, { status: 'error', detail: 'Status check failed' })
      }
    }, 4000)
  }

  // On load: discover any syncs running from a previous session or another tab
  useEffect(() => {
    api.streamSources.getActiveSyncs().then((logs: SyncLog[]) => {
      for (const log of logs) {
        startPolling(log.id, log.source_name ?? 'Stream source')
      }
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const syncSource = useMutation({
    mutationFn: (id: string) => api.streamSources.syncSource(id),
    onSuccess: (data, sourceId) => {
      const src = sources.find(s => s.id === sourceId)
      startPolling(data.log_id, data.source_name ?? src?.display_name ?? 'Stream source')
    },
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

        {(playlists as Playlist[]).filter(p => !p.is_shared).map((pl) => (
          <div
            key={pl.id}
            className={cn('rounded-lg transition-colors', dragOverPlaylist === pl.id && 'bg-xkc-accent/20 ring-1 ring-xkc-accent')}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOverPlaylist(pl.id) }}
            onDragLeave={() => setDragOverPlaylist(null)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOverPlaylist(null)
              const raw = e.dataTransfer.getData('trackIds')
              if (raw) addTracksToPlaylist.mutate({ plId: pl.id, trackIds: JSON.parse(raw) as string[] })
            }}
          >
            {renamingId === pl.id ? (
              <form
                onSubmit={(e) => { e.preventDefault(); if (renameVal.trim()) renamePlaylist.mutate({ id: pl.id, name: renameVal.trim() }) }}
                className="px-1 mb-1"
              >
                <input
                  autoFocus
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onBlur={() => { if (!renameVal.trim()) setRenamingId(null) }}
                  onKeyDown={(e) => { if (e.key === 'Escape') setRenamingId(null) }}
                  className="w-full bg-xkc-bg border border-xkc-accent rounded px-2 py-1 text-xs text-xkc-text focus:outline-none"
                />
              </form>
            ) : (
              <SidebarItem
                label={pl.name}
                count={pl.track_count}
                active={selectedPlaylistId === pl.id}
                onClick={() => onPlaylistSelect(pl.id)}
                onContextMenu={(e) => { e.preventDefault(); setPlCtxMenu({ x: e.clientX, y: e.clientY, pl }) }}
                dotColor={hexColor(pl.cover_color)}
                className="w-full"
              />
            )}
          </div>
        ))}

        {(playlists as Playlist[]).filter(p => !p.is_shared).length === 0 && !addingPlaylist && (
          <div className="text-xs text-xkc-muted px-1">No playlists yet</div>
        )}
      </div>

      {/* Shared Playlists */}
      {(playlists as Playlist[]).some(p => p.is_shared) && (
        <div className="p-3 border-b border-xkc-border">
          <div className="text-xs text-xkc-muted uppercase tracking-wider mb-2 px-1">Shared</div>
          {(playlists as Playlist[]).filter(p => p.is_shared).map((pl) => (
            <div
              key={pl.id}
              className={cn('rounded-lg transition-colors', dragOverPlaylist === pl.id && 'bg-xkc-accent/20 ring-1 ring-xkc-accent')}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOverPlaylist(pl.id) }}
              onDragLeave={() => setDragOverPlaylist(null)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOverPlaylist(null)
                const raw = e.dataTransfer.getData('trackIds')
                if (raw) addTracksToPlaylist.mutate({ plId: pl.id, trackIds: JSON.parse(raw) as string[] })
              }}
            >
              <SidebarItem
                label={pl.name}
                count={pl.track_count}
                active={selectedPlaylistId === pl.id}
                onClick={() => onPlaylistSelect(pl.id)}
                onContextMenu={(e) => { e.preventDefault(); setPlCtxMenu({ x: e.clientX, y: e.clientY, pl }) }}
                dotColor={hexColor(pl.cover_color)}
                className="w-full"
              />
            </div>
          ))}
        </div>
      )}

      {/* Playlist right-click context menu */}
      {plCtxMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPlCtxMenu(null)} />
          <div
            className="fixed z-50 bg-xkc-surface border border-xkc-border rounded-lg shadow-xl py-1 min-w-[160px] text-sm"
            style={{ left: plCtxMenu.x, top: plCtxMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-1 text-xs text-xkc-muted border-b border-xkc-border mb-1 truncate">{plCtxMenu.pl.name}</div>
            <button className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-xkc-text"
              onClick={() => { setRenamingId(plCtxMenu.pl.id); setRenameVal(plCtxMenu.pl.name); setPlCtxMenu(null) }}>
              Rename
            </button>
            <button className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-xkc-text"
              onClick={() => sharePlaylist.mutate({ id: plCtxMenu.pl.id, shared: !plCtxMenu.pl.is_shared })}>
              {plCtxMenu.pl.is_shared ? 'Stop sharing' : 'Share (collaborative)'}
            </button>
            <div className="border-t border-xkc-border my-1" />
            <button className="w-full text-left px-3 py-1.5 hover:bg-xkc-border text-red-400"
              onClick={() => deletePlaylist.mutate(plCtxMenu.pl.id)}>
              Delete
            </button>
          </div>
        </>
      )}

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
                <div>
                  <label className="block text-[10px] text-xkc-muted mb-0.5">Playlist destination</label>
                  <select
                    value={(editSource.mirror_playlist_id !== undefined ? editSource.mirror_playlist_id : src.mirror_playlist_id) ?? ''}
                    onChange={e => setEditSource({ ...editSource, mirror_playlist_id: e.target.value || null })}
                    className="w-full bg-xkc-surface border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none text-xs"
                  >
                    <option value="">Library only (All Tracks)</option>
                    {playlists.map(pl => <option key={pl.id} value={pl.id}>{pl.name}</option>)}
                  </select>
                </div>
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
              <div>
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
                {src.mirror_playlist_id && (() => {
                  const pl = playlists.find(p => p.id === src.mirror_playlist_id)
                  return pl ? (
                    <button
                      onClick={() => onPlaylistSelect(pl.id)}
                      className={cn(
                        'w-full flex items-center gap-1.5 pl-5 pr-2 py-0.5 text-[11px] rounded transition-colors truncate',
                        selectedPlaylistId === pl.id ? 'text-xkc-accent bg-xkc-accent/10' : 'text-xkc-muted hover:text-xkc-text'
                      )}
                    >
                      <span className="truncate">{pl.name}</span>
                      <span className="flex-shrink-0 text-[9px] opacity-50">{pl.track_count}</span>
                    </button>
                  ) : null
                })()}
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
  label, active, onClick, onContextMenu, count, dotColor, icon, className
}: {
  label: string
  active?: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  count?: number
  dotColor?: string
  icon?: React.ReactNode
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
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
