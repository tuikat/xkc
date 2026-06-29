import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import type { User } from '../lib/api'
import { ArrowLeft, Plus, Pencil, Trash2, ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react'
import { cn } from '../lib/utils'

const PERMISSION_LABELS: Record<string, string> = {
  upload: 'Upload',
  delete: 'Delete',
  edit_metadata: 'Edit Metadata',
  manage_playlists: 'Playlists',
  share_playlists: 'Share',
  manage_tags: 'Tags',
  export: 'Export',
  stream_sync: 'Streaming',
  rekordbox_import: 'RB Import',
}

export default function Users() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user: me } = useStore()
  const [adding, setAdding] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', password: '', email: '', is_admin: false })

  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: api.users.getUsers })

  const createUser = useMutation({
    mutationFn: () => api.users.createUser(newUser),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] })
      setAdding(false)
      setNewUser({ username: '', password: '', email: '', is_admin: false })
    },
  })

  return (
    <div className="min-h-screen bg-xkc-bg flex flex-col">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-xkc-border bg-xkc-surface">
        <button onClick={() => navigate('/')} className="text-xkc-muted hover:text-xkc-text"><ArrowLeft size={18} /></button>
        <div className="font-medium text-xkc-text">User Management</div>
        <button
          onClick={() => setAdding(true)}
          className="ml-auto flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-xkc-accent text-white hover:bg-blue-600"
        >
          <Plus size={12} /> New User
        </button>
      </header>

      <div className="p-6 max-w-3xl space-y-3">
        {adding && (
          <div className="bg-xkc-surface border border-xkc-border rounded-xl p-4 space-y-3">
            <div className="text-sm font-medium text-xkc-text">Create User</div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Username</label>
                <input value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} className="input" />
              </div>
              <div>
                <label className="label">Password</label>
                <input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} className="input" />
              </div>
              <div>
                <label className="label">Email (optional)</label>
                <input value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} className="input" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-xkc-text">
              <input type="checkbox" checked={newUser.is_admin} onChange={(e) => setNewUser({ ...newUser, is_admin: e.target.checked })} className="accent-xkc-accent" />
              Admin
            </label>
            <div className="flex gap-2">
              <button onClick={() => createUser.mutate()} disabled={!newUser.username || !newUser.password} className="btn-primary text-xs">Create</button>
              <button onClick={() => setAdding(false)} className="btn-secondary text-xs">Cancel</button>
            </div>
          </div>
        )}

        {(users as User[]).map((user) => (
          <UserCard key={user.id} user={user} me={me} qc={qc} />
        ))}
      </div>

      <style>{`
        .label { display: block; font-size: 11px; color: #737373; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
        .input { width: 100%; background: #0f0f0f; border: 1px solid #2a2a2a; border-radius: 6px; padding: 6px 10px; font-size: 13px; color: #e5e5e5; outline: none; }
        .input:focus { border-color: #3b82f6; }
        .btn-primary { background: #3b82f6; color: white; border-radius: 8px; padding: 6px 14px; font-weight: 500; }
        .btn-primary:hover { background: #2563eb; }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-secondary { background: #1a1a1a; color: #e5e5e5; border: 1px solid #2a2a2a; border-radius: 8px; padding: 6px 14px; }
        .btn-secondary:hover { background: #2a2a2a; }
      `}</style>
    </div>
  )
}

