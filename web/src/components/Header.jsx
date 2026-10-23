import { apuracao, dataHora, rotuloTurno } from '../format.js'

// `aoVivo` chega do replay (MapWorkspace -> Mapa): enquanto ele corre, o
// cabeçalho mostra o percentual e o carimbo DO PASSO, não o arquivo fechado.
// Sem replay a prop é null e o texto volta ao valor oficial da apuração.
export default function Header({ estados, erro, aoVivo = null }) {
  const carregado = Boolean(estados)
  const meta = aoVivo
    ? `${rotuloTurno(estados?.turno)} · replay ${apuracao(aoVivo.pct)} apurado · ${aoVivo.carimbo}`
    : carregado
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
          <p className="header-meta" data-prova="header-meta" data-fonte={aoVivo ? 'replay' : 'oficial'}>
            {meta}
          </p>
        </div>
      </div>

      <div
        className="header-badge"
        title={`código da eleição no TSE · ${
          carregado ? rotuloTurno(estados.turno) : '1º turno'
        }`}
        aria-label={`eleição no TSE: código ${carregado ? estados.eleicao : '—'}, ${
          carregado ? rotuloTurno(estados.turno) : '1º turno'
        }`}
      >
        <span className="badge-label" title="código da eleição no TSE">
          eleição TSE
        </span>
        <span className="badge-valor">
          {carregado ? estados.eleicao : '—'}
        </span>
        <span className="badge-sep" aria-hidden="true">
          ·
        </span>
        <span className="badge-valor">
          {carregado ? rotuloTurno(estados.turno) : '—'}
        </span>
      </div>
    </header>
  )
}
