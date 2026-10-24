#!/usr/bin/env bash
# teste_ataques.sh — bateria de ataque contra o app do mapa (nginx + API Go).
#
# Uso:
#   scripts/seguranca/teste_ataques.sh [BASE] [TOKEN]
#     BASE          default http://127.0.0.1:8110 (site público, alvo do túnel)
#     TOKEN         token do painel privado; se omitido, lê METRICAS_TOKEN de .env
#     BASE_INTERNO  env, default http://127.0.0.1:8112 (painel, só loopback)
#     PUB           env, default https://eleicao2026.belmino.dev (borda real)
#
# DECISÃO DE 24/10 (é o que o caso [11] mede): no 127.0.0.1:8112 — porta
# publicada SÓ em loopback e fora do túnel — painel e métricas abrem SEM token.
# A barreira deixou de ser a credencial e passou a ser PORTA + CAMINHO + a marca
# X-Painel-Local que só aquele server block do nginx sabe escrever. O token
# continua valendo onde sempre importou: fora do loopback, a API responde 401
# sem a marca, MESMO com X-Real-IP/X-Forwarded-For forjados.
#
# O caso [11] prova as duas coisas de uma vez: 200 sem token no loopback e 404
# no site público — inclusive com token válido, inclusive com cabeçalho forjado.
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
PULADOS=0
FALHAS=()

cor() { case "$1" in ok) printf '\033[32m%s\033[0m' "$2";; ruim) printf '\033[31m%s\033[0m' "$2";; aviso) printf '\033[33m%s\033[0m' "$2";; *) printf '%s' "$2";; esac; }

registra_ok()   { PASS=$((PASS+1)); printf '  %s  %-38s %s\n' "$(cor ok PASS)" "$1" "${2:-}"; }
registra_falha(){ FAIL=$((FAIL+1)); FALHAS+=("$1: $2"); printf '  %s  %-38s %s\n' "$(cor ruim FAIL)" "$1" "$2"; }
# Pular não é passar: o caso não foi medido (túnel fora, compose parado, sem
# token no .env) e o número tem de aparecer no resumo para ninguém confundir
# "não medido" com "defendido".
pula()          { PULADOS=$((PULADOS+1)); printf '  %s  %-38s %s\n' "$(cor aviso SKIP)" "$1" "${2:-não medido}"; }

# status <url> [extra curl...] → código HTTP (000 quando não há conexão)
status() {
  local url="$1"; shift
  local codigo
  # Sem `|| echo 000`: o curl já imprime 000 quando a conexão é recusada, e o
  # OR concatenava os dois ("000000"), fazendo caso de recusa parecer resposta.
  codigo="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$@" "$url" 2>/dev/null)"
  printf '%s' "${codigo:0:3}"
  [ -n "${codigo:0:3}" ] || printf '000'
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

# ------------------------------------- 11. painel de métricas: decisão de 24/10
echo
echo "[11] painel de métricas: local SEM token, público sem rota"
# Decisão do Pedro (24/10): em 127.0.0.1:8112 — porta publicada SÓ em loopback
# (compose.yaml) e fora do túnel — painel e métricas abrem SEM token. A barreira
# passou a ser PORTA + CAMINHO + a marca X-Painel-Local, que só aquele server
# block do nginx escreve (proxy_set_header sobrescreve o que o cliente mandar).
# O token continua valendo fora do loopback: a API pela rede do compose responde
# 401 sem a marca — é o caso 11b, que substitui o antigo "8112 sem token → 401".
INTERNO="${BASE_INTERNO:-http://127.0.0.1:8112}"
PUB="${PUB:-https://eleicao2026.belmino.dev}"
FORJA=( -H 'X-Real-IP: 127.0.0.1' -H 'X-Forwarded-For: 127.0.0.1' )

