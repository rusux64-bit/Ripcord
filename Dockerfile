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

# download the latest yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
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
    PORT=5224

CMD ["node", "server.js"]
