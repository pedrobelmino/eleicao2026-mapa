#!/usr/bin/env bash
# coleta_apuracao.sh — coleta do TSE + snapshot público + publicação no site.
#
# O que faz, em ordem (e o que NÃO faz):
#   1. respeita a detecção automática de turno dos coletores (coleta_presidente.py
#      e snapshot_publico.py usam o 6258 só quando ele tem seção apurada; com o
#      2º turno zerado eles seguem no 1º turno);
#   2. gera o snapshot público no repositório do painel;
#   3. SÓ publica no site se o snapshot for da MESMA eleição que o site está
#      configurado para exibir (.env ELEICAO). Snapshot de outro turno, ou com
#      sem_dado=true, NÃO sobrescreve o dado do site — dado velho rotulado como
#      novo é o pior defeito deste projeto;
#   4. reinicia a api (ela carrega publico.json em memória no boot: arquivo novo
#      sem restart não aparece) e confere /api/health com o gerado_em novo.
#
# Fora do dia da eleição o job não faz nada (silencioso). O timer chama a cada
# 10 min; a decisão de trabalhar é aqui, por data, em ~/.hermes/eleicao_turno/config.json.
#
# Uso:
#   bash scripts/coleta_apuracao.sh            # respeita o dia da eleição
#   bash scripts/coleta_apuracao.sh --forcar   # roda agora, mesmo fora do dia
set -uo pipefail

PROJETO="${ELEICAO_PROJETO:-/home/pedro/eleicao2026-mapa}"
PAINEL="${ELEICAO_PAINEL:-/home/pedro/monitoramento-eleicoes-presidenciais-governo-ce}"
BASE_HERMES="${ELEICAO_BASE_HERMES:-$HOME/.hermes}"
CONFIG="$BASE_HERMES/eleicao_turno/config.json"
LOG="$BASE_HERMES/logs/eleicao-coleta.log"
SITE_JSON="$PROJETO/dados/publico.json"
PAINEL_JSON="$PAINEL/dados/publico.json"
FORCAR=0
[ "${1:-}" = "--forcar" ] && FORCAR=1

mkdir -p "$(dirname "$LOG")"
logar() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

# ------------------------------------------ limite de vida (liberar a trava)
# Uma coleta travada (rede muda, docker pendurado) não pode segurar a trava para
# sempre. Este bloco re-executa o próprio script sob `timeout` ANTES de pegar o
# flock: quando o limite estoura o processo morre e o kernel libera a trava.
# 1740 s < TimeoutStartSec=1800 do systemd (o systemd continua sendo a última linha).
LIMITE_S="${ELEICAO_LIMITE_S:-1740}"
if [ "${ELEICAO_SOB_TIMEOUT:-0}" != 1 ]; then
  export ELEICAO_SOB_TIMEOUT=1 ELEICAO_LIMITE_S="$LIMITE_S"
  timeout -k 30 "$LIMITE_S" /bin/bash "$0" "$@"
  rc=$?
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
    logar "AVISO: coleta encerrada no limite de ${LIMITE_S}s (timeout) — trava liberada"
  fi
  exit "$rc"
fi

# ---------------------------------------------------------------- dia da eleição
DIA="$(jq -r '.dia_eleicao // "2026-10-25"' "$CONFIG" 2>/dev/null || echo 2026-10-25)"
HOJE="$(date +%F)"
# Janela: o dia da eleição e as 36 h seguintes (apuração pode virar a noite e o
# dump do turno só sai no fim). Fora disso, 10 min de coleta não fazem sentido.
if [ "$FORCAR" != 1 ]; then
  if ! python3 - "$DIA" "$HOJE" <<'PY'
import sys
from datetime import date, timedelta
dia = date.fromisoformat(sys.argv[1]); hoje = date.fromisoformat(sys.argv[2])
sys.exit(0 if dia <= hoje <= dia + timedelta(hours=36) else 1)
PY
  then
    logar "fora da janela do dia da eleição (dia=$DIA hoje=$HOJE) — sem coleta"
    exit 0
  fi
fi

