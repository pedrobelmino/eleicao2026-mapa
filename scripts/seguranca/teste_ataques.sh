#!/usr/bin/env bash
# teste_ataques.sh — bateria de ataque contra o app do mapa (nginx + API Go).
#
# Uso:
#   scripts/seguranca/teste_ataques.sh [BASE] [TOKEN]
#     BASE         default http://127.0.0.1:8110 (site público, também o alvo
#                  do túnel quando rodado com https://eleicao2026.belmino.dev)
#     TOKEN        token do painel privado; se omitido, lê METRICAS_TOKEN de .env
#     BASE_INTERNO default http://127.0.0.1:8112 (painel privado, só loopback)
#
# O caso [11] prova as duas coisas de uma vez: o painel responde 200 na porta
# interna e 404 no site público, MESMO com token válido.
#
# Cada caso imprime PASS/FAIL com o motivo. Sai com código 1 se algo falhar.
# Nada aqui altera estado: só dispara requisição e olha a resposta.
#
# ORDEM IMPORTA: o flood é o ÚLTIMO caso. Ele satura o balde do IP no nginx
# (limit_req), e os casos seguintes receberiam 429 e falhariam sem ter falha.

set -uo pipefail

BASE="${1:-http://127.0.0.1:8110}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOKEN="${2:-}"
if [ -z "$TOKEN" ] && [ -r "$RAIZ/.env" ]; then
  TOKEN="$(grep -oP '^METRICAS_TOKEN=\K.*' "$RAIZ/.env" | head -1 | tr -d '"'"'"'')"
fi

PASS=0
FAIL=0
FALHAS=()

cor() { case "$1" in ok) printf '\033[32m%s\033[0m' "$2";; ruim) printf '\033[31m%s\033[0m' "$2";; *) printf '%s' "$2";; esac; }

registra_ok()   { PASS=$((PASS+1)); printf '  %s  %-38s %s\n' "$(cor ok PASS)" "$1" "${2:-}"; }
registra_falha(){ FAIL=$((FAIL+1)); FALHAS+=("$1: $2"); printf '  %s  %-38s %s\n' "$(cor ruim FAIL)" "$1" "$2"; }

# status <url> [extra curl...] → código HTTP
status() {
  local url="$1"; shift
  curl -s -o /dev/null -m 8 -w '%{http_code}' "$@" "$url" 2>/dev/null || echo "000"
}

# corpo <url> → corpo da resposta
corpo() {
  local url="$1"; shift
  curl -s -m 8 "$@" "$url" 2>/dev/null
}

espera_status() { # nome, esperado(s) separados por |, url, extra...
  local nome="$1" esperados="$2" url="$3"; shift 3
  local obtido; obtido="$(status "$url" "$@")"
  if [[ "|$esperados|" == *"|$obtido|"* ]]; then
    registra_ok "$nome" "HTTP $obtido"
  else
    registra_falha "$nome" "HTTP $obtido (esperado $esperados) em $url"
  fi
}

# corpo_sem <nome> <termo proibido> <url> [extra...] → PASS se o termo não aparece
corpo_sem() {
  local nome="$1" proibido="$2" url="$3"; shift 3
  local texto; texto="$(corpo "$url" "$@")"
  if printf '%s' "$texto" | grep -qiF -- "$proibido"; then
    registra_falha "$nome" "corpo contém \"$proibido\""
  else
    registra_ok "$nome" "sem \"$proibido\""
  fi
}

echo "=============================================================="
echo " bateria de ataque — $BASE"
echo " $(date '+%Y-%m-%d %H:%M:%S %z')  curl $(curl --version | head -1 | awk '{print $2}')"
echo "=============================================================="

# Descanso de 8 s: se a bateria rodou agora há pouco, o balde do IP ainda está
# vazio (o flood do caso 12 é de propósito). 40 req/s → 8 s devolvem 320 fichas.
sleep 8

