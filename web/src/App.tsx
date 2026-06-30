import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './lib/api'
import { useStore } from './lib/store'
import Login from './pages/Login'
import Library from './pages/Library'
import Settings from './pages/Settings'
import Users from './pages/Users'
import Profile from './pages/Profile'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const [desktopReady, setDesktopReady] = useState(false)
  const qc = useQueryClient()

  // On mount: if ?desktop_token= is in the URL, call /api/auth/desktop-init
  // via a same-origin fetch to set the auth cookie (bypasses WKWebView ITP).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const dt = params.get('desktop_token')
    if (!dt) { setDesktopReady(true); return }

    fetch(`/api/auth/desktop-init?token=${encodeURIComponent(dt)}`, {
      credentials: 'include',
    })
      .catch(() => {})
      .finally(() => {
        const url = new URL(window.location.href)
        url.searchParams.delete('desktop_token')
        window.history.replaceState({}, '', url.pathname + (url.search || ''))
        qc.invalidateQueries({ queryKey: ['me'] })
        setDesktopReady(true)
      })
  }, [qc])

  const { data: user, isLoading, isError } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.auth.getMe(),
    retry: false,
    enabled: desktopReady,
  })
  const setUser = useStore((s) => s.setUser)

  useEffect(() => {
    if (user) setUser(user)
  }, [user, setUser])

  if (!desktopReady || isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-xkc-bg">
        <div className="text-xkc-muted text-sm">Loading...</div>
      </div>
    )
  }
  if (isError) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <Routes>
                <Route path="/" element={<Library />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/users" element={<Users />} />
                <Route path="/profile/:username" element={<Profile />} />
              </Routes>
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}
