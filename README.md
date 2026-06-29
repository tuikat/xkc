# XKC

DJ library management system. Self-hosted, Pioneer CDJ-compatible, Spotify/SoundCloud sync.

## What it is

- **Server** — Docker container with a web UI. Upload, tag, and organise your tracks. Sync from Spotify/SoundCloud playlists. Export USB-ready Pioneer format (export.pdb + ANLZ) compatible with CDJ-2000NXS, CDJ-3000, XDJ-RX3, XDJ-XZ.
- **Desktop App** — macOS/Windows/Linux app. Watches folders, auto-syncs USB drives when inserted, shows the full web UI.

## Quick Start (Server)

**1. Generate a secret key:**
```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

**2. Create a `.env` file:**
```bash
cp .env.example .env
# Edit .env — set XKC_SECRET_KEY, XKC_ADMIN_PASSWORD, XKC_PUBLIC_URL
```

**3. Run:**
```bash
docker compose up -d
```

Server is at `http://localhost:3001`. Default login: `admin` / `changeme` (change immediately).

## Using the Docker image from GitHub

```bash
docker run -d \
  --name xkc-server \
  --network host \
  -v xkc_data:/data \
  -e XKC_SECRET_KEY=your-key \
  -e XKC_ADMIN_PASSWORD=yourpassword \
  -e XKC_PUBLIC_URL=https://yourdomain.com \
  ghcr.io/tuikat/xkc-server:latest
```

## Domain / HTTPS

Put XKC behind Caddy (easiest):

```
yourdomain.com {
    reverse_proxy localhost:3001
}
```

Set `XKC_PUBLIC_URL=https://yourdomain.com` in your `.env` before starting.

## Desktop App

Download the latest installer from [Releases](../../releases):
- macOS: `.dmg` (Apple Silicon or Intel)
- Windows: `-setup.exe`
- Linux: `.AppImage`

On first launch, enter your server URL and credentials.

## Streaming Sync (Spotify / SoundCloud)

In the web UI: **Settings → Streaming → Add Source**

- **Spotify**: Paste any public playlist URL. For liked tracks, connect your Spotify account.
- **SoundCloud**: Paste a public playlist or profile URL.
- Set sync to `Master Library` (just adds tracks) or `Mirror Playlist` (creates a matching playlist).
- Auto-sync runs on your chosen schedule; manual sync available any time.

> Note: Audio is sourced via YouTube Music (Spotify) or direct SoundCloud download (yt-dlp). Respects creator availability.

## Rekordbox Import

**Settings → Import → Rekordbox XML**

In Rekordbox: File → Export Collection in xml format → upload the file here. Imports tracks (matched by file path), cues, beat grids, and playlists.

## Pioneer USB Export

Select playlists → **Export → Pioneer USB Format** → download zip.

The zip contains the full `/PIONEER/` directory structure:
- `rekordbox/export.pdb` — track database (DeviceSQL format)
- `USBANLZ/` — per-track beat grids and waveforms

Unzip to the root of your USB drive. Works on CDJ-2000NXS, CDJ-2000NXS2, CDJ-3000, XDJ-RX3, XDJ-XZ, and similar.

> Device Library Plus (for OPUS-QUAD, XDJ-AZ, CDJ-3000X) is not yet supported; those devices fall back to the legacy format above.

## Multi-User

Admin can create users and set granular permissions: upload, delete, edit metadata, manage playlists, export, streaming sync, etc.

## Configuration

All settings via environment variables (prefix `XKC_`):

| Variable | Default | Description |
|---|---|---|
| `XKC_SECRET_KEY` | — | **Required.** JWT signing key |
| `XKC_ADMIN_USERNAME` | `admin` | Bootstrap admin username |
| `XKC_ADMIN_PASSWORD` | `changeme` | Bootstrap admin password |
| `XKC_PUBLIC_URL` | `http://localhost:3001` | Public-facing URL |
| `XKC_DATA_DIR` | `/data` | Data directory |
| `XKC_MAX_UPLOAD_MB` | `500` | Max upload file size |
| `XKC_ANALYSIS_WORKERS` | `2` | Analysis thread pool size |
| `XKC_SPOTIFY_CLIENT_ID` | — | Spotify API (liked tracks) |
| `XKC_SPOTIFY_CLIENT_SECRET` | — | Spotify API |

Export your full config from **Settings → Export Config**.

## Development

```bash
# Backend
cd server && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 3001

# Frontend
cd web && npm install && npm run dev   # http://localhost:5173

# Desktop
cd desktop && npm install
npm run tauri dev
```

## Release Process

Tag a commit to trigger releases:
```bash
git tag v1.0.0 && git push origin v1.0.0
```

This triggers:
- GitHub Actions builds Docker image → pushes to `ghcr.io/tuikat/xkc-server:v1.0.0`
- Tauri builds desktop apps for macOS (Intel + Apple Silicon), Windows, Linux → attached to GitHub Release

## Compatibility

| Hardware | Format | Status |
|---|---|---|
| CDJ-2000NXS, NXS2 | export.pdb | ✅ |
| CDJ-3000 | export.pdb | ✅ |
| XDJ-RX3, XDJ-XZ | export.pdb | ✅ |
| OPUS-QUAD, XDJ-AZ | Device Library Plus | ⏳ V2 |
| CDJ-3000X | Device Library Plus | ⏳ V2 |
