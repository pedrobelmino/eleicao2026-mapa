export default function Legend() {
  return (
    <aside className="legend" aria-label="Legenda do mapa">
      <div className="legend-title">margem do líder (pontos)</div>
      <div className="legend-bar" aria-hidden="true" />
      <div className="legend-scale" aria-hidden="true">
        <span>40+</span>
        <span>0</span>
        <span>40+</span>
      </div>
      <div className="legend-parties" aria-hidden="true">
        <span className="legend-party legend-party--pl">PL</span>
        <span className="legend-party legend-party--pt">PT</span>
      </div>
      <p className="legend-note">fonte: TSE — dados públicos</p>
    </aside>
  )
}

export function ResumoLideres({ resumo }) {
  return (
    <div className="resumo-lideres" aria-label="Estados por partido do líder">
      <span className="resumo-item resumo-item--pl">
        <i aria-hidden="true" /> PL <strong>{resumo.PL}</strong>
      </span>
      <span className="resumo-item resumo-item--pt">
        <i aria-hidden="true" /> PT <strong>{resumo.PT}</strong>
      </span>
      {resumo.outros > 0 ? (
        <span className="resumo-item resumo-item--outros">
          <i aria-hidden="true" /> outros <strong>{resumo.outros}</strong>
        </span>
      ) : null}
      <span className="resumo-total">{resumo.total} UFs</span>
    </div>
  )
}