# 11a — a decisão, medida: loopback SEM token responde 200.
espera_status "interno: métricas SEM token → 200"     "200" "$INTERNO/api/interno/metricas"
espera_status "interno: painel SEM token → 200"       "200" "$INTERNO/api/interno/painel"
espera_status "interno: token é irrelevante na 8112"  "200" "$INTERNO/api/interno/metricas?token=errado"
espera_status "interno: rota inexistente → 404"       "404" "$INTERNO/api/interno/qualquer"
corpo_sem     "interno: métricas sem IP de visitante" "189.4.1" "$INTERNO/api/interno/metricas"

# 11b — fora do loopback o token continua obrigatório (401/403). Medido de
# dentro da rede do compose: a marca não vem, e X-Real-IP/X-Forwarded-For
# forjados não convencem o Go (só o proxy escreve a marca).
if command -v docker >/dev/null 2>&1 \
   && ID_API="$(docker compose -f "$RAIZ/compose.yaml" --project-directory "$RAIZ" ps -q api 2>/dev/null)" \
   && [ -n "$ID_API" ] && [ "$(docker inspect -f '{{.State.Running}}' "$ID_API" 2>/dev/null)" = "true" ]; then
  direto() { # [opções wget...] → status da API pela rede do compose
    docker compose -f "$RAIZ/compose.yaml" --project-directory "$RAIZ" exec -T web \
      wget -q -S -O /dev/null "$@" http://api:8080/api/interno/metricas 2>&1 \
      | grep -m1 -o 'HTTP/1.1 [0-9]*' | awk '{print $2}'
  }
  checa_nao_local() { # nome, obtido
    if [ "$2" = "401" ] || [ "$2" = "403" ]; then
      registra_ok "$1" "HTTP $2"
    else
      registra_falha "$1" "HTTP ${2:-sem resposta} (esperado 401/403)"
    fi
  }
  checa_nao_local "não-loopback: API sem marca → 401/403" "$(direto)"
  checa_nao_local "não-loopback: X-Real-IP/XFF forjados" \
    "$(direto --header='X-Real-IP: 127.0.0.1' --header='X-Forwarded-For: 127.0.0.1')"
else
  pula "não-loopback: API sem marca" "compose/api fora do ar — não medido"
  pula "não-loopback: X-Real-IP/XFF forjados" "compose/api fora do ar — não medido"
fi

# 11c — BURLA pelo site público local (8110): o caminho não existe ali. 404
# seco, sem token, com cabeçalho forjado e até com X-Painel-Local: 1 — a marca
# que o Go exige não sobrevive ao server block público.
espera_status "público local: métricas SEM token → 404"       "404" "$BASE/api/interno/metricas"
espera_status "público local: painel SEM token → 404"         "404" "$BASE/api/interno/painel"
espera_status "público local: X-Real-IP/XFF forjados → 404"   "404" "$BASE/api/interno/metricas" "${FORJA[@]}"
espera_status "público local: X-Painel-Local forjado → 404"   "404" "$BASE/api/interno/metricas" -H 'X-Painel-Local: 1'
espera_status "público local: rota interna inexistente → 404" "404" "$BASE/api/interno/qualquer"

# 11d — BURLA pela borda real (túnel). O pedido passa pela Cloudflare antes do
# nginx: com CF-Connecting-IP forjado quem responde 403 é a própria borda
# (medido: server: cloudflare) e o origem nem é tocado. Por isso o caso aceita
# 403|404 — o que NÃO se aceita é 200.
if [ "$(status "$PUB/")" = "200" ]; then
  espera_status "borda: métricas SEM token → 404"        "404"     "$PUB/api/interno/metricas"
  espera_status "borda: painel SEM token → 404"          "404"     "$PUB/api/interno/painel"
  espera_status "borda: 3 cabeçalhos forjados → 403/404" "403|404" "$PUB/api/interno/metricas" \
    -H 'X-Real-IP: 127.0.0.1' -H 'X-Forwarded-For: 127.0.0.1' -H 'CF-Connecting-IP: 127.0.0.1'
  espera_status "borda: rota interna inexistente → 404"  "404"     "$PUB/api/interno/qualquer"
  if [ -n "$TOKEN" ]; then
    espera_status "borda: métricas COM token válido → 404" "404" "$PUB/api/interno/metricas?token=$TOKEN"
  else
    pula "borda: métricas COM token válido" "METRICAS_TOKEN ausente no .env"
  fi
  corpo_sem "borda: painel não entrega HTML" "Métricas · eleição 2026" "$PUB/api/interno/painel"
