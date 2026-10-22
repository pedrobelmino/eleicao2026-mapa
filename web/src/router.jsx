import { useEffect, useState } from 'react'

// Router mínimo, sem dependência externa. A rota é sempre o pathname atual,
// normalizado: "/mapa" e "/mapa/" apontam para o mesmo lugar.
export function normalizarRota(caminho) {
  if (!caminho) return '/'
  let rota = caminho
  // Remove barras finais, menos a da raiz.
  if (rota.length > 1) rota = rota.replace(/\/+$/, '')
  return rota || '/'
}

export function useRota() {
  const [rota, setRota] = useState(() =>
    normalizarRota(window.location.pathname),
  )

  useEffect(() => {
    const aoMudar = () => setRota(normalizarRota(window.location.pathname))
    window.addEventListener('popstate', aoMudar)
    return () => window.removeEventListener('popstate', aoMudar)
  }, [])

  return rota
}

// navega() troca a URL sem recarregar a página. Como pushState/replaceState não
// disparam popstate, avisamos os ouvintes com um evento próprio.
export function navega(caminho, { substituir = false } = {}) {
  const destino = normalizarRota(caminho)
  if (normalizarRota(window.location.pathname) === destino) return

  if (substituir) {
    window.history.replaceState({}, '', destino)
  } else {
    window.history.pushState({}, '', destino)
  }
  window.dispatchEvent(new PopStateEvent('popstate'))
}