# ------------------------------------------------- trava de exclusão mútua (flock)
# O timer roda de 5 em 5 min e uma coleta forçada pode cair em cima: duas
# execuções reescrevendo publico.json e reiniciando a api ao mesmo tempo. A trava
# cobre coleta + publicação + restart — o fd 9 fica aberto até o script sair.
# NÃO BLOQUEANTE: se já há coleta rodando, este ciclo é PULADO (empilhar é pior:
# o dado que importa é o último do TSE, não a fila). O kernel libera a trava
# quando o dono morre; o `timeout` acima limita a vida do dono.
LOCK_DIR="$BASE_HERMES/run"
LOCK="$LOCK_DIR/eleicao-coleta.lock"
mkdir -p "$LOCK_DIR"
exec 9>>"$LOCK"                     # append: `>` truncaria o pid do dono
if ! flock -n 9; then
  dono="$(tail -1 "$LOCK" 2>/dev/null)"
  logar "outra coleta em andamento (${dono:-dono desconhecido}) — pulando este ciclo"
  exit 0
fi
truncate -s 0 "$LOCK" 2>/dev/null || true
printf 'pid=%s desde=%s\n' "$$" "$(date '+%F %T')" >&9
logar "trava adquirida: $LOCK (pid=$$)"

# ------------------------------------------------------------------- coleta TSE
cd "$PAINEL" || { logar "ERRO: repositório do painel ausente em $PAINEL"; exit 1; }
logar "coleta: iniciando (auto-detecção de turno)"

if ! timeout 900 python3 coleta_presidente.py >>"$LOG" 2>&1; then
  logar "AVISO: coleta_presidente.py saiu com erro (série pode ficar sem ponto novo)"
fi

if ! timeout 900 python3 snapshot_publico.py --saida "$PAINEL_JSON" >>"$LOG" 2>&1; then
  logar "ERRO: snapshot_publico.py falhou — nada é publicado no site"
  exit 1
fi

# --------------------------------------------------------- validação do snapshot
if [ ! -f "$PAINEL_JSON" ]; then
  logar "ERRO: $PAINEL_JSON não existe — nada a publicar"
  exit 1
fi
ELEICAO_SNAP="$(jq -r '.eleicao // ""' "$PAINEL_JSON" 2>/dev/null)"
TURNO_SNAP="$(jq -r '.turno // ""' "$PAINEL_JSON" 2>/dev/null)"
# Cuidado: em jq, `false // true` devolve TRUE (o operador // troca null E false).
# Por isso a leitura crua e o default só quando o campo não existe.
SEM_DADO="$(jq -r 'if has("sem_dado") then (.sem_dado|tostring) else "true" end' "$PAINEL_JSON" 2>/dev/null)"
CAND="$(jq -r '(.nacional.candidatos // []) | length' "$PAINEL_JSON" 2>/dev/null)"
GERADO="$(jq -r '.gerado_em // ""' "$PAINEL_JSON" 2>/dev/null)"
ELEICAO_SITE="$(sed -n 's/^ELEICAO=//p' "$PROJETO/.env" 2>/dev/null | tr -d '[:space:]')"
ELEICAO_SITE="${ELEICAO_SITE:-6257}"

logar "snapshot: eleicao=$ELEICAO_SNAP turno=$TURNO_SNAP sem_dado=$SEM_DADO candidatos=$CAND gerado_em=$GERADO"

if [ "$SEM_DADO" = "true" ] || [ "$CAND" = "0" ]; then
  logar "NÃO PUBLICA: snapshot sem voto publicado (turno zerado) — dado do site fica como está"
  exit 0
fi
if [ "$ELEICAO_SNAP" != "$ELEICAO_SITE" ]; then
  logar "NÃO PUBLICA: snapshot é da eleição $ELEICAO_SNAP e o site exibe $ELEICAO_SITE" \
        "(a tela avisa que o dado é do outro turno)"
  exit 0
fi

# ----------------------------------------------------------------- publicação
if [ -f "$SITE_JSON" ] && cmp -s "$PAINEL_JSON" "$SITE_JSON"; then
  logar "sem mudança no snapshot — site não é tocado e a api não reinicia"
  exit 0
fi

# Escrita atômica: cópia para um temporário NO MESMO diretório, flush em disco e
# rename. O rename é atômico no mesmo filesystem: quem lê (a api, o servidor)
# vê o arquivo antigo inteiro ou o novo inteiro, nunca meio arquivo.
TMP_SITE="$SITE_JSON.tmp.$$"
if ! cp "$PAINEL_JSON" "$TMP_SITE" || ! sync "$TMP_SITE" 2>/dev/null; then
  rm -f "$TMP_SITE"
  logar "ERRO: falha ao preparar $TMP_SITE — site e api não são tocados"
  exit 1
fi
if ! mv -f "$TMP_SITE" "$SITE_JSON"; then
  rm -f "$TMP_SITE"
  logar "ERRO: falha no rename para $SITE_JSON — site e api não são tocados"
  exit 1
