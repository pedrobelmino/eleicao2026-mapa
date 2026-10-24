#!/usr/bin/env bash
# prova_bloqueio.sh — prova ponta a ponta da defesa automática (item 3).
#
# Ataca 127.0.0.1:8110 com um IP público FORJADO no cabeçalho que o nginx
# confia (CF-Connecting-IP, vindo de 127.0.0.1) e mostra, em ordem:
#
#   antes passa → surto → vigia bloqueia → atacante recebe 403 → outro IP
#   público continua 200 → loopback e faixa privada intactos → desbloqueio
#   manual devolve o acesso.
#
# Uso: bash scripts/defesa/prova_bloqueio.sh [N]
#   N = tamanho do surto (default 200). IPs de teste não são reais.
#
# O Telegram é o de verdade: o canal do Pedro recebe o aviso do bloqueio.
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8110}"
ATACANTE="${ATACANTE:-45.22.33.44}"
INOCENTE="${INOCENTE:-45.22.33.45}"
PRIVADO="${PRIVADO:-192.168.0.10}"
N="${1:-200}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VIGIA="$RAIZ/scripts/defesa/vigia_ataques.py"

pedir() { # ip, caminho → código HTTP, forjando o IP de origem
  curl -s -o /dev/null -m 8 -w '%{http_code}' -H "CF-Connecting-IP: $1" "$BASE$2" 2>/dev/null || echo 000
}
pedir_local() { # sem cabeçalho: o IP real é 127.0.0.1
  curl -s -o /dev/null -m 8 -w '%{http_code}' "$BASE$1" 2>/dev/null || echo 000
}

echo "=============================================================="
echo " prova da defesa automática — $(date '+%Y-%m-%d %H:%M:%S %z')"
echo " atacante=$ATACANTE  inocente=$INOCENTE  privado=$PRIVADO  surto=$N"
echo "=============================================================="

echo
echo "[0] antes de qualquer surto"
echo "    atacante  $ATACANTE      → $(pedir "$ATACANTE" /api/estados)"
echo "    127.0.0.1 (sem header)   → $(pedir_local /api/estados)"

echo
echo "[1] surto: $N requisições de $ATACANTE contra /api/estados"
fim=$(( $(date +%s) + 120 ))
ok=0; limite=0; outro=0
for _ in $(seq 1 "$N"); do
  codigo="$(pedir "$ATACANTE" /api/estados)"
  case "$codigo" in
    200) ok=$((ok+1)) ;;
    429) limite=$((limite+1)) ;;
    *) outro=$((outro+1)) ;;
  esac
  [ "$(date +%s)" -gt "$fim" ] && break
done
echo "    resultado do surto: 200=$ok · 429=$limite · outros=$outro"

echo
echo "[2] vigia rodando o ciclo agora"
python3 "$VIGIA" --forcar 2>&1 | sed 's/^/    /'

echo
echo "[3] depois do bloqueio"
echo "    atacante  $ATACANTE      → $(pedir "$ATACANTE" /api/estados)   (esperado 403)"
echo "    atacante  home           → $(pedir "$ATACANTE" /)             (esperado 403)"
echo "    outro público $INOCENTE  → $(pedir "$INOCENTE" /api/estados)   (esperado 200)"
echo "    outro público home       → $(pedir "$INOCENTE" /)             (esperado 200)"
echo "    127.0.0.1 (sem header)   → $(pedir_local /api/estados)         (esperado 200)"
echo "    127.0.0.1 home           → $(pedir_local /)                    (esperado 200)"
echo "    privado $PRIVADO       → $(pedir "$PRIVADO" /api/estados)      (esperado 200)"

echo
echo "[4] lista de bloqueio em vigor (var/defesa/bloqueios.conf)"
grep -v '^#' "$RAIZ/var/defesa/bloqueios.conf" | grep -v '^$' | sed 's/^/    /' || echo "    (vazia)"

echo
echo "[5] trava de faixa privada: nenhum IP privado/loopback na lista"
if grep -v '^#' "$RAIZ/var/defesa/bloqueios.conf" | grep -Ev '^$' | grep -qE '^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|::1|fe80|fc00)'; then
  echo "    FALHOU: a lista contém faixa privada"
else
  echo "    PASS: só IP público na lista"
fi

echo
echo "[6] estado do vigia"
python3 "$VIGIA" --status 2>&1 | sed 's/^/    /'

echo
echo "[7] desbloqueio manual (reversível)"
bash "$RAIZ/scripts/defesa/desbloquear.sh" "$ATACANTE" 2>&1 | tail -1 | sed 's/^/    /'
echo "    atacante volta       → $(pedir "$ATACANTE" /api/estados)      (esperado 200)"
echo "=============================================================="
