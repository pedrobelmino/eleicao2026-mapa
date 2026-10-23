#!/usr/bin/env node
// Prova do POLIMENTO pós-entrega dos itens 5 e 6 — três defeitos medidos em print.
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/polimento.mjs --base http://127.0.0.1:8100 --out _provas
//
// O que é medido (nada de "deve funcionar"):
//   1. CABEÇALHO e PLACAR LATERAL no replay: com o replay parado em ~40%
//      (passo 25/61), o cabeçalho do site e o placar do painel mostram o
//      percentual e os VOTOS DO PASSO — e não o arquivo fechado (100%). Ao
//      sair do replay, os dois voltam ao valor oficial. A prova lê o passo
//      esperado direto de /api/replay (mesma fórmula do front: % = votos do
//      candidato / votos válidos do passo) e compara com o que está na tela.
//   2. TEXTO DE CARREGAMENTO: com a lista de 10 municípios decisivos já
//      renderizada, a string "calculando margens" tem de ocorrer ZERO vezes no
//      DOM. Medido em duas condições: rede normal e com /api/margens (o
//      agregado nacional, 140 KB) segurado por 1,2 s — que é a condição real
//      em que a print pegou a lista na tela e o "calculando margens…" embaixo.
//   3. PARÁGRAFO METODOLÓGICO do card: cada `.margem-nota` tem de crescer
//      inteiro — scrollHeight == clientHeight, sem line-clamp, sem overflow
//      escondendo texto, dentro da caixa do card — e o texto renderizado tem
//      de ser o texto que a API mandou (comparação normalizada, começo e fim).
//
// Saída: `_provas/polimento_resumo.json` com
//   { cabecalho_replay, placar_replay, texto_calculando_ocorrencias,
//     paragrafo_ok, console_erros }
// + prints `_provas/polimento_{desktop_1440x900,mobile_390x844}.png`.
// O campo `gerado` só é gravado no fim: sem ele o JSON não vale.
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop_1440x900', largura: 1440, altura: 900 },
  { nome: 'mobile_390x844', largura: 390, altura: 844 },
]

const ALVO_PCT = 40

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

function argumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8100', out: '_provas', vp: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const [chave, mesmo] = argv[i].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in opcoes)) continue
    opcoes[nome] = mesmo ?? argv[i + 1]
    if (mesmo == null) i += 1
  }
  opcoes.base = opcoes.base.replace(/\/+$/, '')
  return opcoes
}

