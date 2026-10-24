#!/usr/bin/env bash
# compilar.sh — build do painel de monitoramento (monitor/), binário local.
#
#   bash scripts/monitor/compilar.sh
#
# O binário fica em monitor/bin/ (fora do git). Nada aqui toca no container do
# site: o painel é um processo separado, que só LÊ var/defesa/acessos.log.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESTINO="$RAIZ/monitor/bin"
mkdir -p "$DESTINO"

cd "$RAIZ/monitor"
gofmt -l . | tee /tmp/gofmt-monitor.txt
if [ -s /tmp/gofmt-monitor.txt ]; then
  echo "erro: arquivos fora do gofmt (rode gofmt -w)" >&2
  exit 1
fi

go vet ./...
go test ./...
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$DESTINO/monitor-ataques" .
ls -la "$DESTINO/monitor-ataques"
echo "ok: $DESTINO/monitor-ataques"
