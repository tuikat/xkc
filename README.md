<h1>XKC</h1>

<p><strong>Self-hosted DJ music and playlist manager, import direct from Spotify or SoundCloud, collaborate with other DJs, watch folders, and sync a Pioneer-ready USB in seconds from any device, anywhere in the world.</strong></p>

<p>
  <img src="https://img.shields.io/badge/status-early%20access-orange?style=flat-square" alt="Status" />
  <img src="https://img.shields.io/badge/pioneer-CDJ%20%7C%20XDJ%20compatible-blue?style=flat-square" alt="Pioneer Compatible" />
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" alt="Platforms" />
</p>

<p>
  <a href="https://xkc.io">xkc.io</a> ·
  <a href="../../releases/latest">Download</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-roadmap">Roadmap</a>
</p>

---

> **⚠️ Early Access | Active Development**
>
> XKC is functional and used in real workflows, but features, APIs, and data formats are still evolving. Breaking changes may occur between versions. Back up your library before upgrading.

> **🎛️ Always test before a gig**
>
> USB exports and hardware compatibility are improving but not guaranteed. Always test your exported USB on your actual hardware before relying on it at a show. XKC takes no responsibility for playback issues at a gig - verify everything works first.

</div>

---

## What is XKC?

XKC is a self-hosted DJ library manager. You run it on your own server. Your music, your metadata, your data. No cloud lock-in. No subscription. No sending your library to someone else's servers.

Unlike Rekordbox and similar tools, XKC is not tied to a single laptop. Your server is the permanent source of truth for your library. Lost a USB at a gig? Export a new one from your phone on the way there. Playing somewhere across the world? Log in, pick your playlists, and sync a fresh USB in minutes. Your library is always live, always up to date, always accessible - not frozen on the last machine you happened to open a desktop app on. And unlike every other option, it is entirely open source and hosted by you, on your hardware, under your control.

- **Web UI** - manage your full library from any browser on your network
- **Desktop App** - native app for macOS, Windows, and Linux with USB auto-sync and folder watching
- **Pioneer-ready exports** - full USB packages with rekordbox.xml, beat grids, cue points, and waveforms for all CDJ/XDJ hardware

<img width="2872" height="1570" alt="Screenshot 2026-07-01 at 00-39-38 XKC" src="https://github.com/user-attachments/assets/ec130f8c-8f37-457a-baf2-95c935a4e6a1" />

---

## Features

### Library Management
- Upload tracks (MP3, FLAC, WAV, AIFF, M4A) with auto-extracted metadata
- Edit title, artist, album, BPM, key, genre, label, rating, year
- Custom tag groups and flexible tagging system
- Playlists with drag-and-drop ordering
- Full-text search across all fields
- Multi-user with granular per-user permission controls

### Pioneer USB Export

Full USB packages compatible with all current CDJ/XDJ hardware:

| Hardware | Status |
|---|---|
| CDJ-2000NXS / NXS2 | ✅ Supported |
| CDJ-3000 | ✅ Supported |
| XDJ-RX3 / XDJ-XZ | ✅ Supported |
| OPUS-QUAD / XDJ-AZ / CDJ-3000X | ⏳ Coming - Device Library Plus format |

Exports include rekordbox.xml with full metadata, ANLZ files (beat grids, cue points, hot cues, waveforms), audio files in Pioneer's `/Contents/` structure, and preserved hot cue colours and loop markers.

### Streaming Sync
Pull tracks from Spotify and SoundCloud playlists directly into your library. Mirror a playlist or import to master library. Manual or scheduled auto-sync. Tracks are matched and de-duplicated against your existing library.

### Rekordbox Import
Import your existing collection from Rekordbox XML including tracks, cue points, beat grids, and playlists, without starting from scratch.

### Desktop App
Connects to your XKC server (local or remote). Full web UI embedded in the app. USB drive detection with per-device playlist selection, one-click sync, eject, and format. Folder sync keeps a local folder updated with a playlist. Available on macOS, Windows, and Linux.

---

## 🚧 Roadmap

XKC is actively being built. Here is what is in progress and what is planned:

| Feature | Status |
|---|---|
| **Device Library Plus** - OPUS-QUAD, XDJ-AZ, CDJ-3000X support | 🔨 In progress |
| **Full colour waveforms** - like Engine DJ / Rekordbox | 🔨 In progress |
| **On-device BPM analysis** - auto beat detection for unanalysed tracks | 📋 Planned |
| **Key detection** - automatic musical key analysis on import | 📋 Planned |
| **Auto hot cue suggestions** - energy-based cue placement | 📋 Planned |
| **Serato library import** - crates, cues, and loops from Serato | 📋 Planned |
| **Engine DJ import** - import from Denon/Engine DJ format | 📋 Planned |
| **Mobile companion app** - iOS/Android library browser | 📋 Planned |
| **Collaborative libraries** - shared libraries across users | 📋 Planned |
| **Play history & analytics** - track stats, set analysis | 📋 Planned |
| **Cloud backup** - optional encrypted offsite backup | 📋 Planned |
| **More streaming sources** - YouTube Music, Beatport, Bandcamp | 📋 Planned |

