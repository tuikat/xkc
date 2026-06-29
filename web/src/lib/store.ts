import { create } from 'zustand'
import type { User } from './api'

interface UploadItem {
  id: string
  file: File
  progress: number
  status: 'pending' | 'uploading' | 'complete' | 'error'
  error?: string
}

interface Filters {
  minBpm?: number
  maxBpm?: number
  keyCamelot?: string
  genre?: string
  tagIds?: string[]
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
}))