# ------------------------------------------------------------------ 1. cabeçalhos
echo
echo "[1] cabeçalhos de segurança (curl -I /)"
CABECALHOS="$(curl -sSI -m 8 "$BASE/" 2>/dev/null)"

checa_cabecalho() { # nome, trecho esperado (regex, case-insensitive)
  local obtido
  obtido="$(printf '%s' "$CABECALHOS" | grep -i "^$1:" | head -1 | tr -d '\r')"
  if [ -z "$obtido" ]; then
    registra_falha "header $1" "ausente"
  elif printf '%s' "$obtido" | grep -qiE -- "$2"; then
    registra_ok "header $1" "${obtido:0:60}"
  else
    registra_falha "header $1" "valor inesperado: ${obtido:0:80}"
  fi
}

checa_cabecalho "Strict-Transport-Security" "max-age=[0-9]{8,}"
checa_cabecalho "Content-Security-Policy"     "default-src 'self'"
checa_cabecalho "Content-Security-Policy"     "frame-ancestors"
checa_cabecalho "X-Content-Type-Options"      "^X-Content-Type-Options: *nosniff"
checa_cabecalho "Referrer-Policy"             "strict-origin-when-cross-origin|no-referrer"
checa_cabecalho "X-Frame-Options"             "SAMEORIGIN|DENY"
checa_cabecalho "Permissions-Policy"          "geolocation=\(\)"

# Server não pode revelar versão: "nginx/1.29.7" é vazamento, "nginx" não é.
SERVIDOR="$(printf '%s' "$CABECALHOS" | grep -i '^Server:' | head -1 | tr -d '\r')"
if printf '%s' "$SERVIDOR" | grep -qE '/[0-9]+\.[0-9]+'; then
  registra_falha "header Server sem versão" "vazou: $SERVIDOR"
else
  registra_ok "header Server sem versão" "${SERVIDOR:-ausente}"
fi

# --------------------------------------------------------------- 2. injeção SQL
echo
echo "[2] injeção SQL"
espera_status "SQL no caminho (aspas)"        "400|404" "$BASE/api/uf/SP%27%20OR%201%3D1/municipios"
espera_status "SQL em parâmetro (modo)"       "400|404" "$BASE/api/replay?modo=2022%27%3B%20DROP%20TABLE%20visitas%3B--"
espera_status "SQL em parâmetro (cd)"         "400|404" "$BASE/api/uf/SP/locais?cd=1%20OR%201%3D1"
corpo_sem     "SQL não vaza erro no corpo"    "SQLITE"  "$BASE/api/replay?modo=2022%27"
corpo_sem     "SQL não vaza erro no corpo"    "syntax error" "$BASE/api/uf/SP/locais?cd=1%27"

# ------------------------------------------------------------------- 3. injeção JS
echo
echo "[3] injeção de JavaScript"
espera_status "XSS em parâmetro (cd)"         "400|404" "$BASE/api/uf/SP/locais?cd=%3Cscript%3Ealert(1)%3C%2Fscript%3E"
espera_status "XSS em parâmetro (modo)"       "400|404" "$BASE/api/replay?modo=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"
corpo_sem     "XSS não ecoado no corpo"       "<script>" "$BASE/api/uf/SP/locais?cd=%3Cscript%3Ealert(1)%3C%2Fscript%3E"
espera_status "XSS no caminho"                "400|404" "$BASE/api/uf/%3Cscript%3E/municipios"

# --------------------------------------------------------------- 4. path traversal
echo
echo "[4] path traversal"
espera_status "travessia simples"             "400|404" --path-as-is "$BASE/api/uf/../../dados/publico.json"
espera_status "travessia até dados/"          "400|404" --path-as-is "$BASE/api/uf/SP/../../dados/municipios.json"
espera_status "travessia codificada"          "400|404" "$BASE/api/uf/%2e%2e%2f%2e%2e%2fdados%2fpublico.json"
espera_status "travessia para /etc/passwd"    "400|404" --path-as-is "$BASE/api/../../../../etc/passwd"
corpo_sem     "travessia não serve rotas"     "UF" "$BASE/api/uf/%2e%2e%2f%2e%2e%2fdados%2fpublico.json"
corpo_sem     "travessia não serve /etc"      "root:x:" --path-as-is "$BASE/api/../../../../etc/passwd"

