export const CARTO_POSITRON =
  'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'

export const CORES_PARTIDO = {
  PL: '#1e58a8',
  PT: '#c8102e',
}

export const COR_NEUTRA = '#9aa0a6'

export const PARTIDO_LIDER_PL = 'PL'
export const PARTIDO_LIDER_PT = 'PT'

export function corDoPartido(partido) {
  return CORES_PARTIDO[partido] || COR_NEUTRA
}

// Limites de zoom de cada nível. São a ÚNICA fonte da verdade: a legenda, as
// camadas do mapa e os atalhos de prova usam estes números.
//   < ZONA        -> estado (coroplético das UFs)
//   ZONA..MUN     -> zona eleitoral (prismas)
//   MUN..LOCAL    -> município (malha municipal colorida)
//   >= LOCAL      -> local de votação (pontos/prismas por local)
export const ZOOM_ZONA = 4.6
export const ZOOM_MUNICIPIO = 7.4
export const ZOOM_LOCAL = 9.2

// Faixa das BARRAS DE ZONA NO NÍVEL DE CIDADE. O polígono inteiro da zona só
// serve para a faixa de estado; perto da cidade ele cobriria o município
// todo, então a mesma barra passa a ser desenhada num losango pequeno no
// centroide da zona (ver prepararZonas em cidade.js). ZOOM_BARRA_ZONA_FIM é o
// fim da barra: acima disso o nível é local puro.
export const ZOOM_BARRA_ZONA = 7.4
export const ZOOM_BARRA_ZONA_FIM = 12.2

// Altura da barra na faixa de cidade = altura_m (proporcional aos votos
// válidos da zona) × este fator. Sem o fator, a coluna de Fortaleza teria
// 102 km e não caberia na tela. Com 0.06 a coluna de uma zona grande tem
// 6000 m (≈14 px em z=8.5, ≈40 px em z=9.5, ≈86 px em z=10.5) e continua sendo
// a MESMA escala nas duas larguras de losango, para o cross-fade 9.3..9.9 não
// dar pulo de altura.
export const FATOR_ALTURA_BARRA_CIDADE = 0.06

// Chaves internas SEM acento: são usadas como nome de camada/legenda no código
// e um acento aqui derrubava a legenda (TEXTOS['município'] != TEXTOS.municipio).
export const NIVEIS_ZOOM = ['estado', 'zona', 'municipio', 'local']

// Texto para o usuário (com acento) na mesma ordem de NIVEIS_ZOOM.
export const NIVEIS_ZOOM_TEXTO = ['estado', 'zona', 'município', 'local']

export const ROTULO_NIVEL = {
  estado: 'estado (UF)',
  zona: 'zona eleitoral',
  municipio: 'município',
  local: 'local de votação (urna)',
}

export function nivelPorZoom(zoom) {
  const z = Number(zoom)
  if (!Number.isFinite(z) || z < ZOOM_ZONA) return 'estado'
  if (z < ZOOM_MUNICIPIO) return 'zona'
  if (z < ZOOM_LOCAL) return 'municipio'
  return 'local'
}

// Expressão data-driven do preenchimento coroplético.
// PL: azul claro (margem 0) -> azul profundo (margem >= 40 pontos).
// PT: vermelho claro (margem 0) -> vinho (margem >= 40 pontos).
// Outros partidos: cinza.
const margemLimitada = [
  'max',
  ['min', ['coalesce', ['get', 'margem_pct'], 0], 40],
  0,
]

// Expressão data-driven da cor do líder (PL azul, PT vermelho, outros cinza),
// com intensidade pela margem em pontos.
const EXPRESSAO_CANDIDATO = [
  'match',
  ['get', 'partido_lider'],
  'PL',
  [
    'interpolate',
    ['linear'],
    margemLimitada,
    0,
    '#c9d9ee',
    10,
    '#a8c1e2',
    20,
    '#789bcd',
    30,
    '#3e6cae',
    40,
    '#0b2b5e',
  ],
  'PT',
  [
    'interpolate',
    ['linear'],
    margemLimitada,
    0,
    '#f3cdd1',
    10,
    '#e9a3ac',
    20,
    '#d66d7c',
    30,
    '#b3364d',
    40,
    '#7a0a1c',
  ],
  '#9aa0a6',
]

