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

export const EXPRESSAO_COR = [
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
