import { numero, percentual, pontos } from '../format.js'

// Card "DE ONDE ESTÁ GANHANDO" (item 6 do ROADMAP).
//
// Duas metades, com fontes diferentes e declaradas:
//   municípios -> /api/uf/{UF}/margens: margem por município da UF aberta, já
//                 ordenada pelo backend por margem_votos × vv (margem × peso);
//   nacional   -> /api/margens: margem do líder do país e contribuição por
//                 região.
//
// Nada aqui é estimativa: o backend soma voto publicado. O card corta no top 10
// e marca quem trocou o partido do líder em relação a 2022.

const TOP_DECISIVOS = 10

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

function textoDelta(delta) {
  if (delta == null || !Number.isFinite(Number(delta))) return null
  const valor = Number(delta)
  return `${valor > 0 ? '+' : ''}${pontos(valor)} pts`
}

// Uma linha da lista de decisivos: nome, quem lidera, margem em VOTOS e em
// PONTOS e a marca de quem virou em 2022.
function LinhaDecisivo({ municipio, referencia }) {
  const peso = Math.abs(Number(municipio.margem_votos) || 0) * (Number(municipio.vv) || 0)
  const largura = referencia > 0 ? Math.max(4, (peso / referencia) * 100) : 0
  const virou = municipio.virou_2022 === true
  const delta = textoDelta(municipio.delta_pp_2022)

  return (
    <li
      className={`margem-municipio${virou ? ' is-virou' : ''}`}
      data-prova="margem-decisivo"
      data-virou={virou ? '1' : '0'}
    >
      <div className="margem-municipio-topo">
        <span className="margem-nome">
          {municipio.nome}
          {virou ? (
            <span className="margem-vira" data-prova="margem-vira-marca">
              virou
            </span>
          ) : null}
        </span>
        <span className="margem-sinal is-favor" data-prova="margem-municipio-margem">
          {numero(municipio.margem_votos)} votos · {pontos(municipio.margem_pct)} pts
        </span>
      </div>
      <div className="margem-municipio-base">
        <span className="margem-lider" data-prova="margem-municipio-lider">
          {municipio.partido_lider || '—'} · {municipio.lider || '—'}
        </span>
        {delta ? <span className="margem-delta">{delta} desde 2022</span> : null}
      </div>
      <span className="margem-barra" aria-hidden="true">
        <span style={{ width: `${largura}%` }} data-partido={municipio.partido_lider} />
      </span>
    </li>
  )
}

export default function MargensCard({
  margens,
  carregando,
  erro,
  margensUf,
  uf,
  carregandoUf,
  erroUf,
  onFechar,
}) {
  const nacional = margens?.nacional
  const regioes = Array.isArray(margens?.regioes) ? margens.regioes : []
  const municipios = Array.isArray(margensUf?.municipios) ? margensUf.municipios : []
  const decisivos = municipios.slice(0, TOP_DECISIVOS)
  const referencia =
    decisivos.length > 0
      ? Math.abs(Number(decisivos[0].margem_votos) || 0) * (Number(decisivos[0].vv) || 0)
      : 0
  const viraram = Number(margensUf?.total_viraram) || 0
  const total = Number(margensUf?.total_municipios) || municipios.length

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

      {/* ------------------------------------------------------- MUNICÍPIOS */}
      {uf ? (
        <>
          <h3 className="margens-sub">
            Municípios decisivos · {uf}
            <span className="margens-sub-nota">margem × peso</span>
          </h3>

          {erroUf ? <p className="margem-erro">{erroUf}</p> : null}
          {carregandoUf && decisivos.length === 0 ? (
            <p className="margem-carregando">calculando margens dos municípios…</p>
          ) : null}

          {decisivos.length > 0 ? (
            <>
              <p className="margem-contagem" data-prova="margem-viraram">
                <strong>{numero(viraram)}</strong> viraram em relação a 2022 · de{' '}
                {numero(total)} municípios
              </p>
              <ul className="margens-municipios">
                {decisivos.map((municipio) => (
                  <LinhaDecisivo
                    key={`${municipio.codarea}-${municipio.nome}`}
                    municipio={municipio}
                    referencia={referencia}
                  />
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : (
        <p className="margem-carregando">
          escolha um estado no mapa para ver os municípios decisivos
        </p>
      )}

      {/* --------------------------------------------------------- NACIONAL */}
      {/* O texto de carregamento só existe quando o card NÃO tem dado nenhum:
          com a lista de decisivos (ou o bloco nacional) na tela ele sai de
          cena — era o defeito de mostrar "calculando margens…" embaixo de uma
          lista de 10 municípios já renderizada. */}
      {carregando && !nacional && decisivos.length === 0 ? (
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
                <span>
                  pontos ({percentual(nacional.lider_pct)} a{' '}
                  {percentual(nacional.segundo_pct)})
                </span>
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

          {margens?.virou && !uf ? (
            <p className="margem-virou">
              Virou em relação a 2022: {numero(margens.virou.total_ufs)} UF(s) e{' '}
              {numero(margens.virou.total_municipios)} município(s) de{' '}
              {numero(margens.virou.municipios_apurados)}.
            </p>
          ) : null}

          <p className="margem-nota">{margens.nota}</p>
        </>
      ) : null}

      {margensUf?.nota ? (
        <p className="margem-nota" data-prova="margem-nota-uf">
          {margensUf.nota}
        </p>
      ) : null}
    </section>
  )
}
