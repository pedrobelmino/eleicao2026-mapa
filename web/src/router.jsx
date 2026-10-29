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

// Link legado (ADV-235): o portfólio saiu da /sobre e virou a rota /portfolio.
// O endereço antigo /sobre#portfolio continua sendo usado em links por aí e
// passa a cair em /portfolio.
export const ANCORA_LEGADA = 'portfolio'
export const ROTA_PORTFOLIO = '/portfolio'

// Troca a URL antes do primeiro render (chamada por main.jsx): o SPA é
// client-rendered, então sem isto a /sobre apareceria por um instante antes de
// o encaminhamento acontecer. Devolve true quando encaminhou.
export function encaminharLinkLegado() {
  const rota = normalizarRota(window.location.pathname)
  const ancora = window.location.hash.replace(/^#/, '')
  if (rota === '/sobre' && ancora === ANCORA_LEGADA) {
    window.history.replaceState({}, '', ROTA_PORTFOLIO)
    return true
  }
  return false
}

export function useRota() {
  const [rota, setRota] = useState(() =>
    normalizarRota(window.location.pathname),
  )

  useEffect(() => {
    const aoMudar = () => setRota(normalizarRota(window.location.pathname))
    // hashchange não muda o pathname: se o legado for acionado dentro da
    // própria /sobre, encaminharLinkLegado() já corrigiu a URL, e aqui só
    // avisamos o React.
    const aoMudarAncora = () => {
      if (encaminharLinkLegado()) setRota(ROTA_PORTFOLIO)
    }
    window.addEventListener('popstate', aoMudar)
    window.addEventListener('hashchange', aoMudarAncora)
    return () => {
      window.removeEventListener('popstate', aoMudar)
      window.removeEventListener('hashchange', aoMudarAncora)
    }
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
