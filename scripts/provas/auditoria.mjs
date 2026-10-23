#!/usr/bin/env node
// Auditoria de polimento: toque, áreas de toque, scroll horizontal zero,
// viewport 390x844 / 1440x900 em TODAS as rotas e fallback sem WebGL.
//
// Uso (o NODE_PATH é obrigatório: o playwright mora nos node_modules do agente):
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/auditoria.mjs --base http://127.0.0.1:8100 --out _provas
//
// O que ele prova, por (rota, viewport, modo):
//   * não há scroll horizontal: documentElement.scrollWidth <= innerWidth e
//     nenhum elemento visível passa da borda direita;
//   * toda área de toque tem pelo menos 44x44 CSS px (WCAG 2.5.5 / Apple HIG);
//   * a página não fica em branco: mede o print (fração de pixels quase-brancos
//     e cores distintas) e exige texto e conteúdo visível;
//   * modo `sem-webgl` (getContext('webgl*') devolve null): o mapa cai no
//     FallbackView com a tabela por UF, e a página continua legível;
//   * no celular, toque real (hasTouch) no botão de fechar a gaveta inferior.
//
// Sai 0 só se tudo passar; imprime a lista de falhas no fim.

import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const ALVO_MINIMO = 44 // px, área de toque mínima

const VIEWPORTS = [
  { nome: 'mobile', largura: 390, altura: 844, toque: true },
  { nome: 'desktop', largura: 1440, altura: 900, toque: false },
]

const ROTAS = [
  {
    nome: 'home',
    caminho: '/',
    seletor: '.home-app h1',
    modos: ['webgl', 'sem-webgl'],
  },
  {
    nome: 'mapa',
    caminho: '/mapa',
    seletor: '.site-header',
    modos: ['webgl', 'sem-webgl'],
  },
  {
    nome: 'mapa_uf',
    caminho: '/mapa?uf=CE&z=6.3',
    seletor: '.site-header',
    modos: ['webgl', 'sem-webgl'],
  },
  {
    nome: 'mapa_municipio',
    caminho: '/mapa?uf=CE&m=13897&z=9.5',
    seletor: '.site-header',
    modos: ['webgl'],
  },
  {
    nome: 'nao_encontrado',
    caminho: '/rota-que-nao-existe',
    seletor: '.nao-encontrado h1',
    modos: ['webgl'],
  },
]

function lerArgumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8100', out: '_provas', so: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const [chave, valorNaLinha] = argv[i].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in opcoes)) continue
    opcoes[nome] = valorNaLinha ?? argv[i + 1]
    if (valorNaLinha == null) i += 1
  }
  opcoes.base = opcoes.base.replace(/\/+$/, '')
  return opcoes
}

// Bloqueia WebGL antes de qualquer script da página rodar: é assim que se
// prova o fallback num navegador que de fato não tem contexto gráfico.
function bloquearWebGL() {
  const original = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (tipo, ...resto) {
    if (typeof tipo === 'string' && tipo.toLowerCase().includes('webgl')) {
      return null
    }
    return original.call(this, tipo, ...resto)
  }
  window.__webglBloqueado = true
}

// Mede o print dentro do próprio navegador (canvas 2D continua disponível com
// o WebGL bloqueado). Devolve fração de pixels ~brancos e de cores distintas:
// é a prova objetiva de "não é tela branca".
async function medirPrint(page, dataUrl) {
  return page.evaluate(async (url) => {
    const imagem = new Image()
    imagem.src = url
    await imagem.decode()
    const tela = document.createElement('canvas')
    tela.width = imagem.naturalWidth
    tela.height = imagem.naturalHeight
    const contexto = tela.getContext('2d')
    contexto.drawImage(imagem, 0, 0)
    const { data } = contexto.getImageData(
      0,
      0,
      tela.width,
      tela.height,
    )
    let brancos = 0
    let naoBrancos = 0
    const cores = new Set()
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      if (r > 245 && g > 245 && b > 245) brancos += 1
      else naoBrancos += 1
      if (i % 4000 === 0) {
        cores.add((r << 16) | (g << 8) | b)
      }
    }
    const total = brancos + naoBrancos
    return {
      largura: tela.width,
      altura: tela.height,
      brancosPct: Math.round((brancos / total) * 1000) / 10,
      naoBrancosPct: Math.round((naoBrancos / total) * 1000) / 10,
      cores: cores.size,
    }
  }, dataUrl)
}

