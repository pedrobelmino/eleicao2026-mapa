import { numero, percentual, pontos } from '../format.js'

// Card "DE ONDE ESTÁ GANHANDO": margem do líder nacional em votos e em pontos,
// a contribuição por região e os municípios que decidem (margem × peso).
//
// Nada aqui é estimativa: o backend soma voto publicado. O índice de decisão é
// margem em pontos × peso do município nos votos válidos do país — as duas
// dimensões que a leitura "onde decide" precisa ter juntas.

function LinhaRegiao({ regiao, liderNacional }) {
  const aFavor = regiao.lider === liderNacional
  return (
    <li className="margem-linha">
      <span className="margem-nome">{regiao.nome}</span>
      <span className={`margem-sinal ${aFavor ? 'is-favor' : 'is-contra'}`}>
        {aFavor ? '+' : '−'}
        {pontos(regiao.margem_pontos)} pts
      </span>
      <span className="margem-votos">{numero(regiao.margem_votos)}</span>
    </li>
  )
}

function LinhaMunicipio({ municipio, referencia }) {
  const largura = referencia > 0 ? Math.max(4, (municipio.indice / referencia) * 100) : 0
  return (
    <li className="margem-municipio">
      <div className="margem-municipio-topo">
        <span className="margem-nome">
          {municipio.municipio}
          <span className="margem-uf">{municipio.uf}</span>
        </span>
        <span className="margem-sinal is-favor">
          +{pontos(municipio.margem_pontos)} pts · {numero(municipio.margem_votos)}
        </span>
      </div>
      <span className="margem-barra" aria-hidden="true">
        <span style={{ width: `${largura}%` }} data-partido={municipio.partido_lider} />
      </span>
    </li>
  )
}

export default function MargensCard({ margens, carregando, erro, onFechar }) {
  const nacional = margens?.nacional
  const regioes = Array.isArray(margens?.regioes) ? margens.regioes : []
  const decisivos = Array.isArray(margens?.decisivos) ? margens.decisivos.slice(0, 8) : []
  const referencia = decisivos.length > 0 ? decisivos[0].indice : 0
  const virou = margens?.virou

  return (
    <section className="margens-card" aria-label="De onde está ganhando">
      <div className="margens-head">
        <span className="eyebrow">De onde está ganhando</span>
        <button
          type="button"
          className="margens-sair"
          onClick={onFechar}
          aria-label="Fechar o painel de margens"
        >
          ×
        </button>
      </div>

      {erro ? <p className="margem-erro">{erro}</p> : null}
      {carregando && !nacional ? (
        <p className="margem-carregando">calculando margens…</p>
      ) : null}

      {nacional ? (
        <>
          <div className="margens-nacional">
            <span className="margens-lider">{nacional.lider || '—'}</span>
            <div className="margens-numeros">
              <div>
                <strong data-prova="margem-votos">{numero(nacional.margem_votos)}</strong>
                <span>votos de margem</span>
              </div>
              <div>
                <strong data-prova="margem-pontos">
                  {pontos(nacional.margem_pontos)}
                </strong>
                <span>pontos ({percentual(nacional.lider_pct)} a {percentual(nacional.segundo_pct)})</span>
              </div>
            </div>
          </div>

          <h3 className="margens-sub">Por região</h3>
          {regioes.length > 0 ? (
            <ul className="margens-lista">
              {regioes.map((regiao) => (
                <LinhaRegiao
                  key={regiao.nome}
                  regiao={regiao}
                  liderNacional={nacional.lider}
                />
              ))}
            </ul>
          ) : (
            <p className="margem-carregando">sem regiões calculadas</p>
          )}

          <h3 className="margens-sub">Municípios decisivos</h3>
          {decisivos.length > 0 ? (
            <ul className="margens-municipios">
              {decisivos.map((municipio) => (
                <LinhaMunicipio
                  key={`${municipio.uf}-${municipio.cd_tse}`}
                  municipio={municipio}
                  referencia={referencia}
                />
              ))}
            </ul>
          ) : (
            <p className="margem-carregando">sem base municipal apurada</p>
          )}

          {virou ? (
            <p className="margem-virou">
              Virou em relação a 2022: {numero(virou.total_ufs)} UF(s) e{' '}
              {numero(virou.total_municipios)} município(s) de{' '}
              {numero(virou.municipios_apurados)}.
            </p>
          ) : null}

          <p className="margem-nota">{margens.nota}</p>
        </>
      ) : null}
    </section>
  )
}
