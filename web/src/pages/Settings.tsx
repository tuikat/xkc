import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { StreamSource } from '../lib/api'
import { ArrowLeft, Plus, Trash2, RefreshCw, Download, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { useStore } from '../lib/store'

type Tab = 'general' | 'tags' | 'streaming' | 'export' | 'import'

export default function Settings() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('general')

  return (
    <div className="min-h-screen bg-xkc-bg flex flex-col">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-xkc-border bg-xkc-surface">
        <button onClick={() => navigate('/')} className="text-xkc-muted hover:text-xkc-text"><ArrowLeft size={18} /></button>
        <div className="font-medium text-xkc-text">Settings</div>
      </header>

      <div className="flex flex-1">
        {/* Tab nav */}
        <nav className="w-48 border-r border-xkc-border p-4 space-y-1">
          {(['general', 'tags', 'streaming', 'export', 'import'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'w-full text-left px-3 py-2 rounded-lg text-sm capitalize transition-colors',
                tab === t ? 'bg-xkc-accent/10 text-xkc-accent' : 'text-xkc-muted hover:text-xkc-text hover:bg-xkc-border/50'
              )}
            >
              {t}
            </button>
          ))}
        </nav>

        {/* Tab content */}
        <div className="flex-1 p-6 max-w-2xl">
          {tab === 'general' && <GeneralTab />}
          {tab === 'tags' && <TagsTab />}
          {tab === 'streaming' && <StreamingTab />}
          {tab === 'export' && <ExportTab />}
          {tab === 'import' && <ImportTab />}
        </div>
      </div>
    </div>
  )
}

