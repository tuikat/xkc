import { useState, useEffect, useCallback } from 'react'

interface WatchedFolder {
  path: string
  autoSync: boolean
  status: 'watching' | 'syncing' | 'idle' | 'error'
  lastSync?: string
}

interface UsbDevice {
  mountPoint: string
  name: string
  status: 'idle' | 'syncing' | 'not_configured'
  autoSync?: boolean
  playlistIds?: string[]
}

interface SyncLogEntry {
  id: string
  timestamp: string
  type: 'upload' | 'usb_sync' | 'error' | 'info'
  message: string
}

interface Props {
  serverUrl: string
}

// Safe invoke wrapper - falls back gracefully when not in Tauri context
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
  const [syncLog, setSyncLog] = useState<SyncLogEntry[]>([])
  const [activeSection, setActiveSection] = useState<'folders' | 'usb' | 'log'>('folders')

  const addLog = useCallback((type: SyncLogEntry['type'], message: string) => {
    setSyncLog(prev => [{
      id: Math.random().toString(36).slice(2),
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
    }, ...prev].slice(0, 20))
  }, [])

  // Persist folders
  useEffect(() => {
    localStorage.setItem('xkc_watched_folders', JSON.stringify(folders))
  }, [folders])

  // Poll USB devices
  useEffect(() => {
    const poll = async () => {
      const mounts = await tauriInvoke<string[]>('get_usb_devices')
      if (mounts) {
        setUsbDevices(mounts.map(mp => ({
          mountPoint: mp,
          name: mp.split('/').filter(Boolean).pop() || mp,
          status: 'idle',
        })))
      }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [])

  const addFolder = async () => {
    const path = await tauriDialog()
    if (!path) return
    if (folders.find(f => f.path === path)) return
    const folder: WatchedFolder = { path, autoSync: true, status: 'idle' }
    setFolders(prev => [...prev, folder])

    const token = localStorage.getItem('xkc_refresh_token') || ''
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
    const token = localStorage.getItem('xkc_refresh_token') || ''
    setUsbDevices(prev => prev.map(d => d.mountPoint === device.mountPoint ? { ...d, status: 'syncing' } : d))
    addLog('usb_sync', `Syncing to ${device.name}...`)
    const result = await tauriInvoke<string>('sync_usb', {
      mountPoint: device.mountPoint,
      serverUrl,
      token,
      playlistIds: device.playlistIds || [],
    })
    setUsbDevices(prev => prev.map(d => d.mountPoint === device.mountPoint ? { ...d, status: 'idle' } : d))
    addLog(result ? 'usb_sync' : 'error', result ? `USB sync complete: ${device.name}` : `USB sync failed: ${device.name}`)
  }

  const s: Record<string, React.CSSProperties> = {
    root: { height: '100%', display: 'flex', flexDirection: 'column', background: '#111', overflow: 'hidden' },
    tabs: { display: 'flex', borderBottom: '1px solid #1f1f1f', flexShrink: 0 },
    tab: (active: boolean): React.CSSProperties => ({
      padding: '6px 14px', fontSize: 11, fontWeight: 600, color: active ? '#e5e5e5' : '#525252',
      background: 'none', border: 'none', cursor: 'pointer', textTransform: 'uppercase',
      letterSpacing: 0.5, borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
    }),
    body: { flex: 1, overflow: 'auto', padding: '10px 14px' },
    row: { display: 'flex', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #1a1a1a', gap: 8 },
    path: { flex: 1, fontSize: 12, color: '#a3a3a3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    badge: (color: string): React.CSSProperties => ({ fontSize: 10, padding: '2px 6px', borderRadius: 10, background: color + '22', color }),
    btn: { fontSize: 11, padding: '3px 8px', borderRadius: 4, border: '1px solid #2a2a2a', background: 'none', color: '#737373', cursor: 'pointer' },
    addBtn: { fontSize: 11, padding: '4px 10px', borderRadius: 4, border: '1px solid #3b82f6', background: 'none', color: '#3b82f6', cursor: 'pointer', marginTop: 8 },
    toggle: (on: boolean): React.CSSProperties => ({
      width: 28, height: 16, borderRadius: 8, background: on ? '#3b82f6' : '#2a2a2a',
      border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0,
    }),
    empty: { color: '#525252', fontSize: 12, padding: '12px 0' },
    logEntry: (type: string): React.CSSProperties => ({
      fontSize: 11, padding: '3px 0', color: type === 'error' ? '#f87171' : type === 'usb_sync' ? '#60a5fa' : '#a3a3a3',
      borderBottom: '1px solid #1a1a1a',
    }),
    logTime: { color: '#525252', marginRight: 8, fontFamily: 'monospace' },
  }

  const statusColor = (s: string) => s === 'watching' ? '#22c55e' : s === 'syncing' ? '#3b82f6' : s === 'error' ? '#ef4444' : '#525252'

  return (
    <div style={s.root}>
      <div style={s.tabs}>
        <button style={s.tab(activeSection === 'folders')} onClick={() => setActiveSection('folders')}>
          Watched Folders ({folders.length})
        </button>
        <button style={s.tab(activeSection === 'usb')} onClick={() => setActiveSection('usb')}>
          USB Devices ({usbDevices.length})
        </button>
        <button style={s.tab(activeSection === 'log')} onClick={() => setActiveSection('log')}>
          Sync Log
        </button>
      </div>

      <div style={s.body}>
        {activeSection === 'folders' && (
          <>
            {folders.length === 0 && <div style={s.empty}>No folders watched. Add a folder to auto-import new tracks.</div>}
            {folders.map(f => (
              <div key={f.path} style={s.row}>
                <span style={s.badge(statusColor(f.status))}>{f.status}</span>
                <span style={s.path} title={f.path}>{f.path}</span>
                <button
                  style={s.toggle(f.autoSync)}
                  onClick={() => toggleAutoSync(f.path)}
                  title={f.autoSync ? 'Auto-sync on' : 'Auto-sync off'}
                />
                <button style={s.btn} onClick={() => removeFolder(f.path)}>Remove</button>
              </div>
            ))}
            <button style={s.addBtn} onClick={addFolder}>+ Add Folder</button>
          </>
        )}

        {activeSection === 'usb' && (
          <>
            {usbDevices.length === 0 && (
              <div style={s.empty}>No Pioneer USB drives detected. Insert a formatted USB drive.</div>
            )}
            {usbDevices.map(d => (
              <div key={d.mountPoint} style={s.row}>
                <span style={s.badge('#3b82f6')}>USB</span>
                <span style={s.path} title={d.mountPoint}>{d.name}</span>
                <span style={{ ...s.badge(statusColor(d.status)), fontSize: 10 }}>{d.status}</span>
                <button
                  style={{ ...s.btn, borderColor: '#3b82f6', color: '#3b82f6' }}
                  onClick={() => syncUsb(d)}
                  disabled={d.status === 'syncing'}
                >
                  {d.status === 'syncing' ? 'Syncing...' : 'Sync Now'}
                </button>
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
