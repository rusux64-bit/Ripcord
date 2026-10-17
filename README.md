# Ripcord

Fast, lightweight web service and UI for downloading music from Spotify and YouTube, powered by `yt-dlp` and FFmpeg.

Features:
- Single tracks, YouTube playlists, Spotify tracks, albums and playlists (streamed as a ZIP).
- AAC (M4A) and Opus (OGG) fast-path remuxing without re-encoding; MP3/FLAC/WAV via FFmpeg.
- Clean Material Design 3 frontend with progress tracking, dark/light theme, and no client-side tracking.
- Hardened rootless Docker image with read-only rootfs, dropped capabilities, and tmpfs workdir.
- Optional throwaway account pool for age-restricted YouTube videos, scoped strictly to fallback retries.

## Quick start

### Docker Compose (recommended)

```bash
git clone https://github.com/rusux64-bit/Ripcord.git
cd Ripcord
cp .env.example .env
docker compose up -d
```

Open `http://localhost:5224`.

### Bare metal

Prerequisites: a current Node.js LTS, FFmpeg, and a recent `yt-dlp` binary on `PATH`.

```bash
git clone https://github.com/rusux64-bit/Ripcord.git
cd Ripcord
cp .env.example .env
npm ci --omit=dev
node server.js
```

## Configuration

All configuration is optional and handled via environment variables (or `.env`). Key settings:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5224` | HTTP port |
| `BIND_ADDRESS` | `127.0.0.1` | Host address to bind to (`0.0.0.0` for all interfaces) |
| `DOWNLOAD_CONCURRENCY` | `4` | Max parallel audio downloads |
| `ENCODE_CONCURRENCY` | `2` | Max parallel FFmpeg encoding tasks |
| `SPOTIFY_SEARCH_CONCURRENCY` | `6` | Concurrency for Spotify track search-ahead |
| `MAX_PLAYLIST_TRACKS` | `30` | Max tracks accepted per playlist/album |
| `AGE_GATE_COOKIES` | `off` | Set to `on` to enable the age-restricted account pool |
| `YTDLP_AGE_COOKIES_DIR` | (unset) | Directory with throwaway `account_*.txt` Netscape cookies |
| `TRUST_PROXY_HOPS` | `0` | Number of reverse proxy hops to trust for client IP |

See `.env.example` for all options.

## License

AGPL-3.0-or-later
