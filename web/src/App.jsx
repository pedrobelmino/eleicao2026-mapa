import Home from './pages/Home.jsx'
import Mapa from './pages/Mapa.jsx'
import { navega, useRota } from './router.jsx'

function NaoEncontrado() {
  return (
    <div className="home-app">
      <main className="nao-encontrado">
        <p className="codigo">404</p>
        <h1>página não encontrada</h1>
        <p>O endereço não existe neste painel. Escolha uma das páginas abaixo.</p>
        <nav>
          <a
            href="/"
            onClick={(evento) => {
              evento.preventDefault()
              navega('/')
            }}
          >
            ir para a home
          </a>
          <a
            href="/mapa"
            className="secundario"
            onClick={(evento) => {
              evento.preventDefault()
              navega('/mapa')
            }}
          >
            abrir o mapa
          </a>
        </nav>
      </main>
    </div>
  )
}

export default function App() {
  const rota = useRota()

  if (rota === '/') return <Home />
  if (rota === '/mapa') return <Mapa />
  return <NaoEncontrado />
}
