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

cp "$PAINEL_JSON" "$SITE_JSON.tmp" && mv "$SITE_JSON.tmp" "$SITE_JSON"
logar "publicado em $SITE_JSON (gerado_em=$GERADO)"

# A api lê o arquivo UMA vez no boot: sem restart o dado novo não aparece.
saida="$(cd "$PROJETO" && docker compose -p eleicao2026-mapa restart api 2>&1)"
logar "restart da api -> $? ${saida//$'\n'/ }"

for _ in $(seq 1 30); do
  saude="$(curl -s -m 5 "$(jq -r '.api_base // "http://127.0.0.1:8110"' "$CONFIG" 2>/dev/null || echo http://127.0.0.1:8110)/api/health" 2>/dev/null)"
  gerado_api="$(printf '%s' "$saude" | jq -r '.gerado_em // ""' 2>/dev/null)"
  if [ "$gerado_api" = "$GERADO" ]; then
    logar "api servindo o snapshot novo: /api/health gerado_em=$gerado_api turno=$(printf '%s' "$saude" | jq -r '.turno')"
    exit 0
  fi
  sleep 2
done
logar "AVISO: api não confirmou gerado_em=$GERADO em 60s (última resposta: ${saude:-vazia})"
exit 1
