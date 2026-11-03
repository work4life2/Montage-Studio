#!/usr/bin/env bash
# One-shot bootstrap on a Ubuntu/Debian server (run as root). Safe next to the other services on the
# box: it adds packages, a service user, the checkout, systemd units and the auto-deploy timer, and
# touches no nginx site or other unit.
#   curl -fsSL https://raw.githubusercontent.com/work4life2/Montage-Studio/main/deploy/server-bootstrap.sh | bash
# Afterwards: copy .env.local + data/oauth/ (or run `npm run auth` there), then `systemctl start montage-studio`.
set -euo pipefail

TARGET="${TARGET:-/opt/montage-studio}"
REPO="${REPO:-https://github.com/work4life2/Montage-Studio.git}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="${SERVICE_USER:-montage}"
export DEBIAN_FRONTEND=noninteractive

echo "[bootstrap] packages"
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl git ffmpeg zip unzip python3 python3-venv python3-pil fonts-dejavu-core fonts-noto-core

if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  echo "[bootstrap] node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd -r -m -d "/home/$SERVICE_USER" -s /bin/bash "$SERVICE_USER"

if [ ! -d "$TARGET/.git" ]; then
  echo "[bootstrap] clone $REPO -> $TARGET"
  mkdir -p "$TARGET" && chown "$SERVICE_USER:$SERVICE_USER" "$TARGET"
  runuser -u "$SERVICE_USER" -- git clone -q -b "$BRANCH" "$REPO" "$TARGET"
fi
runuser -u "$SERVICE_USER" -- mkdir -p "$TARGET/data"
chmod 750 "$TARGET"

echo "[bootstrap] first deploy"
TARGET="$TARGET" BRANCH="$BRANCH" SERVICE_USER="$SERVICE_USER" bash "$TARGET/deploy/deploy.sh" --force || true
echo "[bootstrap] python venv (librosa beat detection)"
runuser -u "$SERVICE_USER" -- bash -c "cd '$TARGET' && node dist/index.js setup venv" || echo "[bootstrap] venv failed; beat detection falls back to the built-in tracker" >&2
systemctl enable -q montage-studio montage-studio-autodeploy.timer
systemctl start montage-studio-autodeploy.timer
echo "[bootstrap] done"
