#!/usr/bin/env python3
"""prova_limiar.py — prova medida do limiar/isenção/allowlist do vigia.

Roda o MESMO fixture sintético de log em duas versões do vigia:

  * a versão de referência (backup anterior à mudança de 25/10, LIMITE_REQ_MIN=120);
  * a versão atual (LIMITE_REQ_MIN=1200 + rotas isentas + allowlist).

Nada toca o nginx nem o Telegram: as duas rodadas usam `--ensaio` e um
DEFESA_DIR temporário (log, estado e lista de bloqueio descartáveis).

Uso:  python3 scripts/defesa/prova_limiar.py [caminho/do/backup.py]
Saída: o que cada versão decidiu, por IP sintético, e o veredito esperado.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

AQUI = Path(__file__).resolve().parent
AGORA = datetime.now(timezone.utc)
# IPs sintéticos: nenhum deles existe no log real; são só endereços públicos
# para exercitar a decisão. 191.31.15.133 é o IP do Pedro (allowlist).
CENARIOS = (
    # (nome, ip, total de req, uri, veredito esperado na versão atual)
    ("navegacao_300", "45.33.32.11", 300, "/api/estados", "NAO bloqueia (isenção de rota + limiar 1200)"),
    ("navegacao_mista_300", "45.33.32.12", 300, "/", "NAO bloqueia (limiar 1200; antes bloqueava)"),
    ("surto_1300", "45.33.32.13", 1300, "/", "BLOQUEIA (surto 1300 >= 1200)"),
    ("isencao_1300", "45.33.32.14", 1300, "/api/health", "NAO bloqueia (rota isenta mesmo com 1300)"),
    ("allowlist_1300", "191.31.15.133", 1300, "/", "NAO bloqueia (allowlist)"),
    ("varredura_900", "45.33.32.16", 900, "/api/ufs.geojson", "NAO bloqueia (900 < 1200; antes bloqueava)"),
)


def linhas_do_cenario(ip: str, total: int, uri: str) -> list[str]:
    """Gera `total` linhas no formato do log de defesa, todas dentro de 60 s."""
    saida = []
    for indice in range(total):
        instante = AGORA - timedelta(seconds=indice % 55)
        quando = instante.strftime("%Y-%m-%dT%H:%M:%S+00:00")
        saida.append(f'{ip} {quando} 200 GET {uri} painel.belmino.dev 0 "GET {uri} HTTP/1.1" Mozilla/5.0')
    return saida


def montar_fixture(destino: Path) -> Path:
    log = destino / "acessos.log"
    with log.open("w", encoding="utf-8") as arquivo:
        for _, ip, total, uri, _veredito in CENARIOS:
            arquivo.write("\n".join(linhas_do_cenario(ip, total, uri)) + "\n")
    # Estado e lista vazios: cada rodada começa do zero.
    (destino / "estado.json").write_text("{}", encoding="utf-8")
    (destino / "bloqueios.conf").write_text("# vazio\n", encoding="utf-8")
    return log


def rodar(script: Path, defesa_dir: Path) -> list[str]:
    ambiente = dict(os.environ)
    ambiente["DEFESA_DIR"] = str(defesa_dir)
    ambiente["DEFESA_LOG"] = str(defesa_dir / "vigia.log")
    # Allowlist: a versão antiga não conhece o arquivo e o ignora sozinha.
    ambiente["DEFESA_ALLOWLIST"] = str(defesa_dir / "allowlist.txt")
    if not (defesa_dir / "allowlist.txt").exists():
        origem = AQUI.parents[1] / "var" / "defesa" / "allowlist.txt"
        if origem.exists():
            (defesa_dir / "allowlist.txt").write_text(origem.read_text(encoding="utf-8"), encoding="utf-8")
    processo = subprocess.run(
        [sys.executable, str(script), "--ensaio"],
        capture_output=True,
        text=True,
        env=ambiente,
        timeout=180,
    )
    if processo.returncode != 0:
        raise SystemExit(f"{script} falhou ({processo.returncode}):\n{processo.stderr[-2000:]}")
    return processo.stdout.splitlines()


def bloqueados(saida: list[str]) -> dict[str, str]:
    """Extrai {ip: motivo} das linhas de BLOQUEIO do ensaio."""
    achados = {}
    for linha in saida:
        if " BLOQUEIO " not in linha:
            continue
        resto = linha.split(" BLOQUEIO ", 1)[1]
        ip, _, detalhe = resto.partition(" · ")
        achados[ip.strip()] = detalhe.strip()
    return achados


def main(argv: list[str]) -> int:
    referencia = Path(argv[1]) if len(argv) > 1 else AQUI / "vigia_ataques.py.bak-20261025-antes-limiar"
    if not referencia.exists():
        print(f"sem backup de referência em {referencia}", file=sys.stderr)
        return 66
    print(f"referência (antes): {referencia.name}")
    print(f"versão atual     : {AQUI / 'vigia_ataques.py'}")
    print(f"fixture          : {sum(c[2] for c in CENARIOS)} linhas sintéticas, {len(CENARIOS)} IPs\n")

    with tempfile.TemporaryDirectory(prefix="prova-limiar-") as temporario:
        base = Path(temporario)
        montar_fixture(base)

        antes = bloqueados(rodar(referencia, base))
        depois = bloqueados(rodar(AQUI / "vigia_ataques.py", base))

    print(f"{'cenário':22} {'ip':16} {'req':>5}  {'ANTES (120/min)':16} {'AGORA (1200/min)':16} esperado")
    print("-" * 132)
    falhas = 0
    for nome, ip, total, _uri, esperado in CENARIOS:
        antes_txt = "BLOQUEIA" if ip in antes else "não bloqueia"
        depois_txt = "BLOQUEIA" if ip in depois else "não bloqueia"
        quer_bloquear = esperado.startswith("BLOQUEIA")
        ok = (ip in depois) == quer_bloquear
        falhas += 0 if ok else 1
        print(f"{nome:22} {ip:16} {total:5}  {antes_txt:16} {depois_txt:16} {'OK' if ok else 'FALHOU'} — {esperado}")

    print("\nlinhas de BLOQUEIO na rodada antiga:")
    for ip, detalhe in sorted(antes.items()):
        print(f"  {ip:16} {detalhe}")
    print("linhas de BLOQUEIO na rodada atual:")
    for ip, detalhe in sorted(depois.items()):
        print(f"  {ip:16} {detalhe}")
    if not depois:
        print("  (nenhuma)")
    print(f"\nresultado: {len(CENARIOS) - falhas}/{len(CENARIOS)} cenários no veredito esperado")
    return 0 if falhas == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
