#!/usr/bin/env python3
"""Mescla dados/estados_fotos.json dentro de dados/estados_identidade.json.

O endpoint /api/estados/identidade serve o arquivo CRU (json.RawMessage), então
bastam os campos novos no proprio estados_identidade.json para o card receber a
foto: foto, alt, credito, licenca, fonte_url. UF sem foto de licenca clara fica
com foto: null (o card desenha o placeholder neutro).

Uso: python3 scripts/fotos_mesclar.py [--conferir]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FOTOS = os.path.join(RAIZ, "dados", "estados_fotos.json")
IDENTIDADE = os.path.join(RAIZ, "dados", "estados_identidade.json")
CAMPOS = ("foto", "alt", "credito", "licenca", "fonte_url")


def carregar(caminho: str) -> dict:
    with open(caminho, encoding="utf-8") as arq:
        return json.load(arq)


def principais(conferir: bool = False) -> int:
    identidade = carregar(IDENTIDADE)
    fotos = carregar(FOTOS)
    ufs = identidade["UF"]
    com_foto = []
    sem_foto = []
    for sigla, dados in ufs.items():
        info = fotos.get(sigla) or {}
        if info.get("foto"):
            dados["foto"] = info["foto"]
            dados["alt"] = info.get("alt") or f"{dados.get('nome', sigla)}: imagem do estado"
            dados["credito"] = info.get("credito") or "Wikimedia Commons"
            dados["licenca"] = info.get("licenca") or ""
            dados["fonte_url"] = info.get("fonte_url") or ""
            com_foto.append(sigla)
        else:
            for campo in CAMPOS:
                dados[campo] = None
            sem_foto.append(sigla)

    # Servida local: nada de URL externa em campo que o front transforma em <img>.
    for sigla in com_foto:
        foto = ufs[sigla]["foto"]
        if not foto.startswith("uf/") or os.path.isabs(foto) or "://" in foto:
            print(f"ERRO: {sigla} com caminho suspeito: {foto}")
            return 1
        if not os.path.exists(os.path.join(RAIZ, "web", "public", foto)):
            print(f"ERRO: {sigla} aponta para arquivo inexistente: {foto}")
            return 1
        if not ufs[sigla]["licenca"]:
            print(f"ERRO: {sigla} sem licenca declarada")
            return 1

    if not conferir:
        with open(IDENTIDADE, "w", encoding="utf-8") as arq:
            json.dump(identidade, arq, ensure_ascii=False, indent=2)
            arq.write("\n")

    print(f"UF com foto: {len(com_foto)} — {' '.join(com_foto)}")
    print(f"UF sem foto: {len(sem_foto)} — {' '.join(sem_foto) if sem_foto else '(nenhuma)'}")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--conferir", action="store_true")
    sys.exit(principais(parser.parse_args().conferir))
