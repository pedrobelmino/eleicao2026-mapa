import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import {
  CARTO_POSITRON,
  CORES_PARTIDO,
  COR_NEUTRA,
  COR_CONCRETO,
  EXPRESSAO_COR,
  EXPRESSAO_COR_UF,
  EXPRESSAO_COR_UF_REPLAY,
  EXPRESSAO_COR_MARGEM,
  EXPRESSAO_CALOR_MUNICIPIO,
  COR_VIRA_2022,
  TRACEJADO_VIRA_2022,
  TRANSICAO_COR_UF,
  ZOOM_BARRA_ZONA,
  ZOOM_BARRA_ZONA_FIM,
  FATOR_ALTURA_BARRA_CIDADE,
  ZOOM_LOCAL,
  ZOOM_MUNICIPIO,
  ZOOM_ROTULO_APP,
  ZOOM_ZONA,
  fonteDeRotuloPorZoom,
  nivelPorZoom,
} from '../mapa.js'
import {
  LIMITE_PREDIOS,
  construirPredios,
  construirUrnas,
  pontosDosLocais,
  prepararZonas,
} from '../cidade.js'
import { instalarControleDeMouse } from '../controle_mouse.js'
import { numero, percentual, pontos } from '../format.js'

const FONTE = 'ufs'
const LAYER_FILL = 'ufs-fill'
const LAYER_LINE = 'ufs-line'
const LAYER_HOVER = 'ufs-hover'
const LAYER_SELECTED = 'ufs-selected'

const FONTE_MUNICIPIOS = 'municipios'
const FONTE_ZONAS = 'zonas'
// Barra de composição da zona: 4 extrusões empilhadas, na ordem em que sobem
// (Lula na base, não apurado no topo). Cada uma tem base e altura acumuladas —
// a soma dos 4 segmentos é 100% dos votos válidos, então o topo da quarta
// coincide com a altura total da zona.
const LAYER_ZONAS_LULA = 'zonas-prisma-lula'
const LAYER_ZONAS_FLAVIO = 'zonas-prisma-flavio'
const LAYER_ZONAS_OUTROS = 'zonas-prisma-outros'
const LAYER_ZONAS_NAO_APURADO = 'zonas-prisma-nao-apurado'
const LAYERS_ZONAS = [
  LAYER_ZONAS_LULA,
  LAYER_ZONAS_FLAVIO,
  LAYER_ZONAS_OUTROS,
  LAYER_ZONAS_NAO_APURADO,
]

// As mesmas 4 fatias da barra de composição, desenhadas no losango de cidade
// (centroide da zona) em vez do polígono inteiro.
const LAYER_ZONAS_BARRA_LULA = 'zonas-barra-lula'
const LAYER_ZONAS_BARRA_FLAVIO = 'zonas-barra-flavio'
const LAYER_ZONAS_BARRA_OUTROS = 'zonas-barra-outros'
const LAYER_ZONAS_BARRA_NAO_APURADO = 'zonas-barra-nao-apurado'
const LAYERS_ZONAS_BARRA = [
  LAYER_ZONAS_BARRA_LULA,
  LAYER_ZONAS_BARRA_FLAVIO,
  LAYER_ZONAS_BARRA_OUTROS,
  LAYER_ZONAS_BARRA_NAO_APURADO,
]

// O mesmo empilhamento, agora no losango ESTREITO do nível de cidade. O largo
// só é legível na aproximação; perto da cidade ele fica enorme, então o par
// minzoom/maxzoom troca a geometria em vez de tentar corrigir a largura com
// uma expressão de zoom (proibida em fill-extrusion-height/base).
const LAYER_ZONAS_BARRA_FINA_LULA = 'zonas-barra-fina-lula'
const LAYER_ZONAS_BARRA_FINA_FLAVIO = 'zonas-barra-fina-flavio'
const LAYER_ZONAS_BARRA_FINA_OUTROS = 'zonas-barra-fina-outros'
const LAYER_ZONAS_BARRA_FINA_NAO_APURADO = 'zonas-barra-fina-nao-apurado'
const LAYERS_ZONAS_BARRA_FINA = [
  LAYER_ZONAS_BARRA_FINA_LULA,
  LAYER_ZONAS_BARRA_FINA_FLAVIO,
  LAYER_ZONAS_BARRA_FINA_OUTROS,
  LAYER_ZONAS_BARRA_FINA_NAO_APURADO,
]

const LAYER_MUN_FILL = 'municipios-fill'
const LAYER_MUN_LINE = 'municipios-line'
const LAYER_MUN_LABELS = 'municipios-labels'
// Item 6 — "de onde está ganhando" no município: o calor da vantagem e o
// tracejado de quem virou em relação a 2022. As duas nascem invisíveis e só
// aparecem com o botão MARGEM ligado.
const LAYER_MUN_MARGEM = 'municipios-margem'
const LAYER_MUN_VIRA = 'municipios-vira'

const FONTE_LOCAIS = 'locais'
const FONTE_LOCAIS_PONTOS = 'locais-pontos'
const LAYER_LOCAL_PRISMA = 'locais-prisma'
// Segmento de concreto no topo do prédio: a fração de seções ainda não
// apuradas. Só existe no 2º turno ao vivo / modo demo — na apuração encerrada
// a expressão filtra tudo fora (altura_concreto_m = 0).
const LAYER_LOCAL_CONCRETO = 'locais-concreto'
const LAYER_LOCAL_CLUSTER = 'locais-cluster'
const LAYER_LOCAL_CLUSTER_COUNT = 'locais-cluster-count'
const LAYER_LOCAL_PONTO = 'locais-ponto'
const LAYER_LOCAL_HIT = 'locais-hit'
const LAYER_LOCAL_SELECIONADO = 'locais-selecionado'

// Urnas do local selecionado: blocos sobre a laje do prédio (uma seção = uma
// urna) e a placa que sustenta a grade.
const FONTE_URNAS = 'urnas'
const LAYER_URNA_PLACA = 'urnas-placa'
const LAYER_URNA_BLOCO = 'urnas-bloco'

// O nosso rótulo de município (LAYER_MUN_LABELS) entra em ZOOM_ROTULO_APP,
// desenhado por cima dos prismas — e é a ÚNICA fonte de nome de lugar a partir
// dali (o basemap é desligado por regerirRotulosBase). Antes desse zoom quem
// desenha é o basemap, porque o nosso rótulo ainda não existe. A régua mora em
// mapa.js para o mapa e a prova lerem o MESMO número.
const ZOOM_ROTULO_MUNICIPIO = ZOOM_ROTULO_APP

// Acima disto o município tem locais demais para desenhar prédio por local; a
// camada cai para os pontos/ícones 2D (o raio continua codificando os votos).
// O limite vive em cidade.js (LIMITE_PREDIOS) para a prova poder medi-lo.

// Cores dos 4 segmentos empilhados da barra de composição da zona. A ordem é
// a de empilhamento, de baixo para cima: Lula (vermelho) -> Flávio (azul) ->
// outros candidatos -> não apurado (concreto).
const COR_SEGMENTO_LULA = CORES_PARTIDO.PT
const COR_SEGMENTO_FLAVIO = CORES_PARTIDO.PL
const COR_SEGMENTO_OUTROS = '#6b7280'
const COR_SEGMENTO_NAO_APURADO = '#b8b3aa'


const OPACIDADE_UFS_COM_DETALHE = [
  'interpolate',
  ['linear'],
  ['zoom'],
  4.6,
  0.85,
  5.8,
  0.06,
]

// As colunas de área saem enquanto a barra de cidade entra em 7.4; a soma das
// duas opacidades nunca cai a zero, então não há pulo. A camada de área só é
// cortada em 8.6 (maxzoom), mesmo com opacidade 0 em 8.2.
const OPACIDADE_PRISMAS = [
  'interpolate',
  ['linear'],
  ['zoom'],
  5.0,
  0,
  6.2,
  0.9,
  7.0,
  0.9,
  7.6,
  0.35,
  8.2,
  0,
]

// Barra LARGA: entra na aproximação e sai quando a fina assume. O pico de
// 0.96 é para o segmento vermelho de Lula não se dissolver no fill vermelho do
// município.
const OPACIDADE_BARRAS_CIDADE = [
  'interpolate',
  ['linear'],
  ['zoom'],
  ZOOM_BARRA_ZONA, 0,
  8.0, 0.96,
  9.3, 0.96,
  9.9, 0,
]

// Barra FINA: nível de cidade; sai em 12.2 para o nível local ficar limpo. O
// pico de 0.96 é para o segmento vermelho de Lula não se dissolver no fill
// vermelho do município.
const OPACIDADE_BARRAS_FINAS = [
  'interpolate',
  ['linear'],
  ['zoom'],
  9.3, 0,
  9.8, 0.96,
  11.4, 0.96,
  ZOOM_BARRA_ZONA_FIM, 0,
]

// Fator de entrada/saída das colunas por zoom: 0 abaixo de 5.0 (a camada ainda
// não está visível), 1 entre 6.2 e 7.2, 0 em 8.2 (antes dos rótulos de
// município, para nenhum nome cair atrás de uma coluna).
//
// ATENÇÃO (bug de 22/10): esta escala NÃO pode ser embutida em
// `fill-extrusion-height`/`fill-extrusion-base` — o MapLibre proíbe expressão de
// `zoom` dentro de propriedade de dado e derrubava o mapa com
// "layers.zonas-prisma-*/paint/fill-extrusion-height: 'zoom' expression may only
// be used as input to a top-level expression". O sumiço das colunas por zoom é
// feito bloqueando a camada (ver aplicarEscalaAlturaPorZoom, que usa setFilter
// ou minzoom/maxzoom), nunca multiplicando a altura por esta escala.
const ESCALA_ALTURA = [
  'interpolate',
  ['linear'],
  ['zoom'],
  5.0,
  0,
  6.2,
  1,
  7.2,
  1,
  8.2,
  0,
]

// Altura de UM segmento da barra = altura total da zona (proporcional aos votos
// válidos, com piso mínimo já calculado no backend) × o percentual do segmento.
// SEM multiplicar por ESCALA_ALTURA: expressão de `zoom` não é aceita dentro de
// fill-extrusion-height/base (ver comentário acima).
function alturaDoSegmento(campo) {
  return [
    '*',
    ['coalesce', ['get', 'altura_m'], 0],
    ['/', ['coalesce', ['get', campo], 0], 100],
  ]
}

// Empilhamento: a base de cada segmento é o topo do anterior. Como os 4
// segmentos somam 100% dos válidos, o topo do concreto é a altura total.
const ALTURA_LULA = alturaDoSegmento('bar_lula')
const BASE_FLAVIO = ALTURA_LULA
const ALTURA_FLAVIO = ['+', BASE_FLAVIO, alturaDoSegmento('bar_flavio')]
const BASE_OUTROS = ALTURA_FLAVIO
const ALTURA_OUTROS = ['+', BASE_OUTROS, alturaDoSegmento('bar_outros')]
const BASE_NAO_APURADO = ALTURA_OUTROS
const ALTURA_NAO_APURADO = ['+', BASE_NAO_APURADO, alturaDoSegmento('bar_nao_apurado')]

// Versão em escala de cidade da MESMA barra: cada segmento é multiplicado pelo
// FATOR_ALTURA_BARRA_CIDADE (nunca por zoom — expressão de zoom não é aceita
// dentro de fill-extrusion-height/base). O empilhamento é idêntico ao da área.
function alturaDaBarraCidade(campo) {
  return ['*', alturaDoSegmento(campo), FATOR_ALTURA_BARRA_CIDADE]
}
const CIDADE_ALTURA_LULA = alturaDaBarraCidade('bar_lula')
const CIDADE_BASE_FLAVIO = CIDADE_ALTURA_LULA
const CIDADE_ALTURA_FLAVIO = ['+', CIDADE_BASE_FLAVIO, alturaDaBarraCidade('bar_flavio')]
const CIDADE_BASE_OUTROS = CIDADE_ALTURA_FLAVIO
const CIDADE_ALTURA_OUTROS = ['+', CIDADE_BASE_OUTROS, alturaDaBarraCidade('bar_outros')]
const CIDADE_BASE_NAO_APURADO = CIDADE_ALTURA_OUTROS
const CIDADE_ALTURA_NAO_APURADO = ['+', CIDADE_BASE_NAO_APURADO, alturaDaBarraCidade('bar_nao_apurado')]


const OPACIDADE_MUNICIPIOS = [
  'interpolate',
  ['linear'],
  ['zoom'],
  6.6,
  0,
  7.4,
  0.82,
]

const OPACIDADE_MUNICIPIOS_LINHA = [
  'interpolate',
  ['linear'],
  ['zoom'],
  6.6,
  0,
  7.4,
  0.9,
]

