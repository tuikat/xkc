import { useState, useEffect } from 'react'
import Setup from './Setup'
import MainLayout from './MainLayout'

export default function App() {
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const url = localStorage.getItem('xkc_server_url')
    const token = localStorage.getItem('xkc_access_token')
    setServerUrl(url)
    setAccessToken(token)
    setLoading(false)
  }, [])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#737373', fontSize: 14 }}>
      Loading...
    </div>
  )

  if (!serverUrl || !accessToken) return (
    <Setup onComplete={(url, token) => {
      localStorage.setItem('xkc_server_url', url)
      setServerUrl(url)
      setAccessToken(token)
    }} />
  )

  return (
    <MainLayout
      serverUrl={serverUrl}
      accessToken={accessToken}
      onDisconnect={() => {
        localStorage.removeItem('xkc_server_url')
        localStorage.removeItem('xkc_access_token')
        localStorage.removeItem('xkc_refresh_token')
        setServerUrl(null)
        setAccessToken(null)
      }}
    />
  )
}
