#!/usr/bin/env bash
# regressao.sh — regressão do eleicao2026.belmino.dev
#
#   bash scripts/regressao/regressao.sh --rapido     (padrão: 6 itens, ~8 min)
#   bash scripts/regressao/regressao.sh --completo   (9 itens, ~15 min)
#   bash scripts/regressao/regressao.sh --completo --base http://127.0.0.1:8100
#
# Cada item: RODA a prova que já existe em scripts/provas/, MEDE o artefato que a
# prova produziu e CLASSIFICA:
#   PASS        o critério do CHECKLIST.json bateu, medido no artefato da rodada
#   FAIL        rodou e o critério NÃO bateu (a regressão acusou)
#   NAO_MEDIDO  não deu para medir (timeout, script ausente, artefato sem o campo
#               final, site fora do ar). NUNCA vira PASS.
#
# Grava `_provas/regressao/<AAAAMMDD-HHMM>/resultado.json` + `resumo.txt`.
# Exit: 0 sem FAIL e sem NAO_MEDIDO · 1 com FAIL · 2 com NAO_MEDIDO (sem FAIL).
set -u -o pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKLIST="$RAIZ/scripts/regressao/CHECKLIST.json"
NODE_PATH_AGENTE="${NODE_PATH_AGENTE:-/home/pedro/.hermes/hermes-agent/node_modules}"
NODE_PATH="$NODE_PATH_AGENTE"
export NODE_PATH

MODO="rapido"
BASE="${BASE:-http://127.0.0.1:8110}"
LIMIAR_PCT="${LIMIAR_PCT:-2.0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --rapido) MODO="rapido" ;;
    --completo) MODO="completo" ;;
    --base=*) BASE="${1#*=}" ;;
    --base) shift; BASE="${1:-$BASE}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $1 (use --rapido | --completo | --base URL)" >&2; exit 64 ;;
  esac
  shift
done
BASE="${BASE%/}"

[ -f "$CHECKLIST" ] || { echo "checklist ausente: $CHECKLIST" >&2; exit 64; }
command -v jq >/dev/null || { echo "jq é obrigatório" >&2; exit 64; }

cd "$RAIZ" || exit 64
SELO="$(date +%Y%m%d-%H%M)"
REL="_provas/regressao/$SELO"
PASTA="$RAIZ/$REL"
mkdir -p "$PASTA"
export RAIZ BASE LIMIAR_PCT PASTA REL

COMMIT="$(git -C "$RAIZ" rev-parse --short HEAD 2>/dev/null || echo 'sem-git')"

# pré-voo: sem o site de pé não se mede nada de runtime (os builds seguem valendo)
SITE_OK=0
CODIGO_PREVOO="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$BASE/" 2>/dev/null || echo 000)"
[ "$CODIGO_PREVOO" = "200" ] && SITE_OK=1
export SITE_OK

# ---------------------------------------------------------------- utilidades
exigir_site() {
  [ "${SITE_OK:-0}" = 1 ] && return 0
  echo "MEDIDA=nao medido: $BASE nao respondeu ao pre-voo (http=$CODIGO_PREVOO)"
  return 2
}

num_maior() { awk -v a="$1" -v b="$2" 'BEGIN{print (b+0>a+0)?b+0:a+0}'; }

# ------------------------------------------------------------------- R01
# três rotas 200 (/, /eleicao, /mapa) — curl, sem browser
prova_R01() {
  exigir_site || return 2
  local rota codigo medida="" cok=1
  for rota in / /eleicao /mapa; do
    codigo="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$BASE$rota" 2>/dev/null || echo 000)"
    medida+="$rota=$codigo "
    [ "$codigo" = "200" ] || cok=0
  done
  echo "MEDIDA=${medida% }"
  [ "$cok" = 1 ] && return 0
  return 1
}