// Cor do PRÉDIO = partido do candidato que lidera o local (regra do item 10).
// O que falta apurar não entra na cor: sobe como segmento de concreto no topo
// (LAYER_LOCAL_CONCRETO), igual à barra de composição da zona.
const COR_PREDIO = [
  'match',
  ['get', 'partido_lider'],
  'PL',
  CORES_PARTIDO.PL,
  'PT',
  CORES_PARTIDO.PT,
  COR_NEUTRA,
]

// Cor de cada urna = partido que lidera aquela seção.
const COR_URNA = COR_PREDIO

const CORES_ICONE = {
  PL: CORES_PARTIDO.PL,
  PT: CORES_PARTIDO.PT,
  NEUTRO: COR_NEUTRA,
}

const BUCKETS_ICONE = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

// Ícone do local: disco branco, anel cinza e arco colorido do topo em sentido
// horário proporcional ao percentual apurado. A 100% vira disco sólido com
// borda branca.
function criarCanvasIconeLocal(bucket, cor) {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const contexto = canvas.getContext('2d')
  if (!contexto) return canvas

  const centro = 32
  const raio = 28

  contexto.beginPath()
  contexto.arc(centro, centro, raio, 0, Math.PI * 2)
  contexto.fillStyle = '#ffffff'
  contexto.fill()

  if (bucket >= 100) {
    contexto.beginPath()
    contexto.arc(centro, centro, raio - 2, 0, Math.PI * 2)
    contexto.fillStyle = cor
    contexto.fill()
    contexto.lineWidth = 4
    contexto.strokeStyle = '#ffffff'
    contexto.stroke()
    return canvas
  }

  const raioAnel = 23
  contexto.beginPath()
  contexto.arc(centro, centro, raioAnel, 0, Math.PI * 2)
  contexto.lineWidth = 9
  contexto.strokeStyle = '#c9ced6'
  contexto.stroke()

  if (bucket > 0) {
    const inicio = -Math.PI / 2
    contexto.beginPath()
    contexto.arc(
      centro,
      centro,
      raioAnel,
      inicio,
      inicio + 2 * Math.PI * (Math.min(bucket, 100) / 100),
      false,
    )
    contexto.lineWidth = 9
    contexto.strokeStyle = cor
    contexto.stroke()
  }

  return canvas
}

// addImage no load, no styledata e no idle, só para os ids que ainda não
// existem no estilo. O styledata pode trocar o estilo inteiro (basemap), então
// re-registrar é barato e evita ícone faltando.
let avisouFalhaIcone = false

export function registrarIconesLocais(mapa) {
  if (!mapa) return
  if (typeof mapa.isStyleLoaded === 'function' && !mapa.isStyleLoaded()) return

  for (const bucket of BUCKETS_ICONE) {
    for (const [partido, cor] of Object.entries(CORES_ICONE)) {
      const id = `local-${bucket}-${partido}`
      if (typeof mapa.hasImage === 'function' && mapa.hasImage(id)) continue
      try {
        // O MapLibre 5.24 NÃO aceita HTMLCanvasElement em addImage: ele valida
        // width*height*4 e o canvas falha com "mismatched image size. expected:
        // 0 but got: 16384" — o ícone nunca era registrado e a camada
        // locais-ponto não desenhava nada. ImageData (mesmas pixels) passa.
        const canvas = criarCanvasIconeLocal(bucket, cor)
        const contexto = canvas.getContext('2d')
        mapa.addImage(
          id,
          contexto.getImageData(0, 0, canvas.width, canvas.height),
          { pixelRatio: 2 },
        )
      } catch (erro) {
        // Troca de estilo em andamento é esperada; qualquer outra falha tem que
        // aparecer uma vez no console em vez de sumir num catch vazio (foi assim
        // que o bug do addImage passou despercebido).
        if (!avisouFalhaIcone) {
          avisouFalhaIcone = true
          console.warn(
            'ícones de local não registrados:',
            erro?.message || erro,
          )
        }
      }
    }
  }
}

// O prédio do local nasce do chão logo depois do ZOOM_LOCAL. A altura NÃO pode
// depender do zoom dentro de fill-extrusion-height (expressão de zoom ali
// derrubava o mapa — ver REGRA-MOUSE-MAPA.txt): quem controla o aparecimento é
// o minzoom da camada + esta opacidade.
const OPACIDADE_LOCAL = [
  'interpolate',
  ['linear'],
  ['zoom'],
  ZOOM_LOCAL,
  0,
  ZOOM_LOCAL + 0.4,
  0.92,
]

// Topo do prédio do local escolhido, na MESMA escala de construirPredios: é a
// laje onde as urnas (seções) são apoiadas.
function alturaDoPredio(nrLocal, locais) {
  const lista = Array.isArray(locais) ? locais : []
  if (!lista.length) return 0
  const colecao = construirPredios(lista)
  const alvo = String(nrLocal)
  const feature = colecao.features.find(
    (item) => String(item.properties?.nr_local) === alvo,
  )
  return Number(feature?.properties?.altura_total_m) || 0
}

// Os pontos 2D vêm de cidade.js (pontosDosLocais): mesma fonte de verdade dos
// prédios, inclusive a escala de altura. É o que alimenta o cluster, os ícones
// de urna e o fallback quando o município tem locais demais para 3D.

function limitesDaGeometria(geometria) {
  if (!geometria?.coordinates) return null
  let oeste = Infinity
  let sul = Infinity
  let leste = -Infinity
  let norte = -Infinity

  function visitar(coordenadas) {
    if (!Array.isArray(coordenadas)) return
    if (typeof coordenadas[0] === 'number' && typeof coordenadas[1] === 'number') {
      const [lon, lat] = coordenadas
      if (lon < oeste) oeste = lon
      if (lat < sul) sul = lat
      if (lon > leste) leste = lon
      if (lat > norte) norte = lat
      return
    }
    for (const item of coordenadas) visitar(item)
  }

  visitar(geometria.coordinates)
  if (!Number.isFinite(oeste)) return null
  return [
    [oeste, sul],
    [leste, norte],
  ]
}

function limitesDaColecao(geojson) {
  let oeste = Infinity
  let sul = Infinity
  let leste = -Infinity
  let norte = -Infinity

  for (const feature of geojson?.features || []) {
    const caixa = limitesDaGeometria(feature.geometry)
    if (!caixa) continue
    if (caixa[0][0] < oeste) oeste = caixa[0][0]
    if (caixa[0][1] < sul) sul = caixa[0][1]
    if (caixa[1][0] > leste) leste = caixa[1][0]
    if (caixa[1][1] > norte) norte = caixa[1][1]
  }

  if (!Number.isFinite(oeste)) return null
  return [
    [oeste, sul],
    [leste, norte],
  ]
}

function paddingDoMapa() {
  if (typeof window !== 'undefined' && window.innerWidth <= 820) {
    // O padding de baixo é o espaço que o sheet cobre DENTRO do canvas. Antes
    // era 72% de innerHeight, conta que ignora cabeçalho/rodapé e estourava a
    // altura do canvas em telas curtas (390x700): o MapLibre avisava "Map
    // cannot fit within canvas" e o enquadramento da UF saía errado.
    const estagio = document.querySelector('.map-stage')
    const altura = estagio?.clientHeight || window.innerHeight
    const topo = 52
    // Reserva 48% do canvas para o sheet (mesma fração do max-height do
    // .sheet-detalhe) e nunca a ponto de não sobrar faixa de mapa: com
    // topo + baixo >= altura o MapLibre não consegue enquadrar nada.
    const baixo = Math.max(
      40,
      Math.min(Math.round(altura * 0.48), altura - topo - 120),
    )
    return { top: topo, right: 24, bottom: baixo, left: 24 }
  }
  return { top: 64, right: 64, bottom: 64, left: 64 }
}

function preencherTooltipUf(elemento, propriedades) {
  elemento.replaceChildren()

  const titulo = document.createElement('strong')
  titulo.textContent = `${propriedades.uf} · ${propriedades.nome}`

  const lider = document.createElement('span')
  lider.textContent = `${propriedades.lider} (${propriedades.partido_lider || '—'})`

  const margem = document.createElement('span')
  margem.className = 'uf-tooltip-margem'
  margem.textContent = `margem ${pontos(propriedades.margem_pct)} pts · ${percentual(
    propriedades.lider_pct,
  )}`

  elemento.append(titulo, lider, margem)
}

function preencherTooltipZona(elemento, propriedades) {
  elemento.replaceChildren()

  const titulo = document.createElement('strong')
  titulo.textContent = `${propriedades.municipio || 'município'} · zona ${propriedades.zona}`

  const lider = document.createElement('span')
  lider.textContent = `${propriedades.lider} (${propriedades.partido_lider || '—'})`

  const margem = document.createElement('span')
  margem.className = 'uf-tooltip-margem'
  margem.textContent = `margem ${pontos(propriedades.margem_pct)} pts · ${percentual(
    propriedades.lider_pct,
  )}`

  const votos = document.createElement('span')
  votos.textContent = `${numero(propriedades.total)} votos · ${numero(
    propriedades.secoes,
  )} seções`

  elemento.append(titulo, lider, margem, votos)
}

function textoDaComparacao(margem) {
  if (!margem) return null
  const delta = margem.delta_pp_2022
  const temDelta = delta != null && Number.isFinite(Number(delta))
  const sinal = temDelta && Number(delta) > 0 ? '+' : ''
  const variacao = temDelta ? `${sinal}${pontos(delta)} pts desde 2022` : 'sem par em 2022'
  if (margem.virou_2022 === true) return `virou em relação a 2022 · ${variacao}`
  if (margem.virou_2022 === false) return `mesmo partido do líder em 2022 · ${variacao}`
  return variacao
}

// `margem` vem de /api/uf/{UF}/margens (por codarea) quando o modo MARGEM está
// ligado: aí o tooltip passa a mostrar a margem ABSOLUTA (votos) e a RELATIVA
// (pontos), que é o que o calor está pintando — e a comparação com 2022.
function preencherTooltipMunicipio(elemento, propriedades, margem) {
  elemento.replaceChildren()

  const titulo = document.createElement('strong')
  titulo.textContent = propriedades.nome || 'município'

  const lider = document.createElement('span')
  lider.textContent = `${propriedades.lider} (${propriedades.partido_lider || '—'})`

  const margemEl = document.createElement('span')
  margemEl.className = 'uf-tooltip-margem'
  margemEl.textContent = margem
    ? `margem ${numero(margem.margem_votos)} votos · ${pontos(margem.margem_pct)} pts`
    : `margem ${pontos(propriedades.margem_pct)} pts · ${percentual(propriedades.lider_pct)}`

  const votos = document.createElement('span')
  votos.textContent = `${numero(propriedades.vv)} válidos · ${numero(
    propriedades.total,
  )} votos`

  elemento.append(titulo, lider, margemEl, votos)

  const comparacao = textoDaComparacao(margem)
  if (comparacao) {
    const linha = document.createElement('span')
    linha.className = 'uf-tooltip-margem uf-tooltip-vira'
    linha.textContent = comparacao
    elemento.append(linha)
  }
}

function preencherTooltipLocal(elemento, propriedades) {
  elemento.replaceChildren()

  const titulo = document.createElement('strong')
  const grupo = Array.isArray(propriedades.nr_locais)
    ? propriedades.nr_locais.length
    : 0
  titulo.textContent =
    propriedades.agrupado && grupo > 1
      ? `local ${propriedades.nr_local ?? '—'} · grupo de ${grupo} locais`
      : `local ${propriedades.nr_local ?? '—'}`

  const lider = document.createElement('span')
  const pctLider = Number(propriedades.lider_pct)
  lider.textContent = `${propriedades.lider || '—'} (${propriedades.partido_lider || '—'})${
    Number.isFinite(pctLider) ? ` · ${percentual(pctLider)}` : ''
  }`

  const margem = document.createElement('span')
  margem.className = 'uf-tooltip-margem'
  margem.textContent = `margem ${pontos(propriedades.margem_pct)} pts`

  const apurado = document.createElement('span')
  const pctApurado = Number(propriedades.pct_apurado)
  apurado.className = 'uf-tooltip-margem'
  apurado.textContent = Number.isFinite(pctApurado)
    ? `${percentual(pctApurado, 1)} apurado · ${numero(
        propriedades.secoes_apuradas,
      )} de ${numero(propriedades.secoes_esperadas)} seções`
    : '—'

  const votos = document.createElement('span')
  votos.textContent = `${numero(propriedades.total)} votos · ${numero(
    propriedades.secao,
  )} seções`

  elemento.append(titulo, lider, margem, apurado, votos)
}

