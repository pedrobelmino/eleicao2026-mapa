// Formatação e cores usadas pelos blocos da home. As regras seguem a home
// antiga: ponto de milhar, vírgula decimal e "—" quando o dado falta.

export const CORES = ['#4f8cff', '#ff5a67', '#f5c542', '#3ddc97']

export const CORES_2022 = {
  LULA: '#ff5a67',
  'JAIR BOLSONARO': '#4f8cff',
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
