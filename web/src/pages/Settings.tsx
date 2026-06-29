import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { StreamSource } from '../lib/api'
import { ArrowLeft, Plus, Trash2, RefreshCw, Download } from 'lucide-react'
import { cn } from '../lib/utils'

type Tab = 'general' | 'streaming' | 'export' | 'import'

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
          {(['general', 'streaming', 'export', 'import'] as Tab[]).map((t) => (
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
          {tab === 'streaming' && <StreamingTab />}
          {tab === 'export' && <ExportTab />}
          {tab === 'import' && <ImportTab />}
        </div>
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

function StreamingTab() {
  const qc = useQueryClient()
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
  const syncSource = useMutation({ mutationFn: api.streamSources.syncSource })

  return (
    <div className="space-y-4">
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
