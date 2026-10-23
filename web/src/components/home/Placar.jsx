import { coresCandidatos, CORES, milhar, pct } from './formato.js'
import Avatar from '../Avatar.jsx'

// Placar nacional com os dois primeiros colocados, na ordem publicada pelo TSE.
// A barra proporcional e a legenda ficam no mesmo grid dos cartões, como na
// home antiga.
export default function Placar({ dados }) {
  const nacional = dados.nacional || {}
  const cores = coresCandidatos(nacional)
  const candidatos = (nacional.candidatos || []).slice(0, 2)

  if (!candidatos.length) {
    return (
      <p className="vazio">
        O TSE ainda não publicou candidatos para este turno.
      </p>
    )
  }

  return (
    <>
      {candidatos.map((candidato) => {
        const cor = cores[candidato.nome] || CORES[0]

        return (
          <div className="cand" style={{ '--cor': cor }} key={candidato.nome}>
            <div className="nome">
              <Avatar
                nome={candidato.nome}
                partido={candidato.partido}
                tamanho={42}
                className="placar-avatar"
              />
              <span>{candidato.nome}</span>
              <em>{candidato.partido}</em>
            </div>
            <div className="num">{pct(candidato.pct, 2)}%</div>
            <div className="votos">{milhar(candidato.votos)} votos</div>
          </div>
        )
      })}

      <div className="barra" aria-hidden="true">
        {candidatos.map((candidato) => {
          const cor = cores[candidato.nome] || CORES[0]
          const largura = Math.max(0, Math.min(100, Number(candidato.pct) || 0))
          return (
            <div
              key={candidato.nome}
              style={{ width: `${largura}%`, background: cor }}
            />
          )
        })}
      </div>

      <div className="legenda">
        {candidatos.map((candidato) => {
          const cor = cores[candidato.nome] || CORES[0]
          return (
            <span key={candidato.nome}>
              <b style={{ background: cor }} />
              {candidato.nome}
            </span>
          )
        })}
        <span>percentual sobre votos válidos</span>
      </div>
    </>
  )
}