function featureDeDetalhe(evento, zoom) {
  const features = evento.features || []
  const municipio = features.find(
    (feature) => feature.layer?.id === LAYER_MUN_FILL,
  )
  const zona = features.find((feature) =>
    LAYERS_ZONAS.includes(feature.layer?.id),
  )

  if (zoom >= 6.6) {
    if (municipio) return municipio
    if (zoom < 8.4) return zona || null
    return null
  }
  if (zoom >= 4.6) return zona || municipio || null
  return null
}

function contarFonte(mapa, fonte) {
  try {
    return mapa.querySourceFeatures(fonte).length
  } catch {
    return 0
  }
}

function contarCamada(mapa, camada) {
  if (!mapa.getLayer(camada)) return 0
  try {
    return mapa.queryRenderedFeatures({ layers: [camada] }).length
  } catch {
    return 0
  }
}

function publicarDebug(mapa, locais, detalhe, municipioSelecionado) {
  let debug = {
    featuresUfs: 0,
    featuresMunicipios: 0,
    featuresZonas: 0,
    zonasBarras: 0,
    zonasBarrasFinas: 0,
    barrasDesenhadas: 0,
    featuresLocais: 0,
    featuresLocaisPontos: 0,
    predios: 0,
    prediosDesenhados: 0,
    prediosConcreto: 0,
    modoPredios: 'pontos',
    urnas: 0,
    urnasDesenhadas: 0,
    urnasColunas: 0,
    urnasLinhas: 0,
    tempoRenderMs: 0,
    clustersVisiveis: 0,
    featuresLocaisPrisma: 0,
    camadasLocais: 0,
    locaisNoMunicipio: 0,
    detalheAtivo: Boolean(detalhe),
    municipioSelecionado: municipioSelecionado
      ? String(municipioSelecionado.codarea ?? municipioSelecionado)
      : null,
    nivel: 0,
    zoom: 0,
    pitch: 0,
    centro: [0, 0],
  }
  if (!mapa) {
    window.__mapaDebug = debug
    return
  }
  const numero = (fn) => {
    try {
      return fn()
    } catch {
      return 0
    }
  }
  try {
    debug = {
      featuresUfs: numero(() => contarFonte(mapa, FONTE)),
      featuresMunicipios: numero(() => contarFonte(mapa, FONTE_MUNICIPIOS)),
      featuresZonas: numero(() => contarFonte(mapa, FONTE_ZONAS)),
      // Barras da última coleção preparada (áreas + os dois losangos na mesma
      // fonte): largas e finas somadas.
      zonasBarras:
        (metricasZonas.get(mapa)?.barras || 0) +
        (metricasZonas.get(mapa)?.barrasFinas || 0),
      zonasBarrasFinas: metricasZonas.get(mapa)?.barrasFinas || 0,
      barrasDesenhadas: numero(() =>
        [...LAYERS_ZONAS_BARRA, ...LAYERS_ZONAS_BARRA_FINA].reduce(
          (soma, camada) => soma + contarCamada(mapa, camada),
          0,
        ),
      ),
      featuresLocais: numero(() => contarFonte(mapa, FONTE_LOCAIS)),
      featuresLocaisPontos: numero(() => contarFonte(mapa, FONTE_LOCAIS_PONTOS)),
      // querySourceFeatures conta por tile e duplica prédio na divisa: a
      // quantidade confiável é a da última coleção construída.
      predios: metricasRender.get(mapa)?.quantidade || 0,
      prediosDesenhados: numero(() => contarCamada(mapa, LAYER_LOCAL_PRISMA)),
      prediosConcreto: numero(() => contarCamada(mapa, LAYER_LOCAL_CONCRETO)),
      modoPredios: deveDesenharPredios(
        mapa,
        Array.isArray(locais) ? locais.length : 0,
      )
        ? 'predios'
        : 'pontos',
      urnas: numero(() => contarFonte(mapa, FONTE_URNAS)),
      urnasDesenhadas: numero(() => contarCamada(mapa, LAYER_URNA_BLOCO)),
      urnasColunas: urnasDebug.get(mapa)?.colunas || 0,
      urnasLinhas: urnasDebug.get(mapa)?.linhas || 0,
      tempoRenderMs: metricasRender.get(mapa)?.ms || 0,
      clustersVisiveis: numero(() => contarCamada(mapa, LAYER_LOCAL_CLUSTER)),
      featuresLocaisPrisma: numero(() => contarFonte(mapa, FONTE_LOCAIS)),
      camadasLocais: numero(
        () =>
          [
            LAYER_LOCAL_PRISMA,
            LAYER_LOCAL_CONCRETO,
            LAYER_URNA_PLACA,
            LAYER_URNA_BLOCO,
            LAYER_LOCAL_CLUSTER,
            LAYER_LOCAL_CLUSTER_COUNT,
            LAYER_LOCAL_PONTO,
            LAYER_LOCAL_HIT,
            LAYER_LOCAL_SELECIONADO,
          ].filter((camada) => Boolean(mapa.getLayer(camada))).length,
      ),
      locaisNoMunicipio: Array.isArray(locais) ? locais.length : 0,
      detalheAtivo: Boolean(detalhe),
      municipioSelecionado: municipioSelecionado
        ? String(municipioSelecionado.codarea ?? municipioSelecionado)
        : null,
      nivel: numero(() => nivelPorZoom(mapa.getZoom())),
      zoom: numero(() => Number(mapa.getZoom().toFixed(2))),
      pitch: numero(() => Number(mapa.getPitch().toFixed(1))),
      centro: numero(() => {
        const centro = mapa.getCenter()
        return [
          Number(centro.lng.toFixed(3)),
          Number(centro.lat.toFixed(3)),
        ]
      }),
    }
  } catch {
    // Mantém os valores padrão (0) para os campos que falharem.
  }
  window.__mapaDebug = debug
}

// O prédio é o indicador do nível de cidade e fica visível do ZOOM_LOCAL até o
// maxZoom do mapa; quem controla a entrada/saída por zoom é o par minzoom/
// maxzoom da camada (nunca altura). Acima do limite de locais do município a
// camada inteira é escondida e o nível cai para os pontos/ícones 2D.
function atualizarVisibilidadePredios(mapa, quantidade) {
  if (!mapa) return
  const total = Number(quantidade) || 0
  const visivel = total > 0 && total <= limiteDePredios()
  for (const camada of [LAYER_LOCAL_PRISMA, LAYER_LOCAL_CONCRETO]) {
    if (!mapa.getLayer(camada)) continue
    mapa.setLayoutProperty(camada, 'visibility', visivel ? 'visible' : 'none')
  }
}

// Rótulos de lugar do BASEMAP (CARTO Positron). A regra é: UMA fonte de rótulo
// por faixa de zoom (ver fonteDeRotuloPorZoom em mapa.js). O nosso
// LAYER_MUN_LABELS é desenhado por cima dos prismas e entra em ZOOM_ROTULO_APP;
// a partir dali os símbolos de lugar do basemap são desligados por completo.
// Antes disso o basemap é a única fonte e fica visível.
//
// Enumeramos as camadas por `source-layer` + tipo `symbol` — NUNCA por id
// inventado. Medido em 23/10 no style do Positron: source `protomaps`,
// source-layer `places` (place_city_r6/r5, place_town, place_villages,
// place_hamlet, place_suburbs, place_state, place_country_*, place_*_dot_*).
const FONTE_LAYERS_ROTULO = /^(places?|place_label)$/

// Última decisão aplicada por instância de mapa ('app' | 'basemap'). O handler
// de `zoom` dispara a cada frame: sem este guarda seria um setLayoutProperty
// por frame, um por camada. Um style swap devolve as camadas do basemap ao
// padrão, então nesse evento a decisão é refeita à força (forcar: true).
const rotulosBaseAplicados = new WeakMap()

function regerirRotulosBase(mapa, { forcar = false } = {}) {
  if (!mapa || typeof mapa.getStyle !== 'function') return

  const fonte = fonteDeRotuloPorZoom(mapa.getZoom())
  if (!forcar && rotulosBaseAplicados.get(mapa) === fonte) return

  const estilo = mapa.getStyle()
  if (!estilo) return
  // [23/10/2026] `ufs-labels` (a sigla da UF) segue a MESMA régua de faixa e é
  // atualizada ANTES do guard de estado: sem isto ela ficava desenhada no zoom de
  // município e, como o município de São Paulo tem o mesmo nome da UF, o mapa
  // mostrava "SÃO PAULO" duas vezes. Não dá para fazer por expressão —
  // `layout.visibility` recusa zoom ("zoom expressions not supported") e o
  // `maxzoom` da camada não a tira do quadro (medido). O `forcar` do style swap
  // reaplica; sem camada ainda criada, a exceção é engolida e o próximo
  // load/styledata resolve.
  try {
    const alvo = fonte === 'basemap' ? 'visible' : 'none'
    if (mapa.getLayer && mapa.getLayer('ufs-labels') &&
        mapa.getLayoutProperty('ufs-labels', 'visibility') !== alvo) {
      mapa.setLayoutProperty('ufs-labels', 'visibility', alvo)
    }
  } catch {
    /* camada ainda não criada neste estilo */
  }

  if (!forcar && rotulosBaseAplicados.get(mapa) === fonte) return

  const visibilidade = fonte === 'basemap' ? 'visible' : 'none'

  for (const camada of estilo.layers || []) {
    if (camada.type !== 'symbol') continue
    if (!FONTE_LAYERS_ROTULO.test(String(camada['source-layer'] || ''))) continue
    try {
      if (mapa.getLayoutProperty(camada.id, 'visibility') === visibilidade) continue
      mapa.setLayoutProperty(camada.id, 'visibility', visibilidade)
    } catch {
      // Camada removida no meio do laço (style swap): a próxima passada, com
      // forcar, resolve. Estado não é gravado, então a decisão será refeita.
      return
    }
  }
  rotulosBaseAplicados.set(mapa, fonte)
}

function colecaoVazia() {
  return { type: 'FeatureCollection', features: [] }
}

// addLayer só é válido com o estilo pronto; se falhar, a intenção de reaplicar
// fica guardada para o próximo load/styledata. O warn traz o id da camada
// que faltou, em vez de engolir a exceção.
const camadasComAviso = new Set()
const fontesComAviso = new Set()

function adicionarCamada(mapa, definicao, aoPendente, antesDe) {
  if (mapa.getLayer(definicao.id)) return true
  try {
    if (antesDe && mapa.getLayer(antesDe)) mapa.addLayer(definicao, antesDe)
    else mapa.addLayer(definicao)
    return true
  } catch (erro) {
    // Um único aviso por camada: o retry é por evento (load/styledata), não
    // um laço de frames que encheria o console.
    if (!camadasComAviso.has(definicao.id)) {
      camadasComAviso.add(definicao.id)
      console.warn(
        `MapView: falha ao criar a camada "${definicao.id}"; nova tentativa no próximo load/styledata.`,
        erro,
      )
    }
    aoPendente?.()
    return false
  }
}

// addSource também depende do estilo montado. Mesmo tratamento da camada:
// falha vira aviso único + reaplicação agendada, nunca exceção solta no evento.
function adicionarFonte(mapa, id, definicao, aoPendente) {
  if (mapa.getSource(id)) return true
  try {
    mapa.addSource(id, definicao)
    return true
  } catch (erro) {
    if (!fontesComAviso.has(id)) {
      fontesComAviso.add(id)
      console.warn(
        `MapView: falha ao criar a fonte "${id}"; nova tentativa no próximo load/styledata.`,
        erro,
      )
    }
    aoPendente?.()
    return false
  }
}

// Estado mínimo que as funções de camada precisam e que vive fora do React:
// qual local está selecionado (para a grade de urnas reaparecer no load) e o
// tempo de render medido da última aplicação de locais.
const estadoLocal = { selecionado: null }
const metricasRender = new WeakMap()
// Quantidade de áreas/barras da última coleção preparada por mapa. O debug usa
// a contagem da coleção (não querySourceFeatures, que duplica na divisa).
const metricasZonas = new WeakMap()
// Último desenho de urnas por mapa (para o __mapaDebug e para a prova).
const urnasDebug = new WeakMap()

// Limite de prédios por município. O gancho window.__limitePredios existe para
// a prova conseguir forçar o caminho de fallback 2D (nenhum município real
// chega perto do limite: Fortaleza é o maior do país com 196 locais).
function limiteDePredios() {
  if (typeof window === 'undefined') return LIMITE_PREDIOS
  const bruto = Number(window.__limitePredios)
  if (Number.isFinite(bruto) && bruto > 0) return bruto
  return LIMITE_PREDIOS
}

