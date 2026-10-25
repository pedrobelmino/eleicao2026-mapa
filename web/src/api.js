// Todas as chamadas usam caminho relativo à base do app (a raiz em produção).
// Em desenvolvimento o proxy do Vite encaminha /api para a API Go.
export const API_BASE = `${import.meta.env.BASE_URL}api`

// Contador de requisições de DADOS feitas pelo app. Serve para a prova de que
// o polling pausa com a aba oculta (scripts/provas/autorefresh.mjs): nada é
// inventado no relatório, o número sai daqui.
export const contadorDados = { total: 0, ultima: null }

export function zerarContadorDados() {
  contadorDados.total = 0
  contadorDados.ultima = null
}

export async function fetchJSON(path) {
  let resposta
  try {
    resposta = await fetch(path, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
  } catch (erro) {
    const falha = new Error('Não foi possível conectar à API.')
    falha.causa = erro
    throw falha
  }

  if (!resposta.ok) {
    const falha = new Error(`A API respondeu com erro ${resposta.status}.`)
    falha.status = resposta.status
    throw falha
  }

  try {
    const dados = await resposta.json()
    contadorDados.total += 1
    contadorDados.ultima = path
    // Handle de prova: quantas leituras de DADOS esta aba fez. É o número que
    // sustenta "com a aba oculta não sai requisição" (e não um relato).
    if (typeof window !== 'undefined') window.__dadosRequisicoes = contadorDados.total
    return dados
  } catch {
    const falha = new Error('A API devolveu uma resposta que não é JSON.')
    falha.status = resposta.status
    throw falha
  }
}
