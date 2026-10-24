/* Painel de monitoramento — JS local, sem framework e sem CDN.
 *
 * Transporte: SSE (/api/monitor/eventos). Se o EventSource falhar duas vezes
 * seguidas, cai para polling de 2 s em /api/monitor/estado e o selo no topo
 * passa a dizer "polling 2 s" — o painel nunca mente sobre como está ligado.
 */
'use strict';

const estado = {
  janela: '1h',
  pausado: false,
  ultimo: null,
  ultimoEm: 0,
  fonte: null,
  falhas: 0,
  modoPolling: false,
  timerPolling: null,
  timerPausa: null,
};

const $ = (seletor) => document.querySelector(seletor);
const esc = (texto) => String(texto == null ? '' : texto)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function num(valor) {
  return new Intl.NumberFormat('pt-BR').format(valor || 0);
}

function selo(modo, texto) {
  const vivo = $('#vivo');
  vivo.dataset.estado = modo;
  $('#vivo-texto').textContent = texto;
}

/* ---------------------------------------------------------------- transporte */

function conectar() {
  if (estado.modoPolling) return;
  try {
    const fonte = new EventSource('/api/monitor/eventos');
    estado.fonte = fonte;

    fonte.addEventListener('ola', () => { estado.falhas = 0; });

    fonte.addEventListener('estado', (ev) => {
      estado.falhas = 0;
      selo('sse', 'ao vivo (SSE)');
      aplicar(JSON.parse(ev.data));
    });

    fonte.onopen = () => { estado.falhas = 0; selo('sse', 'ao vivo (SSE)'); };

    fonte.onerror = () => {
      estado.falhas += 1;
      if (estado.falhas >= 2 && fonte.readyState === EventSource.CLOSED) {
        selo('online', 'reconectando…');
        trocarParaPolling('SSE indisponível');
      }
    };
  } catch (erro) {
    trocarParaPolling('SSE indisponível');
  }
}

function trocarParaPolling(motivo) {
  if (estado.modoPolling) return;
  estado.modoPolling = true;
  if (estado.fonte) { estado.fonte.close(); estado.fonte = null; }
  selo('online', 'polling 2 s (' + motivo + ')');
  buscar();
  estado.timerPolling = setInterval(buscar, 2000);
}

async function buscar() {
  try {
    const resposta = await fetch('/api/monitor/estado', { cache: 'no-store' });
    if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
    selo('online', 'polling 2 s');
    aplicar(await resposta.json());
  } catch (erro) {
    selo('offline', 'painel fora do ar');
  }
}

function aplicar(foto) {
  estado.ultimo = foto;
  estado.ultimoEm = Date.now();
  if (!estado.pausado) desenhar(foto);
  else marcarPausa();
}

/* ------------------------------------------------------------------ desenho */

function desenhar(foto) {
  const janela = foto.janelas[estado.janela];
  desenharCards(janela, foto);
  desenharInsights(foto.insights || []);
  desenharSuspeitos(foto);
  desenharAtaques(janela);
  desenharHosts(janela);
  desenharTop('#tabela-ips', janela.top_ips, 'IP');
  desenharTop('#tabela-caminhos', janela.top_caminhos, 'caminho');
  desenharTop('#tabela-uas', janela.top_uas, 'user-agent');
  desenharSerie('#serie-min', foto.serie_min || []);
  desenharSerie('#serie-dia', foto.serie_dia || []);
  desenharFeed(foto.feed || []);
}