// Decide se este município desenha prédio 3D ou cai nos pontos 2D: acima do
// limite (ou com window.__sem3D ligado por prova) a fonte 3D fica vazia e quem
// aparece são os ícones/clusters, que já existem.
function deveDesenharPredios(mapa, quantidade) {
  const total = Number(quantidade) || 0
  if (total <= 0) return false
  if (typeof window !== 'undefined' && window.__sem3D === true) return false
  return total <= limiteDePredios()
}

// Tempo entre setData dos prédios e o mapa ficar ocioso (frame desenhado). É a
// medida usada na prova de desempenho — fica em __mapaDebug.tempoRenderMs.
function medirTempoDeRender(mapa, inicio, quantidade) {
  if (!mapa || !inicio) return
  const registro = { ms: 0, quantidade, iniciadoEm: inicio }
  metricasRender.set(mapa, registro)

  let concluido = false
  const fim = () => {
    if (concluido) return
    concluido = true
    if (typeof mapa.off === 'function') mapa.off('idle', fim)
    registro.ms = Number((performance.now() - inicio).toFixed(1))
    if (typeof window !== 'undefined' && window.__mapaDebug) {
      window.__mapaDebug.tempoRenderMs = registro.ms
    }
  }

  if (typeof mapa.once === 'function') mapa.once('idle', fim)
  if (typeof mapa.triggerRepaint === 'function') mapa.triggerRepaint()
  // Em GPU de software o idle pode demorar: a prova não pode ficar pendurada.
  setTimeout(fim, 10000)
}