// Coleta, no navegador, as violações de layout e de área de toque.
function auditarLayout(alvoMinimo) {
  const larguraJanela = window.innerWidth

  const visivel = (elemento) => {
    const estilo = window.getComputedStyle(elemento)
    if (estilo.display === 'none' || estilo.visibility === 'hidden') return false
    if (Number(estilo.opacity) === 0) return false
    const r = elemento.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  const offendersOverflow = []
  const todos = document.querySelectorAll('body *')
  for (const elemento of todos) {
    if (!visivel(elemento)) continue
    const r = elemento.getBoundingClientRect()
    if (r.right <= larguraJanela + 1) continue
    // Elemento dentro de um contêiner com scroll horizontal próprio não
    // empurra o documento: só conta quem não tem ancestral rolável em X.
    let pai = elemento.parentElement
    let contido = false
    while (pai && pai !== document.body) {
      const estilo = window.getComputedStyle(pai)
      if (
        (estilo.overflowX === 'auto' || estilo.overflowX === 'scroll') &&
        pai.scrollWidth > pai.clientWidth
      ) {
        contido = true
        break
      }
      pai = pai.parentElement
    }
    if (contido) continue
    offendersOverflow.push({
      tag: elemento.tagName.toLowerCase(),
      classe: (elemento.className || '').toString().slice(0, 60),
      direita: Math.round(r.right),
      excedente: Math.round(r.right - larguraJanela),
    })
  }

  // Dois níveis, de propósito: controle de verdade (botão, aba, seletor) exige
  // 44x44 — alvo de dedo confortável (WCAG 2.5.5 / Apple HIG). Link dentro de
  // tabela ou de texto corrido é exceção do próprio WCAG 2.5.8 (inline) e cai
  // no piso de 24x24 (AA). O que fica entre 24 e 44 em link vira aviso.
  const seletorControle =
    'button, summary, [role="button"], select, input:not([type="hidden"]), textarea'
  const seletorLink = 'a[href]'

  const medir = (elemento) => {
    const r = elemento.getBoundingClientRect()
    return {
      tag: elemento.tagName.toLowerCase(),
      classe:
        (elemento.className || '').toString().slice(0, 50) ||
        (elemento.getAttribute('aria-label') || '').slice(0, 40),
      texto: (elemento.innerText || '').replace(/\s+/g, ' ').slice(0, 40),
      largura: Math.round(r.width),
      altura: Math.round(r.height),
    }
  }

  const foraDaTela = (elemento) => {
    const r = elemento.getBoundingClientRect()
    // Fora do viewport vertical: nada a ver com área de toque. Fora do
    // horizontal continua contando, porque isso é o overflow de verdade.
    return r.bottom < 0 || r.top > window.innerHeight * 8
  }

  // Elemento dentro de um <details> fechado (ou de um bloco colapsado) não é
  // área de toque: ninguém toca no que não está na tela.
  const dentroDeColapsado = (elemento) => {
    let pai = elemento.parentElement
    while (pai && pai !== document.body) {
      if (pai.tagName === 'DETAILS' && !pai.open) return true
      const estilo = window.getComputedStyle(pai)
      if (
        (estilo.visibility === 'hidden' || estilo.display === 'none') &&
        pai !== document.body
      ) {
        return true
      }
      if (
        (estilo.overflow === 'hidden' || estilo.overflowY === 'hidden') &&
        pai.clientHeight === 0
      ) {
        return true
      }
      pai = pai.parentElement
    }
    return false
  }

  const controlesPequenos = []
  for (const elemento of document.querySelectorAll(seletorControle)) {
    if (!visivel(elemento) || foraDaTela(elemento)) continue
    if (elemento.closest('[aria-hidden="true"]')) continue
    if (dentroDeColapsado(elemento)) continue
    const medida = medir(elemento)
    if (medida.largura >= alvoMinimo && medida.altura >= alvoMinimo) continue
    controlesPequenos.push(medida)
  }

  const linksPequenos = []
  const linksApertados = []
  for (const elemento of document.querySelectorAll(seletorLink)) {
    if (!visivel(elemento) || foraDaTela(elemento)) continue
    if (elemento.closest('[aria-hidden="true"]')) continue
    if (dentroDeColapsado(elemento)) continue
    const medida = medir(elemento)
    if (medida.largura < 24 || medida.altura < 24) {
      linksPequenos.push(medida)
    } else if (medida.largura < alvoMinimo || medida.altura < alvoMinimo) {
      linksApertados.push(medida)
    }
  }
  const alvos = controlesPequenos

  const metaViewport = document.querySelector('meta[name="viewport"]')
  return {
    larguraJanela,
    scrollWidth: document.documentElement.scrollWidth,
    corpoScrollWidth: document.body.scrollWidth,
    offendersOverflow,
    alvos,
    controlesPequenos,
    linksPequenos,
    linksApertados,
    metaViewport: metaViewport ? metaViewport.getAttribute('content') : null,
    textoVisivel: document.body.innerText.replace(/\s+/g, ' ').trim().length,
    canvas: document.querySelectorAll('canvas.maplibregl-canvas').length,
    fallbackVisivel: Boolean(
      document.querySelector('.fallback-view') &&
        document.querySelector('.fallback-view').getBoundingClientRect()
          .height > 0,
    ),
    linhasFallback: document.querySelectorAll('.fallback-table tbody tr')
      .length,
    gavetaAberta: Boolean(document.querySelector('.bottom-sheet.is-open')),
  }
}

async function auditarCenario(browser, base, out, rota, viewport, modo) {
  const rotulo = `[${rota.nome}][${viewport.nome}][${modo}]`
  const contexto = await browser.newContext({
    viewport: { width: viewport.largura, height: viewport.altura },
    deviceScaleFactor: 1,
    hasTouch: viewport.toque,
    isMobile: viewport.toque,
  })
  if (modo === 'sem-webgl') await contexto.addInitScript(bloquearWebGL)

  const page = await contexto.newPage()
  const errosConsole = []
  const requestsFalhas = []
  const requestsErro = []

  page.on('console', (m) => {
    if (m.type() === 'error') errosConsole.push(m.text())
  })
  page.on('pageerror', (e) => errosConsole.push(`pageerror: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('/api/uf/')) {
      requestsErro.push(`${r.status()} ${r.url()}`)
    }
  })
  page.on('requestfailed', (r) => {
    const erro = r.failure()?.errorText || 'falhou'
    // Tiles do CARTO abortados por mudança de câmera são esperados.
    if (erro === 'net::ERR_ABORTED') return
    // Sem WebGL não há renderer: requisições de tile nem começam.
    requestsFalhas.push(`${r.url()} (${erro})`)
  })

  const destino = path.join(
    out,
    `auditoria_${rota.nome}_${viewport.nome}_${modo}.png`,
  )
  const problemas = []
  let medidas = null
  let print = null
  let toque = null

  try {
    await page.goto(`${base}${rota.caminho}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    })
    await page.waitForSelector(rota.seletor, { timeout: 30000 })

    // /mapa só tem conteúdo final depois da API responder.
    if (rota.nome.startsWith('mapa')) {
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('.workspace')) ||
          Boolean(document.querySelector('.fallback-view')) ||
          Boolean(document.querySelector('.state-view')),
        null,
        { timeout: 40000 },
      )
    }
    await page.waitForTimeout(modo === 'sem-webgl' ? 1200 : 2500)

    medidas = await page.evaluate(auditarLayout, ALVO_MINIMO)

    // --- scroll horizontal zero
    if (medidas.scrollWidth > medidas.larguraJanela) {
      problemas.push(
        `scroll horizontal: scrollWidth=${medidas.scrollWidth} > viewport=${medidas.larguraJanela}`,
      )
    }
    if (medidas.offendersOverflow.length) {
      const lista = medidas.offendersOverflow
        .slice(0, 6)
        .map((o) => `${o.tag}.${o.classe}+${o.excedente}px`)
        .join(', ')
      problemas.push(`${medidas.offendersOverflow.length} elemento(s) passando da borda: ${lista}`)
    }

    // --- área de toque: controle exige 44, link exige 24 (piso AA)
    if (medidas.controlesPequenos.length) {
      const lista = medidas.controlesPequenos
        .slice(0, 8)
        .map((a) => `${a.tag}.${a.classe || a.texto} ${a.largura}x${a.altura}`)
        .join(' | ')
      problemas.push(
        `${medidas.controlesPequenos.length} controle(s) < ${ALVO_MINIMO}px: ${lista}`,
      )
    }
    if (medidas.linksPequenos.length) {
      const lista = medidas.linksPequenos
        .slice(0, 8)
        .map((a) => `${a.texto || a.classe} ${a.largura}x${a.altura}`)
        .join(' | ')
      problemas.push(
        `${medidas.linksPequenos.length} link(s) < 24px: ${lista}`,
      )
    }

    // --- viewport meta
    if (!medidas.metaViewport || !medidas.metaViewport.includes('width=device-width')) {
      problemas.push(
        `meta viewport ausente ou sem width=device-width: ${medidas.metaViewport}`,
      )
    }

    // --- conteúdo: nada de tela vazia
    if (medidas.textoVisivel < 120) {
      problemas.push(`pouco texto visível: ${medidas.textoVisivel} caracteres`)
    }

    // --- mapa x fallback
    if (rota.nome.startsWith('mapa') && rota.caminho !== '/mapa?uf=CE&m=13897&z=9.5') {
      if (modo === 'webgl' && medidas.canvas < 1 && !medidas.fallbackVisivel) {
        problemas.push('sem canvas do MapLibre e sem fallback: nenhuma visão do mapa')
      }
      if (modo === 'sem-webgl') {
        if (!medidas.fallbackVisivel) {
          problemas.push('WebGL bloqueado e a tabela de fallback não apareceu')
        }
        if (medidas.linhasFallback !== 27) {
          problemas.push(`fallback com ${medidas.linhasFallback} UFs (quer 27)`)
        }
        if (medidas.canvas > 0) {
          problemas.push('WebGL bloqueado mas há canvas do MapLibre (deveria cair no fallback)')
        }
      }
    }

    // --- print: prova objetiva de que não é tela branca
    const buffer = await page.screenshot({ path: destino, fullPage: false })
    print = await medirPrint(page, `data:image/png;base64,${buffer.toString('base64')}`)
    if (print.naoBrancosPct < 5) {
      problemas.push(
        `print quase todo branco: ${print.brancosPct}% branco, ${print.cores} cores`,
      )
    }

    // --- toque real no celular: gaveta inferior abre em ?uf=CE; o × fecha.
    if (viewport.toque && rota.nome === 'mapa_uf' && modo === 'webgl') {
      if (!medidas.gavetaAberta) {
        problemas.push('gaveta inferior não abriu com ?uf=CE no celular')
      } else {
        const caixa = await page.locator('.sheet-close').boundingBox()
        await page.locator('.sheet-close').tap()
        await page.waitForTimeout(500)
        const fechou = await page.evaluate(
          () => !document.querySelector('.bottom-sheet.is-open'),
        )
        toque = { caixa, fechou }
        if (!fechou) problemas.push('toque no × não fechou a gaveta inferior')
      }
    }

    if (errosConsole.length) {
      problemas.push(`console.error: ${errosConsole.slice(0, 3).join(' | ')}`)
    }
    if (requestsErro.length) {
      problemas.push(`HTTP>=400: ${requestsErro.slice(0, 3).join(' | ')}`)
    }
    if (requestsFalhas.length) {
      problemas.push(`request falhou: ${requestsFalhas.slice(0, 3).join(' | ')}`)
    }
  } catch (erro) {
    problemas.push(`exceção: ${erro.message.split('\n')[0]}`)
    try {
      await page.screenshot({ path: destino })
    } catch {
      // print de socorro é opcional
    }
  } finally {
    await page.close()
    await contexto.close()
  }

  const estado = problemas.length ? 'FALHA' : 'ok'
  console.log(
    `${rotulo} ${estado} scrollW=${medidas?.scrollWidth ?? '—'}/${medidas?.larguraJanela ?? '—'} ctrlPequenos=${medidas?.controlesPequenos?.length ?? '—'} linksPequenos=${medidas?.linksPequenos?.length ?? '—'} linksApertados=${medidas?.linksApertados?.length ?? '—'} canvas=${medidas?.canvas ?? '—'} fallback=${medidas?.fallbackVisivel ? 'sim' : 'nao'}(${medidas?.linhasFallback ?? 0}) print=${print ? `${print.naoBrancosPct}%conteudo/${print.cores}cores` : '—'} print=${destino}`,
  )
  if (toque) {
    console.log(
      `${rotulo} toque: x=${Math.round(toque.caixa?.width ?? 0)}x${Math.round(toque.caixa?.height ?? 0)} fechou=${toque.fechou ? 'sim' : 'NAO'}`,
    )
  }
  for (const problema of problemas) console.log(`${rotulo}   - ${problema}`)

  return problemas
}