# ------------------------------------------------------------- 5. header injection
echo
echo "[5] injeção de cabeçalho (CRLF)"
# curl recusa CR/LF em -H; a requisição vai crua pelo /dev/tcp.
PORTA="${BASE##*:}"; PORTA="${PORTA%%/*}"
HOST_BASE="${BASE#*://}"; HOST_BASE="${HOST_BASE%%:*}"
CRUA="$(printf 'GET /api/estados HTTP/1.1\r\nHost: alvo\r\nX-Teste: valor\rInjetado: 1\r\nConnection: close\r\n\r\n' \
  | timeout 6 bash -c "exec 3<>/dev/tcp/${HOST_BASE}/${PORTA}; cat >&3; head -c 400 <&3" 2>/dev/null)"
if printf '%s' "$CRUA" | grep -qi '^Injetado:'; then
  registra_falha "CRLF não cria cabeçalho" "resposta trouxe o cabeçalho injetado"
elif printf '%s' "$CRUA" | grep -qE 'HTTP/1\.[01] 400'; then
  registra_ok "CRLF recusado com 400" "nginx barrou a requisição"
elif printf '%s' "$CRUA" | grep -qE 'HTTP/1\.[01] 200'; then
  registra_ok "CRLF não injetou cabeçalho" "200 sem o cabeçalho injetado"
else
  registra_falha "CRLF não cria cabeçalho" "resposta inesperada: $(printf '%s' "$CRUA" | head -1)"
fi

# --------------------------------------------------------------- 6. payload gigante
echo
echo "[6] payload gigante"
GRANDE="$(mktemp)"
head -c 2097152 /dev/zero | tr '\0' 'A' > "$GRANDE"
espera_status "POST com 2 MB"                 "413|400|405|431" "$BASE/api/estados" -X POST --data-binary @"$GRANDE"
espera_status "GET com corpo de 2 MB"         "413|400|405|431" "$BASE/api/estados" -X GET --data-binary @"$GRANDE"
espera_status "URI gigante"                   "414|400|431"     "$BASE/api/estados?x=$(head -c 4096 /dev/zero | tr '\0' 'a')"
rm -f "$GRANDE"

# ------------------------------------------------------------- 7. métodos HTTP
echo
echo "[7] métodos não permitidos"
for METODO in POST PUT DELETE PATCH TRACE OPTIONS; do
  espera_status "método $METODO"              "405|400|403|501" "$BASE/api/estados" -X "$METODO"
done

# ------------------------------------------------------- 8. arquivo de dados direto
echo
echo "[8] acesso direto a arquivo de dados"
for CAMINHO in /dados/publico.json /.env /.git/config /nginx.conf /api/api /metricas/visitas.db; do
  obtido="$(status "$BASE$CAMINHO")"
  if [[ "$obtido" == "403" || "$obtido" == "404" ]]; then
    registra_ok "arquivo $CAMINHO" "HTTP $obtido"
  else
    registra_falha "arquivo $CAMINHO" "HTTP $obtido (esperado 403/404)"
  fi
done
# Caminho que parece arquivo de dados fora de /dados/ cai no index.html do SPA
# (200). O teste então olha o CONTEÚDO: se o index viesse com dado junto, era vazamento.
for CAMINHO in /publico.json /municipios.json /secoes_SP.json; do
  CODIGO="$(status "$BASE$CAMINHO")"
  if [[ "$CODIGO" == "403" || "$CODIGO" == "404" ]]; then
    registra_ok "arquivo $CAMINHO" "HTTP $CODIGO"
  elif [ "$CODIGO" = "200" ] && ! corpo "$BASE$CAMINHO" | grep -qE '"gerado_em"|"candidatos"|"secoes"|"locais"'; then
    registra_ok "arquivo $CAMINHO" "HTTP 200 = index.html do SPA, sem dado"
  else
    registra_falha "arquivo $CAMINHO" "HTTP $CODIGO entregou conteúdo de dados"
  fi
