FROM node:24.5.0-bookworm-slim AS web-builder
WORKDIR /src
RUN npm install --global pnpm@10.33.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY public/ public/
COPY src/ src/
RUN pnpm build

FROM rust:1.95.0-bookworm AS rust-builder
WORKDIR /src/server
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src/ src/
RUN cargo build --locked --release

FROM node:24.5.0-bookworm-slim

ARG TARGETARCH
ARG S6_VERSION=3.2.0.2
ARG CLAUDE_CODE_VERSION=2.1.205
ARG CODEX_VERSION=0.144.3
ARG OPENCODE_VERSION=1.17.20
ARG CLAUDE_ACP_VERSION=0.59.0
ARG CODEX_ACP_VERSION=1.1.2

ENV NB_USER=jovyan \
    NB_UID=1000 \
    NB_GID=0 \
    HOME=/home/jovyan \
    PERSISTENT_DIR=/home/jovyan/srv \
    NB_PREFIX=/ \
    HOST=0.0.0.0 \
    PORT=8888 \
    KUBECODE_STATIC_DIR=/opt/kubecode/dist \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=300000 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq openssh-client procps ripgrep sudo tmux xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && case "${TARGETARCH}" in \
      amd64) S6_ARCH=x86_64 ;; \
      arm64) S6_ARCH=aarch64 ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION}/s6-overlay-noarch.tar.xz" -o /tmp/s6-noarch.tar.xz \
 && curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" -o /tmp/s6-arch.tar.xz \
 && tar -C / -Jxpf /tmp/s6-noarch.tar.xz \
 && tar -C / -Jxpf /tmp/s6-arch.tar.xz \
 && rm -f /tmp/s6-noarch.tar.xz /tmp/s6-arch.tar.xz \
 && npm install --global --omit=dev \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
      "@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}" \
      "@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}" \
 && useradd --create-home --uid "${NB_UID}" --gid "${NB_GID}" --shell /bin/bash "${NB_USER}" \
 && usermod -aG sudo "${NB_USER}" \
 && printf '%%sudo ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/kubecode \
 && mkdir -p "${PERSISTENT_DIR}" /opt/kubecode/dist \
 && chown -R "${NB_UID}:${NB_GID}" "${HOME}" /opt/kubecode

COPY --from=rust-builder /src/server/target/release/kubecode-server /usr/local/bin/kubecode-server
COPY --from=web-builder /src/dist/ /opt/kubecode/dist/
COPY --chmod=755 deploy/s6/ /etc/

USER ${NB_UID}
WORKDIR ${PERSISTENT_DIR}
EXPOSE 8888
ENTRYPOINT ["/init"]
