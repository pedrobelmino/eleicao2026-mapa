#!/usr/bin/env python3
"""prova_antispam.py — prova do anti-spam do Telegram com o CICLO REAL.

O que este script faz: roda `vigia_ataques.ciclo()` de verdade (lê o log, agrega,
decide, aplica, "envia" Telegram) numa pasta temporária, com três coisas
injetadas:

  * relógio falso (`vigia.agora`) — permite "esperar" 6 h em milissegundos;
  * Telegram falso — cada mensagem é capturada em memória, não sai do host;
  * nginx falso — `recarregar_nginx` devolve ok sem tocar em container.

Nada da produção é lido nem escrito: log, estado, lista de bloqueio e log do
vigia vão todos para o diretório temporário.

Cenário (o defeito de 24/10 e a correção):
  18:00        1º surto de 45.22.33.44  → 1 mensagem (BLOQUEADO)
  18:10        2º surto do MESMO IP     → 0 mensagem  (antes: "RENOVAÇÃO")
  00:01 (+6h)  mesmo IP de volta         → 1 mensagem nova

Uso: python3 scripts/defesa/prova_antispam.py [-v]
Saída: PASS/FAIL por caso e código de saída 0 só se tudo passar.
"""

from __future__ import annotations

import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vigia_ataques as vigia  # noqa: E402

FUSO = vigia.FUSO
IP = "45.22.33.44"
N = 130  # > LIMITE_REQ_MIN (120) dentro da janela de 60 s = surto

UAS = [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
]
# Caminhos legítimos e variados: nada de padrão sensível, nada de 500. O surto
# é por VOLUME — que é exatamente o que derruba site e o que o vigia bloqueia.
CAMINHOS = ["/mapa", "/api/estados", "/", "/api/municipios/2304400"]


def linha(ip: str, quando: datetime, indice: int) -> str:
    caminho = CAMINHOS[indice % len(CAMINHOS)]
    ua = UAS[indice % len(UAS)]
    return (
        f'{ip} {quando.isoformat(timespec="seconds")} 200 GET {caminho} belmino.dev 0 '
        f'"GET {caminho} HTTP/1.1" {ua}'
    )


def novo_estado() -> dict:
    return {"offset": 0, "bloqueios": {}, "total_bloqueios": 0}


def main(argv: list[str]) -> int:
    verbose = "-v" in argv[1:]
    falhas = 0
    enviados: list[str] = []
    relogio = {"agora": datetime(2026, 10, 24, 18, 0, tzinfo=FUSO)}

    def telegram_falso(texto: str, ensaio: bool = False):
        enviados.append(texto)
        return True, "capturado em memória (prova)"

    def nginx_falso():
        return True, "stub da prova (nenhum container tocado)"

    def conferir(rotulo: str, obtido, esperado) -> None:
        nonlocal falhas
        ok = obtido == esperado
        print(f"  {'PASS' if ok else 'FAIL'}  {rotulo:52} {obtido!r} (esperado {esperado!r})")
        falhas += 0 if ok else 1

    with tempfile.TemporaryDirectory(prefix="prova-antispam-") as tmp:
        base = Path(tmp)
        vigia.DEFESA_DIR = base
        vigia.ARQ_LOG = base / "acessos.log"
        vigia.ARQ_BLOQUEIOS = base / "bloqueios.conf"
        vigia.ARQ_ESTADO = base / "estado.json"
        vigia.LOG_VIGIA = base / "vigia.log"
        vigia.agora = lambda: relogio["agora"]
        vigia.telegram = telegram_falso
        vigia.recarregar_nginx = nginx_falso
        vigia.ARQ_LOG.write_text("", encoding="utf-8")

        print("prova do anti-spam — ciclo real, relógio injetado, Telegram em memória")
        print(f"  log/estado/lista: {base}")
        print(f"  Telegram real: NÃO usado · nginx: NÃO tocado\n")

        def rodada(quando: datetime, rotulo: str) -> list[str]:
            """injeta um surto no log, roda o ciclo de verdade e devolve as novas mensagens."""
            relogio["agora"] = quando
            antes = len(enviados)
            with vigia.ARQ_LOG.open("a", encoding="utf-8") as arquivo:
                for indice in range(N):
                    arquivo.write(linha(IP, quando, indice) + "\n")
            vigia.ciclo(ensaio=False)
            novas = enviados[antes:]
            print(f"[{rotulo}] {quando.strftime('%d/%m %H:%M')} · surto de {N} req de {IP} → "
                  f"{len(novas)} mensagem(ns) no Telegram")
            for mensagem in novas:
                for trecho in mensagem.splitlines():
                    print(f"      | {trecho}")
            return novas

        t0 = relogio["agora"]
        primeira = rodada(t0, "1º surto")
        segunda = rodada(t0 + timedelta(minutes=10), "2º surto em +10 min")
        terceira = rodada(t0 + timedelta(hours=6, minutes=1), "mesmo IP em +6h01")

        print("\ncasos")
        conferir("1º surto: 1 mensagem", len(primeira), 1)
        conferir("mensagem do 1º surto é de BLOQUEIO", "BLOQUEADO" in primeira[0] if primeira else False, True)
        conferir("2º surto em +10 min: nenhuma mensagem", len(segunda), 0)
        conferir("IP de volta em +6h01: 1 mensagem nova", len(terceira), 1)
        conferir("mensagem de +6h01 é de RENOVAÇÃO", "segue bloqueado" in terceira[0] if terceira else False, True)
        conferir("total de mensagens sobre o IP", len(enviados), 2)

        estado = vigia.ler_estado()
        conferir("bloqueio continua ativo (renovado)", IP in estado["bloqueios"], True)
        conferir("renovações registradas", estado["bloqueios"].get(IP, {}).get("renovacoes"), 2)
        conferir(
            "ledger anti-spam marcou o IP",
            bool((estado.get("suspeita") or {}).get("avisos", {}).get(IP)),
            True,
        )

        if verbose:
            print("\nlog do vigia (temporário):")
            print(vigia.LOG_VIGIA.read_text(encoding="utf-8"))
            print("estado final:")
            print(vigia.ARQ_ESTADO.read_text(encoding="utf-8"))

    print(
        "\nresumo: "
        + ("anti-spam provado — 2 surtos em 10 min = 1 mensagem; 6 h depois, 1 nova"
           if falhas == 0
           else f"{falhas} falha(s)")
    )
    return 0 if falhas == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