function UserCard({ user, me, qc }: { user: User; me: User | null; qc: ReturnType<typeof useQueryClient> }) {
  const [editOpen, setEditOpen] = useState(false)
  const [draft, setDraft] = useState({ username: user.username, email: user.email || '', password: '' })
  const isSelf = me?.id === user.id

  const updateUser = useMutation({
    mutationFn: (data: Partial<User> & { password?: string }) => api.users.updateUser(user.id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  const saveEdit = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {}
      if (draft.username !== user.username) payload.username = draft.username
      if (draft.email !== (user.email || '')) payload.email = draft.email
      if (draft.password) payload.password = draft.password
      return api.users.updateUser(user.id, payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] })
      setEditOpen(false)
      setDraft({ username: user.username, email: user.email || '', password: '' })
    },
  })

  const deleteUser = useMutation({
    mutationFn: () => api.users.deleteUser(user.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  function togglePermission(perm: string, val: boolean) {
    updateUser.mutate({ permissions: { ...user.permissions, [perm]: val } })
  }

  return (
    <div className={cn('bg-xkc-surface border border-xkc-border rounded-xl p-4', !user.is_active && 'opacity-50')}>
      {/* Header row */}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded-full bg-xkc-accent/20 text-xkc-accent flex items-center justify-center text-sm font-medium flex-shrink-0">
          {user.username[0].toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-xkc-text">{user.username}</span>
            {user.is_admin && (
              <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 bg-xkc-accent/20 text-xkc-accent rounded">
                <ShieldCheck size={10} /> Admin
              </span>
            )}
            {!user.is_active && (
              <span className="text-xs px-1.5 py-0.5 bg-red-900/30 text-red-400 rounded">Inactive</span>
            )}
            {isSelf && (
              <span className="text-xs text-xkc-muted">(you)</span>
            )}
          </div>
          {user.email && <div className="text-xs text-xkc-muted mt-0.5 truncate">{user.email}</div>}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => {
              setDraft({ username: user.username, email: user.email || '', password: '' })
              setEditOpen((v) => !v)
            }}
            className={cn('p-1.5 rounded-lg text-xkc-muted hover:text-xkc-text hover:bg-xkc-border/50 transition-colors', editOpen && 'bg-xkc-border/50 text-xkc-text')}
            title="Edit user"
          >
            {editOpen ? <ChevronUp size={14} /> : <Pencil size={14} />}
          </button>

          {!isSelf && (
            <button
              onClick={() => {
                if (confirm(`${user.is_active ? 'Deactivate' : 'Delete'} user "${user.username}"?`))
                  deleteUser.mutate()
              }}
              className="p-1.5 rounded-lg text-xkc-muted hover:text-red-400 hover:bg-red-900/20 transition-colors"
              title={user.is_active ? 'Deactivate user' : 'Delete user'}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Edit panel */}
      {editOpen && (
        <div className="mb-4 p-3 bg-xkc-bg rounded-lg border border-xkc-border space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Username</label>
              <input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} className="input" />
            </div>
            <div>
              <label className="label">Email</label>
              <input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="optional" className="input" />
            </div>
          </div>
          <div>
            <label className="label">New Password <span className="normal-case text-xkc-muted">(leave blank to keep current)</span></label>
            <input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} placeholder="Min 8 characters" className="input" />
          </div>
          {!user.is_admin && (
            <label className="flex items-center gap-2 text-sm text-xkc-text">
              <input
                type="checkbox"
                checked={false}
                onChange={() => updateUser.mutate({ is_admin: true })}
                className="accent-xkc-accent"
              />
              Promote to Admin
            </label>
          )}
          {user.is_admin && !isSelf && (
            <label className="flex items-center gap-2 text-sm text-xkc-text">
              <input
                type="checkbox"
                checked={true}
                onChange={() => updateUser.mutate({ is_admin: false })}
                className="accent-xkc-accent"
              />
              Admin
            </label>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => saveEdit.mutate()}
              disabled={saveEdit.isPending || (!draft.password && draft.username === user.username && draft.email === (user.email || ''))}
              className="btn-primary text-xs"
            >
              {saveEdit.isPending ? 'Saving…' : 'Save Changes'}
            </button>
            <button onClick={() => setEditOpen(false)} className="btn-secondary text-xs">Cancel</button>
            {!isSelf && (
              <button
                onClick={() => updateUser.mutate({ is_active: !user.is_active })}
                className="ml-auto text-xs text-xkc-muted hover:text-xkc-text"
              >
                {user.is_active ? 'Deactivate' : 'Reactivate'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Permissions (non-admins only) */}
      {!user.is_admin ? (
        <div className="flex flex-wrap gap-2">
          {Object.entries(PERMISSION_LABELS).map(([perm, label]) => (
            <label
              key={perm}
              className={cn(
                'flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg border cursor-pointer transition-colors select-none',
                user.permissions?.[perm]
                  ? 'border-xkc-accent/50 bg-xkc-accent/10 text-xkc-accent'
                  : 'border-xkc-border text-xkc-muted hover:border-xkc-border/80'
              )}
            >
              <input
                type="checkbox"
                checked={!!user.permissions?.[perm]}
                onChange={(e) => togglePermission(perm, e.target.checked)}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </div>
      ) : (
        <div className="text-xs text-xkc-muted flex items-center gap-1.5">
          <ShieldCheck size={11} className="text-xkc-accent" />
          Has all permissions
        </div>
      )}
    </div>
  )
}
