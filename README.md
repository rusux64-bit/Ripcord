# Ripcord

A clean, self-hosted web tool for extracting tagged audio from Spotify and YouTube links.

Hosted under [webjuniors.org](https://webjuniors.org) platform.


Currently available at: [ripcord.webjuniors.org](https://dev-ripcord.webjuniors.org).

---

## What It Does

Paste a link to any track, album, or playlist from Spotify, YouTube, or YouTube Music. Ripcord extracts the audio, lets you pick a format and bitrate, embeds cover art and metadata, and streams the finished file directly to your browser. Playlists and albums are automatically bundled into an on-the-fly ZIP archive.

Supported formats: MP3, M4A, FLAC, WAV, and OGG.

---

## How It Works Under the Hood

- **Metadata Resolution**: Scrapes embed schemas for Spotify tracks and playlists; queries YouTube oEmbed and `yt-dlp --flat-playlist` to discover tracklists without full downloads.
- **Audio Extraction**: Spawns `yt-dlp` with strict process boundaries (`--`) to stream source audio directly to standard output without downloading video files.
- **Spotify Matching**: Because Spotify does not expose raw audio, Ripcord normalizes metadata (primary and featured artists, version tags such as remixes, live recordings, and acoustic edits), generates targeted YouTube search queries, and deterministically scores candidates across title similarity, artist credits, smooth duration curves, version compatibility, and official/Topic channel signals. If no candidate clears the confidence threshold, the track is safely rejected to prevent downloading incorrect audio.
- **Transcoding & Tagging**: Pipes raw audio through FFmpeg to encode the selected format, embeds ID3v2/Vorbis tags, and applies high-resolution cover art fetched from CDNs.
- **Streamed Output**: Single tracks stream directly over HTTP. Multi-track collections are transcoded in bounded concurrent batches and piped straight into an `archiver` ZIP stream, using minimal server disk space.

---

## Quick Start

### Prerequisites
- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [ffmpeg](https://ffmpeg.org)

### Run Locally

```bash
git clone https://github.com/rusux64-bit/Ripcord.git
cd Ripcord
cp .env.example .env
npm install
npm start
```

Adjust `.env` to tune rate limits, concurrency, and media resource ceilings. Values are validated and bounded; unset options use the defaults shown in `server.js`.

### Performance Tuning

For a small VPS with 1–2 CPU cores, keep `DOWNLOAD_CONCURRENCY` around 2–3 and set `ENCODE_CONCURRENCY=1`. On a larger machine, `DOWNLOAD_CONCURRENCY=4` and `ENCODE_CONCURRENCY=2` are reasonable starting points; increase gradually while watching CPU and memory use. `YTDLP_CONCURRENT_FRAGMENTS` controls parallel fragments per source download, and aria2c can be enabled with `YTDLP_USE_ARIA2C=true` when installed.

Set `WORK_DIR` to an absolute path on tmpfs (for example `/dev/shm/ripcord`) to keep temporary media off persistent storage. Make sure the tmpfs has enough capacity for concurrent downloads and converted tracks.

Open `http://localhost:5224`.

### Run with Docker

```bash
docker compose up -d
```

---

## Notes & Limitations

- **Source Fidelity**: YouTube audio streams are lossy (typically 128-160 kbps Opus/AAC). Selecting FLAC or WAV provides an uncompressed container, but cannot restore frequencies absent from the source stream.
- **Spotify Accuracy**: Audio matching compares search-result titles, artist/channel metadata, and duration. Alternate edits can still pass when their metadata closely matches, and low-confidence results are skipped.
- **Bot Detection**: When hosting on cloud VPS providers, provide a Netscape-formatted `cookies.txt` or set `YTDLP_COOKIES_PATH` in `.env` if YouTube challenges requests.
- **Fair Use**: Intended solely for personal archiving and educational purposes.

---

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0)
