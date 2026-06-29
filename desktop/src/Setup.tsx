import { useState } from 'react'

interface Props {
  onComplete: (serverUrl: string) => void
}

export default function Setup({ onComplete }: Props) {
  const [step, setStep] = useState<'url' | 'login'>('url')
  const [serverUrl, setServerUrl] = useState('http://localhost:3001')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)

  const testConnection = async () => {
    setTesting(true)
    setError('')
    try {
      const url = serverUrl.replace(/\/$/, '')
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) })
      if (res.ok) {
        setStep('login')
      } else {
        setError(`Server responded with ${res.status}`)
      }
    } catch (e: any) {
      setError(`Cannot reach server: ${e.message}`)
    } finally {
      setTesting(false)
    }
  }

  const login = async () => {
    setLoggingIn(true)
    setError('')
    try {
      const url = serverUrl.replace(/\/$/, '')
      const res = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password, device_label: 'XKC Desktop' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Login failed')
      if (data.refresh_token) {
        localStorage.setItem('xkc_refresh_token', data.refresh_token)
      }
      onComplete(url)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoggingIn(false)
    }
  }

  const s: Record<string, React.CSSProperties> = {
    wrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0f0f0f' },
    card: { background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 12, padding: 40, width: 420 },
    logo: { fontSize: 28, fontWeight: 700, color: '#3b82f6', letterSpacing: -1, marginBottom: 8 },
    sub: { color: '#737373', fontSize: 13, marginBottom: 32 },
    label: { display: 'block', fontSize: 12, color: '#a3a3a3', marginBottom: 6, fontWeight: 500 },
    input: { width: '100%', background: '#0f0f0f', border: '1px solid #2a2a2a', borderRadius: 6, padding: '10px 12px', color: '#e5e5e5', fontSize: 14, outline: 'none', marginBottom: 16 },
    btn: { width: '100%', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, padding: '11px 0', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
    btnGhost: { width: '100%', background: 'transparent', color: '#737373', border: '1px solid #2a2a2a', borderRadius: 6, padding: '10px 0', fontSize: 13, cursor: 'pointer', marginBottom: 12 },
    err: { background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 6, padding: '10px 12px', color: '#fca5a5', fontSize: 13, marginBottom: 16 },
    back: { background: 'none', border: 'none', color: '#737373', cursor: 'pointer', fontSize: 13, marginBottom: 20 },
  }

  return (
    <div style={s.wrap}>
      <div style={s.card}>
        <div style={s.logo}>XKC</div>
        <div style={s.sub}>DJ Library Manager</div>

        {step === 'url' && (
          <>
            <label style={s.label}>Server URL</label>
            <input
              style={s.input}
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              placeholder="http://192.168.1.10:3001"
              onKeyDown={e => e.key === 'Enter' && testConnection()}
            />
            {error && <div style={s.err}>{error}</div>}
            <button style={s.btn} onClick={testConnection} disabled={testing}>
              {testing ? 'Connecting...' : 'Connect to Server'}
            </button>
          </>
        )}

        {step === 'login' && (
          <>
            <button style={s.back} onClick={() => { setStep('url'); setError('') }}>
              ← {serverUrl}
            </button>
            <label style={s.label}>Username</label>
            <input
              style={s.input}
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
            />
            <label style={s.label}>Password</label>
            <input
              style={s.input}
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && login()}
              autoComplete="current-password"
            />
            {error && <div style={s.err}>{error}</div>}
            <button style={s.btn} onClick={login} disabled={loggingIn}>
              {loggingIn ? 'Signing in...' : 'Sign In'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
