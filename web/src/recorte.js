// RECORTE — procedência do dado gravado no arquivo versus turno do painel.
//
// O painel acompanha a apuração do turno configurado na API (ELEICAO/TURNO do
// ambiente). Município, zona e local de votação NÃO: o TSE só publica o dump
// por seção ao final de cada turno, então durante a apuração do 2º turno esses
// arquivos continuam sendo os do 1º. Desenhar zona/município do 1º turno num
// mapa rotulado de 2º é o pior defeito possível neste projeto — daí este
// módulo comparar a procedência que CADA payload declara (campos `eleicao` e
// `turno`, gravados pelo gerador) com o turno do painel.
//
// A regra é: divergiu, esconde a camada e diz o motivo na tela. Nunca deduzir
// pelo rótulo do ambiente (aquele é o turno EM EXIBIÇÃO, não o do arquivo).

const ROTULOS_TURNO = { 1: '1º turno', 2: '2º turno' }

// Turno em número: aceita 1, '1', '2º turno', '1 turno', 'turno 2'.
// Devolve null quando não há turno legível (payload antigo, sem procedência).
export function normalizarTurno(valor) {
  if (valor == null) return null
  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? Math.trunc(valor) : null
  }
  const texto = String(valor).trim().toLowerCase()
  if (!texto) return null
  const achado = texto.match(/\d+/)
  if (!achado) return null
  const numero = Number(achado[0])
  return Number.isFinite(numero) ? numero : null
}

export function normalizarEleicao(valor) {
  if (valor == null) return null
  const texto = String(valor).trim()
  return texto || null
}

export function rotuloTurno(valor) {
  const turno = normalizarTurno(valor)
  if (turno == null) return 'turno não declarado'
  return ROTULOS_TURNO[turno] || `turno ${turno}`
}

// Extrai a procedência de um payload da API. `mesmo_turno` (quando o backend
// mandar) manda mais que a comparação numérica: é o próprio backend afirmando
// se o arquivo é do turno em exibição.
export function lerProcedencia(payload) {
  if (!payload || typeof payload !== 'object') return null
  return {
    eleicao: normalizarEleicao(payload.eleicao),
    turno: normalizarTurno(payload.turno),
    mesmoTurno:
      typeof payload.mesmo_turno === 'boolean' ? payload.mesmo_turno : null,
  }
}

// compararRecorte({ painel, fonte }) -> recorte
//
//   painel: { eleicao, turno }            (o que a tela está exibindo)
//   fonte:  { eleicao, turno, mesmo_turno} (o que o arquivo declara ter)
//
// Campos do retorno:
//   conhecida   — a fonte declarou procedência? (sem ela não se esconde nada:
//                 esconder por ausência de campo apagaria camada que funcionava)
//   divergente  — TRUE é o único caso que esconde zona/município/local.
//   eleicao, turno, rotuloFonte, rotuloPainel — para o texto do aviso.
//   chave       — muda quando o recorte muda; serve para rearmar o toggle
//                 "ver o turno anterior".
export function compararRecorte({ painel, fonte } = {}) {
  const painelEleicao = normalizarEleicao(painel?.eleicao)
  const painelTurno = normalizarTurno(painel?.turno)
  const fonteEleicao = normalizarEleicao(fonte?.eleicao)
  const fonteTurno = normalizarTurno(fonte?.turno)
  const mesmoTurno =
    typeof fonte?.mesmo_turno === 'boolean' ? fonte.mesmo_turno : null

  const base = {
    painelEleicao,
    painelTurno,
    eleicao: fonteEleicao,
    turno: fonteTurno,
    rotuloPainel: painelTurno == null ? null : rotuloTurno(painelTurno),
    rotuloFonte: fonteTurno == null ? null : rotuloTurno(fonteTurno),
    chave: `${painelEleicao || '?'}/${painelTurno ?? '?'}|${fonteEleicao || '?'}/${fonteTurno ?? '?'}|${mesmoTurno}`,
  }

  // Declaração explícita do backend tem precedência.
  if (mesmoTurno === true) {
    return { ...base, conhecida: true, divergente: false }
  }

  const conhecida = Boolean(fonteEleicao || fonteTurno != null)

  if (mesmoTurno === false) {
    return { ...base, conhecida: true, divergente: true }
  }

  if (!conhecida) {
    return { ...base, conhecida: false, divergente: false }
  }

  const eleicaoDiverge =
    fonteEleicao != null && painelEleicao != null && fonteEleicao !== painelEleicao
  const turnoDiverge =
    fonteTurno != null && painelTurno != null && fonteTurno !== painelTurno

  return { ...base, conhecida: true, divergente: eleicaoDiverge || turnoDiverge }
}

// Texto único do aviso, para a tela não inventar frase diferente em cada lugar.
export function motivoDoBloqueio(recorte) {
  if (!recorte?.divergente) return null
  const alvo = recorte.rotuloPainel || 'turno em exibição'
  const partes = []
  if (recorte.rotuloFonte) partes.push(`arquivo do ${recorte.rotuloFonte}`)
  if (recorte.eleicao) partes.push(`eleição ${recorte.eleicao}`)
  const disponivel = partes.length
    ? ` Dado disponível: ${partes.join(', ')}.`
    : ''
  return (
    `O recorte por zona e local do ${alvo} só é publicado pelo TSE ao final da ` +
    'apuração. Enquanto isso, o mapa mostra o resultado por UF.' +
    disponivel
  )
}