# ------------------------------------------------------------------- R02
# mapa preservado: print de hoje x _provas/mapa_antes_* (pixels alterados)
prova_R02() {
  exigir_site || return 2
  local pref="mapa_depois" vp antes depois saida pct maior=0 medida="" rc_mapa=0
  node scripts/provas/mapa_estado.mjs --base "$BASE" --out "$PASTA" --prefix "$pref" \
    >"$PASTA/R02-mapa_estado.log" 2>&1 || rc_mapa=$?
  for vp in desktop_1440x900 mobile_390x844; do
    antes="$RAIZ/_provas/mapa_antes_${vp}.png"
    depois="$PASTA/${pref}_${vp}.png"
    if [ ! -f "$antes" ]; then
      echo "MEDIDA=referencia ausente: _provas/mapa_antes_${vp}.png"
      return 2
    fi
    if [ ! -f "$depois" ]; then
      echo "MEDIDA=print de hoje ausente para $vp (mapa_estado rc=$rc_mapa, ver R02-mapa_estado.log)"
      return 2
    fi
    saida="$(python3 scripts/provas/diff_prints.py "$antes" "$depois" --limiar 8 2>&1)"
    printf '%s\n' "$saida" >"$PASTA/R02-diff_${vp}.log"
    if printf '%s' "$saida" | grep -q 'TAMANHO DIFERENTE'; then
      echo "MEDIDA=$vp tamanho diferente do print de referencia"
      return 1
    fi
    pct="$(printf '%s\n' "$saida" | sed -n 's/.*(\([0-9.]*\)%).*/\1/p' | head -1)"
    if [ -z "$pct" ]; then
      echo "MEDIDA=$vp diff sem percentual (ver R02-diff_${vp}.log)"
      return 2
    fi
    medida+="$vp=${pct}% "
    maior="$(num_maior "$maior" "$pct")"
  done
  echo "MEDIDA=${medida% }| pior=${maior}% limiar=${LIMIAR_PCT}%"
  if awk -v a="$maior" -v l="$LIMIAR_PCT" 'BEGIN{exit !(a+0<=l+0)}'; then return 0; fi
  return 1
}

# ------------------------------------------------------------------- R03
# um rótulo por cidade (z8/z9.5/z10.5, desktop+mobile) — criterio falhas=0
prova_R03() {
  exigir_site || return 2
  node scripts/provas/rotulos.mjs --base "$BASE" --out "$PASTA" --prefix rotulos \
    >"$PASTA/R03-rotulos.log" 2>&1
  local arq="$PASTA/rotulos_resumo.json" gerado falhas cen
  [ -f "$arq" ] || { echo "MEDIDA=nao medido: rotulos_resumo.json nao foi gravado (ver R03-rotulos.log)"; return 2; }
  gerado="$(jq -r '.gerado // ""' "$arq" 2>/dev/null)"
  [ -n "$gerado" ] || { echo "MEDIDA=nao medido: resumo sem campo 'gerado' (prova morreu no meio)"; return 2; }
  falhas="$(jq -r '(.falhas // []) | length' "$arq" 2>/dev/null)"
  cen="$(jq -r '(.itens // []) | length' "$arq" 2>/dev/null)"
  [ -n "$falhas" ] || { echo "MEDIDA=nao medido: resumo sem 'falhas'"; return 2; }
  echo "MEDIDA=cenarios=$cen falhas=$falhas"
  [ "$falhas" = "0" ] && return 0
  return 1
}

# ------------------------------------------------------------------- R04
# replay funciona — replay_resumo.json ok:true e problemas vazio
prova_R04() {
  exigir_site || return 2
  node scripts/provas/replay.mjs --base "$BASE" --out "$PASTA" >"$PASTA/R04-replay.log" 2>&1
  local arq="$PASTA/replay_resumo.json" ok prob gerado
  [ -f "$arq" ] || { echo "MEDIDA=nao medido: replay_resumo.json nao foi gravado (ver R04-replay.log)"; return 2; }
  gerado="$(jq -r '.gerado // ""' "$arq" 2>/dev/null)"
  [ -n "$gerado" ] || { echo "MEDIDA=nao medido: resumo sem 'gerado' (prova morreu no meio)"; return 2; }
  ok="$(jq -r '.ok' "$arq" 2>/dev/null)"
  prob="$(jq -r '(.problemas // []) | length' "$arq" 2>/dev/null)"
  echo "MEDIDA=ok=$ok problemas=$prob gerado=$gerado"
  [ "$ok" = "true" ] && [ "$prob" = "0" ] && return 0
  return 1
}

