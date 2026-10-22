FROM node:24-bookworm-slim

# install system tools we need: ffmpeg, python, and audio libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    flac \
    vorbis-tools \
    python3 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# download the pinned yt-dlp binary with checksum verification
ARG YTDLP_VERSION=2026.10.21
ARG YTDLP_SHA256=b7af77f686e95f7845ce8d09d21957718febb8b48b30555adb9dd2292ad7bf14
RUN curl -L "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp && \
    echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# install the node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# copy the rest of the project files
COPY . .

# create cache directory owned by node user for volume mounts
RUN mkdir -p /app/cache && chown -R node:node /app/cache

# Run the network-facing service without root privileges.
USER node

EXPOSE 5224

ENV NODE_ENV=production \
    PORT=5224 \
    XDG_CACHE_HOME=/tmp/.cache

CMD ["node", "server.js"]
