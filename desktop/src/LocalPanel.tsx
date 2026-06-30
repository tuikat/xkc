import { useState, useEffect, useCallback } from 'react'

interface WatchedFolder {
  path: string
  autoSync: boolean
  status: 'watching' | 'syncing' | 'idle' | 'error'
  lastSync?: string
}

interface UsbDevice {
  mount_point: string
  name: string
  is_pioneer: boolean
  status: 'idle' | 'syncing'
  statusDetail?: string
  selectedPlaylistIds: string[] | null  // null = all playlists
}

interface DownloadSync {
  id: string
  path: string
  playlist_id: string
  playlist_name: string
}

interface ServerPlaylist {
  id: string
  name: string
}

interface SyncLogEntry {
  id: string
  timestamp: string
  type: 'upload' | 'usb_sync' | 'download' | 'error' | 'info'
  message: string
}

interface Props {
  serverUrl: string
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<T>(cmd, args)
  } catch {
    return null
  }
}

async function tauriDialog(): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({ directory: true, multiple: false })
    return typeof result === 'string' ? result : null
  } catch {
    return null
  }
}

export default function LocalPanel({ serverUrl }: Props) {
  const [folders, setFolders] = useState<WatchedFolder[]>(() => {
    try { return JSON.parse(localStorage.getItem('xkc_watched_folders') || '[]') } catch { return [] }
  })
  const [usbDevices, setUsbDevices] = useState<UsbDevice[]>([])
  const [downloadSyncs, setDownloadSyncs] = useState<DownloadSync[]>(() => {
    try { return JSON.parse(localStorage.getItem('xkc_download_syncs') || '[]') } catch { return [] }
  })
  const [syncLog, setSyncLog] = useState<SyncLogEntry[]>([])
  const [activeSection, setActiveSection] = useState<'folders' | 'usb' | 'downloads' | 'log'>('folders')
  const [expandedUsb, setExpandedUsb] = useState<string | null>(null)

  // For "Add Download Sync" form
  const [showAddDownload, setShowAddDownload] = useState(false)
  const [newSyncPath, setNewSyncPath] = useState<string | null>(null)
  const [newSyncPlaylistId, setNewSyncPlaylistId] = useState('')
  const [playlists, setPlaylists] = useState<ServerPlaylist[]>([])

  const addLog = useCallback((type: SyncLogEntry['type'], message: string) => {
    setSyncLog(prev => [{
      id: Math.random().toString(36).slice(2),
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
    }, ...prev].slice(0, 30))
  }, [])

  useEffect(() => {
    localStorage.setItem('xkc_watched_folders', JSON.stringify(folders))
  }, [folders])

  useEffect(() => {
    localStorage.setItem('xkc_download_syncs', JSON.stringify(downloadSyncs))
  }, [downloadSyncs])

  // Poll USB devices
  useEffect(() => {
    const poll = async () => {
      const devices = await tauriInvoke<{ mount_point: string; name: string; is_pioneer: boolean }[]>('get_usb_devices')
      if (devices) {
        setUsbDevices(prev => devices.map(d => {
          const existing = prev.find(p => p.mount_point === d.mount_point)
          return {
            ...d,
            status: existing?.status ?? 'idle',
            statusDetail: existing?.statusDetail,
            selectedPlaylistIds: existing?.selectedPlaylistIds ?? null,
          }
        }))
      }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [])

  // Live staged progress from the Rust sync_usb command (requesting -> building ->
  // downloading -> extracting -> complete/failed), shown on the device badge and
  // logged so it's visible what's actually happening during a long sync.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const un = await listen<{ mount_point: string; stage: string; detail: string }>('usb-sync-progress', (event) => {
          const { mount_point, stage, detail } = event.payload
          setUsbDevices(prev => prev.map(d =>
            d.mount_point === mount_point ? { ...d, statusDetail: detail } : d
          ))
          if (stage === 'requesting' || stage === 'downloading' || stage === 'complete' || stage === 'failed') {
            addLog(stage === 'failed' ? 'error' : 'usb_sync', detail)
          }
        })
        if (cancelled) un()
        else unlisten = un
      } catch {
        // not running under Tauri (e.g. plain browser dev) -- no-op
      }
    })()
    return () => { cancelled = true; unlisten?.() }
  }, [addLog])

  // Fetch playlists when USB tab is active or Add Download Sync is opened
  useEffect(() => {
    if (activeSection !== 'usb' && !showAddDownload) return
    const token = localStorage.getItem('xkc_access_token') || ''
    fetch(`${serverUrl}/api/playlists/`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    })
      .then(r => r.ok ? r.json() : [])
      .then((data: ServerPlaylist[]) => setPlaylists(data))
      .catch(() => setPlaylists([]))
  }, [activeSection, showAddDownload, serverUrl])

  const addFolder = async () => {
    const path = await tauriDialog()
    if (!path) return
    if (folders.find(f => f.path === path)) return
    const folder: WatchedFolder = { path, autoSync: true, status: 'idle' }
    setFolders(prev => [...prev, folder])
    const token = localStorage.getItem('xkc_access_token') || ''
    await tauriInvoke('start_folder_watch', { path, serverUrl, token })
    addLog('info', `Started watching: ${path}`)
  }

  const removeFolder = async (path: string) => {
    await tauriInvoke('stop_folder_watch', { path })
    setFolders(prev => prev.filter(f => f.path !== path))
    addLog('info', `Stopped watching: ${path}`)
  }

  const toggleAutoSync = (path: string) => {
    setFolders(prev => prev.map(f => f.path === path ? { ...f, autoSync: !f.autoSync } : f))
  }

  const syncUsb = async (device: UsbDevice) => {
    const token = localStorage.getItem('xkc_access_token') || ''
    const playlistIds = device.selectedPlaylistIds ?? playlists.map(p => p.id)
    setUsbDevices(prev => prev.map(d => d.mount_point === device.mount_point ? { ...d, status: 'syncing', statusDetail: undefined } : d))
    addLog('usb_sync', `Syncing ${playlistIds.length === 0 ? 'all' : playlistIds.length} playlist(s) to ${device.name}...`)
    const result = await tauriInvoke<string>('sync_usb', {
      mountPoint: device.mount_point,
      serverUrl,
      token,
      playlistIds,
    })
    setUsbDevices(prev => prev.map(d => d.mount_point === device.mount_point ? { ...d, status: 'idle', statusDetail: undefined } : d))
    if (result) {
      addLog('usb_sync', `Done: ${result}`)
    } else {
      addLog('error', `USB sync failed: ${device.name}`)
    }
  }

  const ejectUsb = async (device: UsbDevice) => {
    const result = await tauriInvoke<string>('eject_usb', { mountPoint: device.mount_point })
    if (result) {
      addLog('info', result)
      setUsbDevices(prev => prev.filter(d => d.mount_point !== device.mount_point))
      if (expandedUsb === device.mount_point) setExpandedUsb(null)
    } else {
      addLog('error', `Failed to eject ${device.name}`)
    }
  }

  const formatUsb = async (device: UsbDevice) => {
    if (!window.confirm(`Format "${device.name}" as Pioneer USB?\n\nThis will create the Pioneer folder structure. Existing non-Pioneer files will not be affected.`)) return
    const result = await tauriInvoke<string>('format_usb', { mountPoint: device.mount_point })
    if (result) {
      addLog('info', result)
      const devices = await tauriInvoke<{ mount_point: string; name: string; is_pioneer: boolean }[]>('get_usb_devices')
      if (devices) {
        setUsbDevices(prev => devices.map(d => ({
          ...d,
          status: prev.find(p => p.mount_point === d.mount_point)?.status ?? 'idle',
          selectedPlaylistIds: prev.find(p => p.mount_point === d.mount_point)?.selectedPlaylistIds ?? null,
        })))
      }
    } else {
      addLog('error', `Format failed for ${device.name}`)
    }
  }

  const togglePlaylistForDevice = (mount_point: string, playlistId: string) => {
    setUsbDevices(prev => prev.map(d => {
      if (d.mount_point !== mount_point) return d
      const current = d.selectedPlaylistIds ?? playlists.map(p => p.id)
      const next = current.includes(playlistId)
        ? current.filter(id => id !== playlistId)
        : [...current, playlistId]
      return { ...d, selectedPlaylistIds: next.length === playlists.length ? null : next }
    }))
  }

  const pickDownloadFolder = async () => {
    const path = await tauriDialog()
    if (path) setNewSyncPath(path)
  }

  const addDownloadSync = () => {
    if (!newSyncPath || !newSyncPlaylistId) return
    const playlist = playlists.find(p => p.id === newSyncPlaylistId)
    if (!playlist) return
    const sync: DownloadSync = {
      id: Math.random().toString(36).slice(2),
      path: newSyncPath,
      playlist_id: newSyncPlaylistId,
      playlist_name: playlist.name,
    }
    setDownloadSyncs(prev => [...prev, sync])
    setShowAddDownload(false)
    setNewSyncPath(null)
    setNewSyncPlaylistId('')
    addLog('info', `Added download sync: ${playlist.name} → ${newSyncPath}`)
  }

  const removeDownloadSync = (id: string) => {
    setDownloadSyncs(prev => prev.filter(s => s.id !== id))
  }

  const runDownloadSync = async (sync: DownloadSync) => {
    const token = localStorage.getItem('xkc_access_token') || ''
    addLog('download', `Syncing "${sync.playlist_name}" → ${sync.path}...`)
    const result = await tauriInvoke<string>('sync_playlist_to_folder', {
      folder: sync.path,
      playlistId: sync.playlist_id,
      serverUrl,
      token,
    })
    if (result) {
      addLog('download', result)
    } else {
      addLog('error', `Download sync failed: ${sync.playlist_name}`)
    }
  }

  const s: Record<string, any> = {
    root: { height: '100%', display: 'flex', flexDirection: 'column', background: '#111', overflow: 'hidden' },
    tabs: { display: 'flex', borderBottom: '1px solid #1f1f1f', flexShrink: 0 },
    tab: (active: boolean): React.CSSProperties => ({
      padding: '6px 12px', fontSize: 11, fontWeight: 600, color: active ? '#e5e5e5' : '#525252',
      background: 'none', border: 'none', cursor: 'pointer', textTransform: 'uppercase',
      letterSpacing: 0.5, borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
      whiteSpace: 'nowrap',
    }),
    body: { flex: 1, overflow: 'auto', padding: '10px 14px' },
    row: { display: 'flex', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #1a1a1a', gap: 8 },
    path: { flex: 1, fontSize: 12, color: '#a3a3a3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    badge: (color: string): React.CSSProperties => ({ fontSize: 10, padding: '2px 6px', borderRadius: 10, background: color + '22', color, flexShrink: 0 }),
    btn: { fontSize: 11, padding: '3px 8px', borderRadius: 4, border: '1px solid #2a2a2a', background: 'none', color: '#737373', cursor: 'pointer', flexShrink: 0 },
    blueBtn: { fontSize: 11, padding: '3px 8px', borderRadius: 4, border: '1px solid #3b82f6', background: 'none', color: '#3b82f6', cursor: 'pointer', flexShrink: 0 },
    addBtn: { fontSize: 11, padding: '4px 10px', borderRadius: 4, border: '1px solid #3b82f6', background: 'none', color: '#3b82f6', cursor: 'pointer', marginTop: 8 },
    toggle: (on: boolean): React.CSSProperties => ({
      width: 28, height: 16, borderRadius: 8, background: on ? '#3b82f6' : '#2a2a2a',
      border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0,
    }),
    empty: { color: '#525252', fontSize: 12, padding: '12px 0' },
    logEntry: (type: string): React.CSSProperties => ({
      fontSize: 11, padding: '3px 0', color: type === 'error' ? '#f87171' : type === 'usb_sync' ? '#60a5fa' : type === 'download' ? '#34d399' : '#a3a3a3',
      borderBottom: '1px solid #1a1a1a',
    }),
    logTime: { color: '#525252', marginRight: 8, fontFamily: 'monospace' as const },
    form: { background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6, padding: 10, marginTop: 8 },
    formRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
    select: { flex: 1, background: '#0f0f0f', border: '1px solid #2a2a2a', borderRadius: 4, padding: '4px 8px', color: '#e5e5e5', fontSize: 12 },
    plConfig: { background: '#0f0f0f', border: '1px solid #1f1f1f', borderRadius: 4, padding: '6px 8px', marginBottom: 4 },
    plRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 11, color: '#a3a3a3', cursor: 'pointer' },
  }

  const statusColor = (s: string) => s === 'watching' ? '#22c55e' : s === 'syncing' ? '#3b82f6' : s === 'error' ? '#ef4444' : '#525252'

  return (
    <div style={s.root}>
      <div style={s.tabs}>
        <button style={s.tab(activeSection === 'folders')} onClick={() => setActiveSection('folders')}>
          Watch ({folders.length})
        </button>
        <button style={s.tab(activeSection === 'downloads')} onClick={() => setActiveSection('downloads')}>
          Download ({downloadSyncs.length})
        </button>
        <button style={s.tab(activeSection === 'usb')} onClick={() => setActiveSection('usb')}>
          USB ({usbDevices.length})
        </button>
        <button style={s.tab(activeSection === 'log')} onClick={() => setActiveSection('log')}>
          Log
        </button>
      </div>

      <div style={s.body}>
        {activeSection === 'folders' && (
          <>
            {folders.length === 0 && <div style={s.empty}>No folders watched. Add a folder to auto-import new audio files.</div>}
            {folders.map(f => (
              <div key={f.path} style={s.row}>
                <span style={s.badge(statusColor(f.status))}>{f.status}</span>
                <span style={s.path} title={f.path}>{f.path}</span>
                <button style={s.toggle(f.autoSync)} onClick={() => toggleAutoSync(f.path)} title={f.autoSync ? 'Auto-sync on' : 'Auto-sync off'} />
                <button style={s.btn} onClick={() => removeFolder(f.path)}>Remove</button>
              </div>
            ))}
            <button style={s.addBtn} onClick={addFolder}>+ Add Folder</button>
          </>
        )}

        {activeSection === 'downloads' && (
          <>
            {downloadSyncs.length === 0 && !showAddDownload && (
              <div style={s.empty}>No download syncs. Add one to mirror a playlist into a local folder.</div>
            )}
            {downloadSyncs.map(sync => (
              <div key={sync.id} style={s.row}>
                <span style={s.badge('#34d399')}>↓</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: '#e5e5e5', fontWeight: 500 }}>{sync.playlist_name}</div>
                  <div style={{ fontSize: 11, color: '#525252', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sync.path}</div>
                </div>
                <button style={s.blueBtn} onClick={() => runDownloadSync(sync)}>Sync</button>
                <button style={s.btn} onClick={() => removeDownloadSync(sync.id)}>✕</button>
              </div>
            ))}
            {showAddDownload ? (
              <div style={s.form}>
                <div style={s.formRow}>
                  <button style={s.blueBtn} onClick={pickDownloadFolder}>
                    {newSyncPath ? '📁 ' + newSyncPath.split('/').pop() : 'Choose Folder'}
                  </button>
                </div>
                <div style={s.formRow}>
                  <select
                    style={s.select}
                    value={newSyncPlaylistId}
                    onChange={e => setNewSyncPlaylistId(e.target.value)}
                  >
                    <option value="">Select playlist...</option>
                    {playlists.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    style={{ ...s.blueBtn, padding: '4px 12px' }}
                    onClick={addDownloadSync}
                    disabled={!newSyncPath || !newSyncPlaylistId}
                  >
                    Add
                  </button>
                  <button style={{ ...s.btn, padding: '4px 12px' }} onClick={() => { setShowAddDownload(false); setNewSyncPath(null); setNewSyncPlaylistId('') }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button style={s.addBtn} onClick={() => setShowAddDownload(true)}>+ Add Download Sync</button>
            )}
          </>
        )}

        {activeSection === 'usb' && (
          <>
            {usbDevices.length === 0 && (
              <div style={s.empty}>No USB drives detected. Insert a drive to get started.</div>
            )}
            {usbDevices.map(d => (
              <div key={d.mount_point}>
                <div style={s.row}>
                  <span style={s.badge(d.is_pioneer ? '#3b82f6' : '#a3a3a3')}>{d.is_pioneer ? 'Pioneer' : 'USB'}</span>
                  <span style={s.path} title={d.mount_point}>{d.name}</span>
                  {d.status === 'syncing' && (
                    <span style={s.badge('#3b82f6')} title={d.statusDetail}>{d.statusDetail || 'syncing...'}</span>
                  )}
                  {d.is_pioneer ? (
                    <>
                      <button
                        style={{ ...s.btn, color: expandedUsb === d.mount_point ? '#e5e5e5' : '#737373' }}
                        onClick={() => setExpandedUsb(expandedUsb === d.mount_point ? null : d.mount_point)}
                        title="Select playlists"
                      >
                        ⚙
                      </button>
                      <button
                        style={{ ...s.blueBtn, opacity: d.status === 'syncing' ? 0.5 : 1 }}
                        onClick={() => syncUsb(d)}
                        disabled={d.status === 'syncing'}
                      >
                        {d.status === 'syncing' ? 'Syncing...' : 'Sync'}
                      </button>
                    </>
                  ) : (
                    <button style={s.btn} onClick={() => formatUsb(d)}>Format as Pioneer</button>
                  )}
                  <button style={s.btn} onClick={() => ejectUsb(d)} title="Safely eject">⏏</button>
                </div>

                {/* Playlist picker for this device */}
                {expandedUsb === d.mount_point && d.is_pioneer && (
                  <div style={{ ...s.plConfig, marginLeft: 8, marginBottom: 4 }}>
                    <div style={{ fontSize: 10, color: '#525252', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Playlists to sync
                    </div>
                    {/* All playlists option */}
                    <label style={s.plRow}>
                      <input
                        type="checkbox"
                        checked={d.selectedPlaylistIds === null}
                        onChange={() => setUsbDevices(prev => prev.map(dev =>
                          dev.mount_point === d.mount_point
                            ? { ...dev, selectedPlaylistIds: null }
                            : dev
                        ))}
                        style={{ accentColor: '#3b82f6' }}
                      />
                      <span style={{ color: '#e5e5e5', fontWeight: 500 }}>All Playlists</span>
                    </label>
                    {/* Individual playlists */}
                    {playlists.length === 0 && (
                      <div style={{ fontSize: 11, color: '#525252', padding: '4px 0' }}>Loading playlists...</div>
                    )}
                    {playlists.map(pl => {
                      const selected = d.selectedPlaylistIds === null || d.selectedPlaylistIds.includes(pl.id)
                      return (
                        <label key={pl.id} style={{ ...s.plRow, opacity: d.selectedPlaylistIds === null ? 0.4 : 1 }}>
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={d.selectedPlaylistIds === null}
                            onChange={() => togglePlaylistForDevice(d.mount_point, pl.id)}
                            style={{ accentColor: '#3b82f6' }}
                          />
                          <span>{pl.name}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {activeSection === 'log' && (
          <>
            {syncLog.length === 0 && <div style={s.empty}>No sync activity yet.</div>}
            {syncLog.map(entry => (
              <div key={entry.id} style={s.logEntry(entry.type)}>
                <span style={s.logTime}>{entry.timestamp}</span>
                {entry.message}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