# ------------------------------------------------------------------- R05
# margem funciona — margem_resumo.json ok:true e problemas 0
prova_R05() {
  exigir_site || return 2
  node scripts/provas/margem.mjs --base "$BASE" --out "$PASTA" >"$PASTA/R05-margem.log" 2>&1
  local arq="$PASTA/margem_resumo.json" ok prob gerado
  [ -f "$arq" ] || { echo "MEDIDA=nao medido: margem_resumo.json nao foi gravado (ver R05-margem.log)"; return 2; }
  gerado="$(jq -r '.gerado // ""' "$arq" 2>/dev/null)"
  [ -n "$gerado" ] || { echo "MEDIDA=nao medido: resumo sem 'gerado' (prova morreu no meio)"; return 2; }
  ok="$(jq -r '.ok' "$arq" 2>/dev/null)"
  prob="$(jq -r '(.problemas // []) | length' "$arq" 2>/dev/null)"
  echo "MEDIDA=ok=$ok problemas=$prob gerado=$gerado"
  [ "$ok" = "true" ] && [ "$prob" = "0" ] && return 0
  return 1
}

# ------------------------------------------------------------------- R06
# mobile sem scroll horizontal e sem dois painéis de baixo ao mesmo tempo.
# painel_unico mede scrollWidth > clientWidth e quantos painéis de baixo estão
# visíveis em cada caso (gaveta do placar OU sheet de detalhe, nunca os dois).
prova_R06() {
  exigir_site || return 2
  node scripts/provas/painel_unico.mjs --base "$BASE" --out "$PASTA" --prefix painel_unico \
    >"$PASTA/R06-painel_unico.log" 2>&1
  local arq="$PASTA/painel_unico_relatorio.json" medidas laterais duplos
  [ -f "$arq" ] || { echo "MEDIDA=nao medido: painel_unico_relatorio.json nao foi gravado (ver R06-painel_unico.log)"; return 2; }
  medidas="$(jq -r '[.. | objects | select(has("scrollLateral"))] | length' "$arq" 2>/dev/null)"
  laterais="$(jq -r '[.. | objects | select(.scrollLateral == true)] | length' "$arq" 2>/dev/null)"
  duplos="$(jq -r '[.. | objects | select((.paineisDeBaixo // 0) > 1)] | length' "$arq" 2>/dev/null)"
  [ -n "$medidas" ] && [ -n "$duplos" ] || { echo "MEDIDA=nao medido: relatorio sem 'scrollLateral'/'paineisDeBaixo'"; return 2; }
  [ "$medidas" != "0" ] || { echo "MEDIDA=nao medido: nenhuma tela medida no relatorio"; return 2; }
  echo "MEDIDA=telas_medidas=$medidas com_scroll_lateral=$laterais com_painel_duplo=$duplos"
  [ "$laterais" = "0" ] && [ "$duplos" = "0" ] && return 0
  return 1
}

# ------------------------------------------------------------------- R07
# console limpo e 0 request >=400 na /mapa
prova_R07() {
  exigir_site || return 2
  node scripts/provas/console.mjs --url "$BASE/mapa" --espera 5000 >"$PASTA/R07-console.log" 2>&1
  local erros req
  erros="$(sed -n 's/^console\.errors=\([0-9]*\)$/\1/p' "$PASTA/R07-console.log" | head -1)"
  req="$(sed -n 's/^requests>=400=\([0-9]*\)$/\1/p' "$PASTA/R07-console.log" | head -1)"
  if [ -z "$erros" ] || [ -z "$req" ]; then
    echo "MEDIDA=nao medido: console.mjs nao imprimiu os contadores (ver R07-console.log)"
    return 2
  fi
  echo "MEDIDA=console.errors=$erros requests>=400=$req"
  [ "$erros" = "0" ] && [ "$req" = "0" ] && return 0
  return 1
}