// "40,3%" -> 40.3 ; "23.059.156 votos" -> 23059156
function numeroBR(texto) {
  if (texto == null) return null
  const achado = String(texto).match(/-?[\d.]+(?:,\d+)?/)
  if (!achado) return null
  const valor = Number(achado[0].replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(valor) ? valor : null
}

const normalizar = (texto) => String(texto ?? '').replace(/\s+/g, ' ').trim()

// Percentual do texto do cabeçalho: "… replay 40,3% apurado · passo 25/61".
// O `numeroBR` genérico pegaria o "1" de "1º turno" — daí este parser separado.
function pctDeTexto(texto) {
  const achado = String(texto ?? '').match(/([\d.]+(?:,\d+)?)\s*%/)
  if (!achado) return null
  const valor = Number(achado[1].replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(valor) ? valor : null
}

function passoMaisProximo(passos, alvo) {
  let melhor = 0
  let distancia = Infinity
  passos.forEach((passo, indice) => {
    const d = Math.abs(Number(passo.pct_apurado) - alvo)
    if (d < distancia) {
      distancia = d
      melhor = indice
    }
  })
  return melhor
}

// Mesma conta do front (normalizarPassos): votos válidos do passo = soma dos
// candidatos da base + "outros"; o % de cada um é sobre esses válidos.
function esperadoDoPasso(serie, indice) {
  const passo = serie.passos[indice]
  const votos = passo.votos || {}
  const validos =
    (serie.candidatos || []).reduce((soma, c) => soma + (Number(votos[c.codigo]) || 0), 0) +
    (Number(votos.outros) || 0)
  const candidatos = (serie.candidatos || []).map((c) => {
    const v = Number(votos[c.codigo]) || 0
    return {
      nome: c.nome,
      partido: c.partido || '',
      votos: v,
      pct: validos > 0 ? (100 * v) / validos : 0,
    }
  })
  return {
    indice,
    carimbo: `${indice + 1}/${serie.passos.length}`,
    pct: Number(passo.pct_apurado) || 0,
    secoes: Number(passo.secoes_apuradas) || 0,
    candidatos,
  }
}

async function esperarMapa(pagina) {
  await pagina.waitForFunction(
    () => Boolean(window.__mapa?.loaded?.() ?? window.__mapa),
    { timeout: 90000 },
  )
}

// ---------------------------------------------------------------- medição
async function medirCabecalhoEPlacar(pagina) {
  return pagina.evaluate(() => {
    const meta = document.querySelector('[data-prova="header-meta"]') ||
      document.querySelector('.site-header .header-meta')
    // Há DOIS `.scoreboard--panel` no DOM (painel lateral e gaveta do celular,
    // escondida): mede-se o que tem caixa na tela — senão a contagem dobra.
    const placares = [...document.querySelectorAll('.scoreboard--panel')]
    const visivel =
      placares.find((el) => {
        const c = el.getBoundingClientRect()
        return c.width > 0 && c.height > 0
      }) || null
    const turno = visivel ? visivel.querySelector('.scoreboard-turno') : null
    const linhas = visivel
      ? [...visivel.querySelectorAll('.score-row')].map((linha) => ({
          nome: linha.querySelector('.score-name')?.textContent?.trim() ?? null,
          pct: linha.querySelector('.score-pct')?.textContent?.trim() ?? null,
          votos: linha.querySelector('.score-votes')?.textContent?.trim() ?? null,
        }))
      : []
    const barra = [...document.querySelectorAll('.placar-barra-linha')].map((linha) => ({
      nome: linha.querySelector('.pb-nome')?.textContent?.trim() ?? null,
      pct: linha.querySelector('.pb-pct')?.textContent?.trim() ?? null,
      votos: linha.querySelector('.pb-votos')?.textContent?.trim() ?? null,
    }))
    return {
      cabecalho: {
        texto: meta ? meta.textContent.trim() : null,
        fonte: meta ? meta.getAttribute('data-fonte') : null,
      },
      lateral: {
        turno: turno ? turno.textContent.trim() : null,
        fonte: visivel ? visivel.getAttribute('data-fonte') : null,
        carimbo: visivel ? visivel.getAttribute('data-carimbo') : null,
        linhas,
      },
      barra_mobile: barra,
    }
  })
}

// A nota metodológica é alcançável por rolagem do painel? Rola até o fim do
// container e mede se o parágrafo INTEIRO (e a última linha dele) fica dentro
// da área visível do scrollport.
async function alcancarNota(pagina) {
  return pagina.evaluate(async () => {
    const card = [...document.querySelectorAll('.margens-card')].find((el) => {
      const c = el.getBoundingClientRect()
      return c.width > 0 && c.height > 0
    })
    if (!card) return { ok: false, motivo: 'sem card visível' }
    const nota = card.querySelector('.margem-nota')
    if (!nota) return { ok: false, motivo: 'sem nota no card visível' }
    let pai = nota.parentElement
    let scroller = null
    while (pai && pai !== document.body) {
      const cs = getComputedStyle(pai)
      if (/(auto|scroll)/.test(cs.overflowY) && pai.scrollHeight > pai.clientHeight + 1) {
        scroller = pai
        break
      }
      pai = pai.parentElement
    }
    if (!scroller) return { ok: false, motivo: 'nenhum container rolável acima da nota' }
    const antes = scroller.scrollTop
    scroller.scrollTop = scroller.scrollHeight
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const scrollMax = scroller.scrollHeight - scroller.clientHeight
    const noFim = scroller.scrollTop
    // O leitor chega na nota rolando até ela: traz para o centro do painel e
    // mede se o parágrafo INTEIRO fica dentro da área visível.
    nota.scrollIntoView({ block: 'center', inline: 'nearest' })
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const rn = nota.getBoundingClientRect()
    const rp = scroller.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(nota)
    const linhas = [...range.getClientRects()]
    const ultima = linhas.length ? linhas[linhas.length - 1] : null
    return {
      ok: true,
      scroller: scroller.className,
      scroll_antes: antes,
      scroll_max: scrollMax,
      scroll_depois: scroller.scrollTop,
      nota_alcancada_por_rolagem: scroller.scrollTop > 0,
      nota_top: Math.round(rn.top),
      nota_bottom: Math.round(rn.bottom),
      scrollport_top: Math.round(rp.top),
      scrollport_bottom: Math.round(rp.bottom),
      nota_inteira_visivel: rn.top >= rp.top - 1 && rn.bottom <= rp.bottom + 1,
      ultima_linha_bottom: ultima ? Math.round(ultima.bottom) : null,
      ultima_linha_inteira: ultima ? ultima.bottom <= rp.bottom + 1 : null,
      linhas: linhas.length,
      scrollHeight: nota.scrollHeight,
      clientHeight: nota.clientHeight,
      scroll_no_fim: noFim,
    }
  })
}

async function esperarReplay(pagina) {
  await pagina.waitForFunction(
    () => {
      const linha = document.querySelector('[data-prova="replay-linha"]')
      return Boolean(linha) && Number(linha.max) > 0 && window.__replayDebug?.modo === 'replay'
    },
    { timeout: 90000 },
  )
  await dormir(1200)
}

async function irPara(pagina, indice) {
  await pagina.evaluate((alvo) => {
    const el = document.querySelector('[data-prova="replay-linha"]')
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set
    setter.call(el, String(alvo))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, indice)
  await pagina.waitForFunction(
    (alvo) => window.__replayDebug?.frame === alvo,
    indice,
    { timeout: 30000 },
  )
  await dormir(900)
}

// ------------------------------------------------------------------- card
// Mede o card QUE TEM CAIXA (lição do item 6: existem dois no DOM — painel e
// sheet mobile; somar os dois dobra a contagem).
const MEDIR_CARD = () => {
  const cards = [...document.querySelectorAll('.margens-card')]
  const card =
    cards.find((el) => {
      const c = el.getBoundingClientRect()
      return c.width > 0 && c.height > 0
    }) || null
  const textoCard = card ? card.innerText : ''
  const textoCorpo = document.body.innerText
  const textoDom = document.body.textContent || ''

  const contar = (texto, agulha) =>
    String(texto).toLowerCase().split(agulha.toLowerCase()).length - 1

  // De onde vem a string, se ela existir: classe do parágrafo e se está no
  // card visível ou no outro (fora da tela).
  const origens = []
  for (const el of document.querySelectorAll('.margem-carregando')) {
    const contem = /calculando margens/i.test(el.textContent || '')
    if (!contem) continue
    const c = el.getBoundingClientRect()
    const cardPai = el.closest('.margens-card')
    const caixaPai = cardPai ? cardPai.getBoundingClientRect() : null
    origens.push({
      texto: el.textContent.trim(),
      classe: el.className,
      dentro_do_card_visivel: Boolean(cardPai && cardPai === card),
      caixa: { largura: Math.round(c.width), altura: Math.round(c.height) },
      card_com_caixa: Boolean(caixaPai && caixaPai.width > 0),
      visivel: Boolean(c.width > 0 && c.height > 0 && getComputedStyle(el).visibility !== 'hidden'),
    })
  }

  const notas = card
    ? [...card.querySelectorAll('.margem-nota')].map((el) => {
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        const caixaCard = card.getBoundingClientRect()
        // Cadeia de ancestrais: algum deles corta o parágrafo sem permitir
        // rolagem? (overflow escondido + conteúdo maior que a caixa)
        const ancestrais = []
        let pai = el.parentElement
        while (pai && pai !== document.body) {
          const csp = getComputedStyle(pai)
          const rp = pai.getBoundingClientRect()
          if (csp.overflow !== 'visible' || csp.overflowY !== 'visible') {
            ancestrais.push({
              classe: pai.className || pai.tagName,
              overflow: `${csp.overflow}/${csp.overflowY}`,
              rola: pai.scrollHeight > pai.clientHeight + 1,
              altura: Math.round(rp.height),
            })
          }
          pai = pai.parentElement
        }
        const linhaAltura = Number.parseFloat(cs.lineHeight) || 0
        return {
          texto: (el.textContent || '').replace(/\s+/g, ' ').trim(),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          altura: Math.round(r.height),
          linhas_estimadas: linhaAltura > 0 ? Math.round(r.height / linhaAltura) : null,
          line_clamp: cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp') || 'none',
          overflow: `${cs.overflow}/${cs.overflowY}`,
          max_height: cs.maxHeight,
          height: cs.height,
          display: cs.display,
          dentro_da_caixa_do_card: Math.round(r.bottom) <= Math.round(caixaCard.bottom) + 1,
          distancia_do_fundo_do_card: Math.round(caixaCard.bottom - r.bottom),
          ancestrais_com_overflow: ancestrais,
        }
      })
    : []

  return {
    tem_card: Boolean(card),
    linhas_decisivos: card ? card.querySelectorAll('[data-prova="margem-decisivo"]').length : 0,
    contagem_texto: {
      dom: contar(textoDom, 'calculando margens'),
      visivel: contar(textoCorpo, 'calculando margens'),
      no_card: contar(textoCard, 'calculando margens'),
    },
    origens,
    notas,
    cards_no_dom: cards.length,
    nacional_ja_na_tela: Boolean(card && card.querySelector('.margens-nacional')),
    tela: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    },
  }
}

async function esperarCard(pagina) {
  await pagina.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll('.margens-card')]
      const card = cards.find((el) => {
        const c = el.getBoundingClientRect()
        return c.width > 0 && c.height > 0
      })
      if (!card) return false
      return card.querySelectorAll('[data-prova="margem-decisivo"]').length >= 10
    },
    { timeout: 90000 },
  )
}