// Urnas do local selecionado: uma seção = um bloco, em grade sobre a laje do
// prédio (base = altura do prédio + folga). Sem seleção a fonte fica vazia e as
// camadas não desenham nada.
function aplicarUrnas(mapa, localSelecionado, locais, aoPendente) {
  if (!mapa || !mapa.getStyle || !mapa.getStyle()) {
    aoPendente?.()
    return { urnas: 0, colunas: 0, linhas: 0, ladoM: 0 }
  }

  const lista = Array.isArray(locais) ? locais : []
  const nr =
    localSelecionado == null
      ? NaN
      : Number(localSelecionado.nr_local ?? localSelecionado)
  const local = Number.isFinite(nr)
    ? lista.find((item) => Number(item.nr_local) === nr) || null
    : null

  let features = []
  let desenho = { urnas: 0, colunas: 0, linhas: 0, ladoM: 0 }
  let baseM = 0

  if (local) {
    // A grade sobe sobre o prédio: mesma escala de altura de construirPredios.
    baseM = alturaDoPredio(nr, lista) + 6
    const urnas = construirUrnas(local, { baseM, ladoCelulaM: 45, vaoM: 10 })
    features = [
      ...urnas.placa.features.map((feature) => ({
        ...feature,
        properties: { ...feature.properties, tipo: 'placa', base_m: baseM },
      })),
      ...urnas.colecao.features.map((feature) => ({
        ...feature,
        properties: { ...feature.properties, tipo: 'urna' },
      })),
    ]
    desenho = {
      urnas: urnas.colecao.features.length,
      colunas: urnas.colunas,
      linhas: urnas.linhas,
      ladoM: Number(urnas.ladoM.toFixed(1)),
      base_m: Number(baseM.toFixed(1)),
    }
  }

  const colecao = { type: 'FeatureCollection', features }
  const fonte = mapa.getSource(FONTE_URNAS)
  if (fonte) fonte.setData(colecao)
  else {
    adicionarFonte(
      mapa,
      FONTE_URNAS,
      { type: 'geojson', data: colecao },
      aoPendente,
    )
  }

  adicionarCamada(
    mapa,
    {
      id: LAYER_URNA_PLACA,
      type: 'fill-extrusion',
      source: FONTE_URNAS,
      minzoom: 10,
      filter: ['==', ['get', 'tipo'], 'placa'],
      paint: {
        'fill-extrusion-color': '#2b3440',
        'fill-extrusion-height': ['+', ['get', 'base_m'], 3],
        'fill-extrusion-base': ['get', 'base_m'],
        'fill-extrusion-opacity': 0.72,
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_URNA_BLOCO,
      type: 'fill-extrusion',
      source: FONTE_URNAS,
      minzoom: 10,
      filter: ['==', ['get', 'tipo'], 'urna'],
      paint: {
        'fill-extrusion-color': COR_URNA,
        'fill-extrusion-height': ['+', ['get', 'base_m'], ['get', 'altura_m']],
        'fill-extrusion-base': ['get', 'base_m'],
        'fill-extrusion-opacity': 0.97,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    aoPendente,
  )

  return desenho
}

function removerDetalhe(mapa) {
  for (const camada of [
    LAYER_LOCAL_SELECIONADO,
    LAYER_LOCAL_HIT,
    LAYER_LOCAL_PONTO,
    LAYER_LOCAL_CLUSTER_COUNT,
    LAYER_LOCAL_CLUSTER,
    LAYER_LOCAL_CONCRETO,
    LAYER_LOCAL_PRISMA,
    // Urnas do local: nenhuma camada pode ficar órfã sobre a fonte removida.
    LAYER_URNA_BLOCO,
    LAYER_URNA_PLACA,
    LAYER_MUN_LABELS,
    LAYER_MUN_LINE,
    LAYER_MUN_FILL,
    // As 4 camadas de área e as 8 de barra (larga + fina): nenhuma pode ficar
    // órfã sobre uma fonte removida.
    ...LAYERS_ZONAS,
    ...LAYERS_ZONAS_BARRA,
    ...LAYERS_ZONAS_BARRA_FINA,
  ]) {
    if (mapa.getLayer(camada)) mapa.removeLayer(camada)
  }
  for (const fonte of [
    FONTE_URNAS,
    FONTE_LOCAIS_PONTOS,
    FONTE_LOCAIS,
    FONTE_ZONAS,
    FONTE_MUNICIPIOS,
  ]) {
    if (mapa.getSource(fonte)) mapa.removeSource(fonte)
  }
}

function aplicarDetalhe(
  mapa,
  detalhe,
  locais,
  aoPendente,
  temSelecao,
  municipioSelecionado,
) {
  if (!mapa) return
  // O gate certo para addSource/addLayer é a existência do estilo, não o
  // isStyleLoaded(): com o basemap CARTO abortando requests o estilo fica
  // eternamente "não carregado", mas já aceita fontes e camadas.
  if (!mapa.getStyle || !mapa.getStyle()) {
    aoPendente?.()
    return
  }

  if (!detalhe) {
    // Durante o recarregamento do detalhe o município continua selecionado e o
    // que está na tela é a última versão válida. Nunca apagar as camadas nesse
    // intervalo: o load/styledata pode reaplicar com detalhe=null antes de os
    // novos dados chegarem.
    if (!temSelecao) {
      removerDetalhe(mapa)
      publicarDebug(mapa, locais, null, null)
    } else {
      publicarDebug(mapa, locais, null, municipioSelecionado)
    }
    return
  }

  const municipiosGeo = detalhe.municipiosGeo || colecaoVazia()
  // A mesma fonte carrega as duas formas da zona: o polígono original
  // (forma: 'area', faixa de estado) e o losango no centroide (forma: 'barra',
  // faixa de cidade). Assim a fonte 'zonas' continua carregada acima de 8.2.
  const zonas = prepararZonas(detalhe.zonasGeo)
  const zonasGeo = zonas.colecao
  metricasZonas.set(mapa, {
    areas: zonas.areas,
    barras: zonas.barras,
    barrasFinas: zonas.barrasFinas,
  })

  const fonteMunicipios = mapa.getSource(FONTE_MUNICIPIOS)
  if (fonteMunicipios) fonteMunicipios.setData(municipiosGeo)
  else {
    adicionarFonte(
      mapa,
      FONTE_MUNICIPIOS,
      {
        type: 'geojson',
        data: municipiosGeo,
        promoteId: 'codarea',
      },
      aoPendente,
    )
  }

  const fonteZonas = mapa.getSource(FONTE_ZONAS)
  if (fonteZonas) fonteZonas.setData(zonasGeo)
  else {
    adicionarFonte(
      mapa,
      FONTE_ZONAS,
      {
        type: 'geojson',
        data: zonasGeo,
      },
      aoPendente,
    )
  }

  // A ordem importa: prismas abaixo do preenchimento municipal e os rótulos
  // por cima de todas as camadas de detalhe.
  //
  // Quatro extrusões empilhadas por zona (barra de composição): a base de cada
  // uma é o topo da anterior. Nenhuma delas decide "quem ganhou" — a separação
  // azul/vermelho mostra a fatia de cada candidato e o concreto mostra o que
  // falta apurar.
  for (const definicao of [
    {
      id: LAYER_ZONAS_LULA,
      cor: COR_SEGMENTO_LULA,
      base: 0,
      altura: ALTURA_LULA,
    },
    {
      id: LAYER_ZONAS_FLAVIO,
      cor: COR_SEGMENTO_FLAVIO,
      base: BASE_FLAVIO,
      altura: ALTURA_FLAVIO,
    },
    {
      id: LAYER_ZONAS_OUTROS,
      cor: COR_SEGMENTO_OUTROS,
      base: BASE_OUTROS,
      altura: ALTURA_OUTROS,
    },
    {
      id: LAYER_ZONAS_NAO_APURADO,
      cor: COR_SEGMENTO_NAO_APURADO,
      base: BASE_NAO_APURADO,
      altura: ALTURA_NAO_APURADO,
    },
  ]) {
    adicionarCamada(
      mapa,
      {
        id: definicao.id,
        type: 'fill-extrusion',
        source: FONTE_ZONAS,
        minzoom: 4.6,
        // A barra de cidade (7.4) assume enquanto esta coluna de área sai; por
        // isso a área pode passar de 8.2 sem deixar buraco até o corte em 8.6.
        maxzoom: 8.6,
        filter: ['==', ['get', 'forma'], 'area'],
        paint: {
          'fill-extrusion-color': definicao.cor,
          'fill-extrusion-height': definicao.altura,
          'fill-extrusion-base': definicao.base,
          'fill-extrusion-opacity': OPACIDADE_PRISMAS,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      aoPendente,
    )
  }

  // O losango LARGO da barra de composição, no centroide da zona: o polígono
  // inteiro cobriria o município na aproximação. A altura é a escala de cidade
  // (FATOR_ALTURA_BARRA_CIDADE), nunca uma expressão de zoom; quem controla a
  // faixa é o par minzoom/maxzoom. Em 9.9 ele cede lugar ao losango fino.
  for (const definicao of [
    {
      id: LAYER_ZONAS_BARRA_LULA,
      cor: COR_SEGMENTO_LULA,
      base: 0,
      altura: CIDADE_ALTURA_LULA,
    },
    {
      id: LAYER_ZONAS_BARRA_FLAVIO,
      cor: COR_SEGMENTO_FLAVIO,
      base: CIDADE_BASE_FLAVIO,
      altura: CIDADE_ALTURA_FLAVIO,
    },
    {
      id: LAYER_ZONAS_BARRA_OUTROS,
      cor: COR_SEGMENTO_OUTROS,
      base: CIDADE_BASE_OUTROS,
      altura: CIDADE_ALTURA_OUTROS,
    },
    {
      id: LAYER_ZONAS_BARRA_NAO_APURADO,
      cor: COR_SEGMENTO_NAO_APURADO,
      base: CIDADE_BASE_NAO_APURADO,
      altura: CIDADE_ALTURA_NAO_APURADO,
    },
  ]) {
    adicionarCamada(
      mapa,
      {
        id: definicao.id,
        type: 'fill-extrusion',
        source: FONTE_ZONAS,
        filter: ['==', ['get', 'forma'], 'barra'],
        minzoom: ZOOM_BARRA_ZONA,
        maxzoom: 9.9,
        paint: {
          'fill-extrusion-color': definicao.cor,
          'fill-extrusion-height': definicao.altura,
          'fill-extrusion-base': definicao.base,
          'fill-extrusion-opacity': OPACIDADE_BARRAS_CIDADE,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      aoPendente,
    )
  }

  // O losango ESTREITO assume a partir de 9.3 e vai até ZOOM_BARRA_ZONA_FIM.
  // A largura menor compensa a projeção no nível de cidade; as alturas/bases
  // são as MESMAS do losango largo — o empilhamento não muda, só a largura.
  for (const definicao of [
    {
      id: LAYER_ZONAS_BARRA_FINA_LULA,
      cor: COR_SEGMENTO_LULA,
      base: 0,
      altura: CIDADE_ALTURA_LULA,
    },
    {
      id: LAYER_ZONAS_BARRA_FINA_FLAVIO,
      cor: COR_SEGMENTO_FLAVIO,
      base: CIDADE_BASE_FLAVIO,
      altura: CIDADE_ALTURA_FLAVIO,
    },
    {
      id: LAYER_ZONAS_BARRA_FINA_OUTROS,
      cor: COR_SEGMENTO_OUTROS,
      base: CIDADE_BASE_OUTROS,
      altura: CIDADE_ALTURA_OUTROS,
    },
    {
      id: LAYER_ZONAS_BARRA_FINA_NAO_APURADO,
      cor: COR_SEGMENTO_NAO_APURADO,
      base: CIDADE_BASE_NAO_APURADO,
      altura: CIDADE_ALTURA_NAO_APURADO,
    },
  ]) {
    adicionarCamada(
      mapa,
      {
        id: definicao.id,
        type: 'fill-extrusion',
        source: FONTE_ZONAS,
        filter: ['==', ['get', 'forma'], 'barra-fina'],
        minzoom: 9.3,
        maxzoom: ZOOM_BARRA_ZONA_FIM,
        paint: {
          'fill-extrusion-color': definicao.cor,
          'fill-extrusion-height': definicao.altura,
          'fill-extrusion-base': definicao.base,
          'fill-extrusion-opacity': OPACIDADE_BARRAS_FINAS,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      aoPendente,
    )
  }


  adicionarCamada(
    mapa,
    {
      id: LAYER_MUN_FILL,
      type: 'fill',
      source: FONTE_MUNICIPIOS,
      minzoom: 6.6,
      paint: {
        'fill-color': EXPRESSAO_COR,
        'fill-opacity': OPACIDADE_MUNICIPIOS,
      },
    },
    aoPendente,
  )

  // Item 6: calor da vantagem por município (escala divergente em torno de 0,
  // lida de feature-state `margem_pp`) e o tracejado de quem virou em 2022
  // (`virou`). Nascem invisíveis: quem liga é o botão MARGEM, por
  // setLayoutProperty — não há camada sendo criada/destruída a cada clique (a
  // lição do replay: camada recriada no meio do gesto deixa buraco na tela).
  adicionarCamada(
    mapa,
    {
      id: LAYER_MUN_MARGEM,
      type: 'fill',
      source: FONTE_MUNICIPIOS,
      minzoom: 6.6,
      layout: { visibility: 'none' },
      paint: {
        'fill-color': EXPRESSAO_CALOR_MUNICIPIO,
        'fill-opacity': 0.92,
      },
    },
    aoPendente,
    LAYER_MUN_LINE,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_MUN_VIRA,
      type: 'line',
      source: FONTE_MUNICIPIOS,
      minzoom: 6.6,
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: {
        'line-color': COR_VIRA_2022,
        'line-width': 1.7,
        'line-dasharray': TRACEJADO_VIRA_2022,
        // Tracejado só no município que virou; o resto fica com opacidade 0.
        'line-opacity': [
          'case',
          ['boolean', ['feature-state', 'virou'], false],
          1,
          0,
        ],
      },
    },
    aoPendente,
    LAYER_MUN_LINE,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_MUN_LINE,
      type: 'line',
      source: FONTE_MUNICIPIOS,
      minzoom: 6.6,
      layout: {
        'line-join': 'round',
      },
      paint: {
        'line-color': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          '#10161f',
          'rgba(255, 255, 255, 0.92)',
        ],
        'line-opacity': OPACIDADE_MUNICIPIOS_LINHA,
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          6.6,
          0.4,
          9,
          1.1,
        ],
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_MUN_LABELS,
      type: 'symbol',
      source: FONTE_MUNICIPIOS,
      // O nosso rótulo é desenhado por cima dos prismas, então pode entrar
      // antes das barras de zona saírem (12.2). Quem cede lugar é o texto do
      // basemap, oculto por regerirRotulosBase.
      minzoom: ZOOM_ROTULO_MUNICIPIO,
      layout: {
        'text-field': ['get', 'nome'],
        'text-font': ['Montserrat SemiBold'],
        // [23/10/2026] `text-allow-overlap: false` NÃO impede o mesmo nome duas
        // vezes: a colisão do MapLibre é entre símbolos distintos e por tile, não
        // deduplica o MESMO texto vindo de tiles vizinhos. Medido no print de drill
        // (São Paulo, z10.5): "SÃO PAULO" desenhado 2×. Agora o nome é ancorado no
        // CENTROIDE do município (o polígono é recortado em várias tiles, o centro
        // não: só a tile que contém o centro coloca o texto) e o overlap é liberado
        // para o nome nunca desaparecer na colisão.
        'text-anchor': 'center',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-size': ['interpolate', ['linear'], ['zoom'], 7.2, 9, 9, 11.5, 12, 14],
        'text-padding': 6,
        // Municípios com mais votos têm prioridade na colocação; quem não couber
        // sai inteiro, nunca pela metade.
        'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'total'], 0]],
        'symbol-z-order': 'source',
      },
      paint: {
        'text-color': '#1c232b',
        'text-halo-color': 'rgba(255, 253, 248, 0.94)',
        'text-halo-width': 1.4,
        'text-opacity': 0.92,
      },
    },
    aoPendente,
  )

  aplicarLocais(mapa, locais, aoPendente, detalhe, municipioSelecionado)
  publicarDebug(mapa, locais, detalhe, municipioSelecionado)
  // Entrou/saiu prisma: decide de novo se os rótulos do basemap aparecem.
  regerirRotulosBase(mapa, { forcar: true })
}

// Camadas do nível urna. A lista de locais já vem agregada pelo backend
// (/api/uf/{UF}/locais?cd=); aqui só se monta geometria e estilo.
function aplicarLocais(mapa, locais, aoPendente, detalhe, municipioSelecionado) {
  if (!mapa) return
  if (!mapa.getStyle || !mapa.getStyle()) {
    aoPendente?.()
    return
  }

  const lista = Array.isArray(locais) ? locais : []
  // Prédios 3D (item 10 — CIDADE-URNA) e pontos 2D da mesma lista. A decisão de
  // desenhar prédio ou só ponto é de atualizarVisibilidadePredios (limite +
  // WebGL + zoom).
  const tem3D = deveDesenharPredios(mapa, lista.length)
  const colecaoPoligonos = tem3D ? construirPredios(lista) : colecaoVazia()
  const colecaoPontos = pontosDosLocais(lista)
  const inicioRender = typeof performance !== 'undefined' ? performance.now() : 0

  const fonteLocais = mapa.getSource(FONTE_LOCAIS)
  if (fonteLocais) fonteLocais.setData(colecaoPoligonos)
  else {
    adicionarFonte(
      mapa,
      FONTE_LOCAIS,
      {
        type: 'geojson',
        data: colecaoPoligonos,
      },
      aoPendente,
    )
  }

  const fontePontos = mapa.getSource(FONTE_LOCAIS_PONTOS)
  if (fontePontos) fontePontos.setData(colecaoPontos)
  else {
    adicionarFonte(
      mapa,
      FONTE_LOCAIS_PONTOS,
      {
        type: 'geojson',
        data: colecaoPontos,
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 48,
      },
      aoPendente,
    )
  }

  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_PRISMA,
      type: 'fill-extrusion',
      source: FONTE_LOCAIS,
      minzoom: ZOOM_LOCAL,
      maxzoom: 14,
      paint: {
        // Cor chapada do partido que lidera: quem conta a apuração parcial é o
        // segmento de concreto no topo, não um degradê na cor.
        'fill-extrusion-color': COR_PREDIO,
        'fill-extrusion-height': ['get', 'altura_cor_m'],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': OPACIDADE_LOCAL,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_CONCRETO,
      type: 'fill-extrusion',
      source: FONTE_LOCAIS,
      minzoom: ZOOM_LOCAL,
      maxzoom: 14,
      // Só existe prisma de concreto onde falta apurar — na apuração fechada
      // (altura_concreto_m = 0) a camada fica vazia e não custa nada.
      filter: ['>', ['get', 'altura_concreto_m'], 0.5],
      paint: {
        'fill-extrusion-color': COR_CONCRETO,
        'fill-extrusion-height': ['get', 'altura_total_m'],
        'fill-extrusion-base': ['get', 'altura_concreto_base_m'],
        'fill-extrusion-opacity': OPACIDADE_LOCAL,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_CLUSTER,
      type: 'circle',
      source: FONTE_LOCAIS_PONTOS,
      minzoom: ZOOM_LOCAL,
      filter: ['has', 'cluster'],
      paint: {
        'circle-color': '#2b3440',
        'circle-radius': [
          'step',
          ['get', 'point_count'],
          18,
          10,
          24,
          50,
          32,
        ],
        'circle-stroke-color': '#fffdf8',
        'circle-stroke-width': 2,
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_CLUSTER_COUNT,
      type: 'symbol',
      source: FONTE_LOCAIS_PONTOS,
      minzoom: ZOOM_LOCAL,
      filter: ['has', 'cluster'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': ['Montserrat SemiBold'],
        'text-size': 11,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#ffffff',
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_PONTO,
      type: 'symbol',
      source: FONTE_LOCAIS_PONTOS,
      minzoom: ZOOM_LOCAL,
      filter: ['!', ['has', 'cluster']],
      layout: {
        'icon-image': [
          'concat',
          'local-',
          [
            'to-string',
            [
              '*',
              10,
              ['floor', ['/', ['coalesce', ['get', 'pct_apurado'], 100], 10]],
            ],
          ],
          '-',
          [
            'case',
            ['==', ['coalesce', ['get', 'partido_lider'], ''], ''],
            'NEUTRO',
            ['get', 'partido_lider'],
          ],
        ],
        'icon-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          9.2,
          0.28,
          12,
          0.5,
          14,
          0.62,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
    aoPendente,
  )

  // Alvo de toque maior que o ícone desenhado (dedo no celular). A opacidade
  // não pode ser 0: o MapLibre descarta a feature do hit-test e o clique no
  // local deixa de abrir o cartão.
  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_HIT,
      type: 'circle',
      source: FONTE_LOCAIS_PONTOS,
      minzoom: ZOOM_LOCAL,
      filter: ['!', ['has', 'cluster']],
      paint: {
        'circle-color': '#000000',
        'circle-opacity': 0.01,
        'circle-radius': 18,
      },
    },
    aoPendente,
  )

  adicionarCamada(
    mapa,
    {
      id: LAYER_LOCAL_SELECIONADO,
      type: 'circle',
      source: FONTE_LOCAIS_PONTOS,
      minzoom: ZOOM_LOCAL,
      filter: ['==', ['get', 'nr_local'], -1],
      paint: {
        'circle-color': 'rgba(0, 0, 0, 0)',
        'circle-radius': 13,
        'circle-stroke-color': '#10161f',
        'circle-stroke-width': 2.2,
      },
    },
    aoPendente,
  )

  // Se uma tentativa parcial criou o hit antes do ponto, o retry não pode
  // inverter a ordem: o alvo transparente tem de continuar acima do ícone.
  if (
    typeof mapa.getStyle === 'function' &&
    typeof mapa.moveLayer === 'function' &&
    mapa.getLayer(LAYER_LOCAL_HIT) &&
    mapa.getLayer(LAYER_LOCAL_PONTO) &&
    mapa.getStyle()
  ) {
    const ordem = mapa.getStyle().layers.map((camada) => camada.id)
    if (ordem.indexOf(LAYER_LOCAL_HIT) < ordem.indexOf(LAYER_LOCAL_PONTO)) {
      if (mapa.getLayer(LAYER_LOCAL_SELECIONADO)) {
        mapa.moveLayer(LAYER_LOCAL_HIT, LAYER_LOCAL_SELECIONADO)
      } else {
        mapa.moveLayer(LAYER_LOCAL_HIT)
      }
    }
  }

  // Acima do limite de locais do município (ou com o 3D desligado) a fonte 3D
  // fica vazia e as camadas escondidas: quem aparece são os ícones/clusters.
  atualizarVisibilidadePredios(mapa, lista.length)
  // Urnas do local selecionado (re)aplicadas junto com os locais: o retry de
  // load/styledata passa por aqui.
  const desenhoUrnas = aplicarUrnas(
    mapa,
    estadoLocal.selecionado,
    lista,
    aoPendente,
  )
  urnasDebug.set(mapa, desenhoUrnas)
  // Tempo de render medido: setData dos prédios -> mapa ocioso.
  medirTempoDeRender(mapa, inicioRender, colecaoPoligonos.features.length)
  // Publica o debug já com as camadas criadas nesta passagem.
  publicarDebug(mapa, lista, detalhe, municipioSelecionado)
}

// Modo de pintura do estado. Três leituras, uma camada:
//   ao vivo  -> EXPRESSAO_COR_UF (regra do concreto, lê as propriedades)
//   margem   -> EXPRESSAO_COR_MARGEM (mapa de calor, ignora o concreto)
//   replay   -> EXPRESSAO_COR_UF_REPLAY (lê feature-state por UF)
// No replay o estado de cada UF entra por feature-state: `fechada` quando as
// seções apuradas do frame igualam o total da UF, e a cor sai de `partido` e
// `margem` do arquivo de 2022 (o GeoJSON carrega as propriedades do pleito
// atual, que não valem para o replay).
function pintarEstados(mapa, geojson, replay, modoMargem) {
  if (!mapa || typeof mapa.getLayer !== 'function') return
  if (!mapa.getLayer(LAYER_FILL) || !mapa.getSource(FONTE)) return

  let expressao = EXPRESSAO_COR_UF
  if (replay) expressao = EXPRESSAO_COR_UF_REPLAY
  else if (modoMargem) expressao = EXPRESSAO_COR_MARGEM
  mapa.setPaintProperty(LAYER_FILL, 'fill-color', expressao)

  const base = replay?.base || {}
  const doFrame = replay?.frame?.ufs || null
  const features = geojson?.features || []
  let fechadas = 0

  for (const feature of features) {
    const sigla = feature?.properties?.uf
    if (!sigla) continue
    const referencia = base[sigla]
    const total = Number(referencia?.secoes_total) || 0
    const apuradas = doFrame ? Number(doFrame[sigla]) || 0 : 0
    const fechada = Boolean(replay && total > 0 && apuradas >= total)
    if (fechada) fechadas += 1
    mapa.setFeatureState(
      { source: FONTE, id: sigla },
      {
        fechada,
        partido: referencia?.partido_lider || '',
        margem: Number(referencia?.margem_pct) || 0,
      },
    )
  }

  // Handle de prova (scripts/provas/replay.mjs): o que a camada está pintando.
  window.__replayDebug = {
    modo: replay ? 'replay' : modoMargem ? 'margem' : 'ao vivo',
    frame: replay?.frame?.i ?? null,
    pct_apurado: replay?.frame?.pct_apurado ?? null,
    ufs_fechadas: fechadas,
    ufs_total: features.length,
  }
}

// ---------------------------------------------------------------------------
// ITEM 6 — calor da vantagem por MUNICÍPIO.
//
// O backend já entrega a lista pronta (margem_votos, margem_pct, vv, lider,
// partido_lider, virou_2022, delta_pp_2022) por codarea. Aqui só se:
//   1. grava `margem_pp` (pontos COM sinal: + no lado PL, − no lado PT) e
//      `virou` por feature-state — a cor e o tracejado leem isso;
//   2. liga/desliga as duas camadas por `visibility` (nada é recriado);
//   3. publica `window.__margemDebug` com o que a prova mede.
function sinalDaMargem(margem) {
  const pontosDaMargem = Number(margem?.margem_pct) || 0
  const partido = String(margem?.partido_lider || '').toUpperCase()
  return partido === 'PT' ? -pontosDaMargem : pontosDaMargem
}

function municipiosQueViraram(margensUf) {
  const lista = Array.isArray(margensUf?.municipios) ? margensUf.municipios : []
  return lista.filter((municipio) => municipio.virou_2022 === true)
}

function publicarDebugMargem(mapa, margensUf, ativo) {
  let featuresCalor = 0
  try {
    if (ativo && mapa.getLayer && mapa.getLayer(LAYER_MUN_MARGEM)) {
      featuresCalor = mapa.queryRenderedFeatures({ layers: [LAYER_MUN_MARGEM] }).length
    }
  } catch {
    featuresCalor = 0
  }
  const lista = Array.isArray(margensUf?.municipios) ? margensUf.municipios : []
  window.__margemDebug = {
    ativo: Boolean(ativo),
    uf: margensUf?.uf ?? null,
    municipios: lista.length,
    municipiosViraram: municipiosQueViraram(margensUf).length,
    totalViraramAPI: Number(margensUf?.total_viraram ?? 0),
    featuresCalor,
    camadaVisivel: Boolean(
      mapa.getLayer && mapa.getLayer(LAYER_MUN_MARGEM)
        ? mapa.getLayoutProperty(LAYER_MUN_MARGEM, 'visibility') !== 'none'
        : false,
    ),
    // A API já ordena por margem_votos × vv; aqui só se corta o topo.
    top5: lista.slice(0, 5).map((municipio) => ({
      nome: municipio.nome,
      uf: margensUf?.uf ?? null,
      lider: municipio.lider,
      partido_lider: municipio.partido_lider,
      margem_votos: municipio.margem_votos,
      margem_pct: municipio.margem_pct,
      virou_2022: municipio.virou_2022 === true,
    })),
  }
}

function pintarMunicipiosMargem(mapa, margensUf, ativo) {
  if (!mapa || typeof mapa.getLayer !== 'function') return
  const lista = Array.isArray(margensUf?.municipios) ? margensUf.municipios : []

  if (lista.length > 0 && mapa.getSource && mapa.getSource(FONTE_MUNICIPIOS)) {
    for (const municipio of lista) {
      mapa.setFeatureState(
        { source: FONTE_MUNICIPIOS, id: String(municipio.codarea) },
        {
          margem_pp: sinalDaMargem(municipio),
          virou: municipio.virou_2022 === true,
        },
      )
    }
  }

  const visivel = Boolean(ativo) && lista.length > 0
  for (const camada of [LAYER_MUN_MARGEM, LAYER_MUN_VIRA]) {
    if (mapa.getLayer(camada)) {
      mapa.setLayoutProperty(camada, 'visibility', visivel ? 'visible' : 'none')
    }
  }

  publicarDebugMargem(mapa, margensUf, ativo)
  // A contagem de features rendidas só é honesta depois de um quadro: refaz o
  // debug no primeiro `idle` que vem depois de ligar a camada.
  if (visivel) mapa.once('idle', () => publicarDebugMargem(mapa, margensUf, ativo))
}

export default function MapView({
  geojson,
  selectedUf,
  onSelect,
  onMapError,
  detalhe,
  municipioSelecionado,
  locais,
  localSelecionado,
  zoomInicial,
  onZoom,
  onSelectMunicipio,
  onSelectLocal,
  replay,
  modoMargem,
  margensUf,
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const estiloCarregadoRef = useRef(false)
  const geojsonRef = useRef(geojson)
  const selectedRef = useRef(selectedUf)
  const onSelectRef = useRef(onSelect)
  const onMapErrorRef = useRef(onMapError)
  const detalheRef = useRef(detalhe)
  const municipioSelecionadoRef = useRef(municipioSelecionado)
  const zoomInicialRef = useRef(zoomInicial)
  const onZoomRef = useRef(onZoom)
  const onSelectMunicipioRef = useRef(onSelectMunicipio)
  const locaisRef = useRef(locais)
  const onSelectLocalRef = useRef(onSelectLocal)
  const localSelecionadoRef = useRef(localSelecionado)
  const hoverRef = useRef(null)
  const selecionadoRef = useRef(null)
  const municipioRef = useRef(null)
  const zoomInicialAplicadoRef = useRef(false)
  const municipioZoomUrlRef = useRef(null)
  const reaplicarDetalheRef = useRef(null)
  // Último local para o qual a câmera já aproximou (evita re-zoom em loop).
  const ultimoLocalZoomadoRef = useRef(null)
  // Modo de pintura das UFs (replay/mapa de calor) lido dentro dos handlers do
  // MapLibre, que são registrados uma vez só.
  const replayRef = useRef(replay)
  const modoMargemRef = useRef(modoMargem)
  // Margens por município da UF aberta (item 6): lidas dentro dos handlers do
  // MapLibre, que são registrados uma vez só.
  const margensUfRef = useRef(margensUf)
  const indiceMargensRef = useRef(new Map())

  geojsonRef.current = geojson
  selectedRef.current = selectedUf
  onSelectRef.current = onSelect
  onMapErrorRef.current = onMapError
  detalheRef.current = detalhe
  municipioSelecionadoRef.current = municipioSelecionado
  zoomInicialRef.current = zoomInicial
  onZoomRef.current = onZoom
  onSelectMunicipioRef.current = onSelectMunicipio
  locaisRef.current = locais
  onSelectLocalRef.current = onSelectLocal
  localSelecionadoRef.current = localSelecionado
  replayRef.current = replay
  modoMargemRef.current = modoMargem
  margensUfRef.current = margensUf
  indiceMargensRef.current = new Map(
    (Array.isArray(margensUf?.municipios) ? margensUf.municipios : []).map((item) => [
      String(item.codarea),
      item,
    ]),
  )

  // Cria o mapa uma única vez.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    let mapa
    try {
      mapa = new maplibregl.Map({
        container,
        style: CARTO_POSITRON,
        center: [-52.5, -15.2],
        zoom: 3.1,
        minZoom: 2.2,
        maxZoom: 14,
        attributionControl: false,
        dragRotate: false,
        touchZoomRotate: true,
        pitchWithRotate: false,
        touchPitch: false,
      })
    } catch (erro) {
      console.error('Falha ao iniciar o MapLibre:', erro)
      onMapErrorRef.current?.()
      return undefined
    }

    mapRef.current = mapa
    // Handle para as provas (scripts/provas/captura.mjs) forçarem resize +
    // repaint: em GPU de software o canvas pode ficar sem frame após o fit.
    window.__mapa = mapa

    // Controle de mouse do app: botão direito = zoom (arraste vertical),
    // bearing travado em 0 e menu de contexto suprimido. Fica num módulo
    // próprio (web/src/controle_mouse.js) para ser provado isolado.
    const controleDeMouse = instalarControleDeMouse(mapa)

    // O basemap pode terminar de carregar depois do load e um style swap apaga
    // as imagens; re-registrar apenas os ids ausentes é idempotente.
    mapa.on('styledata', () => {
      // A própria registrarIconesLocais já decide pelo isStyleLoaded (addImage
      // exige o estilo assentado); aqui não se descarta a chamada por isso.
      registrarIconesLocais(mapa)
      // Style swap devolve os rótulos do basemap ao padrão: reaplica a decisão.
      regerirRotulosBase(mapa, { forcar: true })
    })

    const compacto = window.matchMedia('(max-width: 820px)').matches
    mapa.addControl(
      new maplibregl.AttributionControl({ compact: compacto }),
      'bottom-right',
    )
    mapa.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      'top-right',
    )

    const tooltipEl = document.createElement('div')
    tooltipEl.className = 'uf-tooltip'
    const tooltip = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 14,
      className: 'uf-tooltip-popup',
    }).setDOMContent(tooltipEl)

    const podeHover = window.matchMedia(
      '(hover: hover) and (pointer: fine)',
    ).matches

    function limparHover() {
      if (hoverRef.current == null) return
      mapa.setFeatureState(
        { source: FONTE, id: hoverRef.current },
        { hover: false },
      )
      hoverRef.current = null
    }

    function aplicarSelecao(uf) {
      if (!mapa.getSource(FONTE)) return
      if (selecionadoRef.current != null) {
        mapa.setFeatureState(
          { source: FONTE, id: selecionadoRef.current },
          { selected: false },
        )
      }
      selecionadoRef.current = uf || null
      if (uf) {
        mapa.setFeatureState({ source: FONTE, id: uf }, { selected: true })
      }
    }

    function atualizarDebug() {
      publicarDebug(
        mapa,
        locaisRef.current,
        detalheRef.current,
        municipioSelecionadoRef.current,
      )
    }

    // Se o detalhe chegou antes do estilo estar pronto (ou uma camada falhou),
    // a reaplicação é agendada por evento (load/styledata) e coalescida por um
    // debounce de 150ms para não repetir a cada tile. As funções são
    // idempotentes.
    let reaplicacaoAgendada = null
    let reagendamentoIdle = null
    let reagendamentoIdleUsado = false

    function reaplicarDetalhe() {
      if (reaplicacaoAgendada != null) return
      reaplicacaoAgendada = window.setTimeout(() => {
        reaplicacaoAgendada = null
        // Sempre lê o estado mais recente no momento da chamada: o evento de
        // load/styledata pode disparar durante o recarregamento do município.
        const detalheAtual = detalheRef.current
        const locaisAtuais = locaisRef.current
        const municipioAtual = municipioSelecionadoRef.current
        const temSelecao = Boolean(municipioAtual)

        if (!detalheAtual && temSelecao) {
          // O detalhe ainda não voltou, mas há município selecionado: preserva
          // as camadas da última aplicação válida e tenta de novo no próximo
          // idle, uma única vez.
          if (!reagendamentoIdleUsado && reagendamentoIdle == null) {
            reagendamentoIdleUsado = true
            reagendamentoIdle = () => {
              reagendamentoIdle = null
              reaplicarDetalhe()
            }
            mapa.once('idle', reagendamentoIdle)
          }
          atualizarDebug()
          return
        }

        reagendamentoIdleUsado = false
        if (reagendamentoIdle != null) {
          mapa.off('idle', reagendamentoIdle)
          reagendamentoIdle = null
        }
        aplicarDetalhe(
          mapa,
          detalheAtual,
          locaisAtuais,
          reaplicarDetalhe,
          temSelecao,
          municipioAtual,
        )
        atualizarDebug()
      }, 150)
    }

    reaplicarDetalheRef.current = reaplicarDetalhe
    mapa.on('load', reaplicarDetalhe)
    mapa.on('styledata', reaplicarDetalhe)

    mapa.on('load', () => {
      estiloCarregadoRef.current = true
      registrarIconesLocais(mapa)
      mapa.addSource(FONTE, {
        type: 'geojson',
        data: geojsonRef.current,
        promoteId: 'uf',
      })

      mapa.addLayer({
        id: LAYER_FILL,
        type: 'fill',
        source: FONTE,
        paint: {
          // Regra do concreto: só recebe cor de candidato a UF que fechou a
          // apuração (secoes_apuradas == secoes_total). Enquanto apura, cinza.
          'fill-color': EXPRESSAO_COR_UF,
          'fill-color-transition': TRANSICAO_COR_UF,
          'fill-opacity': 0.85,
        },
      })

      mapa.addLayer({
        id: LAYER_LINE,
        type: 'line',
        source: FONTE,
        paint: {
          'line-color': 'rgba(255, 255, 255, 0.94)',
          'line-width': 1,
        },
      })

      mapa.addLayer({
        id: LAYER_HOVER,
        type: 'line',
        source: FONTE,
        paint: {
          'line-color': '#18222e',
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            2.4,
            0,
          ],
        },
      })

      mapa.addLayer({
        id: LAYER_SELECTED,
        type: 'line',
        source: FONTE,
        paint: {
          'line-color': '#10161f',
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            3,
            0,
          ],
        },
      })

      mapa.addLayer({
        id: 'ufs-labels',
        type: 'symbol',
        source: FONTE,
        minzoom: 3,
        // [23/10/2026] maxzoom devolve a faixa de estado. Sem ele a sigla "SP"
        // do centroide seguia desenhada no zoom de MUNICÍPIO e, como o município
        // São Paulo tem o mesmo nome da UF, o print do drill mostrava
        // "SÃO PAULO" duas vezes (medido: ufs-labels + municipios-labels em
        // z8 e z10.5, desktop e mobile). O nome da cidade é da camada própria.
        maxzoom: ZOOM_ROTULO_APP,
        layout: {
          'text-field': ['get', 'uf'],
          // [23/10/2026] A sigla da UF morre no zoom de município. Duas coisas
          // medidas aqui: (a) `maxzoom` da camada NÃO bastava — `ufs-labels`
          // seguia no quadro em z8 e z10.5 (queryRenderedFeatures); (b)
          // `layout.visibility` NÃO aceita expressão de zoom ("layers.ufs-labels
          // .layout.visibility: zoom expressions not supported", erro de console).
          // Solução: a camada do app troca a visibilidade com setLayoutProperty
          // em regerirRotulosBase (mesma faixa ZOOM_ROTULO_APP), e aqui ela nasce
          // visível só abaixo da faixa.
          'visibility': 'visible',
          'text-font': ['Montserrat SemiBold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, 9, 5, 12, 7, 14],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-padding': 2,
        },
        paint: {
          'text-color': '#1c232b',
          'text-halo-color': 'rgba(255, 253, 248, 0.94)',
          'text-halo-width': 1.4,
          'text-opacity': 0.92,
        },
      })

      // Com UF inicial vinda da URL, o fitBounds da seleção já rodou e não
      // pode ser sobrescrito pelo enquadramento do Brasil.
      if (!selectedRef.current) {
        const limites = limitesDaColecao(geojsonRef.current)
        if (limites) {
          mapa.fitBounds(limites, {
            padding: { top: 24, right: 24, bottom: 24, left: 24 },
            maxZoom: 4.2,
            duration: 0,
          })
        }
      }

      aplicarSelecao(selectedRef.current)
      aplicarDetalhe(
        mapa,
        detalheRef.current,
        locaisRef.current,
        reaplicarDetalhe,
        Boolean(municipioSelecionadoRef.current),
        municipioSelecionadoRef.current,
      )
      atualizarDebug()
      onZoomRef.current?.(mapa.getZoom())
      // Estado das UFs no modo corrente (ao vivo, margem ou replay). O efeito
      // de [replay, modoMargem] reaplica a cada mudança de frame; aqui garante
      // a primeira pintura, porque o efeito roda antes das camadas existirem.
      pintarEstados(
        mapa,
        geojsonRef.current,
        replayRef.current,
        modoMargemRef.current,
      )
    })

    if (podeHover) {
      mapa.on('mousemove', LAYER_FILL, (evento) => {
        const feature = evento.features?.[0]
        if (!feature) return
        const id = feature.id

        if (hoverRef.current !== id) {
          limparHover()
          hoverRef.current = id
          mapa.setFeatureState({ source: FONTE, id }, { hover: true })
        }

        mapa.getCanvas().style.cursor = 'pointer'
        preencherTooltipUf(tooltipEl, feature.properties || {})
        tooltip.setLngLat(evento.lngLat).addTo(mapa)
      })

      mapa.on('mouseleave', LAYER_FILL, () => {
        limparHover()
        mapa.getCanvas().style.cursor = ''
        tooltip.remove()
      })

      mapa.on('mousemove', [...LAYERS_ZONAS, LAYER_MUN_FILL], (evento) => {
        const feature = featureDeDetalhe(evento, mapa.getZoom())
        if (!feature) return

        limparHover()
        mapa.getCanvas().style.cursor = 'pointer'
        if (feature.layer.id === LAYER_MUN_FILL) {
          preencherTooltipMunicipio(
            tooltipEl,
            feature.properties || {},
            indiceMargensRef.current.get(String(feature.properties?.codarea ?? '')),
          )
        } else {
          preencherTooltipZona(tooltipEl, feature.properties || {})
        }
        tooltip.setLngLat(evento.lngLat).addTo(mapa)
      })

      mapa.on('mouseleave', [...LAYERS_ZONAS, LAYER_MUN_FILL], () => {
        mapa.getCanvas().style.cursor = ''
        tooltip.remove()
      })

      mapa.on('mousemove', [LAYER_LOCAL_HIT, LAYER_LOCAL_PRISMA, LAYER_LOCAL_PONTO], (evento) => {
        if (mapa.getZoom() < ZOOM_LOCAL) return
        const feature = evento.features?.[0]
        if (!feature) return
        mapa.getCanvas().style.cursor = 'pointer'
        preencherTooltipLocal(tooltipEl, feature.properties || {})
        tooltip.setLngLat(evento.lngLat).addTo(mapa)
      })

      mapa.on('mouseleave', [LAYER_LOCAL_HIT, LAYER_LOCAL_PRISMA, LAYER_LOCAL_PONTO], () => {
        mapa.getCanvas().style.cursor = ''
        tooltip.remove()
      })
    }

    mapa.on('click', LAYER_FILL, (evento) => {
      // No nível urna o clique é do ponto/cluster, não da UF.
      if (mapa.getZoom() >= ZOOM_LOCAL) return
      const feature = evento.features?.[0]
      if (feature?.properties?.uf) {
        onSelectRef.current?.(feature.properties.uf)
      }
    })

    mapa.on('click', LAYER_MUN_FILL, (evento) => {
      // No nível urna o clique é do local, não do município.
      if (mapa.getZoom() >= ZOOM_LOCAL) return
      const feature = evento.features?.[0]
      if (!feature) return
      const propriedades = feature.properties || {}

      preencherTooltipMunicipio(
        tooltipEl,
        propriedades,
        indiceMargensRef.current.get(String(propriedades.codarea ?? '')),
      )
      tooltip.setLngLat(evento.lngLat).addTo(mapa)

      onSelectMunicipioRef.current?.(
        propriedades.nome,
        String(propriedades.codarea),
      )

      // O feature devolvido pelo MapLibre pode vir recortado pela tile; para
      // enquadrar o município inteiro usamos a geometria completa da fonte.
      const completa = detalheRef.current?.municipiosGeo?.features?.find(
        (item) => String(item.properties?.codarea) === String(propriedades.codarea),
      )
      const limites = limitesDaGeometria(completa?.geometry || feature.geometry)
      if (limites) {
        mapa.fitBounds(limites, {
          padding: paddingDoMapa(),
          maxZoom: 9.5,
          duration: 850,
        })
      }
    })

    mapa.on('click', LAYERS_ZONAS, (evento) => {
      // A partir do zoom municipal o preenchimento cobre os prismas e o
      // clique deve abrir o município, não a zona.
      if (mapa.getZoom() >= 6.6) return
      const feature = evento.features?.[0]
      if (!feature) return

      preencherTooltipZona(tooltipEl, feature.properties || {})
      tooltip.setLngLat(evento.lngLat).addTo(mapa)
    })

    // Cluster de locais: dois passos de zoom aproximam até o nível de rua.
    mapa.on('click', LAYER_LOCAL_CLUSTER, (evento) => {
      const feature = evento.features?.[0]
      const coordenadas = feature?.geometry?.coordinates
      if (!coordenadas) return
      evento.preventDefault?.()
      mapa.easeTo({
        center: coordenadas,
        zoom: Math.min(mapa.getZoom() + 2, 14),
        duration: 600,
      })
    })

    // Nível urna: o clique/toque abre o local e a lista de seções dele. A
    // agregação é do backend; aqui só se identifica o nr_local.
    mapa.on('click', [LAYER_LOCAL_HIT, LAYER_LOCAL_PRISMA], (evento) => {
      if (mapa.getZoom() < ZOOM_LOCAL) return
      const feature = evento.features?.[0]
      if (!feature) return
      evento.preventDefault?.()
      const nrLocal = Number(feature.properties?.nr_local)
      if (!Number.isFinite(nrLocal)) return
      onSelectLocalRef.current?.(nrLocal)
    })

    mapa.on('idle', () => {
      // Os ícones dos locais eram registrados só no load/styledata com a guarda
      // isStyleLoaded(): no celular o load chegava com o estilo ainda não
      // assentado e nenhum styledata posterior vinha, então
      // hasImage('local-100-PT') ficava false e a camada locais-ponto não
      // desenhava nada (medido: imagens=0 por 10s, ponto=0 em todos os
      // paddings). O idle chega depois de tiles/glyphs; hasImage torna a
      // chamada idempotente e barata.
      registrarIconesLocais(mapa)
      atualizarDebug()
    })
    mapa.on('sourcedata', (evento) => {
      if (
        evento.sourceId === FONTE ||
        evento.sourceId === FONTE_MUNICIPIOS ||
        evento.sourceId === FONTE_ZONAS ||
        evento.sourceId === FONTE_LOCAIS ||
        evento.sourceId === FONTE_LOCAIS_PONTOS
      ) {
        atualizarDebug()
      }
    })
    mapa.on('moveend', () => {
      atualizarVisibilidadePredios(
        mapa,
        Array.isArray(locaisRef.current) ? locaisRef.current.length : 0,
      )
      // Fim de gesto: reaplica a decisão de rótulo (idempotente — o guarda por
      // instância devolve na hora se a faixa não mudou).
      regerirRotulosBase(mapa)
      atualizarDebug()
      onZoomRef.current?.(mapa.getZoom())
    })

    // Os rótulos do basemap saem da faixa do nosso rótulo junto com o zoom.
    // O handler roda a cada frame, mas regerirRotulosBase lê o guarda antes de
    // tocar em qualquer camada: setLayoutProperty só quando a faixa muda.
    mapa.on('zoom', () => regerirRotulosBase(mapa))

    const aoPerderContexto = () => {
      console.error('Contexto WebGL perdido.')
      onMapErrorRef.current?.()
    }
    mapa.getCanvas().addEventListener('webglcontextlost', aoPerderContexto)

    const observador = new ResizeObserver(() => mapa.resize())
    observador.observe(container)

    return () => {
      observador.disconnect()
      if (reaplicacaoAgendada != null) {
        window.clearTimeout(reaplicacaoAgendada)
        reaplicacaoAgendada = null
      }
      if (reagendamentoIdle != null) {
        mapa.off('idle', reagendamentoIdle)
        reagendamentoIdle = null
      }
      reagendamentoIdleUsado = false
      reaplicarDetalheRef.current = null
      mapa.getCanvas().removeEventListener('webglcontextlost', aoPerderContexto)
      tooltip.remove()
      controleDeMouse.desinstalar()
      mapa.remove()
      mapRef.current = null
      estiloCarregadoRef.current = false
      delete window.__mapaDebug
      delete window.__mapa
    }
  }, [])

  // Mantém o source sincronizado caso os dados sejam recarregados.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa || !geojson) return undefined

    const aplicar = () => {
      const fonte = mapa.getSource(FONTE)
      if (fonte) fonte.setData(geojson)
    }

    // Aplica já (as funções internas só dependem de getStyle) e reaplica no
    // load caso as camadas base ainda não existam. isStyleLoaded() não serve
    // de gate aqui: com o basemap abortando requests ele fica falso para sempre.
    aplicar()
    if (!estiloCarregadoRef.current) mapa.once('load', aplicar)

    return () => {
      mapa.off('load', aplicar)
    }
  }, [geojson])

  // Replay e mapa de calor mudam só a PINTURA da camada de UF (expressão +
  // feature-state). Nada aqui mexe em geometria, altura de prisma ou zoom — as
  // duas lições caras do projeto: expressão com 'zoom' dentro de altura de
  // extrusão derruba o mapa, e o resto é pintura.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa) return undefined

    const aplicar = () => {
      pintarEstados(mapa, geojsonRef.current, replay, modoMargem)
    }

    aplicar()
    if (!estiloCarregadoRef.current) mapa.once('load', aplicar)
    // Style swap (basemap) recria as camadas: reaplica a pintura do modo.
    mapa.on('styledata', aplicar)

    return () => {
      mapa.off('load', aplicar)
      mapa.off('styledata', aplicar)
    }
  }, [replay, modoMargem])

  // ITEM 6 — calor por município: feature-state + visibility, reaplicados quando
  // o modo troca, quando a lista da UF chega e quando a malha municipal é
  // recarregada (setData zera feature-state de feature nova).
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa) return undefined

    const aplicar = () => {
      pintarMunicipiosMargem(mapa, margensUfRef.current, modoMargemRef.current)
    }

    aplicar()
    if (!estiloCarregadoRef.current) mapa.once('load', aplicar)
    mapa.on('styledata', aplicar)

    return () => {
      mapa.off('load', aplicar)
      mapa.off('styledata', aplicar)
    }
  }, [modoMargem, margensUf, detalhe])

  // Cria/atualiza as fontes e camadas municipais/zonais/urnas quando chegam.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa) return undefined

    // Recarregando o detalhe do município: não tocar no mapa, senão as
    // camadas válidas da seleção atual seriam apagadas.
    if (municipioSelecionado && !detalhe) return undefined

    const aplicar = () => {
      const detalheAtual = detalheRef.current
      const municipioAtual = municipioSelecionadoRef.current
      if (municipioAtual && !detalheAtual) return
      aplicarDetalhe(
        mapa,
        detalheAtual,
        locaisRef.current,
        reaplicarDetalheRef.current,
        Boolean(municipioAtual),
        municipioAtual,
      )
    }
    // Aplica já (as funções internas só dependem de getStyle) e reaplica no
    // load caso as camadas base ainda não existam. isStyleLoaded() não serve
    // de gate aqui: com o basemap abortando requests ele fica falso para sempre.
    aplicar()
    if (!estiloCarregadoRef.current) mapa.once('load', aplicar)

    return () => {
      mapa.off('load', aplicar)
    }
  }, [detalhe, municipioSelecionado, locais, localSelecionado])

  // Anel em volta do local escolhido + as urnas daquele local na laje do
  // prédio. Ao abrir um local a câmera aproxima (uma vez) para a grade de urnas
  // caber na tela.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa) return

    const nrLocal = localSelecionado
      ? Number(localSelecionado.nr_local ?? localSelecionado)
      : -1
    if (mapa.getLayer(LAYER_LOCAL_SELECIONADO)) {
      mapa.setFilter(
        LAYER_LOCAL_SELECIONADO,
        ['==', ['get', 'nr_local'], Number.isFinite(nrLocal) ? nrLocal : -1],
      )
    }

    // O estado fora do React é o que o retry de load/styledata consulta.
    estadoLocal.selecionado = localSelecionado ?? null
    const desenho = aplicarUrnas(
      mapa,
      localSelecionado,
      locais,
      reaplicarDetalheRef.current,
    )
    urnasDebug.set(mapa, desenho)

    if (!Number.isFinite(nrLocal)) {
      ultimoLocalZoomadoRef.current = null
      return
    }
    if (ultimoLocalZoomadoRef.current === nrLocal) return
    ultimoLocalZoomadoRef.current = nrLocal

    const local = (Array.isArray(locais) ? locais : []).find(
      (item) => Number(item.nr_local) === nrLocal,
    )
    const lat = Number(local?.lat)
    const lon = Number(local?.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return

    // Nunca aproxima além do que já está: se o usuário já está em zoom de
    // detalhe, só centraliza. pitch sobe para as urnas aparecerem em 3D.
    mapa.easeTo({
      center: [lon, lat],
      zoom: Math.max(mapa.getZoom(), 12.6),
      pitch: Math.max(mapa.getPitch(), 50),
      bearing: 0,
      padding: paddingDoMapa(),
      duration: 700,
    })
  }, [localSelecionado, locais])

  // O coroplético de UF só esmaece quando existe UF selecionada e o detalhe
  // municipal já foi carregado.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa) return undefined

    const aplicar = () => {
      if (!mapa.getLayer(LAYER_FILL)) return
      mapa.setPaintProperty(
        LAYER_FILL,
        'fill-opacity',
        selectedUf && detalhe ? OPACIDADE_UFS_COM_DETALHE : 0.85,
      )
    }

    // Aplica já (as funções internas só dependem de getStyle) e reaplica no
    // load caso as camadas base ainda não existam. isStyleLoaded() não serve
    // de gate aqui: com o basemap abortando requests ele fica falso para sempre.
    aplicar()
    if (!estiloCarregadoRef.current) mapa.once('load', aplicar)

    return () => {
      mapa.off('load', aplicar)
    }
  }, [selectedUf, detalhe])

  // Destaque do estado selecionado via feature-state.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa) return
    if (!mapa.getSource(FONTE)) return

    if (selecionadoRef.current != null) {
      mapa.setFeatureState(
        { source: FONTE, id: selecionadoRef.current },
        { selected: false },
      )
    }
    selecionadoRef.current = selectedUf || null
    if (selectedUf) {
      mapa.setFeatureState(
        { source: FONTE, id: selectedUf },
        { selected: true },
      )
    }
  }, [selectedUf])

  // Contorno do município escolhido no painel.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa || !mapa.getSource(FONTE_MUNICIPIOS)) return

    if (municipioRef.current != null) {
      mapa.setFeatureState(
        { source: FONTE_MUNICIPIOS, id: municipioRef.current },
        { selected: false },
      )
    }
    municipioRef.current = municipioSelecionado
      ? String(municipioSelecionado.codarea)
      : null
    if (municipioRef.current) {
      mapa.setFeatureState(
        { source: FONTE_MUNICIPIOS, id: municipioRef.current },
        { selected: true },
      )
    }
  }, [municipioSelecionado, detalhe])

  // Aproxima a UF escolhida, inclina a câmera para os prismas e aplica o zoom
  // inicial da URL uma única vez, depois do fitBounds.
  useEffect(() => {
    const mapa = mapRef.current
    if (!mapa) return undefined

    if (!selectedUf) {
      mapa.easeTo({ pitch: 0, bearing: 0, duration: 650 })
      return undefined
    }
    if (!geojson) return undefined

    const feature = geojson.features?.find(
      (item) => item.properties?.uf === selectedUf,
    )
    const limites = limitesDaGeometria(feature?.geometry)
    if (!limites) return undefined

    mapa.fitBounds(limites, {
      padding: paddingDoMapa(),
      maxZoom: 8.2,
      duration: 850,
    })

    let concluido = false
    let reserva = null

    const concluirAproximacao = () => {
      if (concluido) return
      concluido = true
      mapa.off('moveend', concluirAproximacao)
      if (reserva != null) window.clearTimeout(reserva)

      const zoomBruto = zoomInicialRef.current
      const zoom = Number(zoomBruto)
      if (
        zoomBruto != null &&
        zoomBruto !== '' &&
        Number.isFinite(zoom) &&
        !zoomInicialAplicadoRef.current
      ) {
        zoomInicialAplicadoRef.current = true
        // Ao SUBIR o zoom por deep link (?z=) o centro do fitBounds fica ao
        // sul quando o padding é assimétrico (celular: bottom 72%), então o
        // ponto enquadrado sai da tela. Nesse caso recentraliza na bbox da UF;
        // ao DESCER o zoom o centro do fitBounds continua correto e é mantido.
        const zoomAtual = mapa.getZoom()
        if (zoom > zoomAtual + 0.01) {
          const centroUf = [
            (limites[0][0] + limites[1][0]) / 2,
            (limites[0][1] + limites[1][1]) / 2,
          ]
          mapa.jumpTo({ zoom, center: centroUf })
        } else if (zoom < zoomAtual - 0.01) {
          mapa.jumpTo({ zoom })
        }
      }

      // No celular o bottom sheet cobre ~72% da tela e quem resolve isso é o
      // padding assimétrico do fitBounds (paddingDoMapa: bottom = 72%). Não há
      // panBy manual aqui: jumpTo/easeTo preservam o enquadramento já corrigido,
      // e o pan extra empurrava o alvo para fora do canvas (medido: ?z=13 abria
      // em lat -4.224, ~55 km ao sul de Fortaleza, tela sem local nenhum).
      const pitch = window.innerWidth <= 820 ? 30 : 50
      mapa.easeTo({ pitch, bearing: 0, duration: 850 })
    }

    const reservarConclusao = () => {
      reserva = window.setTimeout(() => {
        if (concluido) return
        // Não interrompe uma animação de fitBounds ainda em andamento (o
        // frame pode demorar em GPUs de software).
        if (mapa.isMoving()) {
          reservarConclusao()
          return
        }
        concluirAproximacao()
      }, 3000)
    }

    mapa.once('moveend', concluirAproximacao)
    reservarConclusao()

    return () => {
      if (reserva != null) window.clearTimeout(reserva)
      mapa.off('moveend', concluirAproximacao)
    }
  }, [selectedUf, geojson])

  // Atalho de URL (?m=<cd_tse>&z=): enquadra o município e aplica o zoom pedido
  // uma única vez, depois que a animação de enquadramento da UF assentar.
  useEffect(() => {
    const mapa = mapRef.current
    const zoom = Number(zoomInicialRef.current)
    const bruto = zoomInicialRef.current
    if (!mapa || !municipioSelecionado || !detalhe) return undefined
    if (bruto == null || bruto === '' || !Number.isFinite(zoom)) return undefined

    const chave = String(municipioSelecionado.codarea)
    if (municipioZoomUrlRef.current === chave) return undefined

    const feature = detalhe.municipiosGeo?.features?.find(
      (item) => String(item.properties?.codarea) === chave,
    )
    const limites = limitesDaGeometria(feature?.geometry)
    if (!limites) return undefined

    const aplicar = () => {
      municipioZoomUrlRef.current = chave
      zoomInicialAplicadoRef.current = true
      mapa.fitBounds(limites, {
        padding: paddingDoMapa(),
        maxZoom: 13,
        duration: 0,
      })
      // O fitBounds com padding assimétrico (celular: bottom 72%) deixa a
      // câmera ao SUL do município para a cidade aparecer na faixa acima do
      // bottom sheet. Ao SUBIR o zoom por deep link (?z=) manter aquele centro
      // jogava a cidade para fora da tela: medido no celular, ?z=13 abria em
      // lat -4.224 e desenhava 0 locais dos 196. Com o zoom aplicado, o centro
      // passa a ser o centro do município, que é o que o deep link pede.
      // Ao DESCER o zoom, o centro calculado pelo fitBounds continua correto,
      // então só o zoom muda; a tolerância de 0.01 evita um salto inútil
      // quando o fitBounds já terminou no zoom pedido.
      const zoomAtual = mapa.getZoom()
      if (zoom > zoomAtual + 0.01) {
        const centroMunicipio = [
          (limites[0][0] + limites[1][0]) / 2,
          (limites[0][1] + limites[1][1]) / 2,
        ]
        mapa.jumpTo({ zoom, center: centroMunicipio })
      } else if (zoom < zoomAtual - 0.01) {
        mapa.jumpTo({ zoom })
      }
      mapa.easeTo({
        pitch: window.innerWidth <= 820 ? 30 : 50,
        bearing: 0,
        duration: 350,
      })
    }

    if (mapa.isMoving()) mapa.once('idle', aplicar)
    else aplicar()

    return () => {
      mapa.off('idle', aplicar)
    }
  }, [municipioSelecionado, detalhe])

  return <div className="map-canvas" ref={containerRef} />
}