# ------------------------------------------------------------------- R08
# compila: go build ./... na api/ e npm run build no web/
prova_R08() {
  local rc_go rc_npm t0 t1 dgo dnpm
  t0="$(date +%s)"
  ( cd "$RAIZ/api" && go build ./... ) >"$PASTA/R08-go-build.log" 2>&1
  rc_go=$?
  t1="$(date +%s)"; dgo=$((t1 - t0)); t0="$(date +%s)"
  ( cd "$RAIZ/web" && npm run build ) >"$PASTA/R08-npm-build.log" 2>&1
  rc_npm=$?
  t1="$(date +%s)"; dnpm=$((t1 - t0))
  echo "MEDIDA=go_build rc=$rc_go (${dgo}s) npm_build rc=$rc_npm (${dnpm}s)"
  [ "$rc_go" = "0" ] && [ "$rc_npm" = "0" ] && return 0
  return 1
}

# ------------------------------------------------------------------- R09
# no celular não existe caixa flutuante do mapa; no desktop o hover continua.
# Le o tooltip_relatorio.json gravado por scripts/provas/tooltip_mobile.mjs.
prova_R09() {
  exigir_site || return 2
  node scripts/provas/tooltip_mobile.mjs --base "$BASE" --out "$PASTA" --prefix tooltip \
    >"$PASTA/R09-tooltip.log" 2>&1
  local arq="$PASTA/tooltip_relatorio.json" ok gerado falhas pior cel
  [ -f "$arq" ] || { echo "MEDIDA=nao medido: tooltip_relatorio.json nao foi gravado (ver R09-tooltip.log)"; return 2; }
  gerado="$(jq -r '.gerado // ""' "$arq" 2>/dev/null)"
  [ -n "$gerado" ] || { echo "MEDIDA=nao medido: relatorio sem 'gerado' (prova morreu no meio)"; return 2; }
  ok="$(jq -r '.ok' "$arq" 2>/dev/null)"
  falhas="$(jq -r '(.falhas // []) | length' "$arq" 2>/dev/null)"
  # pior contagem de .uf-tooltip-popup no celular (zona/UF/município/local)
  pior="$(jq -r '[.celular[] | ([.tooltipsDepoisDeTocarZona.total, .tooltipsDepoisDeTocarUf.total,
      .tooltipsDepoisDeTocarMunicipio.total, .tooltipsDepoisDeTocarLocal.total] | max)] | max' "$arq" 2>/dev/null)"
  cel="$(jq -r '[.desktop.tooltipsHoverZona.total, .desktop.tooltipsHoverUf.total,
      .desktop.tooltipsHoverMunicipio.total, .desktop.tooltipsHoverLocal.total] | join("/")' "$arq" 2>/dev/null)"
  echo "MEDIDA=celular_popups(pior)=$pior desktop_hover(zona/uf/municipio/local)=$cel falhas=$falhas ok=$ok"
  [ "$ok" = "true" ] && [ "$falhas" = "0" ] && return 0
  return 1
}

export -f exigir_site num_maior prova_R01 prova_R02 prova_R03 prova_R04
export -f prova_R05 prova_R06 prova_R07 prova_R08 prova_R09

# ------------------------------------------------------------------ execução
IDS="$(jq -r --arg modo "$MODO" '.itens[] | select(if $modo == "rapido" then (.rapido == true) else true end) | .id' "$CHECKLIST")"
[ -n "$IDS" ] || { echo "nenhum item selecionado para o modo $MODO" >&2; exit 64; }

: >"$PASTA/itens.ndjson"
LINHAS=()
n_pass=0; n_fail=0; n_nao=0
CABECALHO="REGRESSAO eleicao2026 $(date '+%Y-%m-%d %H:%M:%S %Z') | modo=$MODO base=$BASE commit=$COMMIT | pasta=$REL"
LINHAS+=("$CABECALHO")
[ "$SITE_OK" = 1 ] || LINHAS+=("AVISO pre-voo: $BASE nao respondeu (http=$CODIGO_PREVOO) — itens de runtime saem NAO_MEDIDO")