done
corpo_sem "dados não expostos" "gerado_em" "$BASE/dados/publico.json"

# ------------------------------------------------------- 9. listagem de diretório
echo
echo "[9] listagem de diretório"
for DIR in /dados/ /dados /assets/ /api/uf/ /metricas/; do
  TEXTO="$(corpo "$BASE$DIR")"
  if printf '%s' "$TEXTO" | grep -qi 'Index of\|<pre>\|Directory listing'; then
    registra_falha "listagem $DIR" "respondeu listagem de diretório"
  else
    registra_ok "listagem $DIR" "sem listagem (HTTP $(status "$BASE$DIR"))"
  fi
done

# ---------------------------------------------------------- 10. 404 sem stack
echo
echo "[10] 404 sem vazamento de stack"
CODIGO_404="$(status "$BASE/api/nao-existe")"
if [[ "$CODIGO_404" == "404" ]]; then
  registra_ok "404 em rota inexistente" "HTTP 404"
else
  registra_falha "404 em rota inexistente" "HTTP $CODIGO_404"
fi
for TERMO in goroutine "panic:" "/home/pedro" ".go:" "sql:"; do
  corpo_sem "404 sem $TERMO" "$TERMO" "$BASE/api/nao-existe"
done

# ------------------------------------------------------- 11. painel privado (token)
echo
echo "[11] painel de métricas privado (token + porta fechada)"
# O painel mora em 127.0.0.1:8112 (servidor nginx separado, fora do túnel).
# No BASE (o site público) as rotas internas NÃO existem: 404 sempre, mesmo
# com token válido — a credencial não é a única barreira, o caminho também não.
INTERNO="${BASE_INTERNO:-http://127.0.0.1:8112}"
if [ -z "$TOKEN" ]; then
  registra_ok "token ausente no .env" "casos de token pulados (defina METRICAS_TOKEN em .env)"
else
  espera_status "interno: sem token → 401/403"    "401|403" "$INTERNO/api/interno/metricas"
  espera_status "interno: token errado → 401/403" "401|403" "$INTERNO/api/interno/metricas?token=errado"
  espera_status "interno: token certo → 200"      "200"     "$INTERNO/api/interno/metricas?token=$TOKEN"
  espera_status "interno: painel HTML → 200"      "200"     "$INTERNO/api/interno/painel?token=$TOKEN"
  corpo_sem     "interno: métricas sem IP claro"  "189.4.1" "$INTERNO/api/interno/metricas?token=$TOKEN"

  if [ "$INTERNO" != "$BASE" ]; then
    espera_status "público: painel com token → 404"     "404" "$BASE/api/interno/painel?token=$TOKEN"
    espera_status "público: métricas com token → 404"   "404" "$BASE/api/interno/metricas?token=$TOKEN"
    espera_status "público: interno sem token → 404"    "404" "$BASE/api/interno/metricas"
    espera_status "público: interno inexistente → 404"  "404" "$BASE/api/interno/qualquer"
    corpo_sem     "público: painel não entrega HTML"    "Métricas · eleição 2026" "$BASE/api/interno/painel?token=$TOKEN"
  else
    registra_ok "público x interno" "mesma base: casos de isolamento pulados"
  fi

  # Painel novo: o gráfico tem de vir no HTML (SVG inline, sem CDN).
  PAINEL_HTML="$(corpo "$INTERNO/api/interno/painel?token=$TOKEN")"
  if printf '%s' "$PAINEL_HTML" | grep -q '<svg'; then
    registra_ok "painel: gráfico SVG presente" "$(printf '%s' "$PAINEL_HTML" | grep -c '<svg') svg inline"
  else
    registra_falha "painel: gráfico SVG presente" "nenhum <svg> no painel"
  fi
  if printf '%s' "$PAINEL_HTML" | grep -qE '<script|https?://[a-z]'; then
    registra_falha "painel: sem script/CDN externo" "achou script ou URL externa"
  else
    registra_ok "painel: sem script/CDN externo" "self-contained"
  fi