else
  pula "borda: casos do túnel" "$PUB não respondeu 200 em / — túnel fora?"
fi

# Painel novo: o gráfico tem de vir no HTML (SVG inline, sem CDN).
PAINEL_HTML="$(corpo "$INTERNO/api/interno/painel")"
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

# ------------------------------------------- 11e. portas: 8112 só em loopback
echo
echo "[11e] portas publicadas só em loopback"
if command -v ss >/dev/null 2>&1; then
  for PORTA in 8110 8112; do
    LINHA_PORTA="$(ss -ltnp 2>/dev/null | grep -E ":$PORTA " | head -1)"
    if printf '%s' "$LINHA_PORTA" | grep -q "127.0.0.1:$PORTA"; then
      registra_ok "porta $PORTA só em 127.0.0.1" "$(printf '%s' "$LINHA_PORTA" | awk '{print $4}')"
    else
      registra_falha "porta $PORTA só em 127.0.0.1" "não está só em loopback: ${LINHA_PORTA:-ausente}"
    fi
  done
fi
# Prova por requisição, não só por ss: o IP de LAN desta máquina tem de dar
# recusa de conexão (000). Se responder, o painel está exposto na rede local.
IP_LAN="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -n "$IP_LAN" ]; then
  COD_LAN="$(status "http://$IP_LAN:8112/api/interno/metricas")"
  if [ "$COD_LAN" = "000" ]; then
    registra_ok "8112 inalcançável pelo IP de LAN" "$IP_LAN: recusa de conexão"
  else
    registra_falha "8112 inalcançável pelo IP de LAN" "HTTP $COD_LAN em http://$IP_LAN:8112 (esperado 000)"
  fi
fi

# ------------------------------------- 11f. borda Cloudflare: nunca bloqueada
echo
echo "[11f] borda Cloudflare: fora do bloqueio automático e do escore"
# Trava ip_borda. O defeito medido em 24/10: 2a06:98c0:3600::103 (a borda) virou
# "suspeito 35". IP de borda não é visitante, é o caminho do visitante: bloquear
# ou acusar a borda derruba o site para todo mundo. Aqui se prova, com o próprio
# módulo: (a) reconhece a faixa, (b) decidir() não devolve a borda nem com surto
# absurdo, (c) o escore registra a borda à parte e não a avalia, (d) --bloquear
# recusa e não escreve na lista.
PROVA_BORDA="$(mktemp)"
VIGIA="$RAIZ/scripts/defesa/vigia_ataques.py"
cat > "$PROVA_BORDA" <<'PY'
import importlib.util
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

caminho = sys.argv[1]
# Log do vigia durante a prova vai para arquivo temporário: prova não suja journal.
os.environ.setdefault("DEFESA_LOG", os.path.join(tempfile.mkdtemp(), "prova.log"))
espec = importlib.util.spec_from_file_location("vigia", caminho)
vigia = importlib.util.module_from_spec(espec)
espec.loader.exec_module(vigia)

BORDA = "2a06:98c0:3600::103"     # a linha real de 24/10 em belmino.dev
VISITANTE = "191.31.15.133"       # controle: IP público de visitante
falhas = []

if not vigia.ip_borda(BORDA):
    falhas.append(f"ip_borda({BORDA}) = False")
if vigia.ip_borda(VISITANTE):
    falhas.append(f"visitante {VISITANTE} tratado como borda")

