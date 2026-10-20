# Pin the verified Node.js 24.22.0 base image; update the digest deliberately.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        git \
        gzip \
        openssh-client \
        tar \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /home/node/.codex

USER node
WORKDIR /workspaces/openclaw-xmpp-channel
