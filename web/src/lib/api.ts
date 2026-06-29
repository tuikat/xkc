// XKC API client

export interface User {
  id: string
  username: string
  email: string | null
  is_admin: boolean
  is_active: boolean
  permissions: Record<string, boolean>
  created_at: string
  last_login: string | null
}

export interface Track {
  id: string
  title: string | null
  artist: string | null
  album: string | null
  album_artist: string | null
  genre: string | null
  label: string | null
  remixer: string | null
  year: number | null
  bpm: number | null
  key_camelot: string | null
  key_musical: string | null
  duration_ms: number | null
  bitrate: number | null
  file_format: string | null
  rating: number
  play_count: number
  color: number
  analysis_state: string
  source_type: string | null
  date_added: string
  artwork_path: string | null
  comment: string | null
  tag_ids?: string[]
  cues?: Cue[]
}

export interface Cue {
  id: string
  position_ms: number
  type: string
  color: number
  label: string | null
  loop_length_ms: number | null
  sort_order: number
}

export interface TagGroup {
  id: string
  name: string
  sort_order: number
  tags: Tag[]
}

export interface Tag {
  id: string
  group_id: string
  name: string
  color: number
  sort_order: number
}

export interface Playlist {
  id: string
  name: string
  owner_id: string
  parent_id: string | null
  is_smart: boolean
  smart_rules: unknown
  is_shared: boolean
  sort_order: number
  cover_color: number
  created_at: string
  track_count: number
}

export interface StreamSource {
  id: string
  service: string
  display_name: string
  source_type: string
  source_url: string
  sync_mode: string
  auto_sync: boolean
  sync_interval_hours: number
  last_synced_at: string | null
  mirror_playlist_id: string | null
  created_at: string
  download_quality?: string
}

export interface SyncLog {
  id: string
  source_id: string
  source_name: string | null
  status: 'running' | 'complete' | 'failed'
  tracks_found: number
  tracks_downloaded: number
  tracks_skipped: number
  error: string | null
  started_at: string | null
  completed_at: string | null
}

export interface TrackParams {
  q?: string
  playlist_id?: string
  tag_ids?: string
  genre?: string
  artist?: string
  min_bpm?: number
  max_bpm?: number
  key_camelot?: string
  analysis_state?: string
  sort_by?: string
  limit?: number
  offset?: number
}

const BASE = ''

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { ...headers, ...(options.headers as Record<string, string> | undefined) },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error((err as { detail?: string }).detail || 'Request failed')
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

