#!/usr/bin/env bash
# desbloquear.sh — tira um IP da lista de bloqueio do nginx (ou todos).
#
#   bash scripts/defesa/desbloquear.sh 45.22.33.44   # um IP
#   bash scripts/defesa/desbloquear.sh --todos       # lista inteira
#
# Escreve a lista, testa a config do nginx e recarrega. Nunca toca em rota,
# dado ou conteúdo: só na lista de bloqueio.
set -uo pipefail

RAIZ="/home/pedro/eleicao2026-mapa"
VIGIA="$RAIZ/scripts/defesa/vigia_ataques.py"

case "${1:-}" in
  ""|-h|--ajuda)
    sed -n '2,8p' "$0"
    exit 64
    ;;
  --todos)
    exec /usr/bin/python3 "$VIGIA" --desbloquear-todos
    ;;
  *)
    exec /usr/bin/python3 "$VIGIA" --desbloquear "$1"
    ;;
esac