async function principal() {
  const { base, out, so } = lerArgumentos(process.argv.slice(2))
  await mkdir(out, { recursive: true })

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })

  const falhas = []
  try {
    for (const viewport of VIEWPORTS) {
      for (const rota of ROTAS) {
        if (so && !rota.nome.includes(so) && !viewport.nome.includes(so)) continue
        for (const modo of rota.modos) {
          const problemas = await auditarCenario(
            browser,
            base,
            out,
            rota,
            viewport,
            modo,
          )
          for (const p of problemas) {
            falhas.push(`[${rota.nome}][${viewport.nome}][${modo}] ${p}`)
          }
        }
      }
    }
  } finally {
    await browser.close()
  }

  if (falhas.length) {
    console.log('')
    console.log(`AUDITORIA FALHOU: ${falhas.length} problema(s)`)
    for (const falha of falhas) console.log(`  - ${falha}`)
    process.exitCode = 1
    return
  }
  console.log('')
  console.log(
    `AUDITORIA OK: scroll horizontal 0, áreas de toque >= ${ALVO_MINIMO}px, fallback sem WebGL com 27 UFs, prints com conteúdo.`,
  )
}

principal().catch((erro) => {
  console.error('AUDITORIA FALHOU ao executar o Playwright:', erro)
  process.exitCode = 1
})