Have a suggestion? [Open an issue](../../issues).

---

## Known Issues & Near-term Fixes

These are tracked in [GitHub Issues](../../issues) and will be addressed in upcoming releases:

- [#1](../../issues/1) Desktop import progress stalls at a static count instead of updating track by track
- [#2](../../issues/2) Track sidebar: title needs gradient behind it for readability, close button should move to top corner
- [#3](../../issues/3) Folder sync runs on demand only - should run automatically on a schedule
- [#4](../../issues/4) USB reformat button missing for already-formatted drives
- [#5](../../issues/5) Library search while a track is playing in the preview player
- [#6](../../issues/6) Playlist watching - live detection of new tracks added to synced streaming playlists

---

## Quick Start

### Server

**1. Generate a secret key:**
```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

**2. Configure:**
```bash
cp .env.example .env
# Edit .env - set XKC_SECRET_KEY, XKC_ADMIN_PASSWORD, XKC_PUBLIC_URL
```

**3. Run:**
```bash
docker compose up -d
```

Open `http://localhost:3001`. Default login is `admin` / `changeme`. Change this immediately.

Or pull directly:

```bash
docker run -d \
  --name xkc-server \
  --network host \
  -v xkc_data:/data \
  -e XKC_SECRET_KEY=your-secret-key \
  -e XKC_ADMIN_PASSWORD=yourpassword \
  -e XKC_PUBLIC_URL=https://yourdomain.com \
  ghcr.io/tuikat/xkc-server:latest
```

### Desktop App

Download the latest installer from [Releases](../../releases/latest):

| Platform | File |
|---|---|
| macOS - Apple Silicon | `XKC_x.x.x_aarch64.dmg` |
| macOS - Intel | `XKC_x.x.x_x64.dmg` |
| Windows | `XKC_x.x.x_x64-setup.exe` |
| Linux | `XKC_x.x.x_amd64.AppImage` |

On first launch, enter your server URL (e.g. `https://xkc.io` or `http://192.168.1.x:3001`) and log in.

---

## HTTPS / Domain

Using [Caddy](https://caddyserver.com/) (handles SSL automatically):

```
yourdomain.com {
    reverse_proxy localhost:3001
}
```

Set `XKC_PUBLIC_URL=https://yourdomain.com` before starting.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `XKC_SECRET_KEY` | required | JWT signing key |
| `XKC_ADMIN_USERNAME` | `admin` | Bootstrap admin username |
| `XKC_ADMIN_PASSWORD` | `changeme` | Bootstrap admin password |
| `XKC_PUBLIC_URL` | `http://localhost:3001` | Public-facing URL |
| `XKC_DATA_DIR` | `/data` | Data directory |
| `XKC_MAX_UPLOAD_MB` | `500` | Max upload size per file |
| `XKC_ANALYSIS_WORKERS` | `2` | Analysis thread pool size |
| `XKC_SPOTIFY_CLIENT_ID` | optional | Spotify API |
| `XKC_SPOTIFY_CLIENT_SECRET` | optional | Spotify API |

Export your full server config from **Settings → Export Config**.

---

## Development

```bash
# Backend (FastAPI + Python)
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 3001

# Frontend (React + Vite)
cd web && npm install && npm run dev
# → http://localhost:5173

# Desktop (Tauri)
cd desktop && npm install
npm run tauri dev
```

Tag to release:
```bash
git tag v1.x.x && git push origin v1.x.x
```

GitHub Actions builds the Docker image and all four desktop installers automatically.

---

## ⚖️ Legal Disclaimer

**XKC is an organisational tool only.**

XKC is designed to help DJs organise, manage, and prepare music that they have the legal right to use - music that has been purchased, licensed, self-produced, or is in the public domain.

**You are solely responsible for ensuring you have the appropriate rights, licences, or permissions for any music you upload, store, sync, or export using XKC.** By using this software, you accept full legal responsibility for your use of it.

The developers of XKC:
- Do not host, distribute, or provide access to any copyrighted music
- Do not condone the use of XKC to store or distribute music without proper authorisation from rights holders
- Accept no liability for copyright infringement or any other unlawful use of this software

Streaming sync features (Spotify, SoundCloud) may be subject to those platforms' terms of service. These features are provided for personal archival use only. Respect artists, labels, and rights holders.

---

<div align="center">

Built for DJs &nbsp;·&nbsp; Self-hosted &nbsp;·&nbsp; Open source

</div>
