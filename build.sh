#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Building frontend..."
cd web && npm run build -s && cd ..
echo "Copying to server/static..."
rm -rf server/static && cp -r web/dist server/static
echo "Building Docker image..."
docker build -t xkc-server-img ./server -q
echo "Restarting container..."
docker rm -f xkc-server 2>/dev/null || true
docker run -d --restart unless-stopped --network host --name xkc-server -v xkc_data:/data --env-file server/.env xkc-server-img
echo "Done. Waiting for startup..."
sleep 3
docker logs xkc-server --tail 5