fi
logar "publicado em $SITE_JSON (gerado_em=$GERADO)"

# ------------------------------------------------------------------- api no ar
# A api recarrega o publico.json SOZINHA (hot-reload em api/hot_reload.go: stat
# a cada 2 s + troca ATÔMICA do retrato servido). Reiniciar o container deixou
# de ser necessário — e era exatamente o que gerava 502 para quem estava com a
# página aberta durante a apuração (recreate de ~9 s, 12 janelas de erro por
# hora; medido em 25/10/2026 nos acessos de Android real).
#
# Aqui só se ESPERA o gerado_em do /api/health refletir o snapshot publicado.
API_BASE="$(jq -r '.api_base // "http://127.0.0.1:8110"' "$CONFIG" 2>/dev/null || echo http://127.0.0.1:8110)"

# gerado_em que a api está servindo agora (vazio = não respondeu).
gerado_no_ar() {
  local saude
  saude="$(curl -s -m 3 "$API_BASE/api/health" 2>/dev/null)" || { printf ''; return 0; }
  printf '%s' "$saude" | jq -r '.gerado_em // ""' 2>/dev/null
}

# Até 30 s de espera. O relógio normal é ~2–4 s (tique do vigia de 2 s + recarga
# de ~40 ms); o aviso em 10 s existe para o log mostrar que algo está lento
# ANTES de cogitar restart.
ESPERA_HOT_S=30
for i in $(seq 1 "$ESPERA_HOT_S"); do
  gerado_api="$(gerado_no_ar)"
  if [ "$gerado_api" = "$GERADO" ]; then
    logar "hot-reload confirmado: /api/health gerado_em=$GERADO em ${i}s, SEM restart da api"
    exit 0
  fi
  if [ "$i" = 10 ]; then
    logar "hot-reload ainda não refletiu em 10s (api em gerado_em=${gerado_api:-sem-resposta}) — sigo esperando sem restart até ${ESPERA_HOT_S}s"
  fi
  sleep 1
done
logar "AVISO: hot-reload não refletiu gerado_em=$GERADO em ${ESPERA_HOT_S}s — caindo no RESTART (fallback)"

# ------------------------------------------- FALLBACK: restart (só se falhou)
# O systemd roda este script com PATH enxuto (/usr/local/bin:/usr/bin:/bin) e o
# docker desta máquina é do snap (/snap/bin/docker) — resolver o binário de forma
# explícita e validar antes de chamar: com `docker` cru o restart virava rc=127
# ("docker: comando não encontrado") e o job passou 14 ticks sem reiniciar a api.
DOCKER_BIN="$(command -v docker 2>/dev/null || true)"
if [ -z "$DOCKER_BIN" ] && [ -x /snap/bin/docker ]; then
  DOCKER_BIN=/snap/bin/docker
fi
if [ -z "$DOCKER_BIN" ] || [ ! -x "$DOCKER_BIN" ]; then
  logar "ERRO DOCKER AUSENTE: binário do docker não encontrado nem em PATH=$PATH nem em /snap/bin/docker — snapshot publicado em $SITE_JSON, mas a api NÃO foi reiniciada e o hot-reload não confirmou (dado velho no ar)"
  exit 3
fi
logar "fallback: docker em $DOCKER_BIN"

saida="$(cd "$PROJETO" && "$DOCKER_BIN" compose -p eleicao2026-mapa restart api 2>&1)"
rc_restart=$?
if [ "$rc_restart" -ne 0 ]; then
  logar "ERRO RESTART API: $DOCKER_BIN compose -p eleicao2026-mapa restart api -> rc=$rc_restart ${saida//$'\n'/ }"
  exit 2
fi
logar "restart da api (fallback) -> rc=0 ${saida//$'\n'/ }"

for _ in $(seq 1 30); do
  saude="$(curl -s -m 5 "$API_BASE/api/health" 2>/dev/null)"
  gerado_api="$(printf '%s' "$saude" | jq -r '.gerado_em // ""' 2>/dev/null)"
  if [ "$gerado_api" = "$GERADO" ]; then
    logar "api servindo o snapshot novo (após restart): /api/health gerado_em=$gerado_api turno=$(printf '%s' "$saude" | jq -r '.turno')"
    exit 0
  fi
  sleep 2
done
logar "AVISO: api não confirmou gerado_em=$GERADO em 60s (última resposta: ${saude:-vazia})"
exit 1
