"""Escore de suspeita por IP para o log de defesa do nginx.

Python 3.10+, somente biblioteca padrão.  O volume de requisições nunca entra
no cálculo: cada sinal vale uma vez por IP, não importa quantas vezes ocorra.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import math
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Any


PESOS: dict[str, int] = {
    "caminho_sensivel": 35,
    "injecao": 40,
    "metodo_anomalo": 15,
    "sondagem_interna": 35,
    "ua_anomalo": 15,
    "regularidade": 15,
    "reincidencia": 15,
}

ORDEM_SINAIS: list[str] = [
    "caminho_sensivel",
    "injecao",
    "metodo_anomalo",
    "sondagem_interna",
    "ua_anomalo",
    "regularidade",
    "reincidencia",
]

CLASSES: dict[str, str] = {
    "limpo": "Limpo",
    "observar": "Observar",
    "suspeito": "Suspeito",
    "malicioso": "Malicioso",
}

# Exatamente as regexes da especificação.  Todas são case-insensitive.
RE_SENSIVEL = re.compile(
    r"(^|/)(\.env|\.git|\.aws|\.ssh|\.htaccess|\.htpasswd|nginx\.conf|web\.config|"
    r"id_rsa|wp-config\.php)|/admin|/administrator|/phpmyadmin|/wp-login|/wp-admin|"
    r"/mysql|/actuator|/console|/server-status|/server-info|/etc/passwd|/etc/shadow|"
    r"/\.svn|/\.ds_store",
    re.IGNORECASE,
)

RE_INJECAO = re.compile(
    r'''(\.\./|%2e%2e)|/etc/passwd|/etc/shadow|/proc/self|('|%27|%22|")\s*(or|and)\s|'''
    r'''union[\s+]+select|information_schema|sleep\s*\(|benchmark\s*\(|pg_sleep|'''
    r'''waitfor[\s+]+delay|1\s*=\s*1|1'\s*=\s*'1|xp_cmdshell|<script|%3cscript|'''
    r'''onerror\s*=|javascript:''',
    re.IGNORECASE,
)

RE_SCANNER_UA = re.compile(
    r"sqlmap|nikto|nmap|masscan|zgrab|nuclei|dirbuster|gobuster|wpscan|acunetix|"
    r"nessus|feroxbuster|ffuf|openvas|w3af|joomscan|whatweb|censys|python-requests|"
    r"python-urllib|aiohttp|curl/|wget/|go-http-client|okhttp|headlesschrome|phantomjs|"
    r"libwww-perl|zgrab",
    re.IGNORECASE,
)

_METODOS_NORMAIS = frozenset({"GET", "HEAD", "POST", "OPTIONS"})
_CAMINHOS_IGNORADOS_EXATOS = frozenset(
    {
        "/",
        "/index.html",
        "/mapa",
        "/eleicao",
        "/api/home",
        "/api/estados",
        "/api/visita",
        "/healthz",
    }
)
_EXTENSOES_IGNORADAS = (".jpg", ".png", ".css", ".js", ".woff2")
_RE_PERCENT = re.compile(r"%(20|27|22|3D|2F|3C|3E)", re.IGNORECASE)
_RE_HTTP_FINAL = re.compile(r"\s+HTTP/\d+(?:\.\d+)?\s*$", re.IGNORECASE)
_RE_METODO_INICIAL = re.compile(r"^[A-Za-z]+\s+")


def _normalizar(texto: str) -> str:
    """Decodifica apenas os percent-encodings pedidos e troca '+' por espaço."""
    if not texto:
        return ""

    def troca(m: re.Match[str]) -> str:
        achado = m.group(0).upper()
        return {
            "%20": " ",
            "%27": "'",
            "%22": '"',
            "%3D": "=",
            "%2F": "/",
            "%3C": "<",
            "%3E": ">",
        }[achado]

    valor = _RE_PERCENT.sub(troca, str(texto))
    return valor.replace("+", " ")


def _limpar_alvo(bruto: str) -> str:
    """Remove 'METODO ' do início e ' HTTP/x' do fim de REQUISICAO_CRUA."""
    if not bruto:
        return ""
    alvo = str(bruto).strip()
    alvo = _RE_HTTP_FINAL.sub("", alvo)
    alvo = _RE_METODO_INICIAL.sub("", alvo, count=1)
    return alvo.strip()


def _resolver_pontos(caminho: str) -> str:
    """Resolve segmentos '.' e '..' para classificar o caminho real.

    A resolução serve só para saber se a requisição cai num caminho ignorado;
    as regexes continuam vendo o alvo original (inclusive o '../').
    """
    partes = caminho.split("/")
    saida: list[str] = []
    for parte in partes:
        baixo = parte.lower().replace("%2e", ".")
        if baixo == "..":
            if saida and saida[-1] != "":
                saida.pop()
        elif baixo == ".":
            continue
        else:
            saida.append(parte)
    resolvido = "/".join(saida)
    if not resolvido.startswith("/"):
        resolvido = "/" + resolvido
    return resolvido


def _caminho_ignorado(uri: str) -> bool:
    caminho = _normalizar(uri).split("?", 1)[0]
    caminho = _resolver_pontos(caminho)
    baixo = caminho.lower()
    if baixo in _CAMINHOS_IGNORADOS_EXATOS:
        return True
    if baixo.startswith("/mapa/") or baixo.startswith("/assets/"):
        return True
    if baixo.endswith(_EXTENSOES_IGNORADAS):
        return True
    return False


def _parse_data(quando_iso: str) -> datetime:
    texto = str(quando_iso).strip()
    if texto.endswith(("Z", "z")):
        texto = texto[:-1] + "+00:00"
    try:
        data = datetime.fromisoformat(texto)
    except ValueError:
        # Mantém a API previsível: uma data inválida não derruba a análise.
        data = datetime.fromtimestamp(0, tz=timezone.utc)
    if data.tzinfo is None:
        data = data.replace(tzinfo=timezone.utc)
    return data


def _epoch(quando_iso: str) -> float:
    return _parse_data(quando_iso).timestamp()


def ua_falsificado(ua: str) -> bool:
    """UA com assinatura antiga/contraditória (navegador falsificado)."""
    valor = str(ua or "").lower()
    for versao in range(6, 10):
        if f"msie {versao}" in valor:
            return True
    for versao in range(1, 13):
        if f"iphone os {versao}_" in valor:
            return True
    for versao in range(1, 7):
        if f"android {versao}." in valor and "chrome/1" not in valor:
            return True
    return False


def navegador_real(ua: str) -> bool:
    """Navegador de verdade: marcador conhecido e UA não falsificado."""
    if ua_falsificado(ua):
        return False
    valor = str(ua or "").lower()
    return any(
        marcador in valor
        for marcador in ("chrome/", "firefox/", "safari/", "edg/", "opr/")
    )


def _ua_anomalo(ua: str) -> bool:
    texto = str(ua or "")
    if not texto.strip():
        return True
    if RE_SCANNER_UA.search(texto):
        return True
    return ua_falsificado(texto)


# Quantos instantes guardar por IP: o suficiente para medir regularidade e
# reincidência sem deixar o estado crescer sem limite (o estado é gravado em
# disco pelo vigia, a cada ciclo).
MAX_INSTANTES = 400


def novo_registro() -> dict[str, Any]:
    """Registro zerado de um IP (só tipos JSON: vai para o estado em disco)."""
    return {
        "eventos": 0,
        "primeiro": None,
        "ultimo": None,
        "hosts": {},
        "sinais": {},
        "erros": 0,
        "primeira_erro": None,
        "instantes": [],
        "ua_real": 0,
    }


def registrar(
    reg: dict[str, Any],
    quando_iso: str,
    status: int,
    metodo: str,
    uri: str,
    alvo: str,
    ua: str,
) -> None:
    """Registra uma requisição no registro do IP (sem contar volume como sinal)."""
    if not isinstance(reg, dict):
        raise TypeError("reg deve ser um dict")

    instante = _epoch(quando_iso)
    reg["eventos"] = int(reg.get("eventos", 0)) + 1

    primeiro = reg.get("primeiro")
    if primeiro is None or instante < _epoch(primeiro):
        reg["primeiro"] = str(quando_iso)
    ultimo = reg.get("ultimo")
    if ultimo is None or instante > _epoch(ultimo):
        reg["ultimo"] = str(quando_iso)

    instantes = reg.setdefault("instantes", [])
    instantes.append(float(instante))
    if len(instantes) > MAX_INSTANTES:
        del instantes[: len(instantes) - MAX_INSTANTES]
    if navegador_real(ua):
        reg["ua_real"] = int(reg.get("ua_real", 0)) + 1

    try:
        codigo = int(status)
    except (TypeError, ValueError):
        codigo = 0

    if codigo in (403, 404):
        reg["erros"] = int(reg.get("erros", 0)) + 1
        primeira = reg.get("primeira_erro")
        if primeira is None or instante < _epoch(primeira):
            reg["primeira_erro"] = str(quando_iso)

    uri_txt = str(uri or "")
    alvo_txt = _limpar_alvo(str(alvo or ""))
    if not uri_txt:
        uri_txt = alvo_txt.split("?", 1)[0]

    ignorado = _caminho_ignorado(uri_txt)
    uri_norm = _normalizar(uri_txt)
    alvo_norm = _normalizar(alvo_txt)

    # caminho_sensivel é suprimido em caminho benigno (polling de /mapa e
    # /api/estados não pode virar suspeita). injecao NÃO: payload é payload,
    # mesmo pendurado na raiz ("/?id=1' OR '1'='1" tem uri "/" e mora na query).
    if not ignorado:
        if RE_SENSIVEL.search(uri_norm) or RE_SENSIVEL.search(alvo_norm):
            reg.setdefault("sinais", {})["caminho_sensivel"] = True
    if RE_INJECAO.search(alvo_norm) or RE_INJECAO.search(uri_norm):
        reg.setdefault("sinais", {})["injecao"] = True

    uri_lower = _normalizar(uri_txt).lower()
    if uri_lower.startswith("/api/interno") or uri_lower.startswith("/interno/"):
        reg.setdefault("sinais", {})["sondagem_interna"] = True

    metodo_txt = str(metodo or "").strip().upper()
    if metodo_txt not in _METODOS_NORMAIS:
        reg.setdefault("sinais", {})["metodo_anomalo"] = True

    if _ua_anomalo(ua):
        reg.setdefault("sinais", {})["ua_anomalo"] = True


def _regularidade(reg: dict[str, Any]) -> bool:
    brutos = list(reg.get("instantes", []))
    if len(brutos) < 10:
        return False
    # Polling de navegador real tem intervalo fixo por natureza: o pedido é
    # explícito em ignorá-lo. Só máquina (sem UA de navegador) pontua aqui.
    if int(reg.get("ua_real", 0)) > 0:
        return False
    instantes = sorted(float(x) for x in brutos)
    if instantes[-1] - instantes[0] <= 1800.0:
        return False

    gaps = [b - a for a, b in zip(instantes, instantes[1:])]
    if not gaps:
        return False
    media = sum(gaps) / len(gaps)
    if media <= 0:
        return False
    variancia = sum((g - media) ** 2 for g in gaps) / len(gaps)
    desvio = math.sqrt(variancia)
    return (desvio / media) <= 0.15


def _reincidencia(reg: dict[str, Any]) -> bool:
    if int(reg.get("erros", 0)) < 3:
        return False
    primeira = reg.get("primeira_erro")
    if primeira is None:
        return False
    primeira_epoch = _epoch(primeira)
    return any(float(t) > primeira_epoch for t in reg.get("instantes", []))


def avaliar(reg: dict[str, Any]) -> dict[str, Any]:
    """Avalia um registro e devolve escore, nível e sinais na ordem canônica."""
    disparados = {
        chave: bool(reg.get("sinais", {}).get(chave)) for chave in ORDEM_SINAIS
    }
    disparados["regularidade"] = _regularidade(reg)
    disparados["reincidencia"] = _reincidencia(reg)

    sinais = [chave for chave in ORDEM_SINAIS if disparados.get(chave)]
    escore = min(100, sum(PESOS[chave] for chave in sinais))

    if escore >= 80:
        nivel = "malicioso"
    elif escore >= 60:
        nivel = "suspeito"
    elif escore >= 20:
        nivel = "observar"
    else:
        nivel = "limpo"

    return {"escore": escore, "nivel": nivel, "sinais": sinais}


def podar(acumulado: dict[str, Any], agora_iso: str, horas: int = 24) -> None:
    """Remove IPs cujo último evento é mais antigo que agora - horas."""
    agora = _parse_data(agora_iso)
    corte = agora - timedelta(hours=horas)
    remover: list[str] = []
    for ip, reg in acumulado.items():
        ultimo = reg.get("ultimo") if isinstance(reg, dict) else None
        if ultimo is None:
            remover.append(ip)
            continue
        if _parse_data(ultimo) < corte:
            remover.append(ip)
    for ip in remover:
        acumulado.pop(ip, None)


def _ip_publico(texto: str) -> bool:
    bruto = str(texto or "").strip()
    if bruto in {"?", "não resolvido", "nao resolvido"}:
        return False
    try:
        ip = ipaddress.ip_address(bruto.strip("[]"))
    except ValueError:
        return False
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    ):
        return False
    return True


def _extrair_linha(linha: str) -> tuple[str, str, int, str, str, str, str, str] | None:
    """Devolve (ip, quando, status, metodo, uri, host, alvo, ua) ou None."""
    texto = linha.strip()
    if not texto:
        return None

    aspa1 = texto.find('"')
    if aspa1 >= 0:
        prefixo = texto[:aspa1].split()
        aspa2 = texto.find('"', aspa1 + 1)
        if aspa2 >= 0:
            bruto = texto[aspa1 + 1 : aspa2]
            ua = texto[aspa2 + 1 :].strip()
        else:
            bruto = texto[aspa1 + 1 :].strip()
            ua = ""
    else:
        partes = texto.split()
        prefixo = partes[:7]
        bruto = ""
        ua = " ".join(partes[7:]) if len(partes) > 7 else ""

    if len(prefixo) < 5:
        return None

    ip = prefixo[0]
    quando = prefixo[1]
    try:
        status = int(prefixo[2])
    except ValueError:
        status = 0
    metodo = prefixo[3]
    uri = prefixo[4]
    host = prefixo[5] if len(prefixo) > 5 else ""
    alvo = _limpar_alvo(bruto) if bruto else uri
    return ip, quando, status, metodo, uri, host, alvo, ua


def registrar_linha(acumulado: dict[str, dict[str, Any]], linha: str) -> bool:
    """Registra UMA linha do log no acumulado por IP.

    É a porta que o vigia usa: ele lê o log em modo tail, uma linha por vez, e
    precisa do mesmo parser da conferência. Devolve False para linha vazia,
    lixo, IP não público ou "não resolvido".
    """
    extraido = _extrair_linha(linha)
    if extraido is None:
        return False
    ip, quando, status, metodo, uri, host, alvo, ua = extraido
    if not _ip_publico(ip):
        return False

    reg = acumulado.get(ip)
    if reg is None:
        reg = novo_registro()
        acumulado[ip] = reg
    registrar(reg, quando, status, metodo, uri, alvo, ua)
    if host:
        reg.setdefault("hosts", {})
        reg["hosts"][host] = int(reg["hosts"].get(host, 0)) + 1
    return True


def analisar_texto(texto: str, agora_iso: str) -> dict[str, dict[str, Any]]:
    """Processa o log inteiro e devolve {ip: avaliar(reg)} para IPs públicos."""
    _ = agora_iso  # parte da API; a análise é feita sobre o texto recebido
    registros: dict[str, dict[str, Any]] = {}

    for linha in str(texto or "").splitlines():
        extraido = _extrair_linha(linha)
        if extraido is None:
            continue
        ip, quando, status, metodo, uri, host, alvo, ua = extraido
        if not _ip_publico(ip):
            continue
        reg = registros.get(ip)
        if reg is None:
            reg = novo_registro()
            registros[ip] = reg
        registrar(reg, quando, status, metodo, uri, alvo, ua)
        if host:
            reg.setdefault("hosts", {})[host] = int(reg["hosts"].get(host, 0)) + 1

    return {ip: avaliar(reg) for ip, reg in registros.items()}


def _conferir(caminho_fixture: str) -> int:
    with open(caminho_fixture, "r", encoding="utf-8") as arquivo:
        fixture = json.load(arquivo)

    agora = fixture.get("agora", "1970-01-01T00:00:00+00:00")
    casos = fixture.get("casos", [])
    passou = 0

    for caso in casos:
        nome = caso.get("nome", "?")
        linhas = caso.get("linhas", [])
        esperado = caso.get("esperado", {})
        resultado = analisar_texto("\n".join(linhas), agora)

        ip_caso = None
        for linha in linhas:
            extraido = _extrair_linha(linha)
            if extraido is not None:
                ip_caso = extraido[0]
                break
        obtido = resultado.get(
            ip_caso,
            {"escore": 0, "nivel": "limpo", "sinais": []},
        )

        esperado_sinais = list(esperado.get("sinais", []))
        ok = (
            obtido["escore"] == esperado.get("escore")
            and obtido["nivel"] == esperado.get("nivel")
            and obtido["sinais"] == esperado_sinais
        )
        if ok:
            passou += 1

        rotulo = "PASS" if ok else "FAIL"
        print(
            f"{rotulo} {nome} | "
            f"escore esperado {esperado.get('escore')} x obtido {obtido['escore']} | "
            f"sinais esperados {esperado_sinais} x obtidos {obtido['sinais']}"
        )

    total = len(casos)
    print(f"resumo: {passou}/{total} PASS")
    return 0 if passou == total else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Escore de suspeita por IP para log de defesa do nginx."
    )
    parser.add_argument(
        "--conferir",
        metavar="FIXTURE",
        help="roda os casos do arquivo JSON de fixture",
    )
    args = parser.parse_args(argv)
    if args.conferir:
        return _conferir(args.conferir)
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
