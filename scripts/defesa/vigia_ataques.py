#!/usr/bin/env python3
"""vigia_ataques.py — defesa automática do eleicao2026.belmino.dev.

Roda a cada 1 min (systemd --user, hermes-eleicao-defesa.timer) e responde a
uma pergunta só: algum IP público está abusando? Se sim, ele bloqueia SÓ aquele
IP na borda do nginx, mantém o site no ar para todo mundo e avisa no Telegram.

O que NÃO faz, por decisão de projeto:
  * não mexe em rota, conteúdo, mapa ou dado — só na lista de bloqueio do nginx;
  * não bloqueia IP privado, loopback, link-local, multicast ou reservado. Essa
    é a trava mais importante do arquivo: 127.0.0.1 é o túnel Cloudflare, o
    próprio nginx e o painel. Bloquear loopback = derrubar o site inteiro;
  * não guarda IP além do necessário: o log de defesa (var/defesa/acessos.log)
    é do nginx, fica 0600, é truncado por este script e a lista de bloqueio
    expira sozinha.

Regras de detecção (janela deslizante, limiares configuráveis por ambiente):

  LIMITE_REQ_MIN   120   requisições do mesmo IP em 60 s
  LIMITE_429       20    respostas 429 (rate limit) em 60 s
  DURACAO_MIN      30    janela do bloqueio, renovável enquanto o abuso durar

Só essas duas regras bloqueiam sozinhas — e as duas são de VOLUME/SURTO, que um
visitante legítimo nunca produz. Acúmulo de caminhos suspeitos NÃO bloqueia:
isso virou ESCORE DE SUSPEITA (scripts/defesa/suspeita.py), que identifica,
classifica (limpo/observar/suspeito/malicioso) e avisa no Telegram, deixando o
bloqueio para decisão manual do Pedro (bloquear.sh <ip> <motivo>).

Por que: em 25/10 a partir das 17 h tem apuração e visitante legítimo fica
conectado por horas, atualizando o painel (polling/SSE). Volume de requisição
do mesmo IP não pode virar suspeita — e não vira: o escore ignora quantidade e
só olha sinais (caminho sensível, payload, método, rota interna, UA, máquina,
reincidência).

Anti-spam do aviso: 1 mensagem por IP a cada 6 h; se houver mais de 3 suspeitos
novos, sai UMA mensagem consolidada (no máximo a cada 30 min) em vez de várias.

Uso:
  vigia_ataques.py                 ciclo normal (lê o log, decide, aplica)
  vigia_ataques.py --forcar        idem, sem checar cadência (o timer já cadencia)
  vigia_ataques.py --ensaio        decide e imprime, sem tocar no nginx/Telegram
  vigia_ataques.py --autoteste     prova que faixas privadas jamais são bloqueadas
  vigia_ataques.py --status        estado atual (bloqueios ativos, suspeitos, contador)
  vigia_ataques.py --suspeitos     lista os IPs com escore agora (sem enviar nada)
  vigia_ataques.py --bloquear IP --motivo "..." [--minutos N]
  vigia_ataques.py --desbloquear IP
  vigia_ataques.py --desbloquear-todos
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]  # /home/pedro/eleicao2026-mapa
DEFESA_DIR = Path(os.environ.get("DEFESA_DIR", RAIZ / "var" / "defesa"))
ARQ_LOG = DEFESA_DIR / "acessos.log"
ARQ_BLOQUEIOS = DEFESA_DIR / "bloqueios.conf"
ARQ_ESTADO = DEFESA_DIR / "estado.json"
LOG_VIGIA = Path(os.environ.get("DEFESA_LOG", Path.home() / ".hermes/logs/eleicao-defesa.log"))

# Módulo irmão: escore de suspeita (mesmas regras do painel 8113, conferidas
# contra o mesmo fixture). Fica ao lado deste arquivo de propósito — mover o
# vigia sem levar suspeita.py junto quebra a importação, e isso é visível.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import suspeita  # noqa: E402

LIMITE_REQ_MIN = int(os.environ.get("LIMITE_REQ_MIN", "120"))
LIMITE_429 = int(os.environ.get("LIMITE_429", "20"))
DURACAO_MIN = int(os.environ.get("DURACAO_MIN", "30"))
MANUAL_DURACAO_MIN = int(os.environ.get("MANUAL_DURACAO_MIN", "240"))
JANELA_RATE_S = 60
JANELA_SUSPEITA_S = 300
MAX_BYTES_POR_CICLO = 4 * 1024 * 1024
LIMITE_LOG_BYTES = int(os.environ.get("LIMITE_LOG_BYTES", str(5 * 1024 * 1024)))
AVISO_RENOVACAO_S = 600  # não repetir Telegram de renovação antes disso

# Escore de suspeita (identifica e avisa; NÃO bloqueia).
ESCORE_SUSPEITO = 60          # >= 60 avisa
ESCORE_MALICIOSO = 80         # >= 80 avisa como malicioso
AVISO_IP_JANELA_S = 6 * 3600  # 1 aviso por IP a cada 6 h
RESUMO_INTERVALO_S = 1800     # consolidado no máximo a cada 30 min
RESUMO_MIN_SUSPEITOS = 4      # "mais de 3" suspeitos novos = consolidado
MAX_AVISOS_POR_CICLO = 3      # surto de avisos individuais não vira metralhadora
PAINEL_URL = os.environ.get("PAINEL_URL", "http://192.168.5.179:8113")

FUSO = timezone(timedelta(hours=-3))  # Brasília, sem horário de verão

# Caminhos que ninguém legítimo pede num mapa eleitoral. Servem para pegar
# varredura (path traversal, arquivo de configuração, painel de terceiro).
PADROES_ATAQUE = re.compile(
    r"(\.\./|%2e%2e|\.env|\.git|/etc/passwd|wp-admin|wp-login|xmlrpc\.php|"
    r"phpmyadmin|/\.aws|/\.ssh|/config\.|/backup|/shell|/cgi-bin|\.php$|"
    r"/vendor/|/admin|/mysql|/actuator|/console)",
    re.IGNORECASE,
)


# ------------------------------------------------------------------ utilidades
def agora() -> datetime:
    return datetime.now(FUSO)


def carimbo(momento: datetime) -> str:
    return momento.isoformat(timespec="seconds")


def logar(mensagem: str) -> None:
    linha = f"{carimbo(agora())} {mensagem}"
    print(linha, flush=True)
    try:
        LOG_VIGIA.parent.mkdir(parents=True, exist_ok=True)
        with LOG_VIGIA.open("a", encoding="utf-8") as arquivo:
            arquivo.write(linha + "\n")
    except OSError as exc:  # log é conveniência; nunca derruba o ciclo
        print(f"aviso: não consegui escrever em {LOG_VIGIA}: {exc}", file=sys.stderr, flush=True)


def ler_estado() -> dict:
    try:
        estado = json.loads(ARQ_ESTADO.read_text(encoding="utf-8"))
        if not isinstance(estado, dict):
            raise ValueError("estado não é objeto")
    except (OSError, ValueError, json.JSONDecodeError):
        estado = {}
    estado.setdefault("offset", 0)
    estado.setdefault("bloqueios", {})
    estado.setdefault("total_bloqueios", 0)
    estado.setdefault("ultima_execucao", "")
    return estado


def gravar_estado(estado: dict) -> None:
    temporario = ARQ_ESTADO.with_suffix(".tmp")
    temporario.write_text(json.dumps(estado, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporario, ARQ_ESTADO)


def ip_publico(texto: str) -> bool:
    """True só para IP global (fora de privado/loopback/link-local/reservado).

    É a trava que impede o vigia de derrubar o túnel, o nginx e o painel.
    """
    try:
        endereco = ipaddress.ip_address(texto.strip())
    except ValueError:
        return False
    if endereco.is_loopback or endereco.is_private or endereco.is_link_local:
        return False
    if endereco.is_multicast or endereco.is_reserved or endereco.is_unspecified:
        return False
    return endereco.is_global


def telegram(texto: str, ensaio: bool = False) -> tuple[bool, str]:
    """Usa o helper de Telegram desta máquina (casa_alerta). Falha não derruba."""
    if ensaio:
        print("[ensaio] Telegram NÃO enviado. Mensagem:\n" + texto, flush=True)
        return True, "não enviado (ensaio)"
    caminho = Path.home() / ".hermes" / "scripts"
    if str(caminho) not in sys.path:
        sys.path.insert(0, str(caminho))
    try:
        import casa_alerta  # type: ignore

        ok, resposta = casa_alerta.enviar_texto_telegram(texto)
        return bool(ok), json.dumps(resposta, ensure_ascii=False)[:200]
    except Exception as exc:  # noqa: BLE001 — helper de terceiro, qualquer falha serve
        return False, f"{type(exc).__name__}: {exc}"


# ------------------------------------------------------------------- leitura
def ler_linhas_novas(estado: dict) -> tuple[list[str], int]:
    """Lê do offset salvo até o fim. Devolve linhas completas e o novo offset."""
    try:
        tamanho = ARQ_LOG.stat().st_size
    except OSError:
        return [], 0

    offset = int(estado.get("offset", 0))
    if tamanho < offset:  # arquivo truncado/rotacionado: recomeça
        offset = 0
    if tamanho - offset > MAX_BYTES_POR_CICLO:
        offset = tamanho - MAX_BYTES_POR_CICLO
        logar(f"aviso: {ARQ_LOG} cresceu demais no ciclo; lendo só o último trecho")

    try:
        with ARQ_LOG.open("rb") as arquivo:
            arquivo.seek(offset)
            bruto = arquivo.read()
    except OSError as exc:
        logar(f"aviso: log de defesa ilegível ({exc})")
        return [], offset

    corte = bruto.rfind(b"\n")
    if corte < 0:
        return [], offset  # linha pela metade: espera o próximo ciclo
    completos = bruto[: corte + 1]
    novo_offset = offset + len(completos)

    linhas = [linha for linha in completos.decode("utf-8", "replace").splitlines() if linha.strip()]
    return linhas, novo_offset


def analisar(linhas: list[str], agora_ts: datetime) -> dict:
    """Agrega por IP: requisições na janela curta, 429 e indícios de varredura."""
    limite_rate = (agora_ts - timedelta(seconds=JANELA_RATE_S)).timestamp()
    limite_suspeita = (agora_ts - timedelta(seconds=JANELA_SUSPEITA_S)).timestamp()

    resumo: dict[str, dict] = {}
    for linha in linhas:
        partes = linha.split()
        if len(partes) < 5:
            continue
        ip, quando, status, metodo, uri = partes[0], partes[1], partes[2], partes[3], partes[4]
        try:
            instante = datetime.fromisoformat(quando).timestamp()
        except ValueError:
            continue
        try:
            codigo = int(status)
        except ValueError:
            continue

        registro = resumo.setdefault(
            ip, {"req60": 0, "c429": 0, "suspeitos": 0, "exemplo": "", "metodo": metodo}
        )
        if instante >= limite_rate:
            registro["req60"] += 1
            if codigo == 429:
                registro["c429"] += 1
        if instante >= limite_suspeita:
            varredura = bool(PADROES_ATAQUE.search(uri))
            if varredura or codigo >= 500:
                registro["suspeitos"] += 1
                if varredura and not registro["exemplo"]:
                    registro["exemplo"] = f"{metodo} {uri}"[:120]
    return resumo


def decidir(resumo: dict) -> list[dict]:
    """Aplica os limiares. Devolve só IP PÚBLICO: faixa privada nunca entra."""
    decisoes = []
    for ip, dados in resumo.items():
        if not ip_publico(ip):
            continue
        motivo = detalhe = ""
        contagem = 0
        if dados["req60"] >= LIMITE_REQ_MIN:
            motivo = "surto"
            contagem = dados["req60"]
            detalhe = f"{dados['req60']} req em {JANELA_RATE_S}s (limite {LIMITE_REQ_MIN}/min)"
        elif dados["c429"] >= LIMITE_429:
            motivo = "429 recorrente"
            contagem = dados["c429"]
            detalhe = f"{dados['c429']} recusas 429 em {JANELA_RATE_S}s (limite {LIMITE_429})"
        # Nada de "varredura" aqui: acúmulo de caminhos suspeitos não bloqueia
        # mais. Quem olha esses sinais é o escore (suspeita.py), que avisa e
        # deixa o bloqueio para o Pedro.
        if motivo:
            decisoes.append({"ip": ip, "motivo": motivo, "detalhe": detalhe, "contagem": contagem})
    return decisoes


# ----------------------------------------------------------- lista de bloqueio
def escrever_bloqueios(bloqueios: dict) -> bool:
    """Escreve a lista geo do nginx. Recusa qualquer IP não público."""
    linhas = [
        "# GERADO por scripts/defesa/vigia_ataques.py — não edite à mão.",
        "# Para tirar um IP: bash scripts/defesa/desbloquear.sh <IP>",
        "# Formato (geo): <ip> 1;",
    ]
    for ip in sorted(bloqueios):
        if not ip_publico(ip):
            logar(f"RECUSADO: {ip} não é IP público — não entra na lista de bloqueio")
            continue
        linhas.append(f"{ip} 1;")
    conteudo = "\n".join(linhas) + "\n"

    try:
        anterior = ARQ_BLOQUEIOS.read_text(encoding="utf-8")
    except OSError:
        anterior = ""
    if anterior == conteudo:
        return False

    temporario = ARQ_BLOQUEIOS.with_suffix(".tmp")
    temporario.write_text(conteudo, encoding="utf-8")
    os.replace(temporario, ARQ_BLOQUEIOS)
    return True


def recarregar_nginx() -> tuple[bool, str]:
    """nginx -t e reload DENTRO do container. Devolve (ok, saída)."""
    base = ["docker", "compose", "-p", "eleicao2026-mapa", "exec", "-T", "web"]
    try:
        teste = subprocess.run(base + ["nginx", "-t"], cwd=RAIZ, capture_output=True, text=True, timeout=30)
        if teste.returncode != 0:
            return False, (teste.stderr or teste.stdout).strip()[:300]
        recarga = subprocess.run(
            base + ["nginx", "-s", "reload"], cwd=RAIZ, capture_output=True, text=True, timeout=30
        )
        if recarga.returncode != 0:
            return False, (recarga.stderr or recarga.stdout).strip()[:300]
        # O reload é assíncrono (HUP no master): sem esta pausa, um pedido logo
        # depois ainda pega a geração antiga da lista.
        time.sleep(0.6)
        return True, "reload ok"
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"{type(exc).__name__}: {exc}"


# ------------------------------------------------- escore de suspeita (aviso)
def setor_suspeita(estado: dict) -> dict:
    """Sub-estado do escore: acumulado por IP + controle de anti-spam."""
    setor = estado.setdefault("suspeita", {})
    if not isinstance(setor, dict):
        setor = {}
        estado["suspeita"] = setor
    setor.setdefault("acumulado", {})
    setor.setdefault("avisos", {})
    setor.setdefault("ultimo_resumo", "")
    return setor


def acumular_suspeitas(linhas: list[str], estado: dict, agora_ts: datetime) -> dict[str, dict]:
    """Registra as linhas novas no acumulado e devolve {ip: avaliação}."""
    setor = setor_suspeita(estado)
    acumulado = setor["acumulado"]
    for linha in linhas:
        try:
            suspeita.registrar_linha(acumulado, linha)
        except (ValueError, TypeError, KeyError) as exc:  # linha torta não derruba ciclo
            logar(f"aviso: linha ignorada no escore ({type(exc).__name__}: {exc})")
    suspeita.podar(acumulado, carimbo(agora_ts))

    avaliacoes = {}
    for ip, reg in acumulado.items():
        if not ip_publico(ip):
            continue
        avaliacoes[ip] = suspeita.avaliar(reg)
    return avaliacoes


def _primeiro_e_ultimo(reg: dict) -> tuple[str, str]:
    def bonito(texto: str | None) -> str:
        if not texto:
            return "?"
        try:
            return datetime.fromisoformat(texto).astimezone(FUSO).strftime("%d/%m %H:%M")
        except ValueError:
            return "?"

    return bonito(reg.get("primeiro")), bonito(reg.get("ultimo"))


def _host_principal(reg: dict) -> str:
    hosts = reg.get("hosts") or {}
    if not hosts:
        return "?"
    return max(sorted(hosts), key=lambda h: hosts[h])


def mensagem_suspeito(ip: str, avaliacao: dict, reg: dict) -> str:
    """Aviso de UM IP. Sem markdown: Telegram cru, para não quebrar formatação."""
    nomes = [ROTULO_SINAL.get(chave) or chave for chave in avaliacao["sinais"]]
    primeiro, ultimo = _primeiro_e_ultimo(reg)
    host = _host_principal(reg)
    comando = f'bash scripts/defesa/bloquear.sh {ip} "escore {avaliacao["escore"]} no painel"'
    return (
        "🔎 eleição 2026 · suspeito no monitor\n"
        f"IP {ip} · escore {avaliacao['escore']}/100 · {avaliacao['nivel']}\n"
        f"sinais ({len(nomes)}): {', '.join(nomes)}\n"
        f"host: {host} · eventos: {reg.get('eventos', 0)} · janela: {primeiro} → {ultimo}\n"
        f"painel: {PAINEL_URL}\n"
        f"bloquear (manual): {comando}\n"
        "NÃO bloqueado automaticamente — a decisão é sua."
    )


def mensagem_resumo(candidatos: list[tuple[str, dict, dict]]) -> str:
    """Consolidado: mais de 3 suspeitos novos na mesma janela."""
    linhas = ["🔎 eleição 2026 · resumo de suspeitos (escore)", ""]
    for ip, avaliacao, reg in candidatos[:10]:
        nomes = [ROTULO_SINAL.get(chave) or chave for chave in avaliacao["sinais"]]
        primeiro, ultimo = _primeiro_e_ultimo(reg)
        linhas.append(
            f"{ip} · {avaliacao['escore']}/100 {avaliacao['nivel']} · "
            f"{reg.get('eventos', 0)} eventos · {primeiro} → {ultimo}"
        )
        linhas.append(f"    sinais: {', '.join(nomes)}")
    if len(candidatos) > 10:
        linhas.append(f"... e mais {len(candidatos) - 10}")
    linhas.append("")
    linhas.append(f"painel: {PAINEL_URL}")
    linhas.append("nenhum bloqueio automático · bloquear é decisão sua (bloquear.sh)")
    return "\n".join(linhas)


ROTULO_SINAL = {
    "caminho_sensivel": "caminho sensível",
    "injecao": "payload de injeção",
    "metodo_anomalo": "método anômalo",
    "sondagem_interna": "sondou rota interna",
    "ua_anomalo": "UA de bot/falsificado",
    "regularidade": "regularidade de máquina",
    "reincidencia": "voltou após 403/404",
}


def avisos_de_suspeita(estado: dict, agora_ts: datetime) -> list[str]:
    """Decide QUAIS mensagens sair (anti-spam) e marca o estado.

    Regras: 1 aviso por IP a cada 6 h; se houver mais de 3 suspeitos novos,
    uma única mensagem consolidada (no máximo a cada 30 min); no máximo 3
    avisos individuais por ciclo.
    """
    setor = setor_suspeita(estado)
    acumulado = setor["acumulado"]
    avisos = setor["avisos"]

    candidatos: list[tuple[str, dict, dict]] = []
    for ip, reg in acumulado.items():
        if not ip_publico(ip):
            continue
        avaliacao = suspeita.avaliar(reg)
        if avaliacao["escore"] < ESCORE_SUSPEITO:
            continue
        ultimo = avisos.get(ip)
        if ultimo:
            try:
                if (agora_ts - datetime.fromisoformat(ultimo)).total_seconds() < AVISO_IP_JANELA_S:
                    continue
            except ValueError:
                pass  # estado torto: trata como "nunca avisado"
        candidatos.append((ip, avaliacao, reg))

    if not candidatos:
        return []

    candidatos.sort(key=lambda item: (-item[1]["escore"], item[0]))
    mensagens: list[str] = []

    ultimo_resumo = setor.get("ultimo_resumo") or ""
    resumo_liberado = True
    if ultimo_resumo:
        try:
            resumo_liberado = (
                agora_ts - datetime.fromisoformat(ultimo_resumo)
            ).total_seconds() >= RESUMO_INTERVALO_S
        except ValueError:
            resumo_liberado = True

    if len(candidatos) >= RESUMO_MIN_SUSPEITOS and resumo_liberado:
        mensagens.append(mensagem_resumo(candidatos))
        setor["ultimo_resumo"] = carimbo(agora_ts)
        for ip, _avaliacao, _reg in candidatos:
            avisos[ip] = carimbo(agora_ts)
        logar(f"resumo de suspeitos: {len(candidatos)} IP(s) numa mensagem só")
        return mensagens

    for ip, avaliacao, reg in candidatos[:MAX_AVISOS_POR_CICLO]:
        mensagens.append(mensagem_suspeito(ip, avaliacao, reg))
        avisos[ip] = carimbo(agora_ts)
        logar(f"SUSPEITO {ip} · escore {avaliacao['escore']} · {avaliacao['nivel']} · {avaliacao['sinais']}")
    return mensagens


# ----------------------------------------------------------------- ciclos
def aplicar(decisoes: list[dict], estado: dict, ensaio: bool, agora_ts: datetime) -> list[str]:
    """Bloqueia/renova e devolve as linhas de aviso do Telegram."""
    avisos = []
    bloqueios = estado["bloqueios"]

    for decisao in decisoes:
        ip = decisao["ip"]
        registro = bloqueios.get(ip)
        if registro is None:
            ate = agora_ts + timedelta(minutes=DURACAO_MIN)
            bloqueios[ip] = {
                "motivo": decisao["motivo"],
                "detalhe": decisao["detalhe"],
                "contagem": decisao["contagem"],
                "desde": carimbo(agora_ts),
                "ate": carimbo(ate),
                "avisado_em": carimbo(agora_ts),
                "renovacoes": 0,
            }
            estado["total_bloqueios"] = int(estado.get("total_bloqueios", 0)) + 1
            logar(
                f"BLOQUEIO {ip} · {decisao['motivo']} · {decisao['detalhe']} · "
                f"até {bloqueios[ip]['ate']}"
            )
            avisos.append(
                f"🛡️ eleição 2026 · defesa\n"
                f"IP {ip} BLOQUEADO por {DURACAO_MIN} min\n"
                f"motivo: {decisao['motivo']} — {decisao['detalhe']}\n"
                f"horário: {agora_ts.strftime('%d/%m %H:%M')}\n"
                f"site segue no ar para os outros · bloqueios ativos: {len(bloqueios)}"
            )
        else:
            renovado = max(
                datetime.fromisoformat(registro["ate"]),
                agora_ts + timedelta(minutes=DURACAO_MIN),
            )
            mudou = renovado > datetime.fromisoformat(registro["ate"])
            registro["ate"] = carimbo(renovado)
            registro["contagem"] = decisao["contagem"]
            if mudou:
                registro["renovacoes"] = int(registro.get("renovacoes", 0)) + 1
                logar(f"RENOVAÇÃO {ip} · {decisao['motivo']} · até {registro['ate']}")
                ultimo_aviso = datetime.fromisoformat(registro.get("avisado_em") or registro["desde"])
                if (agora_ts - ultimo_aviso).total_seconds() >= AVISO_RENOVACAO_S:
                    registro["avisado_em"] = carimbo(agora_ts)
                    avisos.append(
                        f"🛡️ eleição 2026 · defesa\n"
                        f"IP {ip} segue bloqueado (renovado até {renovado.strftime('%d/%m %H:%M')})\n"
                        f"motivo: {decisao['motivo']} — {decisao['detalhe']}"
                    )

    # Desbloqueio automático no fim da janela.
    for ip in list(bloqueios):
        try:
            expira = datetime.fromisoformat(bloqueios[ip]["ate"])
        except (KeyError, ValueError):
            del bloqueios[ip]
            continue
        if expira <= agora_ts:
            del bloqueios[ip]
            logar(f"DESBLOQUEIO automático {ip} (janela de {DURACAO_MIN} min venceu)")

    if ensaio:
        return avisos

    mudou_lista = escrever_bloqueios(bloqueios)
    if mudou_lista:
        ok, resposta = recarregar_nginx()
        logar(f"lista de bloqueio aplicada no nginx: {resposta}")
        if not ok:
            avisos.append(
                "⚠️ eleição 2026 · defesa\n"
                f"a lista de bloqueio mudou mas o nginx NÃO recarregou: {resposta}\n"
                "bloqueio não está valendo — ver journalctl --user -u hermes-eleicao-defesa"
            )
    return avisos


def ciclo(ensaio: bool = False) -> int:
    estado = ler_estado()
    agora_ts = agora()

    linhas, novo_offset = ler_linhas_novas(estado)
    resumo = analisar(linhas, agora_ts)
    decisoes = decidir(resumo)

    avisos = aplicar(decisoes, estado, ensaio, agora_ts)

    # Escore de suspeita: lê as mesmas linhas novas, acumula por IP e decide os
    # avisos (anti-spam). Nunca bloqueia.
    avaliacoes = acumular_suspeitas(linhas, estado, agora_ts)
    avisos_suspeita = avisos_de_suspeita(estado, agora_ts)
    avisos.extend(avisos_suspeita)

    if avaliacoes:
        interessantes = [
            (ip, av) for ip, av in avaliacoes.items() if av["escore"] >= ESCORE_SUSPEITO
        ]
        if interessantes:
            interessantes.sort(key=lambda item: -item[1]["escore"])
            listagem = ", ".join(f"{ip}({av['escore']})" for ip, av in interessantes[:5])
            logar(f"escore: {len(interessantes)} IP(s) >= {ESCORE_SUSPEITO} — {listagem}")
            estado.setdefault("suspeita", {})["ultima_avaliacao"] = {
                "quando": carimbo(agora_ts),
                "avaliados": len(avaliacoes),
                "suspeitos": len(interessantes),
                "topo": [
                    {"ip": ip, "escore": av["escore"], "nivel": av["nivel"], "sinais": av["sinais"]}
                    for ip, av in interessantes[:5]
                ],
            }

    if not ensaio:
        estado["offset"] = novo_offset
        estado["ultima_execucao"] = carimbo(agora_ts)
        estado["ultimo_ciclo"] = {
            "linhas": len(linhas),
            "ips": len(resumo),
            "decisoes": len(decisoes),
            "suspeitos_avaliados": len(avaliacoes),
        }
        # Retenção: o log por IP não cresce sem limite. Acima do teto ele é
        # truncado (nginx abre com O_APPEND, então volta a escrever do zero) e
        # o offset zera junto.
        try:
            if ARQ_LOG.stat().st_size > LIMITE_LOG_BYTES:
                with ARQ_LOG.open("wb"):
                    pass
                estado["offset"] = 0
                logar(f"log de defesa truncado (passou de {LIMITE_LOG_BYTES} B)")
        except OSError as exc:
            logar(f"aviso: não consegui truncar o log de defesa ({exc})")
        gravar_estado(estado)

    for aviso in avisos:
        ok, resposta = telegram(aviso, ensaio)
        logar(f"Telegram: {('enviado' if ok else 'FALHOU')} ({resposta})")

    if decisoes:
        resumo_decisoes = ", ".join(f"{d['ip']}({d['motivo']})" for d in decisoes)
        logar(f"ciclo: {len(linhas)} linhas · {len(decisoes)} decisão(ões): {resumo_decisoes}")
    return 0


# ------------------------------------------------------------------- comandos
def status() -> int:
    estado = ler_estado()
    bloqueios = estado.get("bloqueios", {})
    print(f"estado: {ARQ_ESTADO}")
    print(f"última execução: {estado.get('ultima_execucao') or '—'}")
    print(f"total de bloqueios (histórico): {estado.get('total_bloqueios', 0)}")
    print(f"bloqueios ativos: {len(bloqueios)}")
    for ip, registro in sorted(bloqueios.items()):
        print(
            f"  {ip:16} {registro.get('motivo','?'):16} até {registro.get('ate','?')} "
            f"({registro.get('detalhe','')})"
        )
    caminho = ARQ_LOG
    try:
        print(f"log de defesa: {caminho} ({caminho.stat().st_size} B)")
    except OSError:
        print(f"log de defesa: {caminho} (ausente)")

    setor = estado.get("suspeita") or {}
    acumulado = (setor or {}).get("acumulado") or {}
    if acumulado:
        avaliados = []
        for ip, reg in acumulado.items():
            if not ip_publico(ip):
                continue
            avaliados.append((ip, suspeita.avaliar(reg), reg))
        avaliados.sort(key=lambda item: (-item[1]["escore"], item[0]))
        acima = [item for item in avaliados if item[1]["escore"] >= ESCORE_SUSPEITO]
        print(f"suspeita: {len(avaliados)} IP(s) acumulado(s), {len(acima)} em suspeito+")
        for ip, avaliacao, reg in acima[:10]:
            print(
                f"  {ip:16} escore {avaliacao['escore']:3} {avaliacao['nivel']:10} "
                f"{reg.get('eventos', 0):5} eventos · {', '.join(avaliacao['sinais'])}"
            )
    else:
        print("suspeita: sem acumulado ainda (o vigia preenche a cada ciclo)")
    return 0


def listar_suspeitos() -> int:
    """Imprime o escore de todos os IPs acumulados (nada é enviado nem bloqueado)."""
    estado = ler_estado()
    acumulado = ((estado.get("suspeita") or {}).get("acumulado") or {})
    if not acumulado:
        print("sem acumulado: rode o vigia uma vez (--forcar) para ler o log")
        return 0

    linhas = []
    for ip, reg in acumulado.items():
        if not ip_publico(ip):
            continue
        avaliacao = suspeita.avaliar(reg)
        linhas.append((ip, avaliacao, reg))
    linhas.sort(key=lambda item: (-item[1]["escore"], item[0]))

    print(f"{'IP':16} {'ESCORE':>6} {'NÍVEL':10} {'EVENTOS':>7}  SINAIS")
    for ip, avaliacao, reg in linhas:
        print(
            f"{ip:16} {avaliacao['escore']:6} {avaliacao['nivel']:10} "
            f"{reg.get('eventos', 0):7}  {', '.join(avaliacao['sinais']) or '-'}"
        )
    return 0


def bloquear(alvo: str, motivo: str, minutos: int) -> int:
    """Bloqueio MANUAL: só entra IP público, e a janela expira sozinha."""
    ip = (alvo or "").strip()
    if not ip_publico(ip):
        print(f"RECUSADO: {ip!r} não é IP público — não entra na lista de bloqueio", file=sys.stderr)
        return 65

    motivo_limpo = " ".join((motivo or "").split())[:120] or "manual"
    estado = ler_estado()
    bloqueios = estado.setdefault("bloqueios", {})
    agora_ts = agora()
    ate = agora_ts + timedelta(minutes=max(1, int(minutos)))
    anterior = bloqueios.get(ip)
    bloqueios[ip] = {
        "motivo": "manual",
        "detalhe": motivo_limpo,
        "contagem": 0,
        "desde": (anterior or {}).get("desde") or carimbo(agora_ts),
        "ate": carimbo(ate),
        "avisado_em": carimbo(agora_ts),
        "renovacoes": int((anterior or {}).get("renovacoes", 0)),
        "origem": "manual",
    }
    estado["total_bloqueios"] = int(estado.get("total_bloqueios", 0)) + 1
    mudou = escrever_bloqueios(bloqueios)
    ok, resposta = (True, "lista igual")
    if mudou:
        ok, resposta = recarregar_nginx()
    gravar_estado(estado)
    logar(f"BLOQUEIO MANUAL {ip} · {motivo_limpo} · até {bloqueios[ip]['ate']} · nginx: {resposta}")
    print(f"bloqueado {ip} por {minutos} min (até {ate.strftime('%d/%m %H:%M')}) · motivo: {motivo_limpo}")
    print(f"nginx: {resposta} (ok={ok})")
    if not ok:
        print("ATENÇÃO: a lista mudou mas o nginx não recarregou — ver journal", file=sys.stderr)
    return 0 if ok else 1


def desbloquear(alvo: str | None) -> int:
    estado = ler_estado()
    bloqueios = estado.get("bloqueios", {})
    if alvo is None:
        removidos = list(bloqueios)
        bloqueios.clear()
    else:
        ip = alvo.strip()
        if ip not in bloqueios:
            print(f"{ip} não está bloqueado. Nada a fazer.")
            return 0
        del bloqueios[ip]
        removidos = [ip]

    escrever_bloqueios(bloqueios)
    ok, resposta = recarregar_nginx()
    estado["bloqueios"] = bloqueios
    gravar_estado(estado)
    logar(f"DESBLOQUEIO manual {', '.join(removidos) or '(nenhum)'} · nginx: {resposta}")
    print(f"removido(s): {', '.join(removidos) or '(nenhum)'} · nginx: {resposta} (ok={ok})")
    return 0 if ok else 1


def autoteste() -> int:
    """Prova, com os endereços que importam, que a trava de faixa privada vale."""
    privados = [
        "127.0.0.1", "127.0.0.53", "::1", "10.0.0.5", "172.17.0.1", "172.20.0.2",
        "192.168.1.10", "169.254.169.254", "0.0.0.0", "fe80::1", "fc00::1", "224.0.0.1",
    ]
    publicos = ["45.22.33.44", "8.8.8.8", "191.31.15.133", "2001:4860:4860::8888"]
    invalidos = ["", "atacante", "999.1.1.1", "127.0.0.1.5", "1.2.3"]
    falhas = 0

    print("[1] faixas que NUNCA podem ser bloqueadas")
    for ip in privados:
        ok = not ip_publico(ip)
        print(f"  {'PASS' if ok else 'FAIL'}  {ip:18} ip_publico={ip_publico(ip)}")
        falhas += 0 if ok else 1

    print("[2] IPs públicos (bloqueáveis)")
    for ip in publicos:
        ok = ip_publico(ip)
        print(f"  {'PASS' if ok else 'FAIL'}  {ip:18} ip_publico={ip_publico(ip)}")
        falhas += 0 if ok else 1

    print("[3] lixo não vira bloqueio")
    for ip in invalidos:
        ok = not ip_publico(ip)
        print(f"  {'PASS' if ok else 'FAIL'}  {ip!r:20} ip_publico={ip_publico(ip)}")
        falhas += 0 if ok else 1

    print("[4] decisão ignora IP privado mesmo com surto absurdo")
    resumo = {
        "127.0.0.1": {"req60": 99999, "c429": 500, "suspeitos": 999, "exemplo": "", "metodo": "GET"},
        "192.168.0.10": {"req60": 500, "c429": 0, "suspeitos": 0, "exemplo": "", "metodo": "GET"},
        "45.22.33.44": {"req60": 300, "c429": 0, "suspeitos": 0, "exemplo": "", "metodo": "GET"},
    }
    decisoes = decidir(resumo)
    ips = [d["ip"] for d in decisoes]
    ok = ips == ["45.22.33.44"]
    print(f"  {'PASS' if ok else 'FAIL'}  decididos={ips} (esperado só 45.22.33.44)")
    falhas += 0 if ok else 1

    print(f"\n[5] escore de suspeita bate com o fixture compartilhado (Go e Python)")
    fixture = Path(__file__).resolve().parent / "suspeita_fixture.json"
    if not fixture.exists():
        print(f"  FAIL  fixture ausente: {fixture}")
        falhas += 1
    else:
        codigo = suspeita._conferir(str(fixture))  # noqa: SLF001 — mesma máquina de teste
        print(f"  {'PASS' if codigo == 0 else 'FAIL'}  suspeita.py --conferir {fixture.name}")
        falhas += 0 if codigo == 0 else 1

    print("\n[6] limiares do aviso e anti-spam")
    casos = [
        ("suspeito aos 60", ESCORE_SUSPEITO == 60),
        ("malicioso aos 80", ESCORE_MALICIOSO == 80),
        ("aviso por IP a cada 6 h", AVISO_IP_JANELA_S == 21600),
        ("resumo a cada 30 min", RESUMO_INTERVALO_S == 1800),
        ("consolidado com mais de 3", RESUMO_MIN_SUSPEITOS == 4),
    ]
    for rotulo, ok in casos:
        print(f"  {'PASS' if ok else 'FAIL'}  {rotulo}")
        falhas += 0 if ok else 1

    print("\n[7] infra local nunca entra no escore (o defeito do 172.19.0.1)")
    # Linha real do acessos.log: prova de injeção NOSSA, que chega ao nginx
    # pelo gateway do docker. Pode ter .env e OR 1=1 — e não pode pontuar.
    linhas_infra = [
        "172.19.0.1 2026-10-24T13:24:24+00:00 404 GET /.env - -",
        "172.19.0.1 2026-10-24T13:24:24+00:00 404 GET /.git/config - -",
        "172.19.0.1 2026-10-24T13:24:24+00:00 404 GET /api/uf/SP' OR 1=1/municipios - -",
        "172.19.0.1 2026-10-24T13:24:24+00:00 404 GET /api/interno/painel - -",
        "127.0.0.1 2026-10-24T13:25:19+00:00 404 GET /api/interno/painel",
    ]
    acumulado: dict[str, dict] = {}
    registrados = sum(1 for linha in linhas_infra if suspeita.registrar_linha(acumulado, linha))
    ok = registrados == 0 and not acumulado
    print(f"  {'PASS' if ok else 'FAIL'}  {len(linhas_infra)} linhas de ataque da infra → registrados={registrados} (esperado 0)")
    falhas += 0 if ok else 1
    linha_publica = "191.31.15.133 2026-10-24T13:25:19+00:00 404 GET /.env - -"
    acumulado2: dict[str, dict] = {}
    ok2 = suspeita.registrar_linha(acumulado2, linha_publica) and "191.31.15.133" in acumulado2
    print(f"  {'PASS' if ok2 else 'FAIL'}  191.31.15.133 público segue registrado (não é descartado)")
    falhas += 0 if ok2 else 1

    print(f"\nresumo: {'todos os casos passaram' if falhas == 0 else str(falhas) + ' falha(s)'}")
    return 0 if falhas == 0 else 1


def main(argv: list[str]) -> int:
    argumentos = argv[1:]
    if not argumentos or argumentos[0] in {"--forcar", "--agora"}:
        return ciclo(ensaio=False)
    comando = argumentos[0]
    if comando == "--ensaio":
        return ciclo(ensaio=True)
    if comando == "--status":
        return status()
    if comando == "--suspeitos":
        return listar_suspeitos()
    if comando == "--autoteste":
        return autoteste()
    if comando == "--bloquear":
        if len(argumentos) < 2:
            print("uso: --bloquear <IP> [--motivo texto] [--minutos N]", file=sys.stderr)
            return 64
        alvo = argumentos[1]
        motivo = ""
        minutos = MANUAL_DURACAO_MIN
        restante = argumentos[2:]
        for indice, item in enumerate(restante):
            if item == "--motivo" and indice + 1 < len(restante):
                motivo = restante[indice + 1]
            elif item == "--minutos" and indice + 1 < len(restante):
                try:
                    minutos = int(restante[indice + 1])
                except ValueError:
                    print("--minutos precisa ser inteiro", file=sys.stderr)
                    return 64
        return bloquear(alvo, motivo, minutos)
    if comando == "--desbloquear":
        if len(argumentos) < 2:
            print("uso: --desbloquear <IP>", file=sys.stderr)
            return 64
        return desbloquear(argumentos[1])
    if comando == "--desbloquear-todos":
        return desbloquear(None)
    print(__doc__, file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
