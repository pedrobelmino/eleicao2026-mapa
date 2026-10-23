#!/usr/bin/env bash
# turno_configuravel.sh — prova que a troca de turno é CONFIGURAÇÃO, não código.
#
# O que ele faz, de verdade (nada simulado):
#   1. compila o binário da API no diretório atual;
#   2. sobe com ELEICAO=6258 / TURNO=2 apontando para uma URL FALSA do TSE
#      (http://127.0.0.1:9/... — porta fechada) e exige:
#        /api/health   200, turno "2", eleicao "6258", 27 UFs;
#        /api/config   200, rótulo "2º turno" e a URL do 2º turno composta;
#        /api/fonte    503 com motivo legível, SEM stack e SEM panic;
#        o processo continua vivo depois disso (falha da fonte não derruba o app);
#        SIGTERM encerra limpo;
#   3. sobe com TURNO=3 e exige falha limpa: sai != 0, mensagem do campo errado,
#      nenhum "panic"/"goroutine";
#   4. com --com-url-real, sobe com TSE_BASE oficial e TURNO=2 e mostra o que o
#      TSE responde hoje (200 = arquivo do 2º turno já publicado; 503 = ainda não).
#
# Nada aqui toca em produção: porta própria (8123 por padrão), dados somente
# leitura e banco de métricas em diretório temporário.

set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORTA="${PORTA:-8123}"
URL_FAKE="${URL_FAKE:-http://127.0.0.1:9/oficial/ele2026}"
COM_URL_REAL=0
[ "${1:-}" = "--com-url-real" ] && COM_URL_REAL=1

TMP="$(mktemp -d)"
BIN="$TMP/api"
LOG="$TMP/api.log"
FALHAS=0
PID=""

limpa() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
}
trap limpa EXIT

ok()    { printf '  ok    %s\n' "$1"; }
falhou(){ printf '  FALHA %s\n' "$1"; FALHAS=$((FALHAS + 1)); }

# espera_porta URL TENTATIVAS: 0 quando algum HTTP responde (mesmo 4xx/5xx).
espera_porta() {
  local url="$1" tentativas="${2:-60}"
  for _ in $(seq 1 "$tentativas"); do
    if curl -s -o /dev/null --max-time 2 "$url"; then return 0; fi
    sleep 0.5
  done
  return 1
}

# sobe BIN com um ambiente; devolve PID em PID e log em LOG.
sobe() { # $1..=pares CHAVE=VALOR
  : >"$LOG"
  env "$@" "$BIN" >>"$LOG" 2>&1 &
  PID=$!
}

echo "== build =="
if ! (cd "$RAIZ/api" && TMPDIR=/tmp go build -o "$BIN" .); then
  echo "FALHA: build da API falhou"
  exit 1
fi
ok "binário compilado em $BIN"

# ------------------------------------------------------------------ 2º turno
echo
echo "== 2º turno (ELEICAO=6258, TURNO=2) com URL falsa: $URL_FAKE =="
sobe PORT="$PORTA" ELEICAO=6258 TURNO=2 TSE_BASE="$URL_FAKE" \
  TSE_PORTAL="https://resultados.tse.jus.br/" DADOS_DIR="$RAIZ/dados" \
  METRICAS_DIR="$TMP/metricas"

if espera_porta "http://127.0.0.1:$PORTA/api/health" 120; then
  ok "a API subiu com a configuração de 2º turno"
else
  falhou "a API não respondeu em http://127.0.0.1:$PORTA/api/health"
  echo "---- log ----"; cat "$LOG"; exit 1
fi

HEALTH="$(curl -s --max-time 5 "http://127.0.0.1:$PORTA/api/health")"
echo "  health: $HEALTH"
[ "$(printf '%s' "$HEALTH" | jq -r '.eleicao')" = "6258" ] \
  && ok 'health.eleicao = 6258' || falhou "health.eleicao != 6258"
[ "$(printf '%s' "$HEALTH" | jq -r '.turno')" = "2" ] \
  && ok 'health.turno = 2' || falhou "health.turno != 2"
[ "$(printf '%s' "$HEALTH" | jq -r '.ok')" = "true" ] \
  && ok 'health.ok = true (o app está vivo mesmo com a fonte fora)' \
  || falhou "health.ok != true"
[ "$(printf '%s' "$HEALTH" | jq -r '.ufs')" = "27" ] \
  && ok 'health.ufs = 27' || falhou "health.ufs != 27"

CONFIG="$(curl -s --max-time 5 "http://127.0.0.1:$PORTA/api/config")"
echo "  config: $CONFIG"
[ "$(printf '%s' "$CONFIG" | jq -r '.rotulo_turno')" = "2º turno" ] \
  && ok 'config.rotulo_turno = 2º turno' || falhou "config.rotulo_turno != 2º turno"
printf '%s' "$CONFIG" | jq -r '.url_nacional' | grep -q '/6258/dados/br/br-c0001-e006258-u.json$' \
  && ok 'config.url_nacional composta para o 6258' \
  || falhou "config.url_nacional não é a do 2º turno: $(printf '%s' "$CONFIG" | jq -r '.url_nacional')"
printf '%s' "$CONFIG" | jq -r '.url_uf' | grep -q '{uf}-c0001-e006258-u.json$' \
  && ok 'config.url_uf (modelo) composta para o 6258' \
  || falhou "config.url_uf (modelo) inesperado: $(printf '%s' "$CONFIG" | jq -r '.url_uf')"

