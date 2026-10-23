// Fotos OFICIAIS do TSE (eleição 6257, presidente) — 161x225, JPEG.
//
// Procedência (dados/fotos_candidatos.json, gerado por scripts/fotos_candidatos.py):
//   JSON oficial: .../oficial/ele2026/6257/dados/br/br-c0001-e006257-u.json
//   Foto:         .../oficial/ele2026/6257/fotos/br/<sqcand>.jpeg
//   LULA 13 / PT          sqcand 280002542548  sha256 f3e9d937…ab19
//   FLAVIO BOLSONARO 22 / PL  sqcand 280002551544  sha256 3f29c484…a917
//
// A identidade não é deduzida: o arquivo baixado é o mesmo que o TSE publica
// para aquele sqcand, e o sqcand vem do JSON oficial de resultados, onde o nome
// do candidato está escrito. Se a foto não estiver disponível, o componente
// Avatar cai na inicial do nome — nunca em um rosto de outra pessoa.
export const FOTOS_OFICIAIS = [
  { numero: '13', nome: 'LULA', partido: 'PT', arquivo: 'candidato-13.jpeg' },
  {
    numero: '22',
    nome: 'FLAVIO BOLSONARO',
    partido: 'PL',
    arquivo: 'candidato-22.jpeg',
  },
]

// Partido só identifica candidato quando há UM candidato daquele partido na
// disputa majoritária (é o caso de PT e PL em 2026). Fora disso, nada de foto.
const NUMERO_POR_PARTIDO = { PT: '13', PL: '22' }

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Devolve a foto oficial do candidato, ou null quando não há como garantir de
 * quem é o rosto. Aceita { nome, partido } ou { numero }.
 */
export function fotoOficial({ nome, partido, numero } = {}) {
  const porNumero = FOTOS_OFICIAIS.find((c) => c.numero === String(numero || ''))
  if (porNumero) return urlDaFoto(porNumero)

  const alvo = normalizar(nome)
  if (alvo) {
    // Nome completo ou primeiro nome ("LULA" casa com "LULA").
    const primeiro = alvo.split(' ')[0]
    const porNome = FOTOS_OFICIAIS.find(
      (c) =>
        normalizar(c.nome) === alvo ||
        (primeiro.length >= 3 && normalizar(c.nome).startsWith(primeiro)),
    )
    if (porNome) return urlDaFoto(porNome)
  }

  const sigla = normalizar(partido)
  const numeroDoPartido = NUMERO_POR_PARTIDO[sigla]
  if (numeroDoPartido) {
    const porPartido = FOTOS_OFICIAIS.find((c) => c.numero === numeroDoPartido)
    if (porPartido) return urlDaFoto(porPartido)
  }

  return null
}

function urlDaFoto(candidato) {
  return {
    ...candidato,
    url: `${import.meta.env.BASE_URL}${candidato.arquivo}`,
  }
}

/** Inicial usada no avatar neutro quando a foto oficial não está disponível. */
export function inicialDe(nome) {
  const limpo = normalizar(nome)
  if (!limpo) return '?'
  if (limpo === 'OUTROS CANDIDATOS') return '+'
  return limpo[0]
}