# decidir(): surto absurdo da borda não vira bloqueio; o visitante vira.
resumo = {
    BORDA: {"req60": 99999, "c429": 900, "suspeitos": 900, "exemplo": "GET /wp-admin/install.php", "metodo": "GET"},
    VISITANTE: {"req60": 99999, "c429": 0, "suspeitos": 0, "exemplo": "", "metodo": "GET"},
}
decididos = [d["ip"] for d in vigia.decidir(resumo)]
if BORDA in decididos:
    falhas.append("decidir() bloquearia a borda")
if VISITANTE not in decididos:
    falhas.append("decidir() não bloqueou o visitante (controle)")

# Escore: a borda fica registrada à parte e nunca é avaliada.
estado: dict = {}
linhas = [
    f'{BORDA} 2026-10-24T12:34:31-03:00 404 GET /.env belmino.dev 0 "GET /.env HTTP/1.1" curl',
    f'{BORDA} 2026-10-24T12:34:33-03:00 404 GET /wp-admin/install.php belmino.dev 0 "GET /wp-admin/install.php HTTP/1.1" curl',
    f'{VISITANTE} 2026-10-24T12:35:10+00:00 404 GET /.env - -',
]
agora = datetime(2026, 10, 24, 15, 40, tzinfo=timezone(timedelta(hours=-3)))
avaliados = vigia.acumular_suspeitas(linhas, estado, agora)
if BORDA in avaliados:
    falhas.append("borda entrou no escore de suspeita")
if VISITANTE not in avaliados:
    falhas.append("visitante não entrou no escore (controle)")
if BORDA not in ((estado.get("borda") or {}).get("ips") or {}):
    falhas.append("borda não ficou registrada à parte no estado")

print(" · ".join(falhas) if falhas else "ok")
sys.exit(1 if falhas else 0)
PY
SAIDA_BORDA="$(python3 "$PROVA_BORDA" "$VIGIA" 2>&1)" && COD_BORDA=0 || COD_BORDA=$?
if [ "$COD_BORDA" -eq 0 ]; then
  registra_ok "borda CF: trava ip_borda (decisão + escore)" "fora do bloqueio e do escore"
else
  registra_falha "borda CF: trava ip_borda (decisão + escore)" "${SAIDA_BORDA:-sem saída}"
fi
rm -f "$PROVA_BORDA"

ANTES_BLOQ="$(sha256sum "$RAIZ/var/defesa/bloqueios.conf" 2>/dev/null | awk '{print $1}')"
SAIDA_CLI="$(python3 "$VIGIA" --bloquear 2a06:98c0:3600::103 --motivo 'prova automatizada' 2>&1)" && COD_CLI=0 || COD_CLI=$?
DEPOIS_BLOQ="$(sha256sum "$RAIZ/var/defesa/bloqueios.conf" 2>/dev/null | awk '{print $1}')"
if [ "$COD_CLI" -ne 0 ] \
   && printf '%s' "$SAIDA_CLI" | grep -qi 'BORDA' \
   && [ "$ANTES_BLOQ" = "$DEPOIS_BLOQ" ] \
   && ! grep -q '2a06:98c0:3600::103' "$RAIZ/var/defesa/bloqueios.conf" 2>/dev/null; then
  registra_ok "borda CF: --bloquear recusa" "exit $COD_CLI · lista intacta"
else
  registra_falha "borda CF: --bloquear recusa" "exit $COD_CLI · $(printf '%s' "$SAIDA_CLI" | tr '\n' ' ' | head -c 120)"
fi

# ------------------------------------------------ 11g. defesa automática (vigia)
echo
echo "[11g] defesa automática (vigia de ataques)"
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
printf ' resumo: %s passaram · %s falharam · %s pulados\n' "$PASS" "$FAIL" "$PULADOS"
if [ "$FAIL" -gt 0 ]; then
  echo " falhas:"
  for LINHA in "${FALHAS[@]}"; do echo "   - $LINHA"; done
  echo "=============================================================="
  exit 1
fi
echo " todos os casos passaram"
echo "=============================================================="
exit 0
