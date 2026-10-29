import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { encaminharLinkLegado } from './router.jsx'
import 'maplibre-gl/dist/maplibre-gl.css'
import './styles.css'

// Link legado /sobre#portfolio -> /portfolio (ADV-235). Antes do render, para a
// página errada não piscar na tela.
encaminharLinkLegado()

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { erro: null }
  }

  static getDerivedStateFromError(erro) {
    return { erro }
  }

  componentDidCatch(erro, info) {
    console.error('Erro inesperado na interface:', erro, info)
  }

  render() {
    if (this.state.erro) {
      return (
        <div className="app">
          <header className="site-header">
            <div className="brand">
              <span className="brand-seal" aria-hidden="true">
                2026
              </span>
              <div className="brand-copy">
                <h1>
                  Eleição 2026 <span className="dash">—</span> Presidente
                </h1>
                <p className="header-meta">mapa da apuração</p>
              </div>
            </div>
          </header>
          <main className="state-view" role="alert">
            <span className="state-icon" aria-hidden="true">
              !
            </span>
            <p className="state-title">a interface encontrou um erro</p>
            <p className="state-detail">
              A página continua disponível. Recarregue para tentar de novo.
            </p>
            <button
              type="button"
              className="state-button"
              onClick={() => window.location.reload()}
            >
              recarregar
            </button>
          </main>
        </div>
      )
    }

    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