function desenharCards(j, foto) {
  const totalClasse = Object.entries(j.por_classe || {})
    .map(([chave, valor]) => chave + ' ' + num(valor)).join(' · ');
  const ataques = j.ataques || 0;
  const suspeita = foto.suspeita_resumo || {};
  const emSuspeita = (suspeita.malicioso || 0) + (suspeita.suspeito || 0);

  const cards = [
    { rotulo: 'req/s (' + j.nome + ')', valor: (j.req_s || 0).toFixed(2), detalhe: num(j.total) + ' req na janela' },
    { rotulo: 'visitantes 1 min', valor: num((j.unicos || {}).minuto), detalhe: 'IPs humanos' },
    { rotulo: 'visitantes 1 h', valor: num((j.unicos || {}).hora), detalhe: 'IPs humanos' },
    { rotulo: 'bots ativos', valor: num(j.bots_ativos), detalhe: 'últimos 5 min' },
    {
      rotulo: 'suspeitos (escore)',
      valor: num(emSuspeita),
      detalhe: num(suspeita.observar || 0) + ' em observação · nada bloqueado sozinho',
      classe: suspeita.malicioso ? 'alerta' : '',
    },
    {
      rotulo: 'ataques (' + j.nome + ')',
      valor: num(ataques),
      detalhe: ataques ? Object.keys(j.ataque_tipo || {}).length + ' tipo(s)' : 'nenhum',
      classe: ataques ? 'alerta' : 'bom',
    },
    { rotulo: 'bloqueados', valor: num(j.bloqueados), detalhe: (foto.vigia && foto.vigia.bloqueios_ativos ? foto.vigia.bloqueios_ativos + ' na lista do vigia' : 'vigia sem bloqueio ativo') },
    { rotulo: 'status', valor: num(j.total), detalhe: totalClasse },
    { rotulo: 'log lido', valor: num(foto.lidos), detalhe: num(foto.canario) + ' canário ignorado' },
  ];

  $('#cards').innerHTML = cards.map((c) => `
    <div class="card ${c.classe || ''}">
      <div class="rotulo">${esc(c.rotulo)}</div>
      <div class="valor">${esc(c.valor)}</div>
      <div class="detalhe">${esc(c.detalhe)}</div>
    </div>`).join('');
}

function desenharInsights(lista) {
  const alvo = $('#insights');
  if (!lista.length) {
    alvo.innerHTML = '<li class="vazio">sem insight nesta janela</li>';
    return;
  }
  alvo.innerHTML = lista.map((i) => `<li class="${esc(i.nivel)}">${esc(i.texto)}</li>`).join('');
}

/* Suspeitos: escore por sinais, nunca por volume. Nada é bloqueado sozinho —
 * o botão e o comando na linha existem para a decisão ser do Pedro. */
function desenharSuspeitos(foto) {
  const corpo = $('#tabela-suspeitos').querySelector('tbody');
  const lista = foto.suspeitos || [];
  const resumo = foto.suspeita_resumo || {};
  const nota = $('#suspeita-nota');

  const partes = [];
  if (resumo.malicioso) partes.push(resumo.malicioso + ' malicioso(s)');
  if (resumo.suspeito) partes.push(resumo.suspeito + ' suspeito(s)');
  if (resumo.observar) partes.push(resumo.observar + ' em observação');
  const infra = foto.infra_local || {};
  if (infra.ips) {
    const detalhe = (infra.lista || [])
      .slice(0, 3)
      .map((i) => i.ip + ' ' + num(i.eventos))
      .join(', ');
    partes.push('infra local fora da contagem: ' + num(infra.ips) + ' IP(s) / ' + num(infra.eventos) + ' req' + (detalhe ? ' (' + detalhe + ')' : ''));
  }
  nota.textContent = partes.length ? partes.join(' · ') : 'nenhum IP com sinal';

  if (!lista.length) {
    corpo.innerHTML = '<tr><td colspan="9" class="vazio">ninguém acima de 20 no escore</td></tr>';
    return;
  }

  corpo.innerHTML = lista.map((s) => {
    const motivo = (s.rotulos || s.sinais || []).join(', ');
    const primeiro = (s.primeiro || '').replace('T', ' ').slice(0, 19);
    const ultimo = (s.ultimo || '').replace('T', ' ').slice(0, 19);
    const comando = 'bash scripts/defesa/bloquear.sh ' + s.ip + ' "' + (motivo || s.nivel) + '"';
    return `
    <tr class="linha-suspeita nivel-${esc(s.nivel)}">
      <td><span class="selo-nivel ${esc(s.nivel)}">${esc(s.nivel)}</span></td>
      <td class="num escore">${num(s.escore)}</td>
      <td class="mono">${esc(s.ip)}</td>
      <td class="mono">${esc(s.host || '?')}</td>
      <td class="sinais">${esc(motivo)}</td>
      <td class="mono">${esc(primeiro)}</td>
      <td class="mono">${esc(ultimo)}</td>
      <td class="num">${num(s.eventos)}</td>
      <td class="acao">
        <button class="bloquear" data-ip="${esc(s.ip)}" data-motivo="${esc(motivo || s.nivel)}"
                title="${esc(comando)}">Bloquear 30 min</button>
        <code class="comando">${esc(comando)}</code>
      </td>
    </tr>`;
  }).join('');

  corpo.querySelectorAll('button.bloquear').forEach((botao) => {
    botao.addEventListener('click', () => bloquear(botao));
  });
}

