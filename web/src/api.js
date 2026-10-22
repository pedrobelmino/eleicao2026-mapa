// Todas as chamadas usam caminho relativo à base do app (/mapa/ em produção).
// Em desenvolvimento o proxy do Vite encaminha /mapa/api para a API Go.
export const API_BASE = `${import.meta.env.BASE_URL}api`

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
    return await resposta.json()
  } catch {
    const falha = new Error('A API devolveu uma resposta que não é JSON.')
    falha.status = resposta.status
    throw falha
  }
}
