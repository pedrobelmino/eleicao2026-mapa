#!/usr/bin/env bash
# acesso_local_painel.sh — prova o acesso SEM TOKEN ao painel de métricas quando a
# requisição vem do loopback do host, e prova que NÃO existe caminho de burla por
# cabeçalho (X-Real-IP / X-Forwarded-For / X-Painel-Local forjados).
#
# Uso: scripts/provas/acesso_local_painel.sh [DIR_SAIDA]
#   DIR_SAIDA default: _provas/defesa/AAAAMMDD-HHMM
#
# Nada aqui altera estado: só dispara requisição e lê o código HTTP. O token do
# .env nunca é impresso (só o código de status).
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SAIDA="${1:-$RAIZ/_provas/defesa/$(date +%Y%m%d-%H%M)}"
mkdir -p "$SAIDA"
ARQ="$SAIDA/prova_acesso_local.txt"

LOCAL="${LOCAL:-http://127.0.0.1:8112}"        # painel privado (publish 127.0.0.1)
PUBLICO="${PUBLICO:-http://127.0.0.1:8110}"    # site público local (alvo do túnel)
PUB="${PUB:-https://eleicao2026.belmino.dev}"  # público de verdade, via túnel

TOKEN=""
if [ -r "$RAIZ/.env" ]; then
  TOKEN="$(grep -oP '^METRICAS_TOKEN=\K.*' "$RAIZ/.env" | head -1 | tr -d '"'"'"'')"
fi

PASS=0
FAIL=0
linhas=()

status() { curl -s -o /dev/null -m 12 -w '%{http_code}' "$@" 2>/dev/null || echo 000; }

espera() { # nome | esperados (a|b) | comando...
  local nome="$1" esperados="$2"; shift 2
  local obtido; obtido="$("$@")"
  local marca
  if [[ "|$esperados|" == *"|$obtido|"* ]]; then
    marca="PASS"; PASS=$((PASS+1))
  else
    marca="FAIL"; FAIL=$((FAIL+1))
  fi
  printf '%-4s %-58s HTTP %-3s (esperado %s)\n' "$marca" "$nome" "$obtido" "$esperados" | tee -a "$ARQ"
}

FORJA=( -H 'X-Real-IP: 127.0.0.1' -H 'X-Forwarded-For: 127.0.0.1' -H 'X-Painel-Local: 1' )

{
  echo "# Prova de acesso local sem token — painel de métricas"
  echo "# gerado: $(date -Is)"
  echo "# local=$LOCAL  publico_local=$PUBLICO  publico=$PUB"
  echo
  echo "## (a)(b) loopback do host, SEM token"
} >> "$ARQ"
espera "a) painel 127.0.0.1:8112 SEM token"        "200" status "$LOCAL/api/interno/painel"
espera "b) metricas 127.0.0.1:8112 SEM token"     "200" status "$LOCAL/api/interno/metricas"

{ echo; echo "## (c) público, SEM token"; } >> "$ARQ"
espera "c1) $PUB /api/interno/painel SEM token"   "404|401" status "$PUB/api/interno/painel"
espera "c2) $PUB /api/interno/metricas SEM token" "404|401" status "$PUB/api/interno/metricas"

{ echo; echo "## (d) tentativa de burla: cabeçalhos de cliente forjados, SEM token"; } >> "$ARQ"
espera "d1) 8110 painel + X-Real-IP/XFF/X-Painel-Local forjados"   "404|401" \
  status "${FORJA[@]}" "$PUBLICO/api/interno/painel"
espera "d2) 8110 metricas + cabeçalhos forjados"                   "404|401" \
  status "${FORJA[@]}" "$PUBLICO/api/interno/metricas"
espera "d3) público painel + cabeçalhos forjados"                  "404|401" \
  status "${FORJA[@]}" "$PUB/api/interno/painel"
espera "d4) público metricas + cabeçalhos forjados"                "404|401" \
  status "${FORJA[@]}" "$PUB/api/interno/metricas"
espera "d5) 8110 painel + X-Forwarded-For encadeado falso"         "404|401" \
  status -H 'X-Forwarded-For: 127.0.0.1, 127.0.0.1' -H 'CF-Connecting-IP: 127.0.0.1' "$PUBLICO/api/interno/painel"

if [ -n "$TOKEN" ]; then
  { echo; echo "## (d6) o público continua 404 MESMO com token válido (isolamento por porta)"; } >> "$ARQ"
  espera "d6) público painel COM token válido" "404" status "$PUB/api/interno/painel?token=$TOKEN"
fi

{ echo; echo "## (d7) dentro da rede do compose: marca é o que libera, não o cabeçalho do cliente"; } >> "$ARQ"
INTERNO_MARCA="$(docker compose -f "$RAIZ/compose.yaml" --project-directory "$RAIZ" exec -T web \
  wget -q -S -O /dev/null --header='X-Painel-Local: 1' http://api:8080/api/interno/metricas 2>&1 \
  | grep -m1 -o 'HTTP/1.1 [0-9]*' | awk '{print $2}')"
INTERNO_SEM="$(docker compose -f "$RAIZ/compose.yaml" --project-directory "$RAIZ" exec -T web \
  wget -q -S -O /dev/null --header='X-Real-IP: 127.0.0.1' --header='X-Forwarded-For: 127.0.0.1' \
  http://api:8080/api/interno/metricas 2>&1 | grep -m1 -o 'HTTP/1.1 [0-9]*' | awk '{print $2}')"
for par in "marca local (proxy):|200|$INTERNO_MARCA" "sem marca, X-Real-IP forjado:|401|$INTERNO_SEM"; do
  nome="${par%%|*}"; resto="${par#*|}"; esp="${resto%%|*}"; obt="${resto#*|}"
  if [ "$obt" = "$esp" ]; then marca="PASS"; PASS=$((PASS+1)); else marca="FAIL"; FAIL=$((FAIL+1)); fi
  printf '%-4s %-58s HTTP %-3s (esperado %s)\n' "$marca" "d7) $nome" "${obt:-NÃO MEDIDO}" "$esp" | tee -a "$ARQ"
done

{ echo; echo "## (e) portas em escuta (só loopback)"; } >> "$ARQ"
ss -ltnp 2>/dev/null | grep -E ':(8110|8112)\b' | tee -a "$ARQ"

{
  echo
  echo "resumo: PASS=$PASS FAIL=$FAIL"
} >> "$ARQ"

echo
echo "resumo: PASS=$PASS FAIL=$FAIL"
echo "arquivo: $ARQ"
[ "$FAIL" -eq 0 ]
