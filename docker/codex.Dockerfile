FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global @openai/codex@0.155.0 \
  && useradd --create-home --shell /bin/bash agent \
  && printf '%s\n' '#!/bin/sh' 'set -eu' 'if [ -f /seed/auth.json ]; then cp /seed/auth.json /codex-home/auth.json; chmod 600 /codex-home/auth.json; fi' 'if [ -f /seed/config.toml ]; then cp /seed/config.toml /codex-home/config.toml; fi' 'exec codex "$@"' > /usr/local/bin/bridge-codex \
  && chmod 755 /usr/local/bin/bridge-codex

USER agent
WORKDIR /workspace
ENTRYPOINT ["bridge-codex"]
