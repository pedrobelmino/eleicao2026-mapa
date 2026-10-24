#!/usr/bin/env python3
"""Baixa uma foto de licenca livre (Wikimedia Commons) por UF e grava a curadoria.

Uso: python3 scripts/fotos_uf.py [--ufs CE,RS,BA] [--saida dados/estados_fotos.json]

Regra dura: nada de hotlink. A imagem e baixada, reduzida para <= 800 px de
largura e servida de web/public/uf/<UF>.jpg. Se nao houver imagem com licenca
clara, a UF fica com foto: null (o card mostra placeholder).
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://commons.wikimedia.org/w/api.php"
UA = "Eleicao2026Mapa/1.0 (projeto pessoal; contato pedrobelmino@gmail.com)"

LICENCAS_OK = (
    "cc by", "cc-by", "cc0", "public domain", "domínio público", "dominio publico",
    "pd", "cc sa", "cc-sa",
)
RUIM_TITULO = re.compile(
    r"\b(map|mapa|maps|flag|bandeira|bras[aã]o|coat of arms|seal|logo|locator|"
    r"satellite|sat[eé]lite|diagram|graph|chart|panorama|montage|collage|"
    r"sign|placa|blank|svg|icon|stamp)\b",
    re.I,
)


def http_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def limpa_html(texto: str) -> str:
    texto = re.sub(r"<[^>]+>", " ", texto or "")
    texto = re.sub(r"\s+", " ", texto).strip()
    return texto


def busca(termo: str, limite: int = 10) -> list[dict]:
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": f"filetype:bitmap {termo}",
        "gsrnamespace": "6",
        "gsrlimit": str(limite),
        "prop": "imageinfo",
        "iiprop": "url|size|mime|extmetadata",
        "iiurlwidth": "900",
    }
    dados = http_json(API + "?" + urllib.parse.urlencode(params))
    paginas = (dados.get("query") or {}).get("pages") or {}
    itens = []
    for pagina in paginas.values():
        info = (pagina.get("imageinfo") or [{}])[0]
        if not info:
            continue
        meta = info.get("extmetadata") or {}
        titulo = pagina.get("title", "")
        itens.append(
            {
                "titulo": titulo,
                "indice": pagina.get("index", 99),
                "mime": info.get("mime", ""),
                "largura": info.get("width", 0),
                "altura": info.get("height", 0),
                "thumb": info.get("thumburl") or info.get("url"),
                "descricao_url": info.get("descriptionurl"),
                "licenca": limpa_html((meta.get("LicenseShortName") or {}).get("value", "")),
                "autor": limpa_html((meta.get("Artist") or {}).get("value", "")),
                "credito": limpa_html((meta.get("Credit") or {}).get("value", "")),
            }
        )
    return itens


def aceitavel(item: dict) -> bool:
    if item["mime"] not in ("image/jpeg", "image/png"):
        return False
    if item["largura"] < 700:
        return False
    nome = item["titulo"].replace("File:", "")
    if RUIM_TITULO.search(nome):
        return False
    lic = item["licenca"].lower()
    if not any(ok in lic for ok in LICENCAS_OK):
        return False
    if not item["autor"]:
        return False
    # Card pequeno com altura fixa: panorama achatado (800x174) ou retrato
    # exagerado some no enquadramento. Prefere proporcao de foto comum.
    proporcao = item["largura"] / max(item["altura"], 1)
    if not 0.55 <= proporcao <= 2.2:
        return False
    return True


def pontua(item: dict, termo: str) -> float:
    nome = item["titulo"].replace("File:", "").lower()
    palavras = [p for p in re.split(r"[^a-z0-9]+", termo.lower()) if len(p) > 2]
    acertos = sum(1 for p in palavras if p in nome)
    nota = acertos * 2.0
    nota -= item["indice"] * 0.15
    if "wikimedia" in nome or "commons" in nome:
        nota -= 1.0
    return nota


def reduzir(dados: bytes, destino: str, largura_max: int = 800) -> tuple[int, int]:
    try:
        from PIL import Image  # type: ignore
    except ImportError:  # pragma: no cover
        with open(destino, "wb") as arq:
            arq.write(dados)
        return (0, 0)
    with Image.open(io.BytesIO(dados)) as img:
        img = img.convert("RGB")
        if img.width > largura_max:
            altura = round(img.height * largura_max / img.width)
            reamostra = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
            img = img.resize((largura_max, altura), reamostra)
        img.save(destino, "JPEG", quality=82, optimize=True, progressive=True)
        return img.size


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ufs", default="")
    ap.add_argument("--saida", default=os.path.join(RAIZ, "dados", "estados_fotos.json"))
    ap.add_argument("--identidade", default=os.path.join(RAIZ, "dados", "estados_identidade.json"))
    args = ap.parse_args()

    with open(args.identidade, encoding="utf-8") as arq:
        identidade = json.load(arq)["UF"]
    # Termos mais específicos por UF, quando a busca curada devolve coisa fora
    # do tema (protesto politico, borboleta, panorama achatado...).
    termos = {}
    caminho_termos = os.path.join(RAIZ, "scripts", "fotos_termos.json")
    if os.path.exists(caminho_termos):
        with open(caminho_termos, encoding="utf-8") as arq:
            termos = {k.upper(): v for k, v in json.load(arq).items()}
    alvo = [u.strip().upper() for u in args.ufs.split(",") if u.strip()] or sorted(identidade)
    pasta = os.path.join(RAIZ, "web", "public", "uf")
    os.makedirs(pasta, exist_ok=True)

    saida = {}
    if os.path.exists(args.saida):
        with open(args.saida, encoding="utf-8") as arq:
            saida = json.load(arq)

    for uf in alvo:
        dados_uf = identidade.get(uf)
        if not dados_uf:
            print(f"{uf}: sem curadoria, pulando")
            continue
        termo = termos.get(uf) or dados_uf.get("foto_busca") or dados_uf["nome"]
        try:
            itens = busca(termo, limite=20)
        except Exception as erro:  # noqa: BLE001
            print(f"{uf}: busca falhou ({erro})")
            saida[uf] = {"foto": None, "motivo": f"busca falhou: {erro}"}
            continue
        candidatos = [i for i in itens if aceitavel(i)]
        candidatos.sort(key=lambda i: pontua(i, termo), reverse=True)
        if not candidatos:
            print(f"{uf}: nenhuma imagem com licenca clara para '{termo}'")
            saida[uf] = {"foto": None, "motivo": "sem imagem de licenca clara"}
            continue
        escolhida = candidatos[0]
        destino_rel = f"uf/{uf}.jpg"
        destino = os.path.join(RAIZ, "web", "public", destino_rel)
        try:
            binario = http_bytes(escolhida["thumb"])
            largura, altura = reduzir(binario, destino)
        except Exception as erro:  # noqa: BLE001
            print(f"{uf}: download falhou ({erro})")
            saida[uf] = {"foto": None, "motivo": f"download falhou: {erro}"}
            continue
        autor = escolhida["autor"] or escolhida["credito"] or "Wikimedia Commons"
        autor = autor[:120]
        saida[uf] = {
            "foto": destino_rel,
            "alt": f"{dados_uf['nome']}: {dados_uf.get('apelido', '')} — imagem de {termo}",
            "credito": autor,
            "licenca": escolhida["licenca"],
            "fonte_url": escolhida["descricao_url"],
            "arquivo_origem": escolhida["titulo"],
            "largura": largura,
            "altura": altura,
            "bytes": os.path.getsize(destino),
        }
        print(
            f"{uf}: {destino_rel} {largura}x{altura} {escolhida['licenca']} "
            f"· {autor[:50]} · {escolhida['titulo'][:70]}"
        )
        time.sleep(0.2)

    with open(args.saida, "w", encoding="utf-8") as arq:
        json.dump(saida, arq, ensure_ascii=False, indent=2, sort_keys=True)
        arq.write("\n")
    print(f"\n{args.saida}: {len(saida)} UFs ({sum(1 for v in saida.values() if v.get('foto'))} com foto)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