// Cinza de concreto: estado (ou segmento) cuja apuração ainda não fechou.
export const COR_CONCRETO = '#b8b3aa'

// Preenchimento dos MUNICÍPIOS: predominância do líder (sem seções apuradas
// por município no GeoJSON, então a regra do concreto não se aplica aqui).
export const EXPRESSAO_COR = EXPRESSAO_CANDIDATO

// Preenchimento do ESTADO. Regra do Pedro (REGRA-COR-ESTADO.txt): cor de
// candidato SÓ quando `secoes_apuradas == secoes_total` e o total é conhecido;
// com a apuração em andamento a UF fica em concreto. É uma regra de exibição
// lida do dado oficial, nunca de estimativa.
export const EXPRESSAO_COR_UF = [
  'case',
  [
    'all',
    ['>', ['coalesce', ['get', 'secoes_total'], 0], 0],
    [
      '==',
      ['coalesce', ['get', 'secoes_apuradas'], 0],
      ['coalesce', ['get', 'secoes_total'], 0],
    ],
  ],
  EXPRESSAO_CANDIDATO,
  COR_CONCRETO,
]

// Tempo do "acender" quando a UF fecha a apuração: a transição é do MapLibre
// sobre a própria expressão, então a cor entra em fade em vez de trocar seco.
export const TRANSICAO_COR_UF = { duration: 900, delay: 0 }

// ---------------------------------------------------------------------------
// REPLAY: no replay as propriedades do GeoJSON continuam sendo as do pleito
// atual, então cor/UF não podem sair de ['get', ...]. O estado por UF vem por
// feature-state (fonte `ufs`, id = sigla):
//   fechada  -> booleano: seções apuradas == total de seções daquela UF
//   partido  -> partido do líder da UF no arquivo de 2022
//   margem   -> margem do líder em pontos (0..40 na rampa)
// `fechada=false` é concreto; `true` acende com a cor do líder. Mesma regra do
// concreto da apuração ao vivo, só que lida do frame do replay.
const margemFeatureState = [
  'max',
  ['min', ['coalesce', ['feature-state', 'margem'], 0], 40],
  0,
]

export const EXPRESSAO_COR_UF_REPLAY = [
  'case',
  ['boolean', ['feature-state', 'fechada'], false],
  [
    'match',
    ['coalesce', ['feature-state', 'partido'], ''],
    'PL',
    [
      'interpolate',
      ['linear'],
      margemFeatureState,
      0,
      '#c9d9ee',
      10,
      '#a8c1e2',
      20,
      '#789bcd',
      30,
      '#3e6cae',
      40,
      '#0b2b5e',
    ],
    'PT',
    [
      'interpolate',
      ['linear'],
      margemFeatureState,
      0,
      '#f3cdd1',
      10,
      '#e9a3ac',
      20,
      '#d66d7c',
      30,
      '#b3364d',
      40,
      '#7a0a1c',
    ],
    COR_NEUTRA,
  ],
  COR_CONCRETO,
]

// Mapa de calor de MARGEM (toggle): ignora a regra do concreto e pinta a UF
// pela intensidade da margem do líder em pontos — 0 ponto é creme, 40+ é vinho.
// É a leitura "onde a disputa está apertada / onde está folgada", que a cor por
// candidato esconde quando a margem é pequena nos dois lados.
const margemPropriedade = [
  'max',
  ['min', ['coalesce', ['get', 'margem_pct'], 0], 40],
  0,
]

export const EXPRESSAO_COR_MARGEM = [
  'interpolate',
  ['linear'],
  margemPropriedade,
  0,
  '#f7efe2',
  8,
  '#f5cf7e',
  16,
  '#eda24e',
  26,
  '#d1622f',
  36,
  '#8e2a26',
]