// ------------------------------------------------------------------ principal
async function principal() {
  const opcoes = argumentos(process.argv.slice(2))
  await mkdir(opcoes.out, { recursive: true })

  const [serie, estados, margensNacional, margensUf] = await Promise.all([
    fetch(`${opcoes.base}/api/replay`).then((r) => r.json()),
    fetch(`${opcoes.base}/api/estados`).then((r) => r.json()),
    fetch(`${opcoes.base}/api/margens`).then((r) => r.json()),
    fetch(`${opcoes.base}/api/uf/CE/margens`).then((r) => r.json()),
  ])
  if (!serie.disponivel) throw new Error(`replay indisponível: ${serie.nota}`)
  if (!Array.isArray(serie.passos) || serie.passos.length === 0) {
    throw new Error('série de apuração sem passos')
  }

  const indiceAlvo = passoMaisProximo(serie.passos, ALVO_PCT)
  const passo = esperadoDoPasso(serie, indiceAlvo)

  // Placar oficial (arquivo fechado) — é o que a tela mostra hoje o tempo todo.
  const nacional = estados?.nacional || {}
  const oficial = {
    pct: Number(nacional.pct_apurado),
    candidatos: (nacional.candidatos || []).map((c) => ({
      nome: c.nome,
      partido: c.partido,
      votos: Number(c.votos) || 0,
      pct: Number(c.pct) || 0,
    })),
  }

  const resumo = {
    gerado: null,
    base: opcoes.base,
    alvo_pct: ALVO_PCT,
    passo_medido: { indice: indiceAlvo, carimbo: passo.carimbo, pct: passo.pct },
    oficial: { pct: oficial.pct, candidatos: oficial.candidatos.map((c) => ({ nome: c.nome, votos: c.votos, pct: c.pct })) },
    cabecalho_replay: {},
    placar_replay: {},
    texto_calculando_ocorrencias: {},
    paragrafo_ok: null,
    paragrafo_detalhe: {},
    console_erros: [],
    problemas: [],
    ok: false,
  }
  const problemas = resumo.problemas
  const registrar = (obj) => console.log(JSON.stringify(obj))

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })

  const viewports = opcoes.vp ? VIEWPORTS.filter((v) => v.nome.startsWith(opcoes.vp)) : VIEWPORTS

  for (const vp of viewports) {
    // ---------------------------------------------------------- 1. replay
    const contexto = await browser.newContext({
      viewport: { width: vp.largura, height: vp.altura },
      deviceScaleFactor: 1,
    })
    const pagina = await contexto.newPage()
    const erros = []
    const respostasRuins = []
    pagina.on('console', (msg) => {
      if (msg.type() === 'error') erros.push(msg.text())
    })
    pagina.on('pageerror', (erro) => erros.push(`pageerror: ${erro.message}`))
    pagina.on('response', (resp) => {
      if (resp.status() >= 400) respostasRuins.push(`${resp.status()} ${resp.url()}`)
    })

    await pagina.goto(`${opcoes.base}/mapa?uf=CE&z=6&replay=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    })
    await esperarReplay(pagina)

    await irPara(pagina, indiceAlvo)
    const noPasso = await medirCabecalhoEPlacar(pagina)
    const arquivoParcial = path.join(opcoes.out, `polimento_${vp.nome}_replay40.png`)
    await pagina.screenshot({ path: arquivoParcial })

    // Sair do replay (mesmo botão que o Pedro usa) e reler.
    await pagina.click('[data-prova="modo-replay"]')
    await dormir(1500)
    const depois = await medirCabecalhoEPlacar(pagina)

    const pctCabecalho = pctDeTexto(noPasso.cabecalho.texto)
    const pctOficialCabecalho = pctDeTexto(depois.cabecalho.texto)
    const linhaDoPasso = (nome) => passo.candidatos.find((c) => c.nome === nome) || null
    // No desktop o placar lateral é o `.scoreboard--panel` do painel; no celular
    // o painel está escondido e o placar visível é a barra fina do topo —
    // conferir o que tem caixa na tela.
    const linhasNoPasso =
      noPasso.lateral.linhas.length > 0 ? noPasso.lateral.linhas : noPasso.barra_mobile
    const linhasDepois =
      depois.lateral.linhas.length > 0 ? depois.lateral.linhas : depois.barra_mobile

    const lateralPasso = linhasNoPasso.map((linha) => {
      const esperado = linhaDoPasso(linha.nome)
      const oficialDoNome = oficial.candidatos.find((c) => c.nome === linha.nome)
      return {
        nome: linha.nome,
        votos_tela: numeroBR(linha.votos),
        votos_passo: esperado ? esperado.votos : null,
        votos_final: oficialDoNome ? oficialDoNome.votos : null,
        bate_com_passo: esperado ? numeroBR(linha.votos) === esperado.votos : false,
        difere_do_final: oficialDoNome ? numeroBR(linha.votos) !== oficialDoNome.votos : false,
      }
    })

    const lateralDepois = linhasDepois.map((linha) => {
      const oficialDoNome = oficial.candidatos.find((c) => c.nome === linha.nome)
      return {
        nome: linha.nome,
        votos_tela: numeroBR(linha.votos),
        votos_final: oficialDoNome ? oficialDoNome.votos : null,
        igual_ao_final: oficialDoNome ? numeroBR(linha.votos) === oficialDoNome.votos : false,
      }
    })

    resumo.cabecalho_replay[vp.nome] = {
      durante: noPasso.cabecalho,
      pct_durante: pctCabecalho,
      pct_passo: passo.pct,
      carimbo_esperado: passo.carimbo,
      depois: depois.cabecalho,
      pct_depois: pctOficialCabecalho,
      pct_oficial: oficial.pct,
      arquivo: path.relative(process.cwd(), arquivoParcial),
    }
    resumo.placar_replay[vp.nome] = {
      lateral_durante: noPasso.lateral,
      turno_durante: noPasso.lateral.turno,
      linhas: lateralPasso,
      lateral_depois: lateralDepois,
      barra_mobile_durante: noPasso.barra_mobile,
    }

    registrar({
      tipo: 'replay',
      viewport: vp.nome,
      cabecalho: noPasso.cabecalho.texto,
      pct: pctCabecalho,
      esperado_pct: passo.pct,
      carimbo: passo.carimbo,
      lateral: lateralPasso,
      cabecalho_depois: depois.cabecalho.texto,
      lateral_depois: lateralDepois,
    })

    // Crivo do cabeçalho: % do passo (não 100) e carimbo do passo.
    if (noPasso.cabecalho.fonte !== 'replay') {
      problemas.push(
        `${vp.nome}: cabeçalho não está em modo replay (data-fonte=${noPasso.cabecalho.fonte})`,
      )
    }
    if (pctCabecalho == null || Math.abs(pctCabecalho - passo.pct) > 0.15) {
      problemas.push(
        `${vp.nome}: cabeçalho mostra "${noPasso.cabecalho.texto}", passo ${passo.carimbo} é ${passo.pct}%`,
      )
    }
    if (!String(noPasso.cabecalho.texto || '').includes(passo.carimbo)) {
      problemas.push(
        `${vp.nome}: cabeçalho não traz o carimbo do passo (${passo.carimbo})`,
      )
    }
    // Crivo do placar: votos do passo e diferentes do final.
    if (linhasNoPasso.length < 2) {
      problemas.push(`${vp.nome}: placar sem as duas linhas (${linhasNoPasso.length})`)
    }
    for (const linha of lateralPasso) {
      if (!linha.bate_com_passo) {
        problemas.push(
          `${vp.nome}: placar lateral ${linha.nome} = ${linha.votos_tela}, passo diz ${linha.votos_passo}`,
        )
      }
      if (!linha.difere_do_final) {
        problemas.push(
          `${vp.nome}: placar lateral ${linha.nome} repetiu o número FINAL (${linha.votos_final}) com o replay em ${passo.pct}%`,
        )
      }
    }
    // Ao sair do replay, tudo volta ao oficial.
    if (pctOficialCabecalho == null || Math.abs(pctOficialCabecalho - oficial.pct) > 0.15) {
      problemas.push(
        `${vp.nome}: fora do replay o cabeçalho mostra "${depois.cabecalho.texto}", oficial ${oficial.pct}%`,
      )
    }
    for (const linha of lateralDepois) {
      if (!linha.igual_ao_final) {
        problemas.push(
          `${vp.nome}: fora do replay o placar lateral ${linha.nome} = ${linha.votos_tela}, oficial ${linha.votos_final}`,
        )
      }
    }

    // ---------------------------------------------------------- 2. margem
    // (a) rede normal
    await pagina.goto(`${opcoes.base}/mapa?uf=CE&z=6&margem=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    })
    await esperarCard(pagina)
    const natural = await pagina.evaluate(MEDIR_CARD)

    // (b) a condição da print: o agregado nacional (/api/margens, 140 KB)
    // chega DEPOIS da lista por UF. Segura a resposta por 1,2 s.
    await pagina.route('**/api/margens', async (rota) => {
      await dormir(1200)
      await rota.continue()
    })
    await pagina.goto(`${opcoes.base}/mapa?uf=CE&z=6&margem=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    })
    await esperarCard(pagina)
    const lento = await pagina.evaluate(MEDIR_CARD)
    const arquivoPrint = path.join(opcoes.out, `polimento_${vp.nome}.png`)
    await pagina.screenshot({ path: arquivoPrint })
    await dormir(1400)
    const depoisLento = await pagina.evaluate(MEDIR_CARD)
    // Defeito 3: a nota tem de ser ALCANÇÁVEL rolando o painel — mede-se o
    // scrollport no máximo e o retângulo do parágrafo contra a área visível.
    const alcance = await alcancarNota(pagina)
    const arquivoNota = path.join(opcoes.out, `polimento_${vp.nome}_nota.png`)
    await pagina.screenshot({ path: arquivoNota })
    await pagina.unroute('**/api/margens')

    // Comparação do parágrafo metodológico com o texto da API.
    const notasAPI = [normalizar(margensUf.nota), normalizar(margensNacional.nota)]
    const confereNota = (nota) => {
      const alvo = notasAPI.find((t) => t.length > 0 && (t.startsWith(nota.slice(0, 60)) || nota.startsWith(t.slice(0, 60))))
      if (!alvo) return { confere: false, motivo: 'texto da API não casa com a nota renderizada' }
      return {
        confere: alvo === nota,
        motivo: alvo === nota ? null : `renderizado difere do texto da API (${nota.length} vs ${alvo.length} chars)`,
        api: alvo.slice(0, 120),
      }
    }

    const notasMedidas = (depoisLento.notas.length >= lento.notas.length
      ? depoisLento.notas
      : lento.notas
    ).map((nota) => ({
      ...nota,
      ...confereNota(nota.texto),
    }))
    const paragrafoOkVp =
      notasMedidas.length > 0 &&
      notasMedidas.every(
        (n) =>
          Math.abs(n.scrollHeight - n.clientHeight) <= 1 &&
          n.line_clamp === 'none' &&
          !/hidden/.test(n.overflow) &&
          n.dentro_da_caixa_do_card &&
          n.confere,
      )

    resumo.texto_calculando_ocorrencias[vp.nome] = {
      natural: natural.contagem_texto,
      nacional_lento: lento.contagem_texto,
      depois_do_nacional: depoisLento.contagem_texto,
      origens_no_nacional_lento: lento.origens,
      linhas_decisivos: lento.linhas_decisivos,
      nacional_ja_na_tela: lento.nacional_ja_na_tela,
      fetch_concluiu: Boolean(natural.nacional_ja_na_tela && depoisLento.nacional_ja_na_tela),
      cards_no_dom: lento.cards_no_dom,
      arquivo: path.relative(process.cwd(), arquivoPrint),
    }
    resumo.nota_alcancavel = resumo.nota_alcancavel || {}
    resumo.nota_alcancavel[vp.nome] = {
      ...alcance,
      arquivo: path.relative(process.cwd(), arquivoNota),
    }
    resumo.paragrafo_detalhe[vp.nome] = {
      medidas: notasMedidas,
      scroll: lento.tela,
    }

    registrar({
      tipo: 'margem',
      viewport: vp.nome,
      calculando_natural: natural.contagem_texto,
      calculando_nacional_lento: lento.contagem_texto,
      calculando_depois: depoisLento.contagem_texto,
      linhas_decisivos: lento.linhas_decisivos,
      origens: lento.origens,
      notas: notasMedidas,
      paragrafo_ok: paragrafoOkVp,
      arquivo: path.relative(process.cwd(), arquivoPrint),
    })

    if (lento.linhas_decisivos < 10) {
      problemas.push(`${vp.nome}: card não renderizou 10 decisivos (${lento.linhas_decisivos})`)
    }
    // Defeito 2, causa: o fetch de /api/margens tem de CONCLUIR (antes o efeito
    // cancelava a própria requisição e o bloco nacional nunca aparecia). Medido
    // com rede normal e depois da resposta segurada por 1,2 s.
    const concluiu = Boolean(natural.nacional_ja_na_tela && depoisLento.nacional_ja_na_tela)
    if (!concluiu) {
      problemas.push(
        `${vp.nome}: /api/margens não concluiu (bloco nacional ausente: natural=${natural.nacional_ja_na_tela}, depois=${depoisLento.nacional_ja_na_tela})`,
      )
    }
    // Defeito 3: a nota tem de ser alcançável rolando o painel, inteira e sem
    // linha cortada na borda inferior.
    if (!alcance.ok) {
      problemas.push(`${vp.nome}: nota metodológica inalcançável (${alcance.motivo})`)
    } else {
      if (!(alcance.scroll_max > 0) || !(alcance.scroll_depois > 0)) {
        problemas.push(
          `${vp.nome}: painel não rola até a nota (scroll_max ${alcance.scroll_max}, scrollTop ${alcance.scroll_depois})`,
        )
      }
      if (!alcance.nota_inteira_visivel) {
        problemas.push(
          `${vp.nome}: nota não fica inteira na área visível (${alcance.nota_top}..${alcance.nota_bottom} vs ${alcance.scrollport_top}..${alcance.scrollport_bottom})`,
        )
      }
      if (!alcance.ultima_linha_inteira) {
        problemas.push(
          `${vp.nome}: última linha da nota cortada (bottom ${alcance.ultima_linha_bottom} > ${alcance.scrollport_bottom})`,
        )
      }
      if (alcance.scrollHeight !== alcance.clientHeight) {
        problemas.push(
          `${vp.nome}: nota com clip próprio (scrollHeight ${alcance.scrollHeight} != clientHeight ${alcance.clientHeight})`,
        )
      }
    }
    for (const [condicao, medida] of [
      ['rede normal', natural.contagem_texto],
      ['nacional lento', lento.contagem_texto],
      ['após o nacional', depoisLento.contagem_texto],
    ]) {
      if (medida.dom !== 0 || medida.visivel !== 0) {
        problemas.push(
          `${vp.nome} (${condicao}): "calculando margens" no DOM ${medida.dom}x / visível ${medida.visivel}x com ${lento.linhas_decisivos} municípios na lista`,
        )
      }
    }
    if (notasMedidas.length === 0) {
      problemas.push(`${vp.nome}: parágrafo metodológico (.margem-nota) não está no card visível`)
    }
    if (!paragrafoOkVp) {
      for (const n of notasMedidas) {
        if (Math.abs(n.scrollHeight - n.clientHeight) > 1) {
          problemas.push(
            `${vp.nome}: parágrafo cortado (scrollHeight ${n.scrollHeight} != clientHeight ${n.clientHeight}, ${n.linhas_estimadas} linhas)`,
          )
        }
        if (n.line_clamp !== 'none') {
          problemas.push(`${vp.nome}: parágrafo com line-clamp ${n.line_clamp}`)
        }
        if (/hidden/.test(n.overflow)) {
          problemas.push(`${vp.nome}: parágrafo com overflow ${n.overflow}`)
        }
        if (!n.dentro_da_caixa_do_card) {
          problemas.push(
            `${vp.nome}: parágrafo passa da caixa do card (${n.distancia_do_fundo_do_card} px)`,
          )
        }
        if (!n.confere) {
          problemas.push(`${vp.nome}: ${n.motivo}`)
        }
      }
    }
    if (lento.tela.scrollWidth > lento.tela.clientWidth) {
      problemas.push(
        `${vp.nome}: scroll horizontal (${lento.tela.scrollWidth} > ${lento.tela.clientWidth})`,
      )
    }

    const errosLimpos = [...new Set(erros)]
    const ruinsLimpos = [...new Set(respostasRuins)]
    for (const erro of errosLimpos) resumo.console_erros.push(`${vp.nome}: ${erro}`)
    for (const ruim of ruinsLimpos) problemas.push(`${vp.nome}: resposta >=400 ${ruim}`)
    if (errosLimpos.length > 0) {
      problemas.push(`${vp.nome}: console com ${errosLimpos.length} erro(s)`)
    }
    registrar({ tipo: 'console', viewport: vp.nome, erros: errosLimpos, respostas_ruins: ruinsLimpos })

    await contexto.close()
  }

  await browser.close()

  resumo.paragrafo_ok = Object.values(resumo.paragrafo_detalhe).every(
    (d) =>
      d.medidas.length > 0 &&
      d.medidas.every(
        (n) =>
          Math.abs(n.scrollHeight - n.clientHeight) <= 1 &&
          n.line_clamp === 'none' &&
          !/hidden/.test(n.overflow) &&
          n.dentro_da_caixa_do_card &&
          n.confere,
      ),
  )
  if (!resumo.paragrafo_ok) problemas.push('parágrafo metodológico reprovado em algum viewport')

  resumo.ok = problemas.length === 0
  resumo.gerado = new Date().toISOString()
  const saida = path.join(opcoes.out, 'polimento_resumo.json')
  await writeFile(saida, `${JSON.stringify(resumo, null, 2)}\n`)
  registrar({ tipo: 'resumo', ok: resumo.ok, problemas, arquivo: saida })
  if (!resumo.ok) process.exitCode = 1
}

principal().catch((erro) => {
  console.error(`falha na prova: ${erro.message}`)
  process.exitCode = 1
})