async function bloquear(botao) {
  const ip = botao.dataset.ip;
  const motivo = 'escore de suspeita no painel: ' + (botao.dataset.motivo || '');
  const antes = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'bloqueando…';
  try {
    const resposta = await fetch('/api/monitor/bloquear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, motivo }),
    });
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok || dados.ok === false) throw new Error(dados.saida || dados.erro || ('HTTP ' + resposta.status));
    botao.textContent = 'bloqueado (30 min)';
    selo(estado.modoPolling ? 'online' : 'sse', (estado.modoPolling ? 'polling 2 s' : 'ao vivo (SSE)') + ' · bloqueou ' + ip);
  } catch (erro) {
    botao.textContent = 'falhou — ver journal';
    selo('offline', 'bloqueio manual de ' + ip + ' falhou: ' + erro.message);
    botao.disabled = false;
    setTimeout(() => { botao.textContent = antes; }, 6000);
  }
}

function desenharAtaques(j) {
  const corpo = $('#tabela-ataques').querySelector('tbody');
  const registros = j.ataques_reg || [];
  $('#ataques-nota').textContent = registros.length ? registros.length + ' agrupamento(s)' : '';

  if (!registros.length) {
    corpo.innerHTML = '<tr><td colspan="8" class="vazio">nenhum ataque na janela</td></tr>';
    return;
  }
  corpo.innerHTML = registros.map((r) => `
    <tr class="linha-ataque">
      <td class="tipo-ataque">${esc(r.tipo)}</td>
      <td class="mono">${esc(r.ip)}</td>
      <td class="mono">${esc(r.host)}</td>
      <td class="num">${num(r.n)}</td>
      <td class="mono">${esc(r.primeiro)}</td>
      <td class="mono">${esc(r.ultimo)}</td>
      <td class="alvo">${esc(r.caminho)}</td>
      <td>${r.bloqueado ? '<span class="tag-bloq">sim</span>' : '<span class="tag-livre">não</span>'}</td>
    </tr>`).join('');
}

function desenharHosts(j) {
  const corpo = $('#tabela-hosts').querySelector('tbody');
  const linhas = j.hosts || [];
  if (!linhas.length) {
    corpo.innerHTML = '<tr><td colspan="5" class="vazio">sem dados</td></tr>';
    return;
  }
  corpo.innerHTML = linhas.map((h) => `
    <tr>
      <td class="mono">${esc(h.host === '?' ? '? (linha antiga)' : h.host)}</td>
      <td class="num">${num(h.humano)}</td>
      <td class="num">${num(h.bot)}</td>
      <td class="num">${num(h.ataque)}</td>
      <td class="num">${num(h.total)}</td>
    </tr>`).join('');
}

