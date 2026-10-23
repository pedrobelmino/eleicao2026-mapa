// Placar nacional em UM lugar só.
//
// A barra fina do topo, a gaveta do celular, a legenda e o painel do desktop
// mostram os mesmos dois candidatos. Antes cada componente procurava o seu e
// arredondava a margem do seu jeito; aqui a conta é feita uma vez e o resto do
// app só formata.
//
// Campos do /api/estados usados aqui (vindos do TSE):
//   nacional.candidatos[].nome | partido | votos | pct
//   nacional.vv  = votos válidos
//   nacional.tv  = total de votos (válidos + brancos + nulos)
//   nacional.te  = total de eleitores aptos
//   nacional.comparecimento (== tv no TSE), vb = brancos, tvn = nulos
//   nacional.ts / st = seções apuradas / total de seções
//   nacional.pct_apurado = % das seções apuradas
import { CORES_PARTIDO } from './mapa.js'

export const NOMES = {
  flavio: { nome: 'FLAVIO BOLSONARO', partido: 'PL' },
  lula: { nome: 'LULA', partido: 'PT' },
}

// Nome primeiro (o campo oficial), partido como reserva. Nunca por índice: a
// ordem do arquivo do TSE não é contrato.
export function acharCandidato(nacional, nome, partido) {
  const candidatos = nacional?.candidatos || []
  return (
    candidatos.find((c) => c.nome === nome) ||
    candidatos.find((c) => c.partido === partido) ||
    null
  )
}

function inteiro(valor) {
  const n = Number(valor)
  return Number.isFinite(n) ? Math.round(n) : null
}

// Duas casas, sem o 1.8699999 do ponto flutuante.
function duasCasas(valor) {
  const n = Number(valor)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

function razao(parte, todo) {
  const a = Number(parte)
  const b = Number(todo)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null
  return duasCasas((a / b) * 100)
}

export function dueloNacional(nacional) {
  const flavio = acharCandidato(nacional, NOMES.flavio.nome, NOMES.flavio.partido)
  const lula = acharCandidato(nacional, NOMES.lula.nome, NOMES.lula.partido)

  const votosFlavio = inteiro(flavio?.votos)
  const votosLula = inteiro(lula?.votos)
  const pctFlavio = Number.isFinite(Number(flavio?.pct)) ? duasCasas(flavio.pct) : null
  const pctLula = Number.isFinite(Number(lula?.pct)) ? duasCasas(lula.pct) : null

  const temDuelo = votosFlavio != null && votosLula != null
  const margemVotos = temDuelo ? Math.abs(votosFlavio - votosLula) : null
  const margemPontos =
    pctFlavio != null && pctLula != null ? duasCasas(Math.abs(pctFlavio - pctLula)) : null

  const validos = inteiro(nacional?.vv)
  const votosTotais = inteiro(nacional?.tv)
  const eleitores = inteiro(nacional?.te)
  const comparecimento =
    inteiro(nacional?.comparecimento) ?? inteiro(nacional?.tv)
  const abstencoes =
    eleitores != null && comparecimento != null
      ? Math.max(eleitores - comparecimento, 0)
      : null

  const secoesApuradas = inteiro(nacional?.ts)
  const secoesTotal = inteiro(nacional?.st)

  // Quem está na frente (por votos). Serve para o resumo da gaveta e para a
  // linha de líder do painel — não para colorir nada.
  let lider = null
  if (temDuelo) {
    const vencedor = votosFlavio >= votosLula ? NOMES.flavio : NOMES.lula
    const candidato = votosFlavio >= votosLula ? flavio : lula
    const perdedor = votosFlavio >= votosLula ? NOMES.lula : NOMES.flavio
    const candidatoPerdedor = votosFlavio >= votosLula ? lula : flavio
    lider = {
      nome: vencedor.nome,
      partido: vencedor.partido,
      cor: CORES_PARTIDO[vencedor.partido] || null,
      votos: inteiro(candidato?.votos),
      pct: duasCasas(candidato?.pct),
      atras: {
        nome: perdedor.nome,
        partido: perdedor.partido,
        votos: inteiro(candidatoPerdedor?.votos),
        pct: duasCasas(candidatoPerdedor?.pct),
      },
    }
  }

  return {
    flavio,
    lula,
    lider,
    // Margem do líder: em votos absolutos e em pontos percentuais.
    margemVotos,
    margemPontos,
    // Peso da margem dentro dos votos válidos (o "quanto falta" em %).
    margemValidos: margemVotos != null ? razao(margemVotos, validos) : null,
    validos,
    votosTotais,
    eleitores,
    comparecimento,
    abstencoes,
    // Participação = comparecimento / eleitores aptos.
    participacao: razao(comparecimento, eleitores),
    pctValidos: razao(validos, votosTotais),
    pctApurado: duasCasas(nacional?.pct_apurado),
    secoesApuradas,
    secoesTotal,
    pctSecoes: razao(secoesApuradas, secoesTotal),
  }
}
