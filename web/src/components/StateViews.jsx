export default function StateViews({ tipo, erro, onTentarNovamente }) {
  if (tipo === 'loading') {
    return (
      <main className="state-view">
        <div className="loading-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="state-title">carregando a apuração…</p>
        <p className="state-detail">buscando estados e malha eleitoral</p>
      </main>
    )
  }

  const status = erro?.status ? `HTTP ${erro.status}` : 'falha de rede'

  return (
    <main className="state-view" role="alert">
      <span className="state-icon" aria-hidden="true">
        !
      </span>
      <p className="state-title">não foi possível carregar o mapa</p>
      <p className="state-detail">
        {status}
        {erro?.message ? ` · ${erro.message}` : ''}
      </p>
      <p className="state-hint">
        Os dados vêm de <code>/mapa/api/estados</code> e{' '}
        <code>/mapa/api/ufs.geojson</code>. Verifique se a API está no ar e
        tente de novo.
      </p>
      <button type="button" className="state-button" onClick={onTentarNovamente}>
        tentar de novo
      </button>
    </main>
  )
}
