import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { User } from '../lib/api'
import { ArrowLeft, Plus, UserX } from 'lucide-react'
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
  const [adding, setAdding] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', password: '', email: '', is_admin: false })

  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: api.users.getUsers })

  const createUser = useMutation({
    mutationFn: () => api.users.createUser(newUser),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setAdding(false); setNewUser({ username: '', password: '', email: '', is_admin: false }) },
  })

  const updateUser = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<User> }) => api.users.updateUser(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  function togglePermission(user: User, perm: string, val: boolean) {
    updateUser.mutate({ id: user.id, data: { permissions: { ...user.permissions, [perm]: val } } })
  }

  return (
    <div className="min-h-screen bg-xkc-bg flex flex-col">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-xkc-border bg-xkc-surface">
        <button onClick={() => navigate('/')} className="text-xkc-muted hover:text-xkc-text"><ArrowLeft size={18} /></button>
        <div className="font-medium text-xkc-text">User Management</div>
        <div className="ml-auto">
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-xkc-accent text-white hover:bg-blue-600"
          >
            <Plus size={12} /> New User
          </button>
        </div>
      </header>

      <div className="p-6 max-w-5xl">
        {/* Create user form */}
        {adding && (
          <div className="bg-xkc-surface border border-xkc-border rounded-xl p-4 mb-6 space-y-3">
            <div className="text-sm font-medium text-xkc-text mb-2">Create User</div>
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

        {/* Users table */}
        <div className="space-y-3">
          {(users as User[]).map((user) => (
            <div key={user.id} className="bg-xkc-surface border border-xkc-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-xkc-text">{user.username}</span>
                    {user.is_admin && (
                      <span className="text-xs px-1.5 py-0.5 bg-xkc-accent/20 text-xkc-accent rounded">admin</span>
                    )}
                    {!user.is_active && (
                      <span className="text-xs px-1.5 py-0.5 bg-red-900/30 text-red-400 rounded">inactive</span>
                    )}
                  </div>
                  {user.email && <div className="text-xs text-xkc-muted mt-0.5">{user.email}</div>}
                </div>
                {!user.is_admin && (
                  <button
                    onClick={() => updateUser.mutate({ id: user.id, data: { is_active: !user.is_active } })}
                    className="flex items-center gap-1 text-xs text-xkc-muted hover:text-red-400"
                  >
                    <UserX size={12} />
                    {user.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                )}
              </div>

              {!user.is_admin && (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(PERMISSION_LABELS).map(([perm, label]) => (
                    <label
                      key={perm}
                      className={cn(
                        'flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg border cursor-pointer transition-colors',
                        user.permissions?.[perm]
                          ? 'border-xkc-accent/50 bg-xkc-accent/10 text-xkc-accent'
                          : 'border-xkc-border text-xkc-muted'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={!!user.permissions?.[perm]}
                        onChange={(e) => togglePermission(user, perm, e.target.checked)}
                        className="sr-only"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
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
