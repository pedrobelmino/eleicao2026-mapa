#!/usr/bin/env node
// Prova do REPLAY DA APURAÇÃO (item 5 do ROADMAP).
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/replay.mjs --base http://127.0.0.1:8110 --out _provas
//
// O que é medido, e não "deve funcionar":
//   1. quatro momentos do replay (0%, ~40%, ~85%, 100%): o `% apurado` mostrado
//      na barra, o carimbo mostrado, o placar do passo (votos e % de cada
//      candidato) e o que o mapa está pintando (`window.__replayDebug`);
//   2. o PLAY de verdade: toca em 1x e o passo avança sozinho; pausa e para de
//      avançar; em 60x chega ao fim em 100%;
//   3. `featuresZonas` (window.__mapaDebug) antes e depois do replay: a camada
//      de zonas não pode zerar quando o replay pinta as UFs (medido também com
//      uma UF aberta — `?uf=CE&replay=1` — que é quando a fonte de zonas enche);
//   4. barra em 390x844: altura e caixa medidas, sem scroll horizontal na
//      página (scrollWidth == clientWidth);
//   5. console limpo e nenhuma resposta >=400.
//
// Saída: `_provas/replay_resumo.json` + prints desktop 1440x900 e mobile
// 390x844. O campo `gerado` só é gravado no fim: se ele não estiver no JSON, a
// prova morreu no meio e o arquivo não vale.
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VIEWPORTS = [
  { nome: 'desktop_1440x900', largura: 1440, altura: 900 },
  { nome: 'mobile_390x844', largura: 390, altura: 844 },
]

// Momentos pedidos: começo, meio do caminho, reta final e o arquivo fechado.
const ALVOS = [0, 40, 85, 100]

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

function argumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8110', out: '_provas', vp: '' }
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

// Passo cujo pct_apurado está mais perto do alvo (a série tem 61 passos, então
// o alvo é aproximado pelo passo mais próximo).
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

function numeroBR(texto) {
  if (!texto) return null
  const limpo = String(texto).replace(/[^\d,]/g, '').replace(',', '.')
  const valor = Number(limpo)
  return Number.isFinite(valor) ? valor : null
}

async function esperarReplay(pagina) {
  await pagina.waitForFunction(
    () => {
      const linha = document.querySelector('[data-prova="replay-linha"]')
      return (
        Boolean(linha) &&
        Number(linha.max) > 0 &&
        window.__mapa?.loaded?.() &&
        window.__replayDebug?.modo === 'replay'
      )
    },
    { timeout: 90000 },
  )
  // A transição de cor das UFs é de 900 ms: o print tem de vir depois dela.
  await dormir(1300)
}

// Mover a linha do tempo como o dedo/mouse move: setter nativo + evento
// `input` (é o evento que o React escuta no range).
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
  await dormir(1200)
}

async function medir(pagina) {
  return pagina.evaluate(() => {
    const texto = (seletor) => {
      const el = document.querySelector(seletor)
      return el ? el.textContent.trim() : null
    }
    const barra = document.querySelector('.replay-bar')
    const caixa = barra ? barra.getBoundingClientRect() : null
    const debug = window.__replayDebug || {}
    const mapaDebug = window.__mapaDebug || {}
    const placar = [
      ...document.querySelectorAll('.replay-placar .replay-placar-linha'),
    ].map((linha) => ({
      nome: linha.querySelector('.replay-placar-nome')?.textContent?.trim() ?? null,
      votos: linha.querySelector('b')?.textContent?.trim() ?? null,
      pct: linha.querySelector('i')?.textContent?.trim() ?? null,
    }))
    const aoVivo = [
      ...document.querySelectorAll('.scoreboard--panel .score-row'),
    ].map((linha) => ({
      nome: linha.querySelector('.score-name')?.textContent?.trim() ?? null,
      votos: linha.querySelector('.score-votes')?.textContent?.trim() ?? null,
      pct: linha.querySelector('.score-pct')?.textContent?.trim() ?? null,
    }))
    return {
      frame: debug.frame ?? null,
      pct_barra: texto('[data-prova="replay-pct"]'),
      carimbo: texto('[data-prova="replay-relogio"]'),
      rotulo_carimbo:
        document
          .querySelector('[data-prova="replay-relogio"]')
          ?.parentElement?.querySelector('span')
          ?.textContent?.trim() ?? null,
      fechadas: texto('[data-prova="replay-fechadas"]'),
      secoes: texto('[data-prova="replay-secoes"]'),
      posicao: texto('.replay-posicao'),
      velocidade_ativa:
        document.querySelector('[data-prova^="replay-vel-"].is-ativo')?.textContent?.trim() ??
        null,
      placar,
      ufs_fechadas: debug.ufs_fechadas ?? null,
      ufs_total: debug.ufs_total ?? null,
      featuresUfs: mapaDebug.featuresUfs ?? null,
      featuresZonas: mapaDebug.featuresZonas ?? null,
      zonasBarras: mapaDebug.zonasBarras ?? null,
      barra: caixa
        ? {
            topo: Math.round(caixa.top),
            altura: Math.round(caixa.height),
            largura: Math.round(caixa.width),
            esquerda: Math.round(caixa.left),
            fundo: Math.round(caixa.bottom),
          }
        : null,
      tela: {
        largura: window.innerWidth,
        altura: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
      },
      vivos: aoVivo,
    }
  })
}

