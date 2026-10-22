const formatoNumero = new Intl.NumberFormat('pt-BR')
const formatoDecimal = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const formatoApurado = new Intl.NumberFormat('pt-BR', {
  maximumFractionDigits: 1,
})
const formatoData = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Sao_Paulo',
})

export function numero(valor) {
  const n = Number(valor)
  return Number.isFinite(n) ? formatoNumero.format(n) : '—'
}

export function percentual(valor, casas = 2) {
  const n = Number(valor)
  if (!Number.isFinite(n)) return '—'
  if (casas === 2) return `${formatoDecimal.format(n)}%`
  return `${formatoApurado.format(n)}%`
}

export function pontos(valor) {
  const n = Number(valor)
  return Number.isFinite(n) ? formatoDecimal.format(n) : '—'
}

export function apuracao(valor) {
  const n = Number(valor)
  return Number.isFinite(n) ? `${formatoApurado.format(n)}%` : '—'
}

export function dataHora(iso) {
  if (!iso) return '—'
  const data = new Date(iso)
  if (Number.isNaN(data.getTime())) return String(iso)
  return formatoData.format(data).replace(',', '')
}

export function rotuloTurno(turno) {
  if (String(turno) === '2') return '2º turno'
  return '1º turno'
}