function desenharTop(seletor, itens, cabecalho) {
  const tabela = $(seletor);
  if (!itens || !itens.length) {
    tabela.innerHTML = `<tbody><tr><td class="vazio">sem dados</td></tr></tbody>`;
    return;
  }
  tabela.innerHTML = `<tbody>${itens.map((i) => `
    <tr><td class="mono">${esc(i.chave)}</td><td class="num">${num(i.n)}</td></tr>`).join('')}</tbody>`;
}

function desenharSerie(seletor, pontos) {
  const alvo = $(seletor);
  if (!pontos.length) { alvo.innerHTML = ''; return; }
  const maximo = Math.max(1, ...pontos.map((p) => (p.humano || 0) + (p.bot || 0) + (p.ataque || 0)));
  alvo.innerHTML = pontos.map((p) => {
    const total = (p.humano || 0) + (p.bot || 0) + (p.ataque || 0);
    const alt = (valor) => (100 * (valor || 0) / maximo).toFixed(1);
    const dica = `${p.rotulo}\nhumano ${p.humano || 0} · bot ${p.bot || 0} · ataque ${p.ataque || 0}`;
    return `<div class="barra" title="${esc(dica)}">
      <div class="seg ataque" style="height:${alt(p.ataque)}%"></div>
      <div class="seg bot" style="height:${alt(p.bot)}%"></div>
      <div class="seg humano" style="height:${alt(p.humano)}%"></div>
      <span class="dica">${esc(dica)}</span>
    </div>`;
  }).join('');
  if (maximo === 1) alvo.dataset.vazio = 'tráfego zero na janela';
}

function desenharFeed(itens) {
  const corpo = $('#tabela-feed').querySelector('tbody');
  if (!itens.length) {
    corpo.innerHTML = '<tr><td colspan="7" class="vazio">sem eventos</td></tr>';
    return;
  }
  corpo.innerHTML = itens.map((e) => `
    <tr class="${e.ataque ? 'linha-ataque' : ''}">
      <td class="mono">${esc(e.hora)}</td>
      <td class="mono">${esc(e.ip)}</td>
      <td class="mono">${esc(e.host)}</td>
      <td class="mono">${esc(e.metodo)}</td>
      <td class="alvo">${esc(e.caminho)}</td>
      <td class="num">${esc(e.status)}</td>
      <td>${e.ataque ? '<span class="tipo-ataque">' + esc(e.ataque) + '</span>' : (e.bot ? '<span class="tag-bot">bot</span>' : '')}</td>
    </tr>`).join('');
}

/* ------------------------------------------------------------------ controles */

function marcarPausa() {
  if (!estado.ultimoEm) return;
  const segundos = Math.round((Date.now() - estado.ultimoEm) / 1000);
  selo('offline', 'pausado há ' + segundos + ' s');
}

document.querySelectorAll('.janela').forEach((botao) => {
  botao.addEventListener('click', () => {
    document.querySelectorAll('.janela').forEach((b) => b.classList.remove('ativo'));
    botao.classList.add('ativo');
    estado.janela = botao.dataset.janela;
    if (estado.ultimo) desenhar(estado.ultimo);
  });
});

$('#pausar').addEventListener('click', (evento) => {
  estado.pausado = !estado.pausado;
  const botao = evento.currentTarget;
  botao.setAttribute('aria-pressed', String(estado.pausado));
  botao.textContent = estado.pausado ? 'Retomar' : 'Pausar';
  if (!estado.pausado) {
    if (estado.ultimo) desenhar(estado.ultimo);
    selo(estado.modoPolling ? 'online' : 'sse', estado.modoPolling ? 'polling 2 s' : 'ao vivo (SSE)');
    clearInterval(estado.timerPausa);
  } else {
    estado.timerPausa = setInterval(marcarPausa, 1000);
    marcarPausa();
  }
});

conectar();
