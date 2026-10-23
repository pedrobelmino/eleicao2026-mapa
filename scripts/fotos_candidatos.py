#!/usr/bin/env python3
"""Baixa as fotos OFICIAIS dos candidatos no TSE e registra a procedência.

Por que existe: o painel mostra a foto do candidato no placar e no card de
estado. Rosto errado em ano de eleição não é bug de layout — é desinformação.
Então a foto não é "achada" na internet: ela é baixada do mesmo arquivo que o
TSE publica para o sqcand daquele candidato, e o sqcand vem do JSON oficial de
resultados, onde o nome e o número estão escritos.

O que grava:

  web/public/candidato-<numero>.jpeg     foto usada pelo front (Vite serve /)
  dados/fotos_candidatos.json            procedência: URL, sqcand, sha256, bytes

O JSON é a prova: quem duvidar da foto roda este script de novo e compara o
sha256. Nada aqui depende de curadoria manual de imagem.

Uso:

  python3 scripts/fotos_candidatos.py                 # baixa/atualiza e confere
  python3 scripts/fotos_candidatos.py --verificar      # só confere, não escreve
  ELEICAO=6257 TURNO=1 CARGO=1 NUMEROS=13,22 python3 scripts/fotos_candidatos.py

Sai com código 1 se alguma foto do disco divergir do arquivo oficial (é o caso
em que o front estaria mostrando outra imagem com o mesmo nome).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DESTINO_FOTOS = RAIZ / "web" / "public"
ARQUIVO_PROCEDENCIA = RAIZ / "dados" / "fotos_candidatos.json"


def cfg() -> dict:
    # TSE_BASE termina no ano da eleição (mesma convenção do api/main.go).
    base = os.getenv("TSE_BASE", "https://resultados.tse.jus.br/oficial/ele2026").rstrip("/")
    eleicao = os.getenv("ELEICAO", "6257")
    turno = os.getenv("TURNO", "1")
    cargo = os.getenv("CARGO", "1")  # 1 = presidente
    numeros = [n.strip() for n in os.getenv("NUMEROS", "13,22").split(",") if n.strip()]
    uf = os.getenv("UF_ABRANGENCIA", "br")
    # caminho oficial do JSON de candidatos: .../ele2026/6257/dados/br/br-c0001-e006257-u.json
    url_json = f"{base}/{eleicao}/dados/{uf}/{uf}-c{cargo.zfill(4)}-e00{eleicao}-u.json"
    return {
        "base": base,
        "eleicao": eleicao,
        "turno": turno,
        "cargo": cargo,
        "numeros": numeros,
        "url_json": url_json,
    }


def baixar(url: str, tentativas: int = 3, timeout: int = 30) -> bytes:
    """GET com retry curto: o TSE oscila, e um 502 não pode virar foto faltando."""
    ultimo = None
    for tentativa in range(1, tentativas + 1):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "eleicao2026-mapa/fotos (+procedencia)"}
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"HTTP {resp.status} em {url}")
                return resp.read()
        except Exception as erro:  # noqa: BLE001 - queremos o motivo no relatório
            ultimo = erro
            if tentativa < tentativas:
                time.sleep(1.5 * tentativa)
    raise RuntimeError(f"falhou baixar {url}: {ultimo}")


def dimensoes_jpeg(dados: bytes) -> tuple[int, int]:
    """Largura/altura lendo o marcador SOF do JPEG (sem Pillow)."""
    if not dados.startswith(b"\xff\xd8"):
        raise ValueError("não é JPEG")
    i = 2
    while i < len(dados) - 9:
        if dados[i] != 0xFF:
            i += 1
            continue
        marcador = dados[i + 1]
        if marcador in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB):
            altura, largura = struct.unpack(">HH", dados[i + 5 : i + 9])
            return largura, altura
        if marcador in (0xD8, 0xD9) or 0xD0 <= marcador <= 0xD7:
            i += 2
            continue
        tamanho = struct.unpack(">H", dados[i + 2 : i + 4])[0]
        i += 2 + tamanho
    raise ValueError("SOF não encontrado")


def candidatos_do_json(bruto: bytes, numeros: list[str]) -> dict[str, dict]:
    """Mapeia numero -> candidato oficial (nome, partido, sqcand).

    Estrutura do JSON do TSE: carg[] -> agr[] -> par[] -> cand[].
    O sqcand é o identificador do candidato e é o que compõe a URL da foto.
    """
    doc = json.loads(bruto.decode("utf-8-sig"))
    achados: dict[str, dict] = {}
    for cargo in doc.get("carg", []):
        for agregado in cargo.get("agr", []):
            for partido in agregado.get("par", []):
                for cand in partido.get("cand", []):
                    numero = str(cand.get("n") or "").strip()
                    if numero and numero in numeros:
                        achados[numero] = {
                            "numero": numero,
                            "nome_oficial": cand.get("nm") or cand.get("nomeUrna") or "",
                            "nome_urna": cand.get("nomeUrna") or "",
                            "partido": partido.get("sg") or "",
                            "sqcand": str(cand.get("sqcand") or ""),
                        }
    return achados


def procedimento(verificar: bool) -> int:
    c = cfg()
    print(f"fonte: {c['url_json']}")
    doc = baixar(c["url_json"])
    catalogo = candidatos_do_json(doc, c["numeros"])

    faltando = [n for n in c["numeros"] if n not in catalogo]
    if faltando:
        print(f"ERRO: sem candidato oficial para os números {faltando}", file=sys.stderr)
        return 1

    DESTINO_FOTOS.mkdir(parents=True, exist_ok=True)
    ARQUIVO_PROCEDENCIA.parent.mkdir(parents=True, exist_ok=True)

    registros = []
    divergencias = []
    for numero in c["numeros"]:
        cand = catalogo[numero]
        if not cand["sqcand"]:
            print(f"ERRO: {numero} ({cand['nome_oficial']}) sem sqcand", file=sys.stderr)
            return 1
        url_foto = f"{c['base']}/{c['eleicao']}/fotos/br/{cand['sqcand']}.jpeg"
        dados = baixar(url_foto)
        largura, altura = dimensoes_jpeg(dados)
        sha_oficial = hashlib.sha256(dados).hexdigest()

        arquivo = DESTINO_FOTOS / f"candidato-{numero}.jpeg"
        existente = arquivo.exists()
        sha_local = hashlib.sha256(arquivo.read_bytes()).hexdigest() if existente else None

        if sha_local and sha_local != sha_oficial:
            divergencias.append((numero, sha_local, sha_oficial))
        status = "ok" if sha_local == sha_oficial else ("novo" if not existente else "DIVERGENTE")
        if not verificar and status != "ok":
            arquivo.write_bytes(dados)
            os.chmod(arquivo, 0o644)
            status = "gravado"
        print(
            f"  {numero:>3} {cand['partido']:<4} {cand['nome_oficial']:<34} "
            f"{largura}x{altura} {len(dados):>6}b {status}"
        )

        registros.append(
            {
                "numero": numero,
                "nome_oficial": cand["nome_oficial"],
                "nome_urna": cand["nome_urna"],
                "partido": cand["partido"],
                "sqcand": cand["sqcand"],
                "fonte_json": c["url_json"],
                "fonte_foto": url_foto,
                "arquivo": f"web/public/{arquivo.name}",
                "sha256": sha_oficial,
                "bytes": len(dados),
                "largura": largura,
                "altura": altura,
            }
        )

    if divergencias:
        print("\nERRO: foto no disco difere da oficial do TSE:", file=sys.stderr)
        for numero, sha_local, sha_oficial in divergencias:
            print(f"  {numero}: local {sha_local} != oficial {sha_oficial}", file=sys.stderr)
        print("Rode sem --verificar para regravar a partir da fonte.", file=sys.stderr)
        return 1

    if verificar:
        print("\nverificação ok: as fotos do disco são byte-a-byte as do TSE")
        return 0

    procedencia = {
        "_nota": (
            "Procedência das fotos oficiais do painel. Gerado por "
            "scripts/fotos_candidatos.py: baixa o JSON oficial de candidatos do TSE "
            "(carg->agr->par->cand), usa o sqcand de lá na URL da foto e grava o "
            "sha256 do arquivo. O componente Avatar só mostra a foto quando o nome/"
            "número/partido casa com este catálogo; fora disso, inicial do nome."
        ),
        "eleicao": c["eleicao"],
        "turno": c["turno"],
        "cargo": c["cargo"],
        "coletado_em": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "fotos": registros,
    }
    ARQUIVO_PROCEDENCIA.write_text(
        json.dumps(procedencia, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"\nprocedência: {ARQUIVO_PROCEDENCIA.relative_to(RAIZ)} ({len(registros)} fotos)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Fotos oficiais do TSE com procedência")
    ap.add_argument(
        "--verificar",
        action="store_true",
        help="não escreve nada; confere o sha256 do disco contra o TSE",
    )
    args = ap.parse_args()
    return procedimento(args.verificar)


if __name__ == "__main__":
    sys.exit(main())
