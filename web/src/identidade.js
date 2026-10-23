import { useEffect, useState } from 'react'
import { API_BASE, fetchJSON } from './api.js'

// Curadoria do card de estado (figurinhas emoji + destaques por UF), servida em
// /api/estados/identidade a partir de dados/estados_identidade.json.
//
// É enfeite de contexto: o download é feito UMA vez por sessão e, se a rota
// falhar, o card de estado aparece sem figurinha — o mapa nunca depende disto.
let cache = null
let emAndamento = null

function buscar() {
  if (cache) return Promise.resolve(cache)
  if (!emAndamento) {
    emAndamento = fetchJSON(`${API_BASE}/estados/identidade`)
      .then((resposta) => {
        const ufs = resposta?.UF
        cache = ufs && typeof ufs === 'object' ? ufs : {}
        return cache
      })
      .catch(() => {
        // Sem retry preso: a próxima montagem tenta de novo.
        emAndamento = null
        return {}
      })
  }
  return emAndamento
}

/** Identidade de uma UF ({ nome, apelido, figurinhas, destaques }) ou null. */
export function useIdentidade(sigla) {
  const [ufs, setUfs] = useState(cache)

  useEffect(() => {
    if (cache) {
      setUfs(cache)
      return undefined
    }
    let ativo = true
    buscar().then((valor) => {
      if (ativo) setUfs(valor)
    })
    return () => {
      ativo = false
    }
  }, [])

  if (!sigla || !ufs) return null
  return ufs[String(sigla).toUpperCase()] || null
}
