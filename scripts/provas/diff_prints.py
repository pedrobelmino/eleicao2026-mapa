#!/usr/bin/env python3
"""Compara dois prints pixel a pixel e diz quantos pixels mudaram.

Uso:
    python3 scripts/provas/diff_prints.py ANTES.png DEPOIS.png [--limiar 8]

Serve de prova de "o mapa continua igual": imprime tamanho, pixels alterados,
percentual e a caixa da diferença (para ver se a mudança está na legenda, no
header, ou no meio do mapa).
"""
import sys

from PIL import Image, ImageChops


def main(argv):
    if len(argv) < 3:
        print("uso: diff_prints.py ANTES.png DEPOIS.png [--limiar N]")
        return 2
    limiar = 8
    if "--limiar" in argv:
        limiar = int(argv[argv.index("--limiar") + 1])

    antes = Image.open(argv[1]).convert("RGB")
    depois = Image.open(argv[2]).convert("RGB")
    if antes.size != depois.size:
        print(f"TAMANHO DIFERENTE: antes={antes.size} depois={depois.size}")
        return 1

    diff = ImageChops.difference(antes, depois)
    cinza = diff.convert("L")
    mascara = cinza.point(lambda p: 255 if p > limiar else 0)
    alterados = sum(1 for p in mascara.getdata() if p)
    total = antes.size[0] * antes.size[1]
    caixa = mascara.getbbox()

    print(f"arquivo_antes={argv[1]}")
    print(f"arquivo_depois={argv[2]}")
    print(f"tamanho={antes.size[0]}x{antes.size[1]} limiar={limiar}")
    print(f"pixels_alterados={alterados} de {total} ({100.0 * alterados / total:.3f}%)")
    print(f"caixa_da_diferenca={caixa}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
