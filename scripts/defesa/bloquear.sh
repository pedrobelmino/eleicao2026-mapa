#!/usr/bin/env bash
# bloquear.sh — bloqueio MANUAL de um IP na borda do nginx.
#
#   bash scripts/defesa/bloquear.sh 45.22.33.44 "escore 100 no painel"
#   bash scripts/defesa/bloquear.sh 45.22.33.44 "varredura /admin" --minutos 60
#
# É o que o aviso do vigia sugere quando um IP passa do escore de suspeita:
# o escore identifica e avisa, mas NÃO bloqueia sozinho — quem decide é o Pedro.
#
# Garantias (as mesmas do vigia, porque quem escreve a lista é ele):
#   * só IP público entra: privado, loopback, link-local, multicast e reservado
#     são RECUSADOS com exit 65 (bloquear 127.0.0.1 derrubaria o site inteiro);
#   * a janela expira sozinha (padrão 240 min, MANUAL_DURACAO_MIN);
#   * mexe só na lista de bloqueio: o nginx é testado antes do reload.
set -uo pipefail

RAIZ="/home/pedro/eleicao2026-mapa"
VIGIA="$RAIZ/scripts/defesa/vigia_ataques.py"

case "${1:-}" in
  ""|-h|--ajuda)
    sed -n '2,15p' "$0"
    exit 64
    ;;
esac

IP="$1"
shift
MOTIVO="manual"
MINUTOS="${MANUAL_DURACAO_MIN:-240}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --motivo)
      MOTIVO="${2:-manual}"
      shift 2
      ;;
    --minutos)
      MINUTOS="${2:-$MINUTOS}"
      shift 2
      ;;
    *)
      # primeiro argumento solto depois do IP é o motivo (forma curta)
      [ "$MOTIVO" = "manual" ] && MOTIVO="$1"
      shift
      ;;
  esac
done

if ! [[ "$MINUTOS" =~ ^[0-9]+$ ]]; then
  echo "--minutos precisa inteiro: $MINUTOS" >&2
  exit 64
fi

exec /usr/bin/python3 "$VIGIA" --bloquear "$IP" --motivo "$MOTIVO" --minutos "$MINUTOS"
