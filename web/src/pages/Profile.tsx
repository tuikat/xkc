import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { hexColor, formatDuration } from '../lib/utils'
import { ArrowLeft, Download, Globe, Lock, Edit2, Check, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { cn } from '../lib/utils'

export default function Profile() {
  const { username } = useParams<{ username: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user } = useStore()
  const isOwnProfile = user?.username === username

  const [editingBio, setEditingBio] = useState(false)
  const [bioText, setBioText] = useState('')

  const { data: profile, isLoading } = useQuery({
    queryKey: ['profile', username],
    queryFn: () => api.social.getProfile(username!),
    enabled: !!username,
  })

  const updateProfile = useMutation({
    mutationFn: (data: { bio?: string }) => api.social.updateProfile(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile', username] })
      setEditingBio(false)
    },
  })

  const setVisibility = useMutation({
    mutationFn: ({ id, vis }: { id: string; vis: 'private' | 'public' }) =>
      api.social.setVisibility(id, vis),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile', username] }),
  })

  const exportPlaylist = async (playlistId: string) => {
    const job = await api.export.requestExport([playlistId], 'csv')
    const poll = setInterval(async () => {
      const st = await api.export.getExportStatus(job.job_id)
      if (st.download_url) {
        clearInterval(poll)
        window.open(st.download_url, '_blank')
      }
    }, 1500)
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-xkc-bg flex items-center justify-center text-xkc-muted text-sm">
        Loading…
      </div>
    )
  }

  if (!profile) {
    return (
      <div className="min-h-screen bg-xkc-bg flex flex-col items-center justify-center gap-3">
        <div className="text-xkc-muted">User not found</div>
        <button onClick={() => navigate(-1)} className="text-xkc-accent text-sm hover:underline">Go back</button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-xkc-bg text-xkc-text">
      {/* Header */}
      <div className="border-b border-xkc-border bg-xkc-surface px-6 py-4 flex items-center gap-4">
        <button onClick={() => navigate(-1)} className="text-xkc-muted hover:text-xkc-text">
          <ArrowLeft size={18} />
        </button>
        <div className="text-sm font-medium">Profile</div>
      </div>

      <div className="max-w-2xl mx-auto px-6 py-8">
        {/* Avatar + name */}
        <div className="flex items-center gap-5 mb-8">
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center text-white text-3xl font-bold flex-shrink-0"
            style={{ backgroundColor: hexColor(profile.avatar_color) }}>
            {profile.username[0].toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-xkc-text">{profile.username}</h1>
            {editingBio ? (
              <div className="flex items-center gap-2 mt-1">
                <input
                  autoFocus
                  value={bioText}
                  onChange={e => setBioText(e.target.value)}
                  className="flex-1 bg-xkc-bg border border-xkc-accent rounded px-2 py-1 text-sm text-xkc-text focus:outline-none"
                  placeholder="Write a short bio…"
                  maxLength={200}
                />
                <button onClick={() => updateProfile.mutate({ bio: bioText })}
                  className="text-green-400 hover:text-green-300"><Check size={16} /></button>
                <button onClick={() => setEditingBio(false)}
                  className="text-xkc-muted hover:text-xkc-text"><X size={16} /></button>
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-1">
                <p className="text-sm text-xkc-muted">{profile.bio || (isOwnProfile ? 'No bio yet' : '')}</p>
                {isOwnProfile && (
                  <button onClick={() => { setBioText(profile.bio ?? ''); setEditingBio(true) }}
                    className="text-xkc-muted hover:text-xkc-text"><Edit2 size={13} /></button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Playlists */}
        <h2 className="text-xs text-xkc-muted uppercase tracking-wider mb-3">
          {isOwnProfile ? 'Your playlists' : `${profile.username}'s playlists`}
        </h2>

        {profile.playlists.length === 0 && (
          <div className="text-sm text-xkc-muted py-8 text-center">
            {isOwnProfile ? 'Make a playlist public to show it here.' : 'No public playlists.'}
          </div>
        )}

        <div className="space-y-2">
          {profile.playlists.map(pl => (
            <div key={pl.id}
              className="flex items-center gap-3 p-3 rounded-xl bg-xkc-surface border border-xkc-border hover:border-xkc-accent/40 transition-colors group">
              <div
                className="w-10 h-10 rounded-lg flex-shrink-0"
                style={{ backgroundColor: hexColor(pl.cover_color) }} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-xkc-text truncate">{pl.name}</div>
                <div className="text-xs text-xkc-muted">{pl.track_count} tracks</div>
              </div>
              <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                {isOwnProfile && (
                  <button
                    onClick={() => setVisibility.mutate({
                      id: pl.id,
                      vis: pl.visibility === 'public' ? 'private' : 'public',
                    })}
                    className={cn(
                      'flex items-center gap-1 px-2 py-1 rounded text-xs border transition-colors',
                      pl.visibility === 'public'
                        ? 'bg-xkc-accent/20 text-xkc-accent border-xkc-accent/40'
                        : 'text-xkc-muted border-xkc-border hover:text-xkc-accent hover:border-xkc-accent/40'
                    )}
                    title={pl.visibility === 'public' ? 'Make private' : 'Make public'}
                  >
                    {pl.visibility === 'public' ? <Globe size={11} /> : <Lock size={11} />}
                    {pl.visibility === 'public' ? 'Public' : 'Private'}
                  </button>
                )}
                <button
                  onClick={() => exportPlaylist(pl.id)}
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs text-xkc-muted border border-xkc-border hover:text-xkc-accent hover:border-xkc-accent/40 transition-colors"
                  title="Export playlist">
                  <Download size={11} /> Export
                </button>
              </div>
              {pl.visibility === 'public' && !isOwnProfile && (
                <span title="Public playlist"><Globe size={13} className="text-xkc-accent flex-shrink-0" /></span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