function buildQuery(params: Record<string, unknown>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.append(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const api = {
  auth: {
    login: (username: string, password: string, deviceLabel?: string) =>
      req<{ access_token: string; refresh_token: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, device_label: deviceLabel }),
      }),
    logout: () => req<void>('/api/auth/logout', { method: 'POST' }),
    getMe: () => req<User>('/api/auth/me'),
    refresh: (refresh_token: string) =>
      req<{ access_token: string; refresh_token: string }>('/api/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refresh_token }),
      }),
  },

  tracks: {
    getTracks: (params: TrackParams = {}) =>
      req<Track[]>(`/api/tracks/${buildQuery(params as Record<string, unknown>)}`),
    getTrack: (id: string) => req<Track>(`/api/tracks/${id}`),
    updateTrack: (id: string, data: Partial<Track>) =>
      req<Track>(`/api/tracks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteTrack: (id: string) => req<void>(`/api/tracks/${id}`, { method: 'DELETE' }),
    addCue: (id: string, data: Partial<Cue>) =>
      req<Cue>(`/api/tracks/${id}/cues`, { method: 'POST', body: JSON.stringify(data) }),
    updateCue: (trackId: string, cueId: string, data: Partial<Cue>) =>
      req<Cue>(`/api/tracks/${trackId}/cues/${cueId}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteCue: (trackId: string, cueId: string) =>
      req<void>(`/api/tracks/${trackId}/cues/${cueId}`, { method: 'DELETE' }),
    setTrackTags: (id: string, tagIds: string[]) =>
      req<void>(`/api/tracks/${id}/tags`, { method: 'POST', body: JSON.stringify({ tag_ids: tagIds }) }),
    reanalyze: (id: string) =>
      req<void>(`/api/tracks/${id}/reanalyze`, { method: 'POST' }),
    getGenres: () => req<string[]>('/api/tracks/genres'),
    updateBeats: (id: string, data: { offset_ms?: number; beat_positions_ms?: number[] }) =>
      req<{ beat_positions_ms: number[] }>(`/api/tracks/${id}/beats`, { method: 'PATCH', body: JSON.stringify(data) }),
    getStreamUrl: (id: string) => `/api/tracks/${id}/stream`,
    getWaveform: (id: string) =>
      req<{ overview: number[]; detail: number[]; beat_times_ms: number[] }>(`/api/tracks/${id}/waveform`),
    uploadTrack: (file: File, onProgress?: (pct: number) => void): Promise<Track> => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        const form = new FormData()
        form.append('file', file)
        xhr.withCredentials = true
        xhr.open('POST', '/api/tracks/upload')
        if (onProgress) {
          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
          })
        }
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)) }
            catch { reject(new Error('Invalid response')) }
          } else {
            try {
              const err = JSON.parse(xhr.responseText)
              reject(new Error(err.detail || 'Upload failed'))
            } catch { reject(new Error('Upload failed')) }
          }
        })
        xhr.addEventListener('error', () => reject(new Error('Network error')))
        xhr.send(form)
      })
    },
  },

  playlists: {
    getPlaylists: () => req<Playlist[]>('/api/playlists/'),
    createPlaylist: (data: { name: string; parent_id?: string; cover_color?: number }) =>
      req<Playlist>('/api/playlists/', { method: 'POST', body: JSON.stringify(data) }),
    updatePlaylist: (id: string, data: Partial<Playlist>) =>
      req<Playlist>(`/api/playlists/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deletePlaylist: (id: string) => req<void>(`/api/playlists/${id}`, { method: 'DELETE' }),
    addTracks: (id: string, trackIds: string[]) =>
      req<void>(`/api/playlists/${id}/tracks`, { method: 'POST', body: JSON.stringify({ track_ids: trackIds }) }),
    removeTrack: (id: string, trackId: string) =>
      req<void>(`/api/playlists/${id}/tracks/${trackId}`, { method: 'DELETE' }),
    getPlaylistTracks: (id: string) => req<Track[]>(`/api/playlists/${id}/tracks`),
  },

  tags: {
    getTagGroups: () => req<TagGroup[]>('/api/tags/'),
    createGroup: (data: { name: string }) =>
      req<TagGroup>('/api/tags/groups/', { method: 'POST', body: JSON.stringify(data) }),
    updateGroup: (id: string, data: { name: string }) =>
      req<TagGroup>(`/api/tags/groups/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteGroup: (id: string) => req<void>(`/api/tags/groups/${id}`, { method: 'DELETE' }),
    createTag: (data: { group_id: string; name: string; color?: number }) =>
      req<Tag>('/api/tags', { method: 'POST', body: JSON.stringify(data) }),
    updateTag: (id: string, data: Partial<Tag>) =>
      req<Tag>(`/api/tags/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteTag: (id: string) => req<void>(`/api/tags/${id}`, { method: 'DELETE' }),
  },

  users: {
    getUsers: () => req<User[]>('/api/users/'),
    createUser: (data: { username: string; password: string; email?: string; is_admin?: boolean }) =>
      req<User>('/api/users/', { method: 'POST', body: JSON.stringify(data) }),
    updateUser: (id: string, data: Partial<User> & { password?: string }) =>
      req<User>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteUser: (id: string) =>
      req<void>(`/api/users/${id}`, { method: 'DELETE' }),
  },

  streamSources: {
    getSources: () => req<StreamSource[]>('/api/stream-sources/'),
    createSource: (data: {
      service: string
      display_name: string
      source_type: string
      source_url: string
      sync_mode?: string
      auto_sync?: boolean
    }) => req<StreamSource>('/api/stream-sources/', { method: 'POST', body: JSON.stringify(data) }),
    updateSource: (id: string, data: Partial<StreamSource>) =>
      req<StreamSource>(`/api/stream-sources/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteSource: (id: string) => req<void>(`/api/stream-sources/${id}`, { method: 'DELETE' }),
    syncSource: (id: string) =>
      req<{ log_id: string; status: string; source_name: string }>(`/api/stream-sources/${id}/sync`, { method: 'POST' }),
    getSyncLog: (logId: string) =>
      req<SyncLog>(`/api/stream-sources/logs/${logId}`),
    getActiveSyncs: () =>
      req<SyncLog[]>('/api/stream-sources/active-syncs'),
  },

  export: {
    requestExport: (playlistIds: string[], format: string) =>
      req<{ job_id: string }>('/api/export', {
        method: 'POST',
        body: JSON.stringify({ playlist_ids: playlistIds, format }),
      }),
    getExportStatus: (jobId: string) =>
      req<{ status: string; progress: number; download_url?: string }>(`/api/export/${jobId}`),
  },

  settings: {
    get: () => req<Record<string, unknown>>('/api/settings/'),
    update: (data: Record<string, unknown>) =>
      req<Record<string, unknown>>('/api/settings/', { method: 'PATCH', body: JSON.stringify(data) }),
    exportConfig: () => fetch('/api/settings/export/', { credentials: 'include' }),
  },

  import: {
    uploadRekordbox: (file: File) => {
      const form = new FormData()
      form.append('file', file)
      return req<{ import_id: string; track_count: number; playlist_count: number; playlists: string[] }>(
        '/api/import/rekordbox',
        { method: 'POST', body: form }
      )
    },
    confirmRekordbox: (importId: string, data: { import_all: boolean; playlist_prefix?: string }) =>
      req<{ status: string }>(`/api/import/rekordbox/${importId}/confirm`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
}
