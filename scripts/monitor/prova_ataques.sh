#!/usr/bin/env bash
# prova_ataques.sh — dispara os 4 ataques de referência PELA BORDA REAL (8110)
# e confere que cada um aparece classificado no painel interno (8113).
#
#   bash scripts/monitor/prova_ataques.sh
#
# Como o visitante real faz: o túnel Cloudflare fala com 127.0.0.1:8110 e manda
# o IP do visitante em CF-Connecting-IP. Aqui o mesmo cabeçalho é enviado com um
# IP público de teste — é o caminho de código que roda em produção, não um
# atalho de teste.
set -uo pipefail

BORDA="${BORDA:-http://127.0.0.1:8110}"
PAINEL="${PAINEL:-http://127.0.0.1:8113}"
IP_TESTE="${IP_TESTE:-191.31.15.133}"
HOST_TESTE="${HOST_TESTE:-eleicao2026.belmino.dev}"

disparar() {
  local rotulo="$1" alvo="$2" extra="${3:-}"
  local codigo
  # shellcheck disable=SC2086
  codigo=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is \
    -H "Host: $HOST_TESTE" -H "CF-Connecting-IP: $IP_TESTE" \
    -A 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0' $extra \
    "$BORDA$alvo")
  printf '%-16s %-28s -> HTTP %s\n' "$rotulo" "$alvo" "$codigo"
}

echo "== disparando pela borda $BORDA como $IP_TESTE =="
disparar "arquivo sensível" "/.env"
disparar "arquivo .git"     "/.git/config"
disparar "path traversal"   "/../etc/passwd"
disparar "traversal normal" "/mapa/../etc/passwd"
disparar "admin"            "/admin"
disparar "SQLi"             "/?id=1'%20OR%20'1'='1"
disparar "scanner"          "/wp-login.php"
disparar "método"           "/mapa" "-X PROPFIND"
disparar "controle normal"  "/mapa"

sleep 2

echo
echo "== o que o painel classificou (janela 5m) =="
curl -s "$PAINEL/api/monitor/estado" | python3 -c '
import json, sys
d = json.load(sys.stdin)
j = d["janelas"]["5m"]
for r in j["ataques_reg"]:
    print("%-26s ip=%-16s host=%-28s n=%s alvo=%s" % (r["tipo"], r["ip"], r["host"], r["n"], r["caminho"]))
print("")
print("por tipo:", j["ataque_tipo"])
print("hosts:", [(h["host"], h["total"]) for h in j["hosts"]])
print("insights:", [i["texto"] for i in d["insights"]])
'