function TagsTab() {
  const qc = useQueryClient()
  const { data: tagGroups = [] } = useQuery({ queryKey: ['tagGroups'], queryFn: api.tags.getTagGroups })
  const [newTagName, setNewTagName] = useState<Record<string, string>>({})
  const [newGroupName, setNewGroupName] = useState('')

  const createTag = useMutation({
    mutationFn: ({ groupId, name }: { groupId: string; name: string }) =>
      api.tags.createTag({ group_id: groupId, name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tagGroups'] }),
  })
  const deleteTag = useMutation({
    mutationFn: (id: string) => api.tags.deleteTag(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tagGroups'] }),
  })
  const createGroup = useMutation({
    mutationFn: (name: string) => api.tags.createGroup({ name }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tagGroups'] }); setNewGroupName('') },
  })
  const deleteGroup = useMutation({
    mutationFn: (id: string) => api.tags.deleteGroup(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tagGroups'] }),
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-medium text-xkc-text mb-1">Tag Groups</h2>
        <p className="text-xs text-xkc-muted mb-4">
          Manage your tag groups and their tags. The <strong>Genre</strong> group tags appear as quick-select options when editing a track's genre.
        </p>
        <div className="space-y-4">
          {tagGroups.map(group => (
            <div key={group.id} className="bg-xkc-surface border border-xkc-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-xkc-text">{group.name}</span>
                <button onClick={() => deleteGroup.mutate(group.id)}
                  className="text-xkc-muted hover:text-red-400 transition-colors" title="Delete group">
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="flex flex-wrap gap-2 mb-3">
                {group.tags.map(tag => (
                  <span key={tag.id}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-xkc-bg border border-xkc-border text-xs text-xkc-text">
                    {tag.name}
                    <button onClick={() => deleteTag.mutate(tag.id)}
                      className="text-xkc-muted hover:text-red-400 ml-0.5">
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {group.tags.length === 0 && (
                  <span className="text-xs text-xkc-muted">No tags yet</span>
                )}
              </div>
              <form onSubmit={e => {
                e.preventDefault()
                const val = (newTagName[group.id] || '').trim()
                if (val) {
                  createTag.mutate({ groupId: group.id, name: val })
                  setNewTagName(prev => ({ ...prev, [group.id]: '' }))
                }
              }} className="flex gap-2">
                <input
                  value={newTagName[group.id] || ''}
                  onChange={e => setNewTagName(prev => ({ ...prev, [group.id]: e.target.value }))}
                  placeholder={`Add ${group.name} tag…`}
                  className="flex-1 bg-xkc-bg border border-xkc-border rounded px-2 py-1 text-xs text-xkc-text focus:outline-none focus:border-xkc-accent"
                />
                <button type="submit"
                  className="px-2 py-1 rounded bg-xkc-accent text-white text-xs hover:bg-blue-600">
                  <Plus size={12} />
                </button>
              </form>
            </div>
          ))}
        </div>
        <form onSubmit={e => { e.preventDefault(); if (newGroupName.trim()) createGroup.mutate(newGroupName.trim()) }}
          className="flex gap-2 mt-4">
          <input
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            placeholder="New tag group name…"
            className="flex-1 bg-xkc-bg border border-xkc-border rounded-lg px-3 py-1.5 text-sm text-xkc-text focus:outline-none focus:border-xkc-accent"
          />
          <button type="submit"
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-xkc-accent text-white text-xs hover:bg-blue-600">
            <Plus size={12} /> Add Group
          </button>
        </form>
      </div>
    </div>
  )
}

function GeneralTab() {
  const qc = useQueryClient()
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings.get })
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const currentUrl = String(settings?.public_url || '')
  const displayUrl = urlDraft ?? currentUrl

  const saveUrl = useMutation({
    mutationFn: () => api.settings.update({ public_url: displayUrl }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] })
      setUrlDraft(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-medium text-xkc-text mb-4">Server</h2>
        <div className="bg-xkc-surface border border-xkc-border rounded-xl p-4 space-y-4 text-sm">
          <div>
            <label className="block text-xs text-xkc-muted uppercase tracking-wide mb-1.5">Public URL</label>
            <div className="flex gap-2">
              <input
                className="flex-1 bg-xkc-bg border border-xkc-border rounded-lg px-3 py-1.5 text-sm text-xkc-text font-mono focus:outline-none focus:border-xkc-accent"
                value={displayUrl}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="https://xkc.io"
              />
              <button
                onClick={() => saveUrl.mutate()}
                disabled={saveUrl.isPending || displayUrl === currentUrl}
                className="px-3 py-1.5 rounded-lg bg-xkc-accent text-white text-xs disabled:opacity-40 hover:bg-blue-600"
              >
                {saved ? 'Saved!' : saveUrl.isPending ? '…' : 'Save'}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-xkc-muted">Used in export configs and desktop app connections.</p>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-xkc-muted">Version</span>
            <span className="text-xkc-text font-mono text-xs">1.0.0</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function YoutubeCookiesSection() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const { data } = useQuery({ queryKey: ['ytCookies'], queryFn: api.settings.getYoutubeCookies })

  const save = useMutation({
    mutationFn: () => api.settings.saveYoutubeCookies(draft),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ytCookies'] }); setEditing(false); setDraft('') },
  })
  const del = useMutation({
    mutationFn: api.settings.deleteYoutubeCookies,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ytCookies'] }),
  })

  return (
    <div className="bg-xkc-surface border border-xkc-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-xkc-text">YouTube Cookies</div>
          <div className="text-xs text-xkc-muted mt-0.5">
            Required for Spotify sync. Export from YouTube via browser extension
            <a href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc" target="_blank" rel="noreferrer" className="text-xkc-accent ml-1 hover:underline">"Get cookies.txt LOCALLY"</a>
            , then paste below.
          </div>
        </div>
        <div className="flex items-center gap-2">
          {data?.configured && <span className="text-xs text-green-400 font-medium">Active</span>}
          {!data?.configured && <span className="text-xs text-yellow-400 font-medium">Not set</span>}
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea
            className="w-full bg-xkc-bg border border-xkc-border rounded-lg px-3 py-2 text-xs font-mono text-xkc-text focus:outline-none focus:border-xkc-accent resize-none"
            rows={6}
            placeholder="Paste cookies.txt content here…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex gap-2">
            <button onClick={() => save.mutate()} disabled={!draft.trim() || save.isPending} className="btn-primary text-xs">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setEditing(false)} className="btn-secondary text-xs">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button onClick={() => setEditing(true)} className="btn-secondary text-xs">
            {data?.configured ? 'Replace cookies' : 'Add cookies'}
          </button>
          {data?.configured && (
            <button onClick={() => del.mutate()} className="text-xs text-red-400 hover:text-red-300">Remove</button>
          )}
        </div>
      )}
    </div>
  )
}

function StreamingTab() {
  const qc = useQueryClient()
  const { addLog, updateLog } = useStore()
  const { data: sources = [] } = useQuery({ queryKey: ['streamSources'], queryFn: api.streamSources.getSources })
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ service: 'spotify', display_name: '', source_url: '', sync_mode: 'master_only', auto_sync: false })

  const createSource = useMutation({
    mutationFn: () => api.streamSources.createSource({ ...form, source_type: 'playlist' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['streamSources'] }); setAdding(false); setForm({ service: 'spotify', display_name: '', source_url: '', sync_mode: 'master_only', auto_sync: false }) },
  })
  const deleteSource = useMutation({
    mutationFn: api.streamSources.deleteSource,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['streamSources'] }),
  })
  const syncSource = useMutation({
    mutationFn: api.streamSources.syncSource,
    onSuccess: (data, sourceId) => {
      const src = sources.find(s => s.id === sourceId)
      const logId = data.log_id
      const name = data.source_name ?? src?.display_name ?? 'Stream source'
      addLog({ id: logId, name: `Sync: ${name}`, status: 'uploading', ts: Date.now() })
      const poll = setInterval(async () => {
        try {
          const job = await api.streamSources.getSyncLog(logId)
          if (job.status === 'complete') {
            clearInterval(poll)
            updateLog(logId, { status: 'complete', detail: `${job.tracks_downloaded ?? 0} downloaded, ${job.tracks_skipped ?? 0} skipped` })
            qc.invalidateQueries({ queryKey: ['tracks'] })
          } else if (job.status === 'failed') {
            clearInterval(poll)
            updateLog(logId, { status: 'error', detail: job.error ?? 'Sync failed' })
          } else {
            const n = name
            let progress: string
            if (job.tracks_found === -1 || job.tracks_found === 0) progress = 'Searching...'
            else if (job.tracks_downloaded === 0) progress = `Found ${job.tracks_found} · starting downloads`
            else progress = `${job.tracks_downloaded}/${job.tracks_found} downloaded`
            updateLog(logId, { name: `Sync: ${n} · ${progress}` })
          }
        } catch { clearInterval(poll); updateLog(logId, { status: 'error', detail: 'Status check failed' }) }
      }, 4000)
    },
  })

  return (
    <div className="space-y-4">
      <YoutubeCookiesSection />
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-xkc-text">Streaming Sources</h2>
        <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-xkc-accent text-white hover:bg-blue-600">
          <Plus size={12} /> Add Source
        </button>
      </div>

      {adding && (
        <div className="bg-xkc-surface border border-xkc-border rounded-xl p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Service</label>
              <select value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} className="input">
                <option value="spotify">Spotify</option>
                <option value="soundcloud">SoundCloud</option>
                <option value="youtube">YouTube</option>
              </select>
            </div>
            <div>
              <label className="label">Name</label>
              <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="My Playlist" className="input" />
            </div>
          </div>
          <div>
            <label className="label">URL</label>
            <input value={form.source_url} onChange={(e) => setForm({ ...form, source_url: e.target.value })} placeholder="https://open.spotify.com/playlist/..." className="input" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Sync Mode</label>
              <select value={form.sync_mode} onChange={(e) => setForm({ ...form, sync_mode: e.target.value })} className="input">
                <option value="master_only">Master Library Only</option>
                <option value="mirror_playlist">Mirror as Playlist</option>
              </select>
            </div>
            <div className="flex items-end pb-0.5">
              <label className="flex items-center gap-2 text-sm text-xkc-text cursor-pointer">
                <input type="checkbox" checked={form.auto_sync} onChange={(e) => setForm({ ...form, auto_sync: e.target.checked })} className="accent-xkc-accent" />
                Auto-sync
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => createSource.mutate()} disabled={!form.source_url || !form.display_name} className="btn-primary text-xs">Add</button>
            <button onClick={() => setAdding(false)} className="btn-secondary text-xs">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {(sources as StreamSource[]).map((src) => (
          <div key={src.id} className="bg-xkc-surface border border-xkc-border rounded-xl p-4 flex items-center justify-between">
            <div>
              <div className="text-sm text-xkc-text font-medium">{src.display_name}</div>
              <div className="text-xs text-xkc-muted mt-0.5">{src.service} · {src.sync_mode} {src.auto_sync ? '· auto' : ''}</div>
              {src.last_synced_at && (
                <div className="text-xs text-xkc-muted">Last sync: {new Date(src.last_synced_at).toLocaleDateString()}</div>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={() => syncSource.mutate(src.id)} className="text-xkc-muted hover:text-xkc-accent" title="Sync now">
                <RefreshCw size={14} className={syncSource.isPending ? 'animate-spin' : ''} />
              </button>
              <button onClick={() => deleteSource.mutate(src.id)} className="text-xkc-muted hover:text-red-400">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
        {sources.length === 0 && !adding && (
          <div className="text-sm text-xkc-muted">No streaming sources configured.</div>
        )}
      </div>
    </div>
  )
}

function ExportTab() {
  async function downloadConfig() {
    const res = await api.settings.exportConfig()
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'xkc-config.zip'; a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-xkc-text">Export Server Configuration</h2>
      <p className="text-sm text-xkc-muted">Download a zip with docker-compose.yml, .env, Caddyfile, and nginx.conf for deploying this server on another machine.</p>
      <button onClick={downloadConfig} className="flex items-center gap-2 btn-primary text-sm">
        <Download size={14} /> Download Config Bundle
      </button>
    </div>
  )
}

function ImportTab() {
  const qc = useQueryClient()
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings.get })
  const enrichEnabled = settings?.enrich_on_import !== false

  const toggleEnrich = useMutation({
    mutationFn: (val: boolean) => api.settings.update({ enrich_on_import: val }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  })

  const [rbFile, setRbFile] = useState<File | null>(null)
  const [rbPreview, setRbPreview] = useState<{ import_id: string; track_count: number; playlists: string[] } | null>(null)
  const [importing, setImporting] = useState(false)
  const [importDone, setImportDone] = useState(false)

  async function handleRbUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setRbFile(file)
    try {
      const preview = await api.import.uploadRekordbox(file)
      setRbPreview(preview as typeof rbPreview)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to parse XML')
    }
  }

  async function confirmImport() {
    if (!rbPreview) return
    setImporting(true)
    try {
      await api.import.confirmRekordbox(rbPreview.import_id, { import_all: true })
      setImportDone(true)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-xkc-surface border border-xkc-border rounded-xl p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-xkc-text">Auto-enrich metadata on import</div>
            <div className="text-xs text-xkc-muted mt-0.5">
              Fills empty fields (year, label, genre, ISRC) from MusicBrainz and SoundCloud.
              Only fills missing values — never overwrites existing metadata or your ratings.
            </div>
          </div>
          <button
            onClick={() => toggleEnrich.mutate(!enrichEnabled)}
            className={cn(
              'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
              enrichEnabled ? 'bg-xkc-accent' : 'bg-xkc-border'
            )}
          >
            <span className={cn(
              'inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200',
              enrichEnabled ? 'translate-x-4' : 'translate-x-0'
            )} />
          </button>
        </div>
      </div>
      <div>
        <h2 className="text-sm font-medium text-xkc-text mb-2">Import from Rekordbox</h2>
        <p className="text-xs text-xkc-muted mb-4">Export your collection from Rekordbox: File → Export Collection in xml format, then upload the .xml file here.</p>
        <input type="file" accept=".xml" onChange={handleRbUpload} className="text-sm text-xkc-muted" />
        {rbPreview && !importDone && (
          <div className="mt-4 bg-xkc-surface border border-xkc-border rounded-xl p-4">
            <div className="text-sm text-xkc-text mb-2">Found {rbPreview.track_count} tracks in {rbPreview.playlists.length} playlists</div>
            <div className="text-xs text-xkc-muted mb-3">Playlists: {rbPreview.playlists.slice(0, 5).join(', ')}{rbPreview.playlists.length > 5 ? '…' : ''}</div>
            <button onClick={confirmImport} disabled={importing} className="btn-primary text-sm">
              {importing ? 'Importing…' : 'Import All'}
            </button>
          </div>
        )}
        {importDone && <div className="mt-3 text-sm text-green-400">Import complete!</div>}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-xkc-muted">{label}</span>
      <span className="text-xkc-text font-mono text-xs">{value}</span>
    </div>
  )
}
