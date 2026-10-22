import { apuracao, dataHora, rotuloTurno } from '../format.js'

export default function Header({ estados, erro }) {
  const carregado = Boolean(estados)
  const meta = carregado
    ? `${rotuloTurno(estados.turno)} · apuração ${apuracao(
        estados.nacional?.pct_apurado,
      )} · atualizado ${dataHora(estados.gerado_em)}`
    : erro
      ? 'apuração indisponível'
      : 'carregando apuração…'

  return (
    <header className="site-header">
      <div className="brand">
        <span className="brand-seal" aria-hidden="true">
          2026
        </span>
        <div className="brand-copy">
          <h1>
            Eleição 2026 <span className="dash">—</span> Presidente
          </h1>
          <p className="header-meta">{meta}</p>
        </div>
      </div>

      <div className="header-badge" title="Eleição e turno publicados pela API">
        <span>{carregado ? estados.eleicao : '—'}</span>
        <span className="badge-sep" aria-hidden="true">
          ·
        </span>
        <span>{carregado ? rotuloTurno(estados.turno) : '—'}</span>
      </div>
    </header>
  )
}
