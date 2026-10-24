#!/usr/bin/env python3
"""turno_vigia.py — vira o painel para o 2º turno SOZINHO, com prova antes e volta atrás em caso de falha.

Decisão do Pedro (24/10/2026): "automático — assim que o 6258 tiver votos, troca
.env, reinicia e avisa no Telegram".

O QUE ELE FAZ
-------------
1. Lê o arquivo NACIONAL do TSE da eleição alvo (6258 = 2º turno) e soma os
   votos válidos publicados (`vap` de cada candidato).
2. Condição de virada: soma > 0. Hoje a soma é 0 (arquivo existe, apuração não
   começou), então ele decide NÃO virar e não toca em nada.
3. Quando a soma passa de 0: backup do `.env`, grava ELEICAO/TURNO do turno
   alvo, `docker compose up -d api` (só a api; a web é estática e não é
   recriada), recarrega o nginx da web (o proxy resolve `api` no boot: container
   recriado com IP novo daria 502 sem o reload) e VALIDA pela rota pública:
   /api/health com turno=2, /api/config com a URL do 6258, /api/fonte 200.
4. Se qualquer validação falhar: restaura o `.env` do backup, sobe de novo e
   avisa no Telegram com o erro. Nunca fica meio virado.
5. Idempotente: com o `.env` já no alvo, sai em silêncio. Nunca vira de volta.
   Estado em ~/.hermes/eleicao_turno/estado.json.

CADÊNCIA
--------
O timer chama a cada 10 min. Fora do dia da eleição (e fora das 36 h seguintes,
janela em que a apuração pode atrasar) ele só faz a checagem de hora em hora —
regra no próprio script, sem segundo timer.

JANELA DE VIRADA
----------------
Só vira entre 17:00 e 23:59 (horário local, FUSO -03) de 25/10/2026, definido em
`janela_virada`; fora dela não toca em .env nem em containers, mesmo com vap>0.
A janela vem ANTES da cadência no caminho de decisão: fora dela o log diz "fora
da janela de virada", não "dentro da janela de 60 min".
`VIGIA_AGORA` (ISO 8601) congela o relógio; `--ensaio=janela` prova os 4 casos.

ENSAIO (o que se prova sem tocar em produção)
---------------------------------------------
`--ensaio` roda a SEQUÊNCIA COMPLETA contra um TSE e uma API de mentira
(servidor HTTP local, fixture com vap>0) e um `.env` de mentira em diretório
temporário. O `docker compose` é substituído por um stub. Dois cenários:
  sucesso — a validação passa e ele mostra o que teria virado;
  falha   — a validação falha e ele mostra o rollback + o aviso de erro.
No fim, confere que o `.env` real não mudou (hash e mtime).

Uso:
    python3 scripts/turno_vigia.py                 # checagem real (o timer usa esta)
    python3 scripts/turno_vigia.py --forcar        # ignora a cadência
    python3 scripts/turno_vigia.py --ensaio        # os dois cenários, sandbox
    python3 scripts/turno_vigia.py --ensaio=falha  # só o cenário de falha
    python3 scripts/turno_vigia.py --ensaio=janela # os 4 casos da janela de virada
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FUSO = timezone(timedelta(hours=-3))
PROJETO = Path(os.environ.get("ELEICAO_PROJETO", "/home/pedro/eleicao2026-mapa"))
BASE_HERMES = Path(os.environ.get("ELEICAO_BASE_HERMES", str(Path.home() / ".hermes")))
CONFIG_PATH = BASE_HERMES / "eleicao_turno" / "config.json"
ESTADO_PATH = BASE_HERMES / "eleicao_turno" / "estado.json"
LOG_PATH = BASE_HERMES / "logs" / "eleicao-turno-vigia.log"

CONFIG_PADRAO = {
    # Eleição e turno para onde o painel deve virar.
    "eleicao_alvo": "6258",
    "turno_alvo": "2",
    # Dia do 2º turno: dentro dele a checagem é a cada 10 min.
    "dia_eleicao": "2026-10-25",
    # Fora desta janela o vigia não vira nada, por hora (horário local -03).
    "janela_virada": {"data": "2026-10-25", "de": "17:00", "ate": "23:59"},
    "tse_base": "https://resultados.tse.jus.br/oficial/ele2026",
    # Rota pública que a validação usa (passa pelo nginx da web, como o usuário).
    "api_base": "http://127.0.0.1:8110",
    "compose_projeto": "eleicao2026-mapa",
    # Espera máxima pela api voltar depois do up -d.
    "espera_api_s": 90,
}

JANELA_DIA = 600          # 10 min no dia da eleição
JANELA_FORA = 3600        # 60 min fora dele
JANELA_POS_DIA_H = 36     # depois do dia, ainda 10 min por até 36 h

UA = "Mozilla/5.0 (compatível; painel-eleicao-vigia)"


# --------------------------------------------------------------------------- log
def agora() -> datetime:
    """Relógio local; VIGIA_AGORA (ISO 8601) permite congelá-lo nos ensaios."""
    override = os.environ.get("VIGIA_AGORA")
    if override:
        try:
            momento = datetime.fromisoformat(override.strip())
        except (TypeError, ValueError):
            pass
        else:
            if momento.tzinfo is None:
                momento = momento.replace(tzinfo=FUSO)
            return momento.astimezone(FUSO)
    return datetime.now(FUSO)


def logar(mensagem: str) -> None:
    linha = f"{agora().strftime('%Y-%m-%d %H:%M:%S')} {mensagem}"
    print(linha, flush=True)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as arquivo:
            arquivo.write(linha + "\n")
    except OSError as exc:                      # log é diagnóstico, nunca motivo de falha
        print(f"aviso: não consegui escrever {LOG_PATH}: {exc}", file=sys.stderr)


# ------------------------------------------------------------------------ HTTP
def http_json(url: str, timeout: int = 20) -> tuple[int, dict]:
    pedido = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(pedido, timeout=timeout) as resposta:
            corpo = resposta.read()
            dados = json.loads(corpo.decode("utf-8"))
            return resposta.status, dados if isinstance(dados, dict) else {"corpo": dados}
    except urllib.error.HTTPError as exc:
        corpo = exc.read()
        try:
            return exc.code, json.loads(corpo.decode("utf-8"))
        except Exception:
            return exc.code, {"corpo": corpo[:200].decode("utf-8", "replace")}


def vap_total(nacional: dict) -> int:
    """Soma dos votos válidos publicados (campo `vap` de cada candidato)."""
    total = 0
    for cargo in nacional.get("carg") or []:
        if str(cargo.get("cd")) != "1":        # cargo 1 = Presidente
            continue
        for agregado in cargo.get("agr") or []:
            for partido in agregado.get("par") or []:
                for candidato in partido.get("cand") or []:
                    valor = candidato.get("vap")
                    if valor in (None, ""):
                        continue
                    total += int(str(valor).replace(".", "").strip() or 0)
    return total


# ------------------------------------------------------------------------ .env
def le_env(caminho: Path) -> list[str]:
    if not caminho.exists():
        return []
    return caminho.read_text(encoding="utf-8").splitlines()


def valor_env(linhas: list[str], chave: str) -> str | None:
    for linha in linhas:
        texto = linha.strip()
        if texto.startswith("#") or "=" not in texto:
            continue
        nome, _, valor = texto.partition("=")
        if nome.strip() == chave:
            return valor.strip()
    return None


def grava_env(caminho: Path, valores: dict[str, str]) -> None:
    """Reescreve o .env preservando comentários e as demais chaves."""
    linhas = le_env(caminho)
    vistos: set[str] = set()
    saida: list[str] = []
    for linha in linhas:
        texto = linha.strip()
        if texto and not texto.startswith("#") and "=" in texto:
            nome = texto.partition("=")[0].strip()
            if nome in valores:
                saida.append(f"{nome}={valores[nome]}")
                vistos.add(nome)
                continue
        saida.append(linha)
    for nome, valor in valores.items():
        if nome not in vistos:
            saida.append(f"{nome}={valor}")
    temporario = caminho.with_suffix(caminho.suffix + ".tmp")
    temporario.write_text("\n".join(saida) + "\n", encoding="utf-8")
    temporario.chmod(0o600)
    temporario.replace(caminho)


def hash_arquivo(caminho: Path) -> str:
    if not caminho.exists():
        return "ausente"
    return hashlib.sha256(caminho.read_bytes()).hexdigest()


# ------------------------------------------------------------------- compose
def compose(*args: str) -> tuple[int, str]:
    """Comando de deploy. Em ensaio, VIGIA_COMPOSE_CMD aponta para um stub."""
    stub = os.environ.get("VIGIA_COMPOSE_CMD")
    if stub:
        completo = [stub, *args]
        cwd = None
    else:
        completo = ["docker", "compose", "-p", CONFIG["compose_projeto"], *args]
        cwd = str(PROJETO)
    try:
        saida = subprocess.run(completo, cwd=cwd, capture_output=True, text=True, timeout=240)
        return saida.returncode, (saida.stdout + saida.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, f"{type(exc).__name__}: {exc}"


# ------------------------------------------------------------------- validação
def valida(alvo_eleicao: str, alvo_turno: str, api_base: str) -> tuple[bool, list[str]]:
    """Confere a troca pela rota pública. Devolve (ok, linhas de evidência)."""
    linhas: list[str] = []
    ok = True

    try:
        status, health = http_json(f"{api_base}/api/health")
    except Exception as exc:
        return False, [f"/api/health inacessível: {type(exc).__name__}: {exc}"]
    linhas.append(f"GET /api/health -> {status} turno={health.get('turno')} eleicao={health.get('eleicao')}")
    if status != 200 or str(health.get("turno")) != alvo_turno or str(health.get("eleicao")) != alvo_eleicao:
        ok = False
        linhas.append(f"  esperava turno={alvo_turno} eleicao={alvo_eleicao}")

    try:
        status, config = http_json(f"{api_base}/api/config")
    except Exception as exc:
        return False, linhas + [f"/api/config inacessível: {type(exc).__name__}: {exc}"]
    url_nacional = str(config.get("url_nacional") or "")
    esperado = f"/{alvo_eleicao}/dados/br/br-c0001-e{int(alvo_eleicao):06d}-u.json"
    linhas.append(f"GET /api/config -> {status} url_nacional={url_nacional}")
    if status != 200 or not url_nacional.endswith(esperado):
        ok = False
        linhas.append(f"  esperava url_nacional terminando em {esperado}")

    try:
        status, fonte = http_json(f"{api_base}/api/fonte", timeout=25)
    except Exception as exc:
        return False, linhas + [f"/api/fonte inacessível: {type(exc).__name__}: {exc}"]
    linhas.append(f"GET /api/fonte -> {status} ok={fonte.get('ok')}")
    if status != 200:
        ok = False
        linhas.append(f"  esperava 200, veio {status}: {str(fonte.get('erro'))[:160]}")

    return ok, linhas


def espera_api(api_base: str, alvo_eleicao: str, alvo_turno: str, segundos: int) -> tuple[bool, list[str]]:
    limite = time.monotonic() + segundos
    ultimas: list[str] = []
    while time.monotonic() < limite:
        ok, linhas = valida(alvo_eleicao, alvo_turno, api_base)
        if ok:
            return True, linhas
        ultimas = linhas
        time.sleep(3)
    return False, ultimas


# -------------------------------------------------------------------- telegram
def avisa(texto: str) -> tuple[bool, str]:
    """Usa o helper de Telegram desta máquina (casa_alerta). Falha não derruba o vigia."""
    if os.environ.get("VIGIA_ENSAIO") == "1":
        print("[ensaio] Telegram NÃO enviado. Mensagem que sairia:\n"
              + "\n".join("  | " + linha for linha in texto.splitlines()), flush=True)
        return True, "não enviado (ensaio)"
    scripts = str(BASE_HERMES / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    try:
        import casa_alerta  # type: ignore
    except Exception as exc:
        return False, f"helper de Telegram indisponível ({type(exc).__name__}: {exc})"
    try:
        ok, resposta = casa_alerta.enviar_texto_telegram(texto)
        return bool(ok), json.dumps(resposta, ensure_ascii=False)[:300]
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


# ----------------------------------------------------------------------- estado
def le_json(caminho: Path) -> dict:
    try:
        return json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def grava_json(caminho: Path, dados: dict) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    temporario = caminho.with_suffix(caminho.suffix + ".tmp")
    temporario.write_text(json.dumps(dados, ensure_ascii=False, indent=1), encoding="utf-8")
    temporario.replace(caminho)


def carrega_config() -> dict:
    config = dict(CONFIG_PADRAO)
    config.update(le_json(CONFIG_PATH))
    for chave in ("tse_base", "api_base", "eleicao_alvo", "turno_alvo", "dia_eleicao",
                  "compose_projeto"):
        env = os.environ.get(f"VIGIA_{chave.upper()}")
        if env:
            config[chave] = env
    return config


CONFIG = CONFIG_PADRAO      # preenchido no main; global para o compose() ver


def url_nacional(config: dict) -> str:
    codigo = int(config["eleicao_alvo"])
    return (f"{config['tse_base']}/{config['eleicao_alvo']}/dados/br/"
            f"br-c0001-e{codigo:06d}-u.json")


# ------------------------------------------------------------- janela de virada
def dentro_da_janela(config: dict, momento: datetime | None = None) -> tuple[bool, str]:
    """Trava explícita: só vira dentro de janela_virada. Config inválida = fecha."""
    try:
        janela = config.get("janela_virada")
        if janela is None:
            janela = {}
        if not isinstance(janela, dict):
            raise TypeError("janela_virada não é um objeto")
        data = janela.get("data") or config.get("dia_eleicao")
        de = janela.get("de") or "17:00"
        ate = janela.get("ate") or "23:59"
        if not data:
            raise ValueError("data da janela ausente")
        inicio = datetime.strptime(f"{data} {de}", "%Y-%m-%d %H:%M").replace(tzinfo=FUSO)
        fim = datetime.strptime(f"{data} {ate}", "%Y-%m-%d %H:%M").replace(
            tzinfo=FUSO, second=59, microsecond=999999)
        rotulo = f"{de}–{ate} de {inicio.strftime('%d/%m/%Y')}"
    except (TypeError, ValueError) as exc:
        return False, f"janela_virada inválida em config ({type(exc).__name__}: {exc})"

    if momento is None:
        momento = agora()
    elif momento.tzinfo is None:
        momento = momento.replace(tzinfo=FUSO)
    return (inicio <= momento <= fim), rotulo


# --------------------------------------------------------------------- cadência
def cadencia_vencida(config: dict, estado: dict, forcar: bool) -> tuple[bool, str]:
    if forcar:
        return True, "cadência ignorada (--forcar)"
    ultima = estado.get("ultima_checagem_ts") or 0
    agora_ts = time.time()
    try:
        dia = datetime.strptime(config["dia_eleicao"], "%Y-%m-%d").replace(tzinfo=FUSO)
    except ValueError:
        logar(f"aviso: dia_eleicao inválido ({config['dia_eleicao']!r}); usando janela de 60 min")
        dia = None

    no_dia = False
    if dia is not None:
        hoje = agora().date()
        no_dia = hoje == dia.date() or (dia.date() < hoje <= (dia + timedelta(hours=JANELA_POS_DIA_H)).date())

    janela = JANELA_DIA if no_dia else JANELA_FORA
    faltam = janela - (agora_ts - ultima)
    if faltam <= 0:
        return True, f"janela de {janela // 60} min vencida"
    return False, f"dentro da janela de {janela // 60} min (faltam {int(faltam)}s)"


# ------------------------------------------------------------------ núcleo real
def virada(config: dict, estado: dict) -> int:
    eleicao_alvo = str(config["eleicao_alvo"])
    turno_alvo = str(config["turno_alvo"])
    env_path = PROJETO / ".env"
    api_base = str(config["api_base"])

    if estado.get("virado_em"):
        logar(f"já virado em {estado['virado_em']} — nada a fazer")
        return 0

    na_janela, rotulo = dentro_da_janela(config)
    if not na_janela:
        logar(f"fora da janela de virada ({rotulo}) — não vira "
              f"(agora {agora().strftime('%Y-%m-%d %H:%M')})")
        return 0

    linhas_env = le_env(env_path)
    eleicao_atual = valor_env(linhas_env, "ELEICAO") or "6257"
    turno_atual = valor_env(linhas_env, "TURNO") or "1"

    if eleicao_atual == eleicao_alvo and turno_atual == turno_alvo:
        estado["virado_em"] = agora().isoformat()
        estado["modo"] = "já estava no .env"
        grava_json(ESTADO_PATH, estado)
        logar(f".env já está em ELEICAO={eleicao_alvo} TURNO={turno_alvo} — nada a fazer")
        return 0

    try:
        status, nacional = http_json(url_nacional(config))
    except Exception as exc:
        logar(f"fonte nacional inacessível ({type(exc).__name__}: {exc}) — não vira")
        estado["ultima_checagem_ts"] = time.time()
        grava_json(ESTADO_PATH, estado)
        return 0

    if status != 200:
        logar(f"fonte nacional HTTP {status} — 2º turno ainda não publicado; não vira")
        estado["ultima_checagem_ts"] = time.time()
        grava_json(ESTADO_PATH, estado)
        return 0

    vap = vap_total(nacional)
    logar(f"fonte 6258: and={nacional.get('and')} t={nacional.get('t')} "
          f"dg={nacional.get('dg')} {nacional.get('hg')} vap_total={vap}")
    if vap <= 0:
        estado["ultima_checagem_ts"] = time.time()
        estado["ultimo_vap"] = vap
        grava_json(ESTADO_PATH, estado)
        logar("vap_total=0: apuração do 2º turno ainda não tem voto publicado — NÃO VIRA")
        return 0

    logar(f"vap_total={vap} > 0 — VIRANDO para ELEICAO={eleicao_alvo} TURNO={turno_alvo}")
    backup = env_path.with_name(f".env.bak-turno-{agora().strftime('%Y%m%d-%H%M%S')}")
    antes = hash_arquivo(env_path)
    shutil.copy2(env_path, backup)
    backup.chmod(0o600)
    logar(f"backup do .env em {backup} (sha256 antes={antes[:16]}…)")

    try:
        grava_env(env_path, {"ELEICAO": eleicao_alvo, "TURNO": turno_alvo})
        logar(f".env gravado: ELEICAO={eleicao_alvo} TURNO={turno_alvo}")

        codigo, saida = compose("up", "-d", "api")
        logar(f"docker compose up -d api -> rc={codigo} {saida[:200]}")
        if codigo != 0:
            raise RuntimeError(f"docker compose up -d api falhou (rc={codigo}): {saida[:300]}")

        # O nginx da web resolve `api` no boot: container recriado com IP novo
        # daria 502 até recarregar. Reload não recria a web.
        codigo, saida = compose("exec", "-T", "web", "nginx", "-s", "reload")
        logar(f"reload do nginx da web -> rc={codigo} {saida[:160]}")

        ok, evidencias = espera_api(api_base, eleicao_alvo, turno_alvo, int(config["espera_api_s"]))
        for linha in evidencias:
            logar(f"  validação: {linha}")
        if not ok:
            raise RuntimeError("validação da virada falhou: " + " | ".join(evidencias))
    except Exception as exc:
        motivo = f"{type(exc).__name__}: {exc}"[:600]
        logar(f"FALHA na virada: {motivo} — voltando o .env do backup")
        try:
            shutil.copy2(backup, env_path)
            env_path.chmod(0o600)
            logar(f".env restaurado do backup (sha256={hash_arquivo(env_path)[:16]}…)")
            codigo, saida = compose("up", "-d", "api")
            logar(f"docker compose up -d api (volta) -> rc={codigo} {saida[:160]}")
            compose("exec", "-T", "web", "nginx", "-s", "reload")
            ok_volta, evidencias = espera_api(api_base, eleicao_atual, turno_atual,
                                             int(config["espera_api_s"]))
            for linha in evidencias:
                logar(f"  volta: {linha}")
            if not ok_volta:
                motivo += " | ATENÇÃO: o painel não voltou ao turno anterior na validação"
        except Exception as exc_volta:
            motivo += f" | rollback também falhou: {type(exc_volta).__name__}: {exc_volta}"
            logar(f"ERRO no rollback: {type(exc_volta).__name__}: {exc_volta}")

        estado["falha_em"] = agora().isoformat()
        estado["falha_motivo"] = motivo
        estado["ultima_checagem_ts"] = time.time()
        grava_json(ESTADO_PATH, estado)
        enviado, resposta = avisa(
            "🚨 Painel eleições: virada para o 2º turno FALHOU e foi revertida.\n"
            f"Motivo: {motivo[:400]}\n"
            f"O painel segue no {turno_atual}º turno (eleição {eleicao_atual}).\n"
            f"Log: {LOG_PATH}\n\n— Automatizador"
        )
        logar(f"aviso de falha no Telegram: {('enviado' if enviado else 'FALHOU')} ({resposta})")
        return 1

    estado["virado_em"] = agora().isoformat()
    estado["modo"] = "automático"
    estado["ultima_checagem_ts"] = time.time()
    estado["vap_na_virada"] = vap
    estado["backup"] = str(backup)
    grava_json(ESTADO_PATH, estado)
    logar(f"VIRADO com validação: health/config/fonte no 6258 · backup {backup}")

    enviado, resposta = avisa(
        "✅ Painel eleições no AR no 2º turno (eleição 6258).\n"
        f"Votos publicados na virada: {vap:,}".replace(",", ".") + "\n"
        "Validado: /api/health turno=2 · /api/config URL do 6258 · /api/fonte 200.\n"
        f"Backup do .env: {backup.name}\n\n— Automatizador"
    )
    logar(f"aviso de sucesso no Telegram: {('enviado' if enviado else 'FALHOU')} ({resposta})")
    return 0


# -------------------------------------------------------------------- ensaio
class Stub(BaseHTTPRequestHandler):
    """TSE e API de mentira para o ensaio: mesmas rotas, mesmos campos."""

    estado: dict = {}

    def log_message(self, format, *args):  # noqa: A002 — silêncio no ensaio
        return

    def _json(self, codigo: int, corpo: dict) -> None:
        dados = json.dumps(corpo).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        self.wfile.write(dados)

    def do_GET(self):                     # noqa: N802 (API do http.server)
        virado = Path(self.estado["flag"]).exists()
        if self.path.endswith("/br-c0001-e006258-u.json"):
            return self._json(200, self.estado["tse"])
        if self.path == "/api/health":
            return self._json(200, {
                "ok": True,
                "eleicao": "6258" if virado else "6257",
                "turno": "2" if virado else "1",
                "ufs": 27, "features": 27,
            })
        if self.path == "/api/config":
            eleicao = "6258" if virado else "6257"
            return self._json(200, {
                "eleicao": eleicao,
                "turno": "2" if virado else "1",
                "url_nacional": (f"https://resultados.tse.jus.br/oficial/ele2026/{eleicao}/dados/br/"
                                 f"br-c0001-e{int(eleicao):06d}-u.json"),
            })
        if self.path == "/api/fonte":
            # Na vida real os dois arquivos nacionais existem (6257 fechado,
            # 6258 publicado com zero voto), então a fonte responde 200 nos dois
            # estados: quem denuncia a virada que não pegou é health/config.
            return self._json(200, {"ok": True, "erro": None})
        return self._json(404, {"erro": "não encontrado"})


def _prepara_sandbox(nome: str, base_tmp: Path, env_real: Path, toca_flag: bool) -> dict:
    """Sandbox de ensaio: .env falso, stub de compose e TSE/API de mentira."""
    sandbox = Path(tempfile.mkdtemp(prefix=f"vigia-ensaio-{nome}-", dir=base_tmp))
    env_falso = sandbox / ".env"
    shutil.copy2(env_real, env_falso)
    env_falso.chmod(0o600)

    flag = sandbox / "virado.flag"
    stub_api = sandbox / "stub_compose.sh"
    stub_api.write_text(
        "#!/usr/bin/env bash\n"
        f'echo "[stub compose] docker compose $*"\n'
        f'echo "docker compose $*" >> "{sandbox}/compose.log"\n'
        + (f'touch "{flag}"\n' if toca_flag else "")
        + "exit 0\n",
        encoding="utf-8",
    )
    stub_api.chmod(0o755)

    fixture = json.loads((Path(__file__).resolve().parent / "provas"
                          / "fixtures" / "tse_6258_com_votos.json").read_text(encoding="utf-8"))
    Stub.estado = {"tse": fixture, "flag": str(flag)}
    servidor = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    porta = servidor.server_address[1]
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    return {"sandbox": sandbox, "env_falso": env_falso, "stub_api": stub_api,
            "fixture": fixture, "servidor": servidor, "porta": porta}


def _config_ensaio(porta: int) -> dict:
    config = dict(CONFIG_PADRAO)
    # A janela provada é a do config.json de PRODUÇÃO (não só o default do código):
    # se o arquivo disser 18:00 e o código 17:00, o ensaio tem de acusar.
    config.update(carrega_config())
    config.update({
        "tse_base": f"http://127.0.0.1:{porta}",
        "api_base": f"http://127.0.0.1:{porta}",
        "espera_api_s": 12,
    })
    return config


def roda_ensaio(cenario: str, base_tmp: Path) -> int:
    """Roda a sequência real contra o stub. Nunca toca no .env de produção."""
    global CONFIG, PROJETO, ESTADO_PATH, LOG_PATH
    config_antigo, projeto_antigo, estado_antigo, log_antigo = CONFIG, PROJETO, ESTADO_PATH, LOG_PATH
    env_real = PROJETO / ".env"
    hash_antes = hash_arquivo(env_real)

    ensaio = _prepara_sandbox(cenario, base_tmp, env_real, cenario == "sucesso")
    sandbox = ensaio["sandbox"]
    env_falso = ensaio["env_falso"]
    servidor = ensaio["servidor"]
    porta = ensaio["porta"]

    CONFIG = _config_ensaio(porta)
    PROJETO = sandbox
    ESTADO_PATH = sandbox / "estado.json"
    LOG_PATH = sandbox / "vigia.log"      # ensaio não suja o log de produção
    os.environ["VIGIA_COMPOSE_CMD"] = str(ensaio["stub_api"])
    os.environ["VIGIA_ENSAIO"] = "1"
    os.environ["VIGIA_AGORA"] = "2026-10-25T20:00:00-03:00"   # dentro da janela

    print(f"\n===== ENSAIO ({cenario}) — TSE/API de mentira em 127.0.0.1:{porta}; "
          f".env de mentira em {env_falso} =====")
    print(f"[ensaio] vap_total da fixture = {vap_total(ensaio['fixture'])}")
    estado_ensaio = sandbox / "estado.json"
    try:
        codigo = virada(CONFIG, {})
    finally:
        servidor.shutdown()
        os.environ.pop("VIGIA_COMPOSE_CMD", None)
        os.environ.pop("VIGIA_ENSAIO", None)
        os.environ.pop("VIGIA_AGORA", None)
        CONFIG, PROJETO, ESTADO_PATH = config_antigo, projeto_antigo, estado_antigo
        LOG_PATH = log_antigo

    print(f"[ensaio] rc={codigo}")
    print(f"[ensaio] .env de mentira depois: "
          f"{[l for l in env_falso.read_text().splitlines() if l.startswith(('ELEICAO', 'TURNO'))]}")
    print(f"[ensaio] estado: {json.loads(estado_ensaio.read_text()) if estado_ensaio.exists() else '{}'}")
    if (sandbox / "compose.log").exists():
        print(f"[ensaio] chamadas de compose:\n{(sandbox / 'compose.log').read_text().rstrip()}")

    hash_depois = hash_arquivo(env_real)
    if hash_depois != hash_antes:
        print(f"[ensaio] ERRO: o .env REAL mudou ({hash_antes[:12]} -> {hash_depois[:12]})")
        return 2
    print(f"[ensaio] .env real intacto: sha256={hash_depois[:16]}… (mesmo antes e depois)")
    return codigo


def roda_ensaio_janela(caso: str, momento: str, espera_virar: bool, base_tmp: Path) -> int:
    """Um caso da trava de janela, em sandbox próprio e com VIGIA_AGORA fixo."""
    global CONFIG, PROJETO, ESTADO_PATH, LOG_PATH
    config_antigo, projeto_antigo, estado_antigo, log_antigo = CONFIG, PROJETO, ESTADO_PATH, LOG_PATH
    env_real = PROJETO / ".env"
    hash_antes = hash_arquivo(env_real)

    ensaio = _prepara_sandbox(f"janela-{caso}", base_tmp, env_real, espera_virar)
    sandbox = ensaio["sandbox"]
    env_falso = ensaio["env_falso"]
    servidor = ensaio["servidor"]
    porta = ensaio["porta"]
    hash_env_antes = hash_arquivo(env_falso)

    CONFIG = _config_ensaio(porta)
    PROJETO = sandbox
    ESTADO_PATH = sandbox / "estado.json"
    LOG_PATH = sandbox / "vigia.log"
    os.environ["VIGIA_COMPOSE_CMD"] = str(ensaio["stub_api"])
    os.environ["VIGIA_ENSAIO"] = "1"
    os.environ["VIGIA_AGORA"] = momento

    print(f"\n===== ENSAIO JANELA ({caso}) — VIGIA_AGORA={momento}; sandbox {sandbox} =====")
    try:
        codigo = virada(CONFIG, {})
    finally:
        servidor.shutdown()
        os.environ.pop("VIGIA_COMPOSE_CMD", None)
        os.environ.pop("VIGIA_ENSAIO", None)
        os.environ.pop("VIGIA_AGORA", None)
        CONFIG, PROJETO, ESTADO_PATH = config_antigo, projeto_antigo, estado_antigo
        LOG_PATH = log_antigo

    compose_log = sandbox / "compose.log"
    compose_chamado = compose_log.exists() and bool(compose_log.read_text().strip())
    env_intacto = hash_arquivo(env_falso) == hash_env_antes
    turno_depois = valor_env(le_env(env_falso), "TURNO")
    estado_existe = (sandbox / "estado.json").exists()
    env_real_intacto = hash_arquivo(env_real) == hash_antes

    if espera_virar:
        veredito = "VIRA"
        ok = codigo == 0 and turno_depois == "2" and compose_chamado
        detalhe = f"rc={codigo} TURNO={turno_depois} compose={'sim' if compose_chamado else 'nao'}"
    else:
        veredito = "NAO VIRA"
        ok = codigo == 0 and env_intacto and not compose_chamado and not estado_existe
        detalhe = (f"rc={codigo} .env={'intacto' if env_intacto else 'MUDOU'} "
                   f"compose={'sim' if compose_chamado else 'nao'} "
                   f"estado={'sim' if estado_existe else 'nao'}")
    ok = ok and env_real_intacto
    detalhe += f" .env_real={'intacto' if env_real_intacto else 'MUDOU'}"
    print(f"[janela] ({caso}) {momento[:16]} -> {veredito} {detalhe} {'OK' if ok else 'FALHOU'}")
    return 0 if ok else 2


# --------------------------------------------------------------- rodar/decidir
def executa(config: dict, forcar: bool = False) -> int:
    """Caminho ÚNICO de decisão do timer: estado -> JANELA -> cadência -> virada.

    A janela vem antes da cadência de propósito: em 24/10 o log tem de dizer
    "fora da janela de virada", não "dentro da janela de 60 min". `forcar`
    ignora a cadência, nunca a janela — virar antes das 17:00 não é opção.
    """
    estado = le_json(ESTADO_PATH)
    if estado.get("virado_em"):
        logar(f"já virado em {estado['virado_em']} — nada a fazer")
        return 0

    na_janela, rotulo = dentro_da_janela(config)
    if not na_janela:
        logar(f"fora da janela de virada ({rotulo}) — não vira "
              f"(agora {agora().strftime('%Y-%m-%d %H:%M')})")
        return 0

    pode, motivo = cadencia_vencida(config, estado, forcar)
    if not pode:
        logar(f"cadência: {motivo} — sem checagem agora")
        return 0
    return virada(config, estado)     # virada() repete a trava (defesa em profundidade)


# ----------------------------------------------------------------------- main
def main(argv: list[str] | None = None) -> int:
    global CONFIG
    parser = argparse.ArgumentParser(description="Vigia de turno do painel eleições 2026")
    parser.add_argument("--forcar", action="store_true", help="ignora a cadência de 10/60 min")
    parser.add_argument("--ensaio", nargs="?", const="todos",
                        choices=["todos", "sucesso", "falha", "janela"],
                        help="ensaia a virada contra um TSE/API de mentira, sem tocar no .env real")
    args = parser.parse_args(argv)

    CONFIG = carrega_config()
    if args.ensaio:
        base_tmp = Path(tempfile.mkdtemp(prefix="ensaio-vigia-"))
        if args.ensaio == "janela":
            casos = [
                ("a", "2026-10-25T16:59:00-03:00", False),   # antes das 17:00
                ("b", "2026-10-25T17:00:00-03:00", True),    # 17:00 em ponto (abre)
                ("c", "2026-10-26T00:00:00-03:00", False),   # depois das 23:59
                ("d", "2026-10-24T22:00:00-03:00", False),   # hoje, 24/10
            ]
            pior = 0
            for caso, momento, espera_virar in casos:
                pior = max(pior, roda_ensaio_janela(caso, momento, espera_virar, base_tmp))
            print(f"\nENSAIO JANELA {'OK' if pior == 0 else 'PROBLEMA'}: "
                  f"fora da janela não vira; dentro dela vira")
            shutil.rmtree(base_tmp, ignore_errors=True)
            return pior

        cenarios = ["sucesso", "falha"] if args.ensaio == "todos" else [args.ensaio]
        pior = 0
        for cenario in cenarios:
            rc = roda_ensaio(cenario, base_tmp)
            if cenario == "sucesso":
                pior = max(pior, 0 if rc == 0 else 2)
            else:                                    # falha esperada: rc=1 e rollback
                pior = max(pior, 0 if rc == 1 else 2)
        print(f"\nENSAIO {'OK' if pior == 0 else 'PROBLEMA'}: "
              f"sucesso vira e valida; falha faz rollback e avisa (rc esperado 1)")
        shutil.rmtree(base_tmp, ignore_errors=True)
        return pior

    estado = le_json(ESTADO_PATH)
    if estado.get("virado_em"):
        logar(f"já virado em {estado['virado_em']} — nada a fazer")
        return 0

    return executa(CONFIG, args.forcar)


if __name__ == "__main__":
    raise SystemExit(main())
