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
