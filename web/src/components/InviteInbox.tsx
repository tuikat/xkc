import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { hexColor } from '../lib/utils'
import { Bell, Check, X } from 'lucide-react'
import { cn } from '../lib/utils'

export default function InviteInbox() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  const { data: invites = [] } = useQuery({
    queryKey: ['social', 'invites'],
    queryFn: api.social.getInvites,
    refetchInterval: 30_000,
  })

  const respond = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'accepted' | 'denied' }) =>
      api.social.respondToInvite(id, status),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['social', 'invites'] })
      qc.invalidateQueries({ queryKey: ['playlists'] })
    },
  })

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={cn(
          'relative p-1.5 rounded-lg transition-colors',
          open ? 'bg-xkc-accent/20 text-xkc-accent' : 'text-xkc-muted hover:text-xkc-text hover:bg-xkc-border/50'
        )}
        title="Share invites"
      >
        <Bell size={16} />
        {invites.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
            {invites.length}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 bg-xkc-surface border border-xkc-border rounded-xl shadow-2xl w-80 z-50 overflow-hidden">
            <div className="px-3 py-2 border-b border-xkc-border text-xs font-medium text-xkc-muted uppercase tracking-wider">
              Playlist invites
            </div>
            {invites.length === 0 ? (
              <div className="px-3 py-6 text-xs text-xkc-muted text-center">No pending invites</div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {invites.map(inv => (
                  <div key={inv.id} className="p-3 border-b border-xkc-border/50 last:border-0">
                    <div className="flex items-center gap-2 mb-1">
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                        style={{ backgroundColor: hexColor(inv.from_avatar_color ?? 0x4A90D9) }}>
                        {(inv.from_username ?? '?')[0].toUpperCase()}
                      </div>
                      <span className="text-xs text-xkc-text">
                        <strong>{inv.from_username}</strong> shared a playlist with you
                      </span>
                    </div>
                    <div className="text-sm font-medium text-xkc-text mb-1 ml-8">
                      {inv.playlist_name}
                    </div>
                    {inv.message && (
                      <div className="text-xs text-xkc-muted italic ml-8 mb-2">"{inv.message}"</div>
                    )}
                    <div className="flex gap-2 ml-8">
                      <button
                        onClick={() => respond.mutate({ id: inv.id, status: 'accepted' })}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30">
                        <Check size={11} /> Accept
                      </button>
                      <button
                        onClick={() => respond.mutate({ id: inv.id, status: 'denied' })}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20">
                        <X size={11} /> Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
