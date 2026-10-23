#!/usr/bin/env python3
"""Agrega a votação de 2022 (Presidente, 1º turno) por UF e por município.

Entrada: ``votacao_secao_2022_BR.zip`` do TSE (dados abertos, votação por seção
eleitoral — o arquivo BR traz o cargo de Presidente para todas as UFs, com a
seção ZZ). O CSV é lido direto do zip, em streaming: são ~1,6 GB e o arquivo
nunca é descompactado no disco.

Saída: ``dados/eleicao_2022.json`` com, por UF e por município:
  - número de seções (distintas por zona+seção),
  - votos de LULA (13) e JAIR BOLSONARO (22) e dos demais,
  - votos válidos, líder, partido do líder, margem em votos e em pontos.

Nada é estimado: cada número é a soma das linhas do CSV do TSE. Este arquivo é a
base do "quem virou em relação a 2022" e do replay de 2022.

Uso::

    python3 scripts/prepara_2022.py --zip ~/.hermes/cache/tse2022/votacao_secao_2022_BR.zip
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import zipfile
from datetime import datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SAIDA_PADRAO = RAIZ / "dados" / "eleicao_2022.json"

LULA = "13"
BOLSONARO = "22"
PARTIDO = {LULA: "PT", BOLSONARO: "PL"}
NOME = {LULA: "LULA", BOLSONARO: "JAIR BOLSONARO"}
# Códigos de voto que não são candidato: 95 branco, 96 nulo, 97 anulado.
NAO_CANDIDATO = {"95", "96", "97"}


def _int(valor) -> int:
    texto = ("" if valor is None else str(valor)).strip()
    if not texto:
        return 0
    return int(texto.replace(".", ""))


def _pct(parte: int, todo: int) -> float:
    if todo <= 0:
        return 0.0
    return round(100.0 * parte / todo, 2)


class Acumulado:
    __slots__ = ("uf", "nome", "v13", "v22", "voutros", "secoes")

    def __init__(self, uf: str, nome: str) -> None:
        self.uf = uf
        self.nome = nome
        self.v13 = 0
        self.v22 = 0
        self.voutros = 0
        self.secoes = 0

    def votos(self, codigo: str, quantidade: int) -> None:
        if codigo == LULA:
            self.v13 += quantidade
        elif codigo == BOLSONARO:
            self.v22 += quantidade
        elif codigo not in NAO_CANDIDATO:
            self.voutros += quantidade

    def resumo(self) -> dict:
        validos = self.v13 + self.v22 + self.voutros
        if self.v13 >= self.v22:
            lider_cod, lider_votos = LULA, self.v13
            segundo = self.v22
        else:
            lider_cod, lider_votos = BOLSONARO, self.v22
            segundo = self.v13
        margem = lider_votos - segundo
        return {
            "secoes": self.secoes,
            "v13": self.v13,
            "v22": self.v22,
            "voutros": self.voutros,
            "validos": validos,
            "lider": NOME[lider_cod],
            "partido_lider": PARTIDO[lider_cod],
            "lider_pct": _pct(lider_votos, validos),
            "margem_votos": margem,
            "margem_pct": _pct(margem, validos),
        }


def agrega(zip_path: Path) -> dict:
    por_uf: dict[str, Acumulado] = {}
    por_municipio: dict[str, Acumulado] = {}
    secoes_vistas: set[tuple[str, str, str, str]] = set()
    secoes_municipio: dict[str, int] = {}
    total_linhas = 0
    cargo_presidente = None

    with zipfile.ZipFile(zip_path) as arquivo:
        nome_csv = next(
            (n for n in arquivo.namelist() if n.lower().endswith(".csv")), None
        )
        if nome_csv is None:
            raise SystemExit(f"{zip_path}: nenhum CSV dentro do zip")

        with arquivo.open(nome_csv) as bruto:
            # O TSE publica em ISO-8859-1 (latin-1), não em UTF-8.
            texto = io.TextIOWrapper(bruto, encoding="latin-1", newline="")
            leitor = csv.DictReader(texto, delimiter=";")
            leitor.fieldnames = [nome.strip() for nome in leitor.fieldnames or []]

            for linha in leitor:
                total_linhas += 1
                if total_linhas % 500000 == 0:
                    print(f"  {total_linhas} linhas…", file=sys.stderr, flush=True)

                cd_cargo = (linha.get("CD_CARGO") or "").strip()
                if cd_cargo and cd_cargo != "1":
                    continue
                cargo_presidente = (linha.get("DS_CARGO") or "").strip() or cargo_presidente

                uf = (linha.get("SG_UF") or "").strip().upper()
                cd_municipio = (linha.get("CD_MUNICIPIO") or "").strip()
                if not uf or not cd_municipio:
                    continue
                nome_municipio = (linha.get("NM_MUNICIPIO") or "").strip()

                zona = (linha.get("NR_ZONA") or "").strip()
                secao = (linha.get("NR_SECAO") or "").strip()
                chave_secao = (uf, cd_municipio, zona, secao)
                nova_secao = chave_secao not in secoes_vistas
                if nova_secao:
                    secoes_vistas.add(chave_secao)
                    secoes_municipio[cd_municipio] = (
                        secoes_municipio.get(cd_municipio, 0) + 1
                    )

                acumulado_uf = por_uf.get(uf)
                if acumulado_uf is None:
                    acumulado_uf = por_uf[uf] = Acumulado(uf, uf)
                acumulado_mun = por_municipio.get(cd_municipio)
                if acumulado_mun is None:
                    acumulado_mun = por_municipio[cd_municipio] = Acumulado(
                        uf, nome_municipio
                    )

                codigo = (linha.get("NR_VOTAVEL") or "").strip()
                quantidade = _int(linha.get("QT_VOTOS"))
                acumulado_uf.votos(codigo, quantidade)
                acumulado_mun.votos(codigo, quantidade)

    for cd_municipio, acumulado in por_municipio.items():
        acumulado.secoes = secoes_municipio.get(cd_municipio, 0)

    # Seções por UF: o dump traz uma linha por seção × candidato e não um total
    # por UF, então a UF é a soma das seções dos seus municípios. Sem esta
    # passagem todas as UFs saíam com secoes = 0 e o replay não acendia nenhuma
    # UF (a soma por UF tem de fechar com totais.secoes).
    for acumulado in por_municipio.values():
        por_uf[acumulado.uf].secoes += acumulado.secoes

    return {
        "fonte": "TSE — Votação por seção eleitoral 2022 (Presidente, 1º turno)",
        "arquivo": zip_path.name,
        "cargo": cargo_presidente or "Presidente",
        "gerado_em": datetime.now().astimezone().isoformat(timespec="seconds"),
        "linhas_lidas": total_linhas,
        "candidatos": {LULA: "LULA (PT)", BOLSONARO: "JAIR BOLSONARO (PL)"},
        "totais": {
            "secoes": len(secoes_vistas),
            "v13": sum(a.v13 for a in por_uf.values()),
            "v22": sum(a.v22 for a in por_uf.values()),
            "validos": sum(a.resumo()["validos"] for a in por_uf.values()),
        },
        "ufs": {uf: acumulado.resumo() for uf, acumulado in sorted(por_uf.items())},
        "municipios": {
            cd: {
                "uf": acumulado.uf,
                "nome": acumulado.nome,
                **acumulado.resumo(),
            }
            for cd, acumulado in sorted(por_municipio.items())
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    padrao = Path.home() / ".hermes" / "cache" / "tse2022" / "votacao_secao_2022_BR.zip"
    parser.add_argument("--zip", default=str(padrao))
    parser.add_argument("--saida", default=str(SAIDA_PADRAO))
    args = parser.parse_args(argv)

    caminho_zip = Path(args.zip).expanduser()
    if not caminho_zip.exists():
        print(f"zip não encontrado: {caminho_zip}", file=sys.stderr)
        return 1

    print(f"lendo {caminho_zip} ({caminho_zip.stat().st_size / 1e6:.0f} MB)…", file=sys.stderr)
    resultado = agrega(caminho_zip)

    saida = Path(args.saida).expanduser()
    saida.parent.mkdir(parents=True, exist_ok=True)
    temporario = saida.with_suffix(".json.tmp")
    temporario.write_text(
        json.dumps(resultado, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    os.replace(temporario, saida)

    totais = resultado["totais"]
    print(f"{len(resultado['ufs'])} UFs, {len(resultado['municipios'])} municípios")
    print(f"{totais['secoes']} seções · válidos {totais['validos']:,}".replace(",", "."))
    print(f"LULA {totais['v13']:,} · BOLSONARO {totais['v22']:,}".replace(",", "."))
    print(f"gravado em {saida} ({saida.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