# /api/fonte: 503 limpo, com motivo, sem stack.
FONTE_STATUS="$(curl -s -o "$TMP/fonte.json" -w '%{http_code}' --max-time 15 "http://127.0.0.1:$PORTA/api/fonte")"
FONTE_CORPO="$(cat "$TMP/fonte.json")"
echo "  fonte: HTTP $FONTE_STATUS $FONTE_CORPO"
[ "$FONTE_STATUS" = "503" ] \
  && ok '/api/fonte responde 503 (fonte inacessível não vira 200 mentiroso)' \
  || falhou "/api/fonte devolveu HTTP $FONTE_STATUS, quer 503"
printf '%s' "$FONTE_CORPO" | jq -e . >/dev/null 2>&1 \
  && ok '/api/fonte devolve JSON válido' || falhou '/api/fonte não devolveu JSON'
[ "$(printf '%s' "$FONTE_CORPO" | jq -r '.ok')" = "false" ] \
  && ok 'fonte.ok = false' || falhou 'fonte.ok != false'
printf '%s' "$FONTE_CORPO" | jq -r '.erro' | grep -qi 'inacess' \
  && ok "mensagem explica o motivo: $(printf '%s' "$FONTE_CORPO" | jq -r '.erro')" \
  || falhou "mensagem sem motivo legível: $(printf '%s' "$FONTE_CORPO" | jq -r '.erro')"
if printf '%s' "$FONTE_CORPO" | grep -qiE 'panic|goroutine [0-9]+ \['; then
  falhou 'a resposta de /api/fonte vazou stack/panic'
else
  ok 'sem panic nem stacktrace na resposta'
fi
if grep -qiE 'panic|goroutine [0-9]+ \[' "$LOG"; then
  falhou 'o log do processo tem panic'
else
  ok 'sem panic no log do processo'
fi

# Continua vivo e ainda responde depois da falha da fonte.
sleep 1
if curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$PORTA/api/estados"; then
  ok 'a API continua servindo /api/estados com a fonte fora'
else
  falhou 'a API parou de responder depois da falha da fonte'
fi

# Encerramento limpo (o compose manda SIGTERM).
kill -TERM "$PID" 2>/dev/null
for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then
  falhou 'SIGTERM não encerrou o processo em 10s'
  kill -KILL "$PID" 2>/dev/null
else
  wait "$PID" 2>/dev/null
  RC=$?
  ok "SIGTERM encerrou o processo (rc=$RC)"
fi
PID=""

# ------------------------------------------------------- configuração inválida
echo
echo "== configuração inválida (TURNO=3) tem de falhar limpa, sem subir =="
sobe PORT="$PORTA" ELEICAO=6258 TURNO=3 TSE_BASE="$URL_FAKE" \
  DADOS_DIR="$RAIZ/dados" METRICAS_DIR="$TMP/metricas3"
SAIU=0
for _ in $(seq 1 20); do
  if ! kill -0 "$PID" 2>/dev/null; then SAIU=1; break; fi
  sleep 0.5
done
if [ "$SAIU" = "1" ]; then
  wait "$PID" 2>/dev/null
  RC=$?
  ok "o processo saiu sozinho (rc=$RC)"
  [ "$RC" != "0" ] && ok "código de saída diferente de 0" || falhou 'saiu com código 0'
else
  falhou 'o processo continuou rodando com TURNO=3'
  kill -TERM "$PID" 2>/dev/null
fi
PID=""
grep -q 'TURNO inválido' "$LOG" \
  && ok 'mensagem aponta o campo errado: TURNO inválido' \
  || falhou "mensagem não aponta TURNO inválido: $(tail -3 "$LOG" | tr '\n' ' ')"
grep -qiE 'panic|goroutine [0-9]+ \[' "$LOG" \
  && falhou 'a falha de configuração gerou panic' \
  || ok 'falha de configuração sem panic'

# ------------------------------------------------------------- URL real (opcional)
if [ "$COM_URL_REAL" = "1" ]; then
  echo
  echo "== 2º turno contra o TSE de verdade (o arquivo pode não existir ainda) =="
  sobe PORT="$PORTA" ELEICAO=6258 TURNO=2 \
    TSE_BASE="https://resultados.tse.jus.br/oficial/ele2026" \
    TSE_PORTAL="https://resultados.tse.jus.br/" DADOS_DIR="$RAIZ/dados" \
    METRICAS_DIR="$TMP/metricas-real"
  if espera_porta "http://127.0.0.1:$PORTA/api/health" 120; then
    ST="$(curl -s -o "$TMP/real.json" -w '%{http_code}' --max-time 20 "http://127.0.0.1:$PORTA/api/fonte")"
    echo "  fonte real: HTTP $ST $(cat "$TMP/real.json")"
    if [ "$ST" = "200" ]; then
      ok 'o TSE já publica o arquivo do 2º turno (503 não aparece)'
    elif [ "$ST" = "503" ]; then
      ok 'o TSE ainda não publica o 2º turno e o painel diz isso com 503 + motivo'
    else
      falhou "/api/fonte devolveu HTTP $ST na fonte real"
    fi
    kill -TERM "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
  else
    falhou 'a API não subiu apontando para o TSE real'
  fi
  PID=""
fi

echo
if [ "$FALHAS" = "0" ]; then
  echo "PROVA OK: turno é configuração — 2º turno sobe só com env, URL falsa falha limpa (503 sem stack) e configuração inválida não sobe."
  exit 0
fi
echo "PROVA FALHOU: $FALHAS problema(s). Log em $LOG"
exit 1