fi

# ------------------------------------------------ 11b. defesa automática (vigia)
echo
echo "[11b] defesa automática (vigia de ataques)"
VIGIA="$RAIZ/scripts/defesa/vigia_ataques.py"
AUTOTESTE="$(mktemp)"
if python3 "$VIGIA" --autoteste >"$AUTOTESTE" 2>&1; then
  registra_ok "vigia: privado/loopback nunca bloqueado" "$(grep -c 'PASS' "$AUTOTESTE") PASS · $(grep -c 'FAIL' "$AUTOTESTE" || true) FAIL"
else
  registra_falha "vigia: privado/loopback nunca bloqueado" "$(tail -2 "$AUTOTESTE" | tr '\n' ' ')"
fi
rm -f "$AUTOTESTE"

if grep -Ev '^[[:space:]]*#' "$RAIZ/var/defesa/bloqueios.conf" 2>/dev/null \
     | grep -qE '^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|::1)'; then
  registra_falha "lista de bloqueio sem faixa privada" "lista em vigor tem IP privado/loopback"
else
  registra_ok "lista de bloqueio sem faixa privada" "só IP público (ou vazia)"
fi

# porta do painel publicada só em loopback
if command -v ss >/dev/null 2>&1; then
  LINHA_PAINEL="$(ss -ltnp 2>/dev/null | grep -E ':8112 ' | head -1)"
  if printf '%s' "$LINHA_PAINEL" | grep -q '127.0.0.1:8112'; then
    registra_ok "painel em 127.0.0.1:8112" "$(printf '%s' "$LINHA_PAINEL" | awk '{print $4}')"
  else
    registra_falha "painel em 127.0.0.1:8112" "não está escutando só em loopback: ${LINHA_PAINEL:-ausente}"
  fi
fi

# ------------------------------------------------------------------ 12. flood
echo
echo "[12] flood (último caso: satura o balde do IP de propósito)"
FLOOD_TOTAL=300
FLOOD_429=0
FLOOD_5XX=0
FLOOD_OUTROS=0
for _ in $(seq 1 "$FLOOD_TOTAL"); do
  CODIGO="$(status "$BASE/api/estados")"
  case "$CODIGO" in
    200) : ;;
    429) FLOOD_429=$((FLOOD_429+1)) ;;
    5*)  FLOOD_5XX=$((FLOOD_5XX+1)) ;;
    *)   FLOOD_OUTROS=$((FLOOD_OUTROS+1)) ;;
  esac
done
echo "     $FLOOD_TOTAL requisições → 429: $FLOOD_429 · 5xx: $FLOOD_5XX · outros: $FLOOD_OUTROS"
if [ "$FLOOD_429" -eq 0 ]; then
  registra_falha "flood recebe 429" "nenhuma recusa em $FLOOD_TOTAL requisições"
else
  registra_ok "flood recebe 429" "$FLOOD_429/$FLOOD_TOTAL recusadas"
fi
if [ "$FLOOD_5XX" -ne 0 ]; then
  registra_falha "flood não derruba o app" "$FLOOD_5XX respostas 5xx"
else
  registra_ok "flood não derruba o app" "nenhum 5xx"
fi

# ------------------------------------------------------------------- resumo
echo
echo "=============================================================="
printf ' resumo: %s passaram · %s falharam\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo " falhas:"
  for LINHA in "${FALHAS[@]}"; do echo "   - $LINHA"; done
  echo "=============================================================="
  exit 1
fi
echo " todos os casos passaram"
echo "=============================================================="
exit 0
