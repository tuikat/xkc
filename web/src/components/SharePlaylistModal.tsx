import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { hexColor } from '../lib/utils'
import { X, Send, Check } from 'lucide-react'
import { cn } from '../lib/utils'

interface Props {
  playlistId: string
  playlistName: string
  onClose: () => void
}

export default function SharePlaylistModal({ playlistId, playlistName, onClose }: Props) {
  const qc = useQueryClient()
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState<Set<string>>(new Set())

  const { data: users = [] } = useQuery({
    queryKey: ['social', 'users'],
    queryFn: api.social.getUsers,
  })

  const { data: sentInvites = [] } = useQuery({
    queryKey: ['social', 'invites', 'sent'],
    queryFn: api.social.getSentInvites,
  })

  const alreadySharedWith = new Set(
    sentInvites
      .filter(i => i.playlist_id === playlistId && i.status !== 'denied')
      .map(i => i.to_user_id)
  )

  const sendInvite = useMutation({
    mutationFn: (toUserId: string) =>
      api.social.sendInvite({ playlist_id: playlistId, to_user_id: toUserId, message: message || undefined }),
    onSuccess: (_, toUserId) => {
      setSent(prev => new Set([...prev, toUserId]))
      qc.invalidateQueries({ queryKey: ['social', 'invites', 'sent'] })
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-xkc-surface border border-xkc-border rounded-xl shadow-2xl w-96 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-xkc-border">
          <div>
            <div className="text-sm font-medium text-xkc-text">Share playlist</div>
            <div className="text-xs text-xkc-muted truncate max-w-[280px]">{playlistName}</div>
          </div>
          <button onClick={onClose} className="text-xkc-muted hover:text-xkc-text"><X size={16} /></button>
        </div>

        <div className="p-3 border-b border-xkc-border">
          <input
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder="Optional message…"
            className="w-full bg-xkc-bg border border-xkc-border rounded px-2 py-1.5 text-xs text-xkc-text focus:outline-none focus:border-xkc-accent"
          />
        </div>

        <div className="overflow-y-auto flex-1 p-2">
          {users.length === 0 && (
            <div className="text-xs text-xkc-muted text-center py-6">No other users on this server</div>
          )}
          {users.map(u => {
            const isShared = alreadySharedWith.has(u.id)
            const justSent = sent.has(u.id)
            return (
              <div key={u.id}
                className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-xkc-bg">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
                  style={{ backgroundColor: hexColor(u.avatar_color) }}>
                  {u.username[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-xkc-text">{u.username}</div>
                  {u.bio && <div className="text-xs text-xkc-muted truncate">{u.bio}</div>}
                </div>
                {isShared || justSent ? (
                  <span className="flex items-center gap-1 text-xs text-green-400">
                    <Check size={12} /> {justSent ? 'Sent' : 'Shared'}
                  </span>
                ) : (
                  <button
                    onClick={() => sendInvite.mutate(u.id)}
                    disabled={sendInvite.isPending}
                    className={cn(
                      'flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
                      'bg-xkc-accent/20 text-xkc-accent hover:bg-xkc-accent/30 border border-xkc-accent/40'
                    )}>
                    <Send size={11} /> Invite
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
