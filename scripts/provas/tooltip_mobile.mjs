#!/usr/bin/env node
// Prova da CAIXA FLUTUANTE (tooltip) do /mapa — decisão do Pedro, 24/10/2026:
//
//   * no CELULAR (largura <= 820px ou ponteiro grosso) NENHUM popup do mapa
//     aparece, em nenhuma camada (UF, município, zona, local, cluster);
//   * no DESKTOP o hover continua mostrando a caixa exatamente como antes;
//   * a SELEÇÃO não quebra no celular: tap na UF seleciona, tap no município
//     faz o drill-down, tap no local abre o local — só a caixa sai.
//
// Mede o que interessa: número de elementos `.uf-tooltip-popup` no DOM depois
// do tap (celular) e depois do hover (desktop), o texto da caixa, a seleção
// resultante, console, requests >= 400 e scrollWidth x clientWidth.
//
//   NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
//     node scripts/provas/tooltip_mobile.mjs --base http://127.0.0.1:8110 \
//     --out _provas --prefix tooltip
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

// Cenário do print do Pedro: Ceará, zona 60 de Acopiara.
const ZONA_ALVO = { municipio: 'ACOPIARA', zona: 60, cdTse: 13056 }
const CD_TSE_FORTALEZA = 13897

const CAMADAS_ZONA = [
  'zonas-prisma-lula',
  'zonas-prisma-flavio',
  'zonas-prisma-outros',
  'zonas-prisma-nao-apurado',
]
const CAMADAS_LOCAL = ['locais-hit', 'locais-prisma', 'locais-ponto']

const VIEWPORTS_MOBILE = [
  { nome: '390x844', largura: 390, altura: 844 },
  { nome: '390x700', largura: 390, altura: 700 },
]

function lerArgumentos(argv) {
  const opcoes = { base: 'http://127.0.0.1:8110', out: '_provas', prefix: 'tooltip' }
  for (let indice = 0; indice < argv.length; indice += 1) {
    const [chave, naLinha] = argv[indice].split('=')
    if (!chave.startsWith('--')) continue
    const nome = chave.slice(2)
    if (!(nome in opcoes)) continue
    opcoes[nome] = naLinha ?? argv[indice + 1]
    if (naLinha == null) indice += 1
  }
  opcoes.base = opcoes.base.replace(/\/+$/, '')
  return opcoes
}

// ---------------------------------------------------------------- helpers
function filtroConsole(linhas) {
  const ambiente = (t) =>
    /GL Driver Message|swiftshader|WebGL-0x|Automatic fallback to software/i.test(t)
  return {
    total: linhas.length,
    erros: linhas.filter((l) => /^(error|pageerror|http):/.test(l) && !ambiente(l)),
  }
}

