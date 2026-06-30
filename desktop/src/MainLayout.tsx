import LocalPanel from './LocalPanel'

interface Props {
  serverUrl: string
  accessToken: string
  onDisconnect: () => void
}

const HEADER_H = 36
const PANEL_H = 200

export default function MainLayout({ serverUrl, accessToken, onDisconnect }: Props) {
  const s: Record<string, React.CSSProperties> = {
    root: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f0f0f', overflow: 'hidden' },
    header: {
      height: HEADER_H, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 16px', background: '#111', borderBottom: '1px solid #1f1f1f', flexShrink: 0,
    },
    logo: { fontWeight: 700, fontSize: 15, color: '#3b82f6', letterSpacing: -0.5 },
    serverLabel: { color: '#525252', fontSize: 12, marginLeft: 12 },
    disconnectBtn: {
      background: 'none', border: '1px solid #2a2a2a', color: '#737373', borderRadius: 5,
      padding: '3px 10px', fontSize: 12, cursor: 'pointer',
    },
    webviewWrap: { flex: 1, overflow: 'hidden' },
    iframe: { width: '100%', height: '100%', border: 'none', display: 'block' },
    panelWrap: { height: PANEL_H, flexShrink: 0, borderTop: '1px solid #1f1f1f' },
  }

  // Load the web app with desktop_token param; the SPA fetches /api/auth/desktop-init
  // (same-origin) to set the auth cookie, bypassing WKWebView third-party cookie blocking.
  const iframeSrc = `${serverUrl}/?desktop_token=${encodeURIComponent(accessToken)}`

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={s.logo}>XKC</span>
          <span style={s.serverLabel}>{serverUrl}</span>
        </div>
        <button style={s.disconnectBtn} onClick={onDisconnect}>Disconnect</button>
      </div>

      <div style={s.webviewWrap}>
        <iframe
          src={iframeSrc}
          style={s.iframe}
          allow="clipboard-read; clipboard-write"
          title="XKC Library"
        />
      </div>

      <div style={s.panelWrap}>
        <LocalPanel serverUrl={serverUrl} />
      </div>
    </div>
  )
}
