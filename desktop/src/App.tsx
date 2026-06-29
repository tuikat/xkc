import { useState, useEffect } from 'react'
import Setup from './Setup'
import MainLayout from './MainLayout'

export default function App() {
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const stored = localStorage.getItem('xkc_server_url')
    setServerUrl(stored)
    setLoading(false)
  }, [])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#737373', fontSize: 14 }}>
      Loading...
    </div>
  )

  if (!serverUrl) return (
    <Setup onComplete={(url) => {
      localStorage.setItem('xkc_server_url', url)
      setServerUrl(url)
    }} />
  )

  return (
    <MainLayout
      serverUrl={serverUrl}
      onDisconnect={() => {
        localStorage.removeItem('xkc_server_url')
        localStorage.removeItem('xkc_refresh_token')
        setServerUrl(null)
      }}
    />
  )
}
