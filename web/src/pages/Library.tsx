import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import Sidebar from '../components/Sidebar'
import TrackTable from '../components/TrackTable'
import TrackDetail from '../components/TrackDetail'
import UploadZone from '../components/UploadZone'
import { Search, Upload, Settings, Users, LogOut, Download, ChevronDown, X, SlidersHorizontal } from 'lucide-react'
import { cn } from '../lib/utils'

export default function Library() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const {
    user, searchQuery, setSearchQuery, selectedPlaylistId, setSelectedPlaylistId,
    selectedTrackId, setSelectedTrackId, filters, setFilters,
  } = useStore()

  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([])
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [exportModal, setExportModal] = useState(false)
  const [selectedForExport, setSelectedForExport] = useState<string[]>([])
  const [exportJobId, setExportJobId] = useState<string | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)

  const { data: tracks = [], isLoading } = useQuery({
    queryKey: ['tracks', searchQuery, selectedPlaylistId, selectedTagIds, filters],
    queryFn: () => api.tracks.getTracks({
      q: searchQuery || undefined,
      playlist_id: selectedPlaylistId || undefined,
      tag_ids: selectedTagIds.length ? selectedTagIds.join(',') : undefined,
      min_bpm: filters.minBpm,
      max_bpm: filters.maxBpm,
      key_camelot: filters.keyCamelot,
      genre: filters.genre,
    }),
  })

  const { data: tagGroups = [] } = useQuery({ queryKey: ['tagGroups'], queryFn: api.tags.getTagGroups })
  const { data: playlists = [] } = useQuery({ queryKey: ['playlists'], queryFn: api.playlists.getPlaylists })

  const deleteTrack = useMutation({
    mutationFn: api.tracks.deleteTrack,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tracks'] })
      if (selectedTrackId) setSelectedTrackId(null)
    },
  })

  const reanalyze = useMutation({
    mutationFn: api.tracks.reanalyze,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tracks'] }),
  })

  const requestExport = useMutation({
    mutationFn: ({ ids, format }: { ids: string[]; format: string }) =>
      api.export.requestExport(ids, format),
    onSuccess: (data) => setExportJobId(data.job_id),
  })

  async function handleLogout() {
    await api.auth.logout()
    qc.clear()
    navigate('/login')
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      // UploadZone handles document-level drops, but we simulate one via the store
      const { addToQueue, updateQueueItem } = useStore.getState()
      Array.from(e.target.files).forEach(async (file) => {
        const qid = addToQueue(file)
        updateQueueItem(qid, { status: 'uploading' })
        try {
          await api.tracks.uploadTrack(file, (pct) => updateQueueItem(qid, { progress: pct }))
          updateQueueItem(qid, { status: 'complete', progress: 100 })
          qc.invalidateQueries({ queryKey: ['tracks'] })
        } catch (err) {
          updateQueueItem(qid, { status: 'error', error: err instanceof Error ? err.message : 'Failed' })
        }
      })
    }
  }

  return (
    <UploadZone>
      <div className="flex flex-col h-screen bg-xkc-bg">
        {/* Top bar */}
        <header className="flex items-center gap-3 px-4 py-2 border-b border-xkc-border bg-xkc-surface flex-shrink-0 h-12">
          <div className="text-lg font-bold text-xkc-text tracking-tight w-40">XKC</div>

          {/* Search */}
          <div className="flex-1 max-w-md relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xkc-muted" />
            <input
              type="text"
              placeholder="Search tracks…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-xkc-bg border border-xkc-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-xkc-text focus:outline-none focus:border-xkc-accent"
            />
          </div>

          {/* Filter chips */}
          <button
            onClick={() => setFilterOpen(!filterOpen)}
            className={cn(
              'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors',
              Object.values(filters).some(Boolean)
                ? 'border-xkc-accent text-xkc-accent bg-xkc-accent/10'
                : 'border-xkc-border text-xkc-muted hover:text-xkc-text'
            )}
          >
            <SlidersHorizontal size={12} />
            Filters
          </button>

          {/* Export button */}
          <button
            onClick={() => setExportModal(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-xkc-border text-xkc-muted hover:text-xkc-text transition-colors"
          >
            <Download size={12} />
            Export
          </button>

          {/* Upload button */}
          <button
            onClick={() => uploadInputRef.current?.click()}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-xkc-accent hover:bg-blue-600 text-white transition-colors"
          >
            <Upload size={12} />
            Import
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            accept="audio/*,.mp3,.flac,.wav,.aiff,.aif,.m4a,.ogg"
            className="hidden"
            onChange={handleFileInput}
          />

          {/* User menu */}
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center gap-1.5 text-xs text-xkc-muted hover:text-xkc-text"
            >
              <div className="w-7 h-7 rounded-full bg-xkc-accent/20 text-xkc-accent flex items-center justify-center text-xs font-medium">
                {user?.username?.[0]?.toUpperCase()}
              </div>
              <ChevronDown size={12} />
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-1 bg-xkc-surface border border-xkc-border rounded-lg shadow-xl py-1 min-w-[140px] z-50">
                <div className="px-3 py-1.5 text-xs text-xkc-muted border-b border-xkc-border mb-1">
                  {user?.username}
                </div>
                <button className="menu-item" onClick={() => { navigate('/settings'); setUserMenuOpen(false) }}>
                  <Settings size={12} /> Settings
                </button>
                {user?.is_admin && (
                  <button className="menu-item" onClick={() => { navigate('/users'); setUserMenuOpen(false) }}>
                    <Users size={12} /> Users
                  </button>
                )}
                <div className="border-t border-xkc-border my-1" />
                <button className="menu-item text-red-400 hover:text-red-300" onClick={handleLogout}>
                  <LogOut size={12} /> Sign out
                </button>
              </div>
            )}
          </div>
        </header>

        {/* Filter bar */}
        {filterOpen && (
          <div className="flex items-center gap-3 px-4 py-2 border-b border-xkc-border bg-xkc-surface/50 text-xs flex-shrink-0">
            <span className="text-xkc-muted">BPM:</span>
            <input
              type="number" placeholder="Min" value={filters.minBpm || ''}
              onChange={(e) => setFilters({ ...filters, minBpm: Number(e.target.value) || undefined })}
              className="w-16 bg-xkc-bg border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none focus:border-xkc-accent"
            />
            <span className="text-xkc-muted">–</span>
            <input
              type="number" placeholder="Max" value={filters.maxBpm || ''}
              onChange={(e) => setFilters({ ...filters, maxBpm: Number(e.target.value) || undefined })}
              className="w-16 bg-xkc-bg border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none focus:border-xkc-accent"
            />
            <span className="text-xkc-muted ml-2">Key:</span>
            <input
              type="text" placeholder="8A" value={filters.keyCamelot || ''}
              onChange={(e) => setFilters({ ...filters, keyCamelot: e.target.value || undefined })}
              className="w-14 bg-xkc-bg border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none focus:border-xkc-accent"
            />
            <span className="text-xkc-muted ml-2">Genre:</span>
            <input
              type="text" placeholder="Techno" value={filters.genre || ''}
              onChange={(e) => setFilters({ ...filters, genre: e.target.value || undefined })}
              className="w-24 bg-xkc-bg border border-xkc-border rounded px-2 py-1 text-xkc-text focus:outline-none focus:border-xkc-accent"
            />
            <button
              onClick={() => { setFilters({}); setFilterOpen(false) }}
              className="ml-auto text-xkc-muted hover:text-xkc-text"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Main layout */}
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            selectedPlaylistId={selectedPlaylistId}
            onPlaylistSelect={setSelectedPlaylistId}
            selectedTagIds={selectedTagIds}
            onTagSelect={setSelectedTagIds}
          />

          <main className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-hidden flex flex-col">
              {/* Track count */}
              <div className="px-3 py-1.5 border-b border-xkc-border text-xs text-xkc-muted bg-xkc-surface/50 flex-shrink-0">
                {isLoading ? 'Loading…' : `${tracks.length} tracks`}
              </div>
              <TrackTable
                tracks={tracks}
                onSelectTrack={setSelectedTrackId}
                selectedTrackId={selectedTrackId}
                tagGroups={tagGroups}
                onAddToPlaylist={(trackId) => {
                  const pl = playlists[0]
                  if (pl) api.playlists.addTracks(pl.id, [trackId])
                }}
                onDeleteTrack={(id) => deleteTrack.mutate(id)}
                onReanalyze={(id) => reanalyze.mutate(id)}
              />
            </div>

            {selectedTrackId && (
              <TrackDetail
                trackId={selectedTrackId}
                onClose={() => setSelectedTrackId(null)}
                tagGroups={tagGroups}
              />
            )}
          </main>
        </div>

        {/* Export Modal */}
        {exportModal && (
          <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setExportModal(false)}>
            <div className="bg-xkc-surface border border-xkc-border rounded-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <div className="font-medium text-xkc-text">Export Library</div>
                <button onClick={() => setExportModal(false)} className="text-xkc-muted hover:text-xkc-text"><X size={16} /></button>
              </div>
              <div className="mb-4">
                <div className="text-xs text-xkc-muted mb-2">Select playlists to export:</div>
                {playlists.map((pl) => (
                  <label key={pl.id} className="flex items-center gap-2 py-1 text-sm text-xkc-text cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedForExport.includes(pl.id)}
                      onChange={(e) =>
                        setSelectedForExport(e.target.checked
                          ? [...selectedForExport, pl.id]
                          : selectedForExport.filter((id) => id !== pl.id))
                      }
                      className="accent-xkc-accent"
                    />
                    {pl.name}
                    <span className="text-xkc-muted text-xs">({pl.track_count})</span>
                  </label>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { requestExport.mutate({ ids: selectedForExport, format: 'pioneer' }); setExportModal(false) }}
                  disabled={selectedForExport.length === 0}
                  className="flex-1 bg-xkc-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm"
                >
                  Pioneer USB Format
                </button>
                <button
                  onClick={() => { requestExport.mutate({ ids: selectedForExport, format: 'flat' }); setExportModal(false) }}
                  disabled={selectedForExport.length === 0}
                  className="flex-1 bg-xkc-surface border border-xkc-border hover:bg-xkc-border disabled:opacity-50 text-xkc-text rounded-lg px-4 py-2 text-sm"
                >
                  Flat Folder
                </button>
              </div>
              {exportJobId && (
                <div className="mt-3 text-xs text-xkc-muted">
                  Export queued. <a href={`/api/export/${exportJobId}/download`} className="text-xkc-accent hover:underline">Download</a> when ready.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <style>{`
        .menu-item {
          display: flex; align-items: center; gap: 8px;
          width: 100%; text-align: left;
          padding: 6px 12px; font-size: 12px;
          color: #e5e5e5; transition: background 0.1s;
        }
        .menu-item:hover { background: #2a2a2a; }
      `}</style>
    </UploadZone>
  )
}
