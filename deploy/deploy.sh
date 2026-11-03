#!/usr/bin/env bash
# Pull-based deploy: fetch origin/<branch>; if it moved (or --force), reset the checkout to it,
# install, build and restart the service. Run as root (it drops to the service user for git/npm).
#   deploy/deploy.sh            # deploy only if origin moved
#   deploy/deploy.sh --force    # always rebuild + restart
# The service binds 127.0.0.1 only; there is no nginx site (operator access: ssh -L 8795:127.0.0.1:8795).
set -euo pipefail

TARGET="${TARGET:-/opt/montage-studio}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="${SERVICE_USER:-montage}"
SERVICE="${SERVICE:-montage-studio}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

as_user() { runuser -u "$SERVICE_USER" -- "$@"; }

cd "$TARGET"
as_user git fetch -q origin "$BRANCH"
LOCAL="$(as_user git rev-parse HEAD)"
REMOTE="$(as_user git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" = 0 ]; then
  exit 0
fi

echo "[deploy] $LOCAL -> $REMOTE"
as_user git reset -q --hard "origin/$BRANCH"
# deploy.sh itself may have just changed: re-run the fresh copy once instead of finishing with stale logic.
if [ "${DEPLOY_REEXEC:-}" != 1 ]; then
  DEPLOY_REEXEC=1 exec bash "$TARGET/deploy/deploy.sh" --force
fi
as_user npm ci --ignore-scripts --no-audit --no-fund
as_user npm run build

install -m 644 deploy/montage-studio.service /etc/systemd/system/montage-studio.service
sed -i "s/User=%i/User=$SERVICE_USER/; s#/opt/montage-studio#$TARGET#g" /etc/systemd/system/montage-studio.service
install -m 644 deploy/montage-studio-autodeploy.service deploy/montage-studio-autodeploy.timer /etc/systemd/system/
systemctl daemon-reload
# Not started until .env.local exists (wallet keys, relay key): the first deploy only installs.
if [ -f .env.local ]; then
  systemctl restart "$SERVICE"
else
  echo "[deploy] .env.local missing — service installed but not started" >&2
fi
echo "[deploy] done: $(as_user git log -1 --format='%h %s')"
