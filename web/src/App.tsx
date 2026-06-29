import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './lib/api'
import { useStore } from './lib/store'
import Login from './pages/Login'
import Library from './pages/Library'
import Settings from './pages/Settings'
import Users from './pages/Users'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading, isError } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.auth.getMe(),
    retry: false,
  })
  const setUser = useStore((s) => s.setUser)

  useEffect(() => {
    if (user) setUser(user)
  }, [user, setUser])

  if (isLoading) {
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
              </Routes>
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}