for id in $IDS; do
  fn="prova_$id"
  if ! declare -F "$fn" >/dev/null; then
    LINHAS+=("$(printf '%-3s %-10s %5s  %s' "$id" "NAO_MEDIDO" "-" "sem função $fn no runner")")
    n_nao=$((n_nao + 1))
    continue
  fi
  to="$(jq -r --arg id "$id" '.itens[] | select(.id == $id) | (.timeout_s // 300)' "$CHECKLIST")"
  ini="$(date +%s%3N)"
  timeout "$to" bash -c "$fn" >"$PASTA/$id.log" 2>&1
  rc=$?
  fim="$(date +%s%3N)"
  dur=$(((fim - ini) / 1000))

  case "$rc" in
    0) status="PASS" ;;
    1) status="FAIL" ;;
    2) status="NAO_MEDIDO" ;;
    124) status="NAO_MEDIDO"; echo "timeout de ${to}s estourou a prova" >>"$PASTA/$id.log" ;;
    *) status="NAO_MEDIDO" ;;
  esac

  medida="$(sed -n 's/^MEDIDA=//p' "$PASTA/$id.log" | head -1 | tr '\n' ' ' | cut -c1-300)"
  [ -n "$medida" ] || medida="não medido (rc=$rc, ver $id.log)"

  case "$status" in
    PASS) n_pass=$((n_pass + 1)) ;;
    FAIL) n_fail=$((n_fail + 1)) ;;
    *) n_nao=$((n_nao + 1)) ;;
  esac

  LINHAS+=("$(printf '%-3s %-10s %4ss  %s' "$id" "$status" "$dur" "$medida")")

  jq -nc --arg id "$id" --arg status "$status" --arg medida "$medida" --arg log "$id.log" \
    --argjson duracao "$dur" --argjson rc "$rc" \
    --arg regra "$(jq -r --arg id "$id" '.itens[] | select(.id == $id) | .regra' "$CHECKLIST")" \
    --arg prova "$(jq -r --arg id "$id" '.itens[] | select(.id == $id) | .prova' "$CHECKLIST")" \
    --arg criterio "$(jq -r --arg id "$id" '.itens[] | select(.id == $id) | .criterio' "$CHECKLIST")" \
    --arg origem "$(jq -r --arg id "$id" '.itens[] | select(.id == $id) | .origem' "$CHECKLIST")" \
    '{id: $id, status: $status, medida: $medida, duracao_s: $duracao, rc: $rc,
      regra: $regra, prova: $prova, criterio: $criterio, origem: $origem, log: $log}' \
    >>"$PASTA/itens.ndjson"
done

if [ "$n_fail" -gt 0 ]; then EXIT=1; elif [ "$n_nao" -gt 0 ]; then EXIT=2; else EXIT=0; fi

jq -n --slurpfile itens "$PASTA/itens.ndjson" \
  --arg gerado "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg modo "$MODO" --arg base "$BASE" \
  --arg commit "$COMMIT" --arg pasta "$REL" --arg pre_voo "$CODIGO_PREVOO" \
  --argjson exit "$EXIT" \
  '{gerado: $gerado, modo: $modo, base: $base, commit: $commit, pasta: $pasta,
    pre_voo_http: $pre_voo, exit: $exit,
    totais: ({PASS: 0, FAIL: 0, NAO_MEDIDO: 0} + (($itens | group_by(.status)
             | map({key: .[0].status, value: length}) | from_entries))),
    itens: $itens}' >"$PASTA/resultado.json"

LINHAS+=("TOTAIS PASS=$n_pass FAIL=$n_fail NAO_MEDIDO=$n_nao | exit=$EXIT")
printf '%s\n' "${LINHAS[@]}" | tee "$PASTA/resumo.txt"
exit "$EXIT"
