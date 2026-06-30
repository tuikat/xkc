import { create } from 'zustand'
import type { User, Track } from './api'

interface UploadItem {
  id: string
  file: File
  progress: number
  status: 'pending' | 'uploading' | 'complete' | 'error'
  error?: string
}

export type UploadStage =
  | 'preparing'   // about to send; if this lingers, the file may be slow to read (e.g. cloud-synced placeholder)
  | 'uploading'   // bytes in flight, see pct
  | 'saved'       // server has the file, hashed it, queued it for background analysis
  | 'analyzing'   // server is indexing (BPM/key/waveform)
  | 'complete'
  | 'duplicate'
  | 'error'

export interface LogEntry {
  id: string
  name: string
  status: 'uploading' | 'complete' | 'error'
  stage?: UploadStage
  pct?: number
  detail?: string
  ts: number
}

interface Filters {
  minBpm?: number
  maxBpm?: number
  keyCamelot?: string
  genre?: string
  artist?: string
  tagIds?: string[]
  analysis_state?: string
}

interface AppState {
  user: User | null
  setUser: (u: User | null) => void

  selectedPlaylistId: string | null
  setSelectedPlaylistId: (id: string | null) => void

  selectedTrackId: string | null
  setSelectedTrackId: (id: string | null) => void

  searchQuery: string
  setSearchQuery: (q: string) => void

  filters: Filters
  setFilters: (f: Filters) => void

  uploadQueue: UploadItem[]
  addToQueue: (file: File) => string
  updateQueueItem: (id: string, data: Partial<UploadItem>) => void
  removeFromQueue: (id: string) => void
  clearCompleted: () => void

  log: LogEntry[]
  addLog: (entry: LogEntry) => void
  updateLog: (id: string, update: Partial<LogEntry>) => void
  clearLog: () => void

  playerTrack: Track | null
  playerExpanded: boolean
  playerPlaying: boolean
  setPlayerTrack: (track: Track | null) => void
  setPlayerExpanded: (v: boolean) => void
  setPlayerPlaying: (v: boolean) => void
}

export const useStore = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),

  selectedPlaylistId: null,
  setSelectedPlaylistId: (id) => set({ selectedPlaylistId: id }),

  selectedTrackId: null,
  setSelectedTrackId: (id) => set({ selectedTrackId: id }),

  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),

  filters: {},
  setFilters: (filters) => set({ filters }),

  uploadQueue: [],
  addToQueue: (file) => {
    const id = Math.random().toString(36).slice(2)
    set((s) => ({
      uploadQueue: [...s.uploadQueue, { id, file, progress: 0, status: 'pending' }],
    }))
    return id
  },
  updateQueueItem: (id, data) =>
    set((s) => ({
      uploadQueue: s.uploadQueue.map((i) => (i.id === id ? { ...i, ...data } : i)),
    })),
  removeFromQueue: (id) =>
    set((s) => ({ uploadQueue: s.uploadQueue.filter((i) => i.id !== id) })),
  clearCompleted: () =>
    set((s) => ({
      uploadQueue: s.uploadQueue.filter((i) => i.status !== 'complete'),
    })),

  log: [],
  addLog: (entry) =>
    set((s) => ({ log: [entry, ...s.log].slice(0, 200) })),
  updateLog: (id, update) =>
    set((s) => ({ log: s.log.map((e) => (e.id === id ? { ...e, ...update } : e)) })),
  clearLog: () => set({ log: [] }),

  playerTrack: null,
  playerExpanded: false,
  playerPlaying: false,
  setPlayerTrack: (track) => set({ playerTrack: track, playerExpanded: track !== null, playerPlaying: false }),
  setPlayerExpanded: (v) => set({ playerExpanded: v }),
  setPlayerPlaying: (v) => set({ playerPlaying: v }),
}))
