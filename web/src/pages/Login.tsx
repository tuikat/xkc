import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await api.auth.login(username, password)
      if (res.refresh_token) {
        localStorage.setItem('xkc_refresh_token', res.refresh_token)
      }
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-xkc-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <div className="text-6xl font-bold tracking-tight text-xkc-text mb-2">XKC</div>
          <div className="text-xkc-muted text-sm">DJ Library</div>
        </div>

        <form onSubmit={handleSubmit} className="bg-xkc-surface border border-xkc-border rounded-xl p-6 space-y-4">
          {error && (
            <div className="text-red-400 text-sm bg-red-950/30 border border-red-900/50 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          <div>
            <label className="block text-xs text-xkc-muted mb-1.5 uppercase tracking-wider">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-xkc-bg border border-xkc-border rounded-lg px-3 py-2.5 text-xkc-text text-sm focus:outline-none focus:border-xkc-accent"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-xs text-xkc-muted mb-1.5 uppercase tracking-wider">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-xkc-bg border border-xkc-border rounded-lg px-3 py-2.5 text-xkc-text text-sm focus:outline-none focus:border-xkc-accent"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-xkc-accent hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors mt-2"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