async function principal() {
  const opcoes = argumentos(process.argv.slice(2))
  await mkdir(opcoes.out, { recursive: true })

  const resposta = await fetch(`${opcoes.base}/api/replay`)
  if (!resposta.ok) throw new Error(`/api/replay respondeu ${resposta.status}`)
  const serie = await resposta.json()
  if (!serie.disponivel) throw new Error(`replay indisponível: ${serie.nota}`)
  const passos = serie.passos || []
  if (passos.length === 0) throw new Error('série de apuração sem passos')

  const momentos = ALVOS.map((alvo) => ({
    alvo,
    indice: passoMaisProximo(passos, alvo),
    pct_serie: passos[passoMaisProximo(passos, alvo)].pct_apurado,
  }))

  const resumo = {
    gerado: null,
    base: opcoes.base,
    serie: {
      eixo: serie.eixo,
      relogio: serie.relogio,
      passos: passos.length,
      secoes_total: serie.secoes_total,
      ufs_base: Object.keys(serie.ufs_base || {}).length,
      candidatos: (serie.candidatos || []).map((c) => c.nome),
      nota: serie.nota,
    },
    momentos_pedidos: momentos,
    viewports: {},
    zonas: null,
    problemas: [],
    ok: false,
  }
  const problemas = resumo.problemas
  const registrar = (obj) => console.log(JSON.stringify(obj))

  registrar({
    tipo: 'serie',
    eixo: serie.eixo,
    relogio: serie.relogio,
    passos: passos.length,
    secoes_total: serie.secoes_total,
    ufs: Object.keys(serie.ufs_base || {}).length,
    momentos: momentos.map((m) => ({ alvo: m.alvo, indice: m.indice, pct: m.pct_serie })),
  })

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })

  const viewports = opcoes.vp
    ? VIEWPORTS.filter((v) => v.nome.startsWith(opcoes.vp))
    : VIEWPORTS

  for (const vp of viewports) {
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

    const dadosVp = { momentos: [], play: null, barra: null, console: null }

    // ?replay=N é 1-based: 1 abre o replay no primeiro passo (0% apurado).
    await pagina.goto(`${opcoes.base}/mapa?replay=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    })
    await esperarReplay(pagina)

    for (const momento of momentos) {
      await irPara(pagina, momento.indice)
      const dados = await medir(pagina)
      const arquivo = path.join(
        opcoes.out,
        `replay_${String(momento.alvo).padStart(3, '0')}_${vp.nome}.png`,
      )
      await pagina.screenshot({ path: arquivo })
      const registro = {
        pedido: momento.alvo,
        indice: momento.indice,
        pct_serie: momento.pct_serie,
        pct_barra: dados.pct_barra,
        carimbo: dados.carimbo,
        rotulo_carimbo: dados.rotulo_carimbo,
        fechadas: dados.fechadas,
        secoes: dados.secoes,
        posicao: dados.posicao,
        placar: dados.placar,
        ufs_fechadas: dados.ufs_fechadas,
        ufs_total: dados.ufs_total,
        featuresZonas: dados.featuresZonas,
        barra: dados.barra,
        arquivo: path.relative(process.cwd(), arquivo),
      }
      dadosVp.momentos.push(registro)
      registrar({ tipo: 'momento', viewport: vp.nome, ...registro })

      // % apurado mostrado tem de ser o do passo da série.
      const mostrado = numeroBR(dados.pct_barra)
      if (mostrado == null || Math.abs(mostrado - Number(momento.pct_serie)) > 0.15) {
        problemas.push(
          `${vp.nome} ${momento.alvo}%: barra mostra ${dados.pct_barra}, série diz ${momento.pct_serie}`,
        )
      }
      // Carimbo: sem relógio do TSE (eixo por ordem de seções) ele é o passo.
      if (dados.rotulo_carimbo && /passo/.test(dados.rotulo_carimbo)) {
        const esperado = `${momento.indice + 1}/${passos.length}`
        if (dados.carimbo !== esperado) {
          problemas.push(
            `${vp.nome} ${momento.alvo}%: carimbo ${dados.carimbo}, esperado ${esperado}`,
          )
        }
      }
      if (!dados.barra) {
        problemas.push(`${vp.nome} ${momento.alvo}%: barra do replay não está na tela`)
      }
      if (dados.tela.scrollWidth > dados.tela.clientWidth) {
        problemas.push(
          `${vp.nome} ${momento.alvo}%: scroll horizontal (${dados.tela.scrollWidth} > ${dados.tela.clientWidth})`,
        )
      }
    }

    // O quadro de números tem de SUBIR entre os momentos: % apurado, seções e
    // votos do placar. Sem isso o replay é uma foto, não um replay.
    const seq = dadosVp.momentos
    const pcts = seq.map((m) => numeroBR(m.pct_barra))
    const secoes = seq.map((m) => numeroBR(m.secoes))
    const votos0 = seq.map((m) => numeroBR(m.placar?.[0]?.votos))
    for (let i = 1; i < seq.length; i += 1) {
      if (!(pcts[i] > pcts[i - 1])) {
        problemas.push(`${vp.nome}: % apurado não subiu (${pcts[i - 1]} -> ${pcts[i]})`)
      }
      if (!(secoes[i] > secoes[i - 1])) {
        problemas.push(`${vp.nome}: seções apuradas não subiram (${secoes[i - 1]} -> ${secoes[i]})`)
      }
      if (!(votos0[i] > votos0[i - 1])) {
        problemas.push(`${vp.nome}: votos do 1º colocado não subiram (${votos0[i - 1]} -> ${votos0[i]})`)
      }
    }
    // Carimbo tem de mudar entre os passos (é o que mostra o tempo andando).
    const carimbos = new Set(seq.map((m) => m.carimbo))
    if (carimbos.size !== seq.length) {
      problemas.push(`${vp.nome}: carimbo repetido entre momentos (${[...carimbos].join(' | ')})`)
    }
    // 100% é o arquivo fechado: todas as UFs fechadas e as mesmas seções do total.
    const fim = seq[seq.length - 1]
    if (fim.ufs_fechadas !== fim.ufs_total || fim.ufs_fechadas < 27) {
      problemas.push(
        `${vp.nome}: no fim ${fim.ufs_fechadas}/${fim.ufs_total} UFs fechadas (esperado todas)`,
      )
    }
    if (numeroBR(fim.secoes) !== Number(serie.secoes_total)) {
      problemas.push(
        `${vp.nome}: seções no fim ${fim.secoes}, total da série ${serie.secoes_total}`,
      )
    }
    // O placar do fim tem de ser o placar ao vivo (mesmo dump, 100%).
    const vivos = (fim.vivos || []).map((c) => ({ nome: c.nome, votos: numeroBR(c.votos) }))
    for (const candidato of fim.placar || []) {
      const vivo = vivos.find((c) => c.nome === candidato.nome)
      const votosReplay = numeroBR(candidato.votos)
      if (vivo && vivo.votos != null && votosReplay !== vivo.votos) {
        problemas.push(
          `${vp.nome}: fim do replay ${candidato.nome}=${votosReplay} difere do placar ao vivo (${vivo.votos})`,
        )
      }
    }

    // ---------------------------------------------------------------- PLAY
    // Toca em 1x: o passo tem de andar sozinho. Pausa: tem de parar. 60x: tem
    // de chegar ao fim (100%) sem tocar na linha do tempo.
    await irPara(pagina, 0)
    const inicio = await medir(pagina)
    await pagina.click('[data-prova="replay-play"]')
    await dormir(2500)
    const andando = await medir(pagina)
    await pagina.click('[data-prova="replay-play"]')
    await dormir(400)
    const pausado = await medir(pagina)
    await dormir(1300)
    const pausadoDepois = await medir(pagina)

    dadosVp.play = {
      inicio: { frame: inicio.frame, pct: inicio.pct_barra, posicao: inicio.posicao },
      depois_1x_2500ms: { frame: andando.frame, pct: andando.pct_barra, posicao: andando.posicao },
      pausado: { frame: pausado.frame, posicao: pausado.posicao },
      pausado_1300ms_depois: { frame: pausadoDepois.frame, posicao: pausadoDepois.posicao },
      velocidade_ativa: andando.velocidade_ativa,
      fim: null,
    }

    if (!(andando.frame > inicio.frame)) {
      problemas.push(`${vp.nome}: play em 1x não avançou (${inicio.frame} -> ${andando.frame})`)
    }
    if (pausadoDepois.frame !== pausado.frame) {
      problemas.push(
        `${vp.nome}: pausa não parou o replay (${pausado.frame} -> ${pausadoDepois.frame})`,
      )
    }

    // 60x até o fim.
    await pagina.click('[data-prova="replay-vel-60x"]')
    await pagina.click('[data-prova="replay-play"]')
    try {
      await pagina.waitForFunction(
        () => document.querySelector('[data-prova="replay-pct"]')?.textContent.trim() === '100%',
        { timeout: 25000 },
      )
    } catch {
      problemas.push(`${vp.nome}: em 60x o replay não chegou a 100%`)
    }
    await dormir(1300)
    const terminou = await medir(pagina)
    dadosVp.play.fim = {
      frame: terminou.frame,
      pct: terminou.pct_barra,
      posicao: terminou.posicao,
      ufs_fechadas: terminou.ufs_fechadas,
      ufs_total: terminou.ufs_total,
      velocidade_ativa: terminou.velocidade_ativa,
    }
    const arquivoFim = path.join(opcoes.out, `replay_fim_${vp.nome}.png`)
    await pagina.screenshot({ path: arquivoFim })
    if (terminou.frame !== passos.length - 1 || terminou.pct_barra !== '100%') {
      problemas.push(
        `${vp.nome}: fim do play em ${terminou.posicao} (${terminou.pct_barra}), esperado ${passos.length}/${passos.length} (100%)`,
      )
    }

    dadosVp.barra = {
      viewport: vp.nome,
      caixa: terminou.barra,
      altura_fracao_tela: terminou.barra
        ? Number((terminou.barra.altura / terminou.tela.altura).toFixed(3))
        : null,
      fundo_fracao_tela: terminou.barra
        ? Number((terminou.barra.fundo / terminou.tela.altura).toFixed(3))
        : null,
      scroll: terminou.tela,
    }

    // Em 390x844 a barra tem de caber sem cobrir o mapa: no máximo um terço da
    // tela, inteira dentro do viewport, e sem scroll horizontal.
    if (terminou.barra) {
      const { topo, altura, largura, esquerda } = terminou.barra
      if (topo < 0 || topo + altura > terminou.tela.altura) {
        problemas.push(
          `${vp.nome}: barra sai do viewport (topo ${topo} + altura ${altura} > ${terminou.tela.altura})`,
        )
      }
      if (esquerda < 0 || esquerda + largura > terminou.tela.largura) {
        problemas.push(
          `${vp.nome}: barra mais larga que a tela (${largura} em ${terminou.tela.largura})`,
        )
      }
      if (altura / terminou.tela.altura > 1 / 3) {
        problemas.push(
          `${vp.nome}: barra come o mapa (${altura}px de ${terminou.tela.altura} = ${Math.round((100 * altura) / terminou.tela.altura)}%)`,
        )
      }
    }

    const errosLimpos = [...new Set(erros)]
    const ruinsLimpos = [...new Set(respostasRuins)]
    dadosVp.console = { erros: errosLimpos, respostas_ruins: ruinsLimpos }
    if (errosLimpos.length > 0) {
      problemas.push(`${vp.nome}: console com ${errosLimpos.length} erro(s): ${errosLimpos.join(' | ')}`)
    }
    if (ruinsLimpos.length > 0) {
      problemas.push(`${vp.nome}: respostas >=400: ${ruinsLimpos.join(' | ')}`)
    }
    registrar({ tipo: 'console', viewport: vp.nome, ...dadosVp.console })
    registrar({
      tipo: 'play',
      viewport: vp.nome,
      inicio: dadosVp.play.inicio,
      andando: dadosVp.play.depois_1x_2500ms,
      pausado: dadosVp.play.pausado,
      fim: dadosVp.play.fim,
    })
    registrar({ tipo: 'barra', viewport: vp.nome, ...dadosVp.barra })

    resumo.viewports[vp.nome] = dadosVp
    await contexto.close()
  }

  // ------------------------------------------------------- zonas (antes/depois)
  // Com uma UF aberta a fonte `zonas` fica cheia: é aí que `featuresZonas`
  // precisa continuar de pé enquanto o replay repinta as UFs.
  {
    const contexto = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    })
    const pagina = await contexto.newPage()
    const errosZonas = []
    pagina.on('console', (msg) => {
      if (msg.type() === 'error') errosZonas.push(msg.text())
    })
    pagina.on('pageerror', (erro) => errosZonas.push(`pageerror: ${erro.message}`))

    await pagina.goto(`${opcoes.base}/mapa?uf=CE&z=9&replay=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    })
    await esperarReplay(pagina)
    await pagina.waitForFunction(() => (window.__mapaDebug?.featuresZonas || 0) > 0, {
      timeout: 60000,
    })
    const antes = await medir(pagina)
    await irPara(pagina, passos.length - 1)
    const depois = await medir(pagina)
    const arquivo = path.join(opcoes.out, 'replay_zonas_CE_desktop_1440x900.png')
    await pagina.screenshot({ path: arquivo })

    resumo.zonas = {
      uf: 'CE',
      antes: { pct: antes.pct_barra, featuresZonas: antes.featuresZonas, zonasBarras: antes.zonasBarras },
      depois: { pct: depois.pct_barra, featuresZonas: depois.featuresZonas, zonasBarras: depois.zonasBarras },
      arquivo: path.relative(process.cwd(), arquivo),
      console: [...new Set(errosZonas)],
    }
    registrar({ tipo: 'zonas', ...resumo.zonas })

    if (!(antes.featuresZonas > 0)) {
      problemas.push('zonas: featuresZonas já estava zerado antes do replay')
    }
    if (!(depois.featuresZonas > 0) || depois.featuresZonas < antes.featuresZonas) {
      problemas.push(
        `zonas: featuresZonas caiu com o replay (${antes.featuresZonas} -> ${depois.featuresZonas})`,
      )
    }
    if (resumo.zonas.console.length > 0) {
      problemas.push(`zonas: console com erro: ${resumo.zonas.console.join(' | ')}`)
    }
    await contexto.close()
  }

  await browser.close()

  resumo.ok = problemas.length === 0
  resumo.gerado = new Date().toISOString()
  const saida = path.join(opcoes.out, 'replay_resumo.json')
  await writeFile(saida, `${JSON.stringify(resumo, null, 2)}\n`)

  registrar({ tipo: 'resumo', ok: resumo.ok, problemas, arquivo: saida })
  if (!resumo.ok) process.exitCode = 1
}

principal().catch((erro) => {
  console.error(`falha na prova: ${erro.message}`)
  process.exitCode = 1
})