function instrumentar(page, registro) {
  page.on('console', (m) => {
    if (m.type() === 'error') registro.console.push(`error: ${m.text()}`)
  })
  page.on('pageerror', (e) => registro.console.push(`pageerror: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400) registro.console.push(`http: ${r.status()} ${r.url()}`)
  })
}

async function assentar(page, url) {
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 30000 })
  await page.waitForFunction(
    () => Boolean(window.__mapa) && Number(window.__mapaDebug?.featuresUfs || 0) > 0,
    null,
    { timeout: 30000 },
  )
  await page.waitForTimeout(2500)
}

async function esperarZonas(page) {
  const prazo = Date.now() + 15000
  while (Date.now() < prazo) {
    const n = await page.evaluate(() => Number(window.__mapaDebug?.featuresZonas || 0))
    if (n > 0) return n
    await page.waitForTimeout(400)
  }
  return 0
}

async function esperarMunicipios(page) {
  const prazo = Date.now() + 20000
  while (Date.now() < prazo) {
    const n = await page.evaluate(
      () => Number(window.__mapaDebug?.featuresMunicipios || 0),
    )
    if (n > 0) return n
    await page.waitForTimeout(400)
  }
  return 0
}

async function medirTooltips(page) {
  return page.evaluate(() => {
    const nos = Array.from(document.querySelectorAll('.uf-tooltip-popup'))
    const visiveis = nos.filter((el) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
    })
    return {
      total: nos.length,
      visiveis: visiveis.length,
      textos: nos.map((el) => el.textContent.replace(/\s+/g, ' ').trim()).slice(0, 4),
      caixas: visiveis.map((el) => {
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      }),
    }
  })
}

async function medirEstado(page) {
  return page.evaluate(() => {
    const mapa = window.__mapa
    const doc = document.documentElement
    const botao = document.querySelector('[data-prova="detalhe-toggle"]')
    const sheet = document.querySelector('.sheet-detalhe')
    return {
      url: window.location.pathname + window.location.search,
      vp: { w: window.innerWidth, h: window.innerHeight },
      midia: {
        largura820: window.matchMedia('(max-width: 820px)').matches,
        ponteiroGrosso: window.matchMedia('(pointer: coarse)').matches,
        hoverFino: window.matchMedia('(hover: hover) and (pointer: fine)').matches,
      },
      scroll: {
        sw: doc.scrollWidth,
        cw: doc.clientWidth,
        iguais: doc.scrollWidth === doc.clientWidth,
      },
      botaoDetalhes: botao
        ? {
            rotulo: botao.getAttribute('aria-label'),
            expandido: botao.getAttribute('aria-expanded'),
            sigla: botao.querySelector('.detalhe-toggle-sigla')?.textContent.trim() || null,
            visivel: botao.getBoundingClientRect().width > 0,
          }
        : null,
      sheet: {
        classe: sheet ? sheet.className : null,
        kicker: sheet?.querySelector('.sheet-header-kicker')?.textContent.trim() || null,
        titulo: sheet?.querySelector('.sheet-header-titulo')?.textContent.trim() || null,
        aberto: Boolean(sheet?.classList.contains('is-open')),
      },
      mapa: {
        zoom: mapa ? Number(mapa.getZoom().toFixed(3)) : null,
        centro: mapa
          ? [Number(mapa.getCenter().lng.toFixed(4)), Number(mapa.getCenter().lat.toFixed(4))]
          : null,
        nivel: window.__mapaDebug?.nivel ?? null,
        municipio: window.__mapaDebug?.municipioSelecionado ?? null,
      },
    }
  })
}

// Acha PONTOS DE TELA que realmente acertam a feature alvo.
//
// Dois cuidados que já custaram uma rodada de medição errada:
//  * `mapa.project()` devolve coordenada do CANVAS; mouse/touch do Playwright
//    usam coordenada de TELA. A diferença é o offset do canvas (o header tem
//    altura própria) — sem somar o rect, o tap caía ~54px acima do alvo.
//  * `queryRenderedFeatures` devolve as features em ordem de RENDERIZAÇÃO:
//    quem responde ao clique é a [0] (a de cima). Testar `.some()` aceitava um
//    prisma de outra zona escondido atrás e o toque abria outra zona.
//
// Cada ponto devolvido passou nos dois testes: topo do pixel é a feature alvo e
// `document.elementFromPoint` é o canvas (nada de painel/legenda por cima).
async function pontosDaFeature(page, alvo, limite = 3) {
  return page.evaluate(
    ({ pedido, maximo }) => {
      const mapa = window.__mapa
      if (!mapa) return { pontos: [], erro: 'sem mapa' }
      const rect = mapa.getCanvas().getBoundingClientRect()
      const visiveis = mapa.queryRenderedFeatures({ layers: pedido.camadas })
      const casa = (props) => {
        if (pedido.uf) return String(props?.uf || '') === pedido.uf
        if (pedido.nome) {
          return String(props?.nome || '').toUpperCase().startsWith(pedido.nome.toUpperCase())
        }
        if (pedido.zona != null) {
          return (
            Number(props?.zona) === Number(pedido.zona) &&
            String(props?.municipio || '')
              .toUpperCase()
              .startsWith(String(pedido.municipio || '').toUpperCase())
          )
        }
        if (pedido.qualquerMunicipio) {
          const nome = String(props?.nome || '').toUpperCase()
          if (pedido.excluirNome && nome.startsWith(pedido.excluirNome.toUpperCase())) return false
          return Boolean(props?.codarea)
        }
        if (pedido.local) return Number(props?.nr_local) > 0
        return false
      }
      const candidatas = visiveis.filter((f) => casa(f.properties))
      if (!candidatas.length) {
        return { pontos: [], erro: 'nenhuma feature alvo nas camadas visíveis', visiveis: visiveis.length }
      }

      const achados = []
      const propsEscolhidas = []
      for (const feature of candidatas) {
        if (achados.length >= maximo) break
        const coords = []
        const coletar = (c) => {
          if (!Array.isArray(c)) return
          if (typeof c[0] === 'number' && typeof c[1] === 'number') {
            coords.push(c)
            return
          }
          for (const filho of c) coletar(filho)
        }
        coletar(feature.geometry?.coordinates)
        if (!coords.length) continue

        const projetados = coords
          .map(([lon, lat]) => mapa.project([lon, lat]))
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        if (!projetados.length) continue

        const xs = projetados.map((p) => p.x)
        const ys = projetados.map((p) => p.y)
        const minX = Math.min(...xs)
        const maxX = Math.max(...xs)
        const minY = Math.min(...ys)
        const maxY = Math.max(...ys)

        const candidatos = []
        for (let i = 1; i <= 8; i += 1) {
          for (let j = 1; j <= 8; j += 1) {
            candidatos.push({
              x: Math.round(minX + ((maxX - minX) * i) / 9),
              y: Math.round(minY + ((maxY - minY) * j) / 9),
            })
          }
        }
        candidatos.push({
          x: Math.round((minX + maxX) / 2),
          y: Math.round((minY + maxY) / 2),
        })

        for (const ponto of candidatos) {
          if (achados.length >= maximo) break
          if (ponto.x < 4 || ponto.y < 4 || ponto.x > rect.width - 4 || ponto.y > rect.height - 4) {
            continue
          }
          const noPonto = mapa.queryRenderedFeatures([ponto.x, ponto.y], { layers: pedido.camadas })
          if (!noPonto.length) continue
          if (!casa(noPonto[0].properties)) continue
          const telaX = Math.round(rect.x + ponto.x)
          const telaY = Math.round(rect.y + ponto.y)
          const alvoDom = document.elementFromPoint(telaX, telaY)
          if (alvoDom?.tagName !== 'CANVAS') continue
          if (achados.some((a) => Math.abs(a.x - telaX) < 24 && Math.abs(a.y - telaY) < 24)) continue
          achados.push({ x: telaX, y: telaY, canvas: { x: ponto.x, y: ponto.y } })
          propsEscolhidas.push(noPonto[0].properties || {})
        }
      }

      return {
        pontos: achados,
        props: propsEscolhidas,
        canvas: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        visiveis: visiveis.length,
        erro: achados.length ? null : 'nenhum ponto do alvo é o topo do pixel',
      }
    },
    { pedido: alvo, maximo: limite },
  )
}

async function tocar(page, ponto) {
  await page.touchscreen.tap(ponto.x, ponto.y)
  // O MapLibre trata o tap no fim do gesto e o handler de clique é síncrono;
  // 700 ms cobrem o popup e qualquer animação de fitBounds.
  await page.waitForTimeout(700)
}

// Toca tentando vários pontos até a seleção esperada aparecer (a confirmação é
// do chamador). Devolve o ponto que funcionou.
async function tocarAte(page, pontos, confirmar, limite = 3) {
  for (const ponto of pontos.slice(0, limite)) {
    await tocar(page, ponto)
    await page.waitForTimeout(900)
    if (await confirmar()) return { ponto, ok: true }
  }
  return { ponto: null, ok: false }
}

async function pairar(page, ponto) {
  // Um único movimento: mover 2px depois pode sair do prisma/polígono fino e o
  // mouseleave apaga a caixa (foi o que fez o hover medir 0 na 1ª rodada).
  await page.mouse.move(ponto.x, ponto.y)
  await page.waitForTimeout(600)
}

// Propriedades da feature que está no TOPO do pixel tocado — prova de que o
// toque acertou o alvo mesmo quando (de propósito) nada aparece na tela.
async function topoNoPonto(page, camadas, ponto) {
  return page.evaluate(
    ({ camadas, x, y }) => {
      const mapa = window.__mapa
      const rect = mapa.getCanvas().getBoundingClientRect()
      const cx = Math.round(x - rect.x)
      const cy = Math.round(y - rect.y)
      const noPonto = mapa.queryRenderedFeatures([cx, cy], { layers: camadas })
      const props = noPonto[0]?.properties || null
      const dom = document.elementFromPoint(x, y)
      return {
        camada: noPonto[0]?.layer?.id || null,
        props: props
          ? {
              uf: props.uf ?? null,
              municipio: props.municipio ?? null,
              zona: props.zona ?? null,
              nome: props.nome ?? null,
              nr_local: props.nr_local ?? null,
            }
          : null,
        dom: dom ? dom.tagName : null,
      }
    },
    { camadas, x: ponto.x, y: ponto.y },
  )
}

// -------------------------------------------------------------- cenários
async function cenarioCelular(navegador, opcoes, vp, falhas) {
  const registro = { console: [] }
  const contexto = await navegador.newContext({
    viewport: { width: vp.largura, height: vp.altura },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'pt-BR',
  })
  const page = await contexto.newPage()
  instrumentar(page, registro)

  const tela = { visao: `${vp.largura}x${vp.altura}`, prints: [] }

  // 0) primeira visita do celular: dispensa o aviso "melhor no desktop" (não é
  //    o objeto desta prova; com ele aberto o card cobre parte do mapa).
  await assentar(page, `${opcoes.base}/mapa?uf=CE&z=6`)
  const temAviso = await page.$('[data-prova="aviso-entendi"]')
  if (temAviso) {
    await page.click('[data-prova="aviso-entendi"]')
    await page.waitForTimeout(500)
  }
  tela.avisoDispensado = Boolean(temAviso)

  // 1) Ceará em nível de estado (cenário do print): tap na zona 60 de Acopiara.
  await esperarZonas(page)
  await page.waitForTimeout(1200)
  tela.midia = (await medirEstado(page)).midia
  const zona = await pontosDaFeature(page, {
    camadas: CAMADAS_ZONA,
    municipio: ZONA_ALVO.municipio,
    zona: ZONA_ALVO.zona,
  })
  tela.pontosZona = zona.pontos
  let maxPopups = 0
  const textosVistos = []
  let topo = null
  if (zona.erro || !zona.pontos.length) {
    falhas.push(`${vp.nome}: não achei a zona ${ZONA_ALVO.zona} de ${ZONA_ALVO.municipio} (${zona.erro})`)
  } else {
    for (const ponto of zona.pontos.slice(0, 2)) {
      await tocar(page, ponto)
      const medido = await medirTooltips(page)
      maxPopups = Math.max(maxPopups, medido.total)
      textosVistos.push(...medido.textos)
      topo = await topoNoPonto(page, CAMADAS_ZONA, ponto)
    }
  }
  const estadoDepoisTap = await medirEstado(page)
  tela.topoNoPontoTocado = topo
  tela.tooltipsDepoisDeTocarZona = {
    total: maxPopups,
    textos: textosVistos.slice(0, 2),
    ultimaMedida: await medirTooltips(page),
  }
  tela.estadoDepoisDeTocarZona = estadoDepoisTap
  if (!topo || topo.dom !== 'CANVAS' || Number(topo.props?.zona) !== ZONA_ALVO.zona) {
    falhas.push(`${vp.nome}: o toque não caiu na zona alvo (${JSON.stringify(topo)})`)
  }

  const arqTap = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_estado_tap.png`)
  await page.screenshot({ path: arqTap })
  tela.prints.push(arqTap)

  if (maxPopups !== 0) {
    falhas.push(
      `${vp.nome}: caixa flutuante no celular após tap na zona (${maxPopups}: ${textosVistos.join(' | ')})`,
    )
  }
  const popupsDepoisDosDoisTaps = tela.tooltipsDepoisDeTocarZona.ultimaMedida.total
  if (popupsDepoisDosDoisTaps !== 0) {
    falhas.push(`${vp.nome}: caixa permaneceu no DOM depois do tap (${popupsDepoisDosDoisTaps})`)
  }
  if (!estadoDepoisTap.botaoDetalhes?.visivel) {
    falhas.push(`${vp.nome}: botão "Mostrar detalhes" não está na tela após o tap`)
  }
  if (!estadoDepoisTap.scroll.iguais) {
    falhas.push(`${vp.nome}: scroll horizontal (sw=${estadoDepoisTap.scroll.sw} cw=${estadoDepoisTap.scroll.cw})`)
  }

  // O painel do botão continua funcionando (só a caixa saiu).
  if (estadoDepoisTap.botaoDetalhes?.visivel) {
    await page.click('[data-prova="detalhe-toggle"]')
    await page.waitForTimeout(1000)
    tela.sheetAbertoPeloBotao = (await medirEstado(page)).sheet
    const arqSheet = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_estado_detalhes.png`)
    await page.screenshot({ path: arqSheet })
    tela.prints.push(arqSheet)
    if (!tela.sheetAbertoPeloBotao.aberto) {
      falhas.push(`${vp.nome}: botão de detalhes não abriu o painel`)
    }
    if ((await medirTooltips(page)).total !== 0) {
      falhas.push(`${vp.nome}: caixa apareceu ao abrir o painel de detalhes`)
    }
    await page.click('[data-prova="detalhe-toggle"]')
    await page.waitForTimeout(400)
  }

  // 2) SELEÇÃO não quebra: tap na UF (macro) continua selecionando o estado.
  await assentar(page, `${opcoes.base}/mapa?z=4.2`)
  await page.waitForTimeout(800)
  const uf = await pontosDaFeature(page, { camadas: ['ufs-fill'], uf: 'CE' })
  tela.pontosUf = uf.pontos
  let toqueUf = { ok: false, ponto: null }
  if (uf.erro || !uf.pontos.length) {
    falhas.push(`${vp.nome}: não achei o Ceará no macro (${uf.erro})`)
  } else {
    toqueUf = await tocarAte(page, uf.pontos, async () => {
      const estado = await medirEstado(page)
      return estado.botaoDetalhes?.sigla === 'CE'
    })
  }
  const depoisUf = await medirEstado(page)
  tela.toqueUf = toqueUf
  tela.tooltipsDepoisDeTocarUf = await medirTooltips(page)
  tela.estadoDepoisDeTocarUf = depoisUf
  if (tela.tooltipsDepoisDeTocarUf.total !== 0) {
    falhas.push(`${vp.nome}: caixa flutuante após tap na UF (${tela.tooltipsDepoisDeTocarUf.total})`)
  }
  if (!toqueUf.ok) {
    falhas.push(`${vp.nome}: tap na UF não selecionou o estado (botão=${JSON.stringify(depoisUf.botaoDetalhes)})`)
  }

  // 3) tap no MUNICÍPIO continua o drill-down (mapa centrado em Acopiara, toque
  //    num município vizinho — o selecionado já vem do ?m).
  await assentar(page, `${opcoes.base}/mapa?uf=CE&m=${ZONA_ALVO.cdTse}&z=8.6`)
  await esperarMunicipios(page)
  await page.waitForTimeout(1800)
  const municipios = await pontosDaFeature(page, {
    camadas: ['municipios-fill'],
    qualquerMunicipio: true,
    excluirNome: ZONA_ALVO.municipio,
  })
  tela.pontosMunicipio = municipios.pontos
  tela.municipioAlvo = municipios.props?.[0]
    ? { nome: municipios.props[0].nome, codarea: municipios.props[0].codarea }
    : null
  let toqueMunicipio = { ok: false, ponto: null }
  if (municipios.erro || !municipios.pontos.length) {
    falhas.push(`${vp.nome}: não achei município vizinho para tocar (${municipios.erro})`)
  } else {
    toqueMunicipio = await tocarAte(page, municipios.pontos, async () => {
      const estado = await medirEstado(page)
      const alvo = String(municipios.props?.[0]?.nome || '').toUpperCase()
      return Boolean(alvo) && String(estado.sheet.titulo || '').toUpperCase().startsWith(alvo)
    })
  }
  await page.waitForTimeout(1000)
  const depoisMunicipio = await medirEstado(page)
  tela.toqueMunicipio = toqueMunicipio
  tela.tooltipsDepoisDeTocarMunicipio = await medirTooltips(page)
  tela.estadoDepoisDeTocarMunicipio = depoisMunicipio
  if (tela.tooltipsDepoisDeTocarMunicipio.total !== 0) {
    falhas.push(`${vp.nome}: caixa flutuante após tap no município (${tela.tooltipsDepoisDeTocarMunicipio.total})`)
  }
  if (!toqueMunicipio.ok) {
    falhas.push(
      `${vp.nome}: drill-down do município não abriu (título="${depoisMunicipio.sheet.titulo}", alvo="${tela.municipioAlvo?.nome}")`,
    )
  }

  // 4) tap no LOCAL continua abrindo o local.
  await assentar(page, `${opcoes.base}/mapa?uf=CE&m=${CD_TSE_FORTALEZA}&z=11`)
  await page.waitForTimeout(3000)
  const local = await pontosDaFeature(page, { camadas: CAMADAS_LOCAL, local: true })
  tela.pontosLocal = local.pontos
  let toqueLocal = { ok: false, ponto: null }
  if (local.erro || !local.pontos.length) {
    falhas.push(`${vp.nome}: não achei local de votação na tela (${local.erro})`)
  } else {
    toqueLocal = await tocarAte(page, local.pontos, async () => {
      const estado = await medirEstado(page)
      return /local/i.test(estado.sheet.kicker || '')
    })
  }
  await page.waitForTimeout(800)
  const depoisLocal = await medirEstado(page)
  tela.toqueLocal = toqueLocal
  tela.tooltipsDepoisDeTocarLocal = await medirTooltips(page)
  tela.estadoDepoisDeTocarLocal = depoisLocal
  if (tela.tooltipsDepoisDeTocarLocal.total !== 0) {
    falhas.push(`${vp.nome}: caixa flutuante após tap no local (${tela.tooltipsDepoisDeTocarLocal.total})`)
  }
  if (!toqueLocal.ok) {
    falhas.push(`${vp.nome}: tap no local não abriu o local (kicker="${depoisLocal.sheet.kicker}")`)
  }
  // print do nível urna no celular (mapa + botão, sem caixa)
  const arqLocal = path.join(opcoes.out, `${opcoes.prefix}_${vp.nome}_local_tap.png`)
  await page.screenshot({ path: arqLocal })
  tela.prints.push(arqLocal)

  tela.console = filtroConsole(registro.console)
  if (tela.console.erros.length) {
    falhas.push(`${vp.nome}: console/HTTP — ${tela.console.erros.slice(0, 3).join(' | ')}`)
  }
  await contexto.close()
  return tela
}

async function cenarioDesktop(navegador, opcoes, falhas) {
  const registro = { console: [] }
  const contexto = await navegador.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'pt-BR',
  })
  const page = await contexto.newPage()
  instrumentar(page, registro)
  const tela = { visao: '1440x900', prints: [] }

  // hover na ZONA 60 de Acopiara (o desktop não pode mudar nada).
  await assentar(page, `${opcoes.base}/mapa?uf=CE&z=6`)
  await esperarZonas(page)
  await page.waitForTimeout(1200)
  const zona = await pontosDaFeature(page, {
    camadas: CAMADAS_ZONA,
    municipio: ZONA_ALVO.municipio,
    zona: ZONA_ALVO.zona,
  })
  tela.pontosZona = zona.pontos
  if (zona.erro || !zona.pontos.length) {
    falhas.push(`desktop: não achei a zona ${ZONA_ALVO.zona} de ${ZONA_ALVO.municipio} (${zona.erro})`)
  } else {
    await pairar(page, zona.pontos[0])
  }
  const hoverZona = await medirTooltips(page)
  tela.tooltipsHoverZona = hoverZona
  const arqHover = path.join(opcoes.out, `${opcoes.prefix}_desktop_1440x900_hover_zona.png`)
  await page.screenshot({ path: arqHover })
  tela.prints.push(arqHover)
  if (hoverZona.total !== 1) {
    falhas.push(`desktop: hover na zona devia mostrar 1 caixa, mediu ${hoverZona.total}`)
  }
  if (hoverZona.total === 1 && !/ACOPIARA · zona 60/i.test(hoverZona.textos[0] || '')) {
    falhas.push(`desktop: texto da caixa da zona não confere ("${hoverZona.textos[0]}")`)
  }

  // hover na UF
  await assentar(page, `${opcoes.base}/mapa?z=4.2`)
  await page.waitForTimeout(800)
  const uf = await pontosDaFeature(page, { camadas: ['ufs-fill'], uf: 'CE' })
  tela.pontosUf = uf.pontos
  if (uf.erro || !uf.pontos.length) {
    falhas.push(`desktop: não achei o Ceará no macro (${uf.erro})`)
  } else {
    await pairar(page, uf.pontos[0])
  }
  const hoverUf = await medirTooltips(page)
  tela.tooltipsHoverUf = hoverUf
  const arqHoverUf = path.join(opcoes.out, `${opcoes.prefix}_desktop_1440x900_hover_uf.png`)
  await page.screenshot({ path: arqHoverUf })
  tela.prints.push(arqHoverUf)
  if (hoverUf.total !== 1) {
    falhas.push(`desktop: hover na UF devia mostrar 1 caixa, mediu ${hoverUf.total}`)
  }
  if (hoverUf.total === 1 && !/CE · Ceará/i.test(hoverUf.textos[0] || '')) {
    falhas.push(`desktop: texto da caixa da UF não confere ("${hoverUf.textos[0]}")`)
  }
  // sair da UF tira a caixa (mouseleave)
  await page.mouse.move(1430, 20)
  await page.waitForTimeout(500)
  tela.tooltipsForaDaUf = await medirTooltips(page)
  if (tela.tooltipsForaDaUf.total !== 0) {
    falhas.push(`desktop: caixa ficou presa ao sair da UF (${tela.tooltipsForaDaUf.total})`)
  }

  // hover no MUNICÍPIO
  await assentar(page, `${opcoes.base}/mapa?uf=CE&m=${ZONA_ALVO.cdTse}&z=8.6`)
  await esperarMunicipios(page)
  await page.waitForTimeout(1800)
  const municipios = await pontosDaFeature(page, {
    camadas: ['municipios-fill'],
    qualquerMunicipio: true,
  })
  tela.pontosMunicipio = municipios.pontos
  tela.municipioAlvo = municipios.props?.[0]
    ? { nome: municipios.props[0].nome, codarea: municipios.props[0].codarea }
    : null
  if (municipios.erro || !municipios.pontos.length) {
    falhas.push(`desktop: não achei município para pairar (${municipios.erro})`)
  } else {
    await pairar(page, municipios.pontos[0])
  }
  const hoverMunicipio = await medirTooltips(page)
  tela.tooltipsHoverMunicipio = hoverMunicipio
  if (hoverMunicipio.total !== 1) {
    falhas.push(`desktop: hover no município devia mostrar 1 caixa, mediu ${hoverMunicipio.total}`)
  }
  const arqHoverMun = path.join(opcoes.out, `${opcoes.prefix}_desktop_1440x900_hover_municipio.png`)
  await page.screenshot({ path: arqHoverMun })
  tela.prints.push(arqHoverMun)

  // hover no LOCAL
  await assentar(page, `${opcoes.base}/mapa?uf=CE&m=${CD_TSE_FORTALEZA}&z=11`)
  await page.waitForTimeout(3000)
  const local = await pontosDaFeature(page, { camadas: CAMADAS_LOCAL, local: true })
  tela.pontosLocal = local.pontos
  if (local.erro || !local.pontos.length) {
    falhas.push(`desktop: não achei local de votação (${local.erro})`)
  } else {
    await pairar(page, local.pontos[0])
  }
  const hoverLocal = await medirTooltips(page)
  tela.tooltipsHoverLocal = hoverLocal
  if (hoverLocal.total !== 1) {
    falhas.push(`desktop: hover no local devia mostrar 1 caixa, mediu ${hoverLocal.total}`)
  }
  const arqHoverLocal = path.join(opcoes.out, `${opcoes.prefix}_desktop_1440x900_hover_local.png`)
  await page.screenshot({ path: arqHoverLocal })
  tela.prints.push(arqHoverLocal)

  const estadoFinal = await medirEstado(page)
  tela.midia = estadoFinal.midia
  tela.scroll = estadoFinal.scroll
  if (!estadoFinal.scroll.iguais) {
    falhas.push(`desktop: scroll horizontal (sw=${estadoFinal.scroll.sw} cw=${estadoFinal.scroll.cw})`)
  }
  tela.console = filtroConsole(registro.console)
  if (tela.console.erros.length) {
    falhas.push(`desktop: console/HTTP — ${tela.console.erros.slice(0, 3).join(' | ')}`)
  }
  await contexto.close()
  return tela
}

async function principal() {
  const opcoes = lerArgumentos(process.argv.slice(2))
  await mkdir(opcoes.out, { recursive: true })

  const navegador = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
    ],
  })

  const relatorio = {
    base: opcoes.base,
    quando: new Date().toISOString(),
    zona: ZONA_ALVO,
    celular: {},
    desktop: null,
    falhas: [],
  }
  const falhas = relatorio.falhas

  for (const vp of VIEWPORTS_MOBILE) {
    relatorio.celular[vp.nome] = await cenarioCelular(navegador, opcoes, vp, falhas)
  }
  relatorio.desktop = await cenarioDesktop(navegador, opcoes, falhas)
  relatorio.ok = falhas.length === 0
  relatorio.gerado = new Date().toISOString()

  await navegador.close()

  const arq = path.join(opcoes.out, `${opcoes.prefix}_relatorio.json`)
  await writeFile(arq, `${JSON.stringify(relatorio, null, 2)}\n`)

  const linha = (rotulo, valor) => console.log(`${rotulo}: ${valor}`)
  for (const nome of Object.keys(relatorio.celular)) {
    const t = relatorio.celular[nome]
    const topoZona = t.topoNoPontoTocado
    linha(
      `celular ${nome} topo do pixel tocado`,
      topoZona
        ? `${topoZona.camada} ${topoZona.props?.municipio}/${topoZona.props?.zona} (dom=${topoZona.dom})`
        : 'null',
    )
    linha(`celular ${nome} tap zona .uf-tooltip-popup (máx)`, t.tooltipsDepoisDeTocarZona?.total)
    linha(`celular ${nome} tap zona .uf-tooltip-popup (final)`, t.tooltipsDepoisDeTocarZona?.ultimaMedida?.total)
    linha(`celular ${nome} tap UF .uf-tooltip-popup`, t.tooltipsDepoisDeTocarUf?.total)
    linha(`celular ${nome} tap município .uf-tooltip-popup`, t.tooltipsDepoisDeTocarMunicipio?.total)
    linha(`celular ${nome} tap local .uf-tooltip-popup`, t.tooltipsDepoisDeTocarLocal?.total)
    linha(
      `celular ${nome} seleção (uf / município / local)`,
      `${t.estadoDepoisDeTocarUf?.botaoDetalhes?.sigla ?? 'null'} / ` +
        `${t.estadoDepoisDeTocarMunicipio?.sheet?.titulo ?? 'null'} / ` +
        `${t.estadoDepoisDeTocarLocal?.sheet?.kicker ?? 'null'}`,
    )
    linha(
      `celular ${nome} scrollWidth==clientWidth`,
      `${t.estadoDepoisDeTocarZona?.scroll?.sw}==${t.estadoDepoisDeTocarZona?.scroll?.cw}`,
    )
  }
  const d = relatorio.desktop
  linha('desktop hover zona .uf-tooltip-popup', `${d.tooltipsHoverZona.total} (${d.tooltipsHoverZona.textos[0] || '-'})`)
  linha('desktop hover UF .uf-tooltip-popup', `${d.tooltipsHoverUf.total} (${d.tooltipsHoverUf.textos[0] || '-'})`)
  linha('desktop hover município .uf-tooltip-popup', `${d.tooltipsHoverMunicipio.total} (${d.tooltipsHoverMunicipio.textos[0] || '-'})`)
  linha('desktop hover local .uf-tooltip-popup', `${d.tooltipsHoverLocal.total} (${d.tooltipsHoverLocal.textos[0] || '-'})`)
  linha('desktop sair da UF .uf-tooltip-popup', d.tooltipsForaDaUf.total)
  linha('relatorio', arq)
  if (falhas.length) {
    console.log(`FALHAS (${falhas.length}):`)
    for (const f of falhas) console.log(`  - ${f}`)
    return 1
  }
  console.log('OK: 0 falhas')
  return 0
}

principal()
  .then((codigo) => process.exit(codigo))
  .catch((erro) => {
    console.error('prova falhou ao rodar:', erro)
    process.exit(1)
  })
