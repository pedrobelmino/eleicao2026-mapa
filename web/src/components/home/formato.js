// Formatação e cores usadas pelos blocos da home. As regras seguem a home
// antiga: ponto de milhar, vírgula decimal e "—" quando o dado falta.

export const CORES = ['#1e58a8', '#c8102e', '#8a5a00', '#0f766e']

// Abaixo deste piso a amostra ainda é pequena demais para parecer resultado.
export const AMOSTRA_PISO = 5

export const CORES_2022 = {
  LULA: '#c8102e',
  'JAIR BOLSONARO': '#1e58a8',
}

export function milhar(valor) {
  if (valor === null || valor === undefined || valor === '') return '—'
  const numero = Number(valor)
  if (!Number.isFinite(numero)) return '—'
  return Math.trunc(numero)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

export function pct(valor, casas = 1) {
  if (valor === null || valor === undefined || valor === '') return '—'
  const numero = Number(valor)
  if (!Number.isFinite(numero)) return '—'
  return numero.toFixed(casas).replace('.', ',')
}

// Sem seção apurada não existe resultado para desenhar.
export function semSecaoApurada(item) {
  if (item?.st === null || item?.st === undefined) return true
  return Number(item.st) <= 0
}

// Fração de seções apuradas no rótulo da amostra ("0,41% das seções").
export function fracaoSecoes(item) {
  const valor = item?.pct_apurado
  if (valor === null || valor === undefined || valor === '') {
    return '— das seções'
  }
  if (!Number.isFinite(Number(valor))) return '— das seções'
  return `${pct(valor, 2)}% das seções`
}

export function coresCandidatos(nacional) {
  const mapa = {}
  for (const [indice, candidato] of (nacional?.candidatos || []).entries()) {
    mapa[candidato.nome] = CORES[indice % CORES.length]
  }
  return mapa
}

export function origemDe(ponto) {
  return ponto?.origem || 'primeira_coleta'
}

export function resumoOrigem(pontos) {
  const contagem = new Map()
  for (const ponto of pontos) {
    const origem = origemDe(ponto)
    contagem.set(origem, (contagem.get(origem) || 0) + 1)
  }
  return [...contagem.entries()]
    .map(([origem, total]) => `${origem} (${total})`)
    .join(' · ')
}

export function pontosValidos(pontos) {
  return (pontos || []).filter(
    (ponto) =>
      ponto &&
      ponto.pct_apurado !== null &&
      ponto.pct_apurado !== undefined &&
      !Number.isNaN(Number(ponto.pct_apurado)),
  )
}
