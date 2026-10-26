// Formatação e cores usadas pelos blocos da home. As regras seguem a home
// antiga: ponto de milhar, vírgula decimal e "—" quando o dado falta.
//
// COR = CANDIDATO (PL azul / PT vermelho), NUNCA = quem lidera.
// Regra do Pedro (25/10/2026): FLAVIO BOLSONARO (PL) é SEMPRE #1e58a8 e LULA
// (PT) é SEMPRE #c8102e, em toda a interface — placar, barras, tabelas por
// região/UF, legenda, tooltip e mapa. A cor não pode mudar com o líder do
// momento nem com a posição do candidato na lista do TSE (a lista vem ordenada
// por votos: colorir por índice pintava de azul quem estava na frente).
import { CORES_PARTIDO, COR_NEUTRA } from '../../mapa.js'

// Paleta por PARTIDO. Nada aqui é posicional: um partido desconhecido fica
// cinza neutro em vez de herdar a cor da posição na lista.
export const CORES = CORES_PARTIDO
export { COR_NEUTRA }

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

// Cor padrão de um candidato: PARTIDO, nunca índice/posição.
// PL (Flávio Bolsonaro) -> azul; PT (Lula) -> vermelho; resto -> cinza neutro.
export function corDoCandidato(candidato) {
  const partido = String(candidato?.partido || '').toUpperCase()
  return CORES_PARTIDO[partido] || COR_NEUTRA
}

// Partido do líder de uma UF/região: lido da lista de candidatos DAQUELE item
// (nome -> partido). A cor sai do partido, nunca da ordem de chegada.
export function partidoDoLider(item) {
  const lider = item?.lider
  if (!lider) return ''
  const achou = (item?.candidatos || []).find((c) => c?.nome === lider)
  return String(achou?.partido || '').toUpperCase()
}

// Cor do líder de uma UF/região: só o PARTIDO do líder; sem partido, cinza
// neutro. Nunca a posição na lista.
export function corDoLider(item) {
  const partido = partidoDoLider(item)
  return CORES_PARTIDO[partido] || COR_NEUTRA
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
