import {
  coresCandidatos,
  fracaoSecoes,
  pct,
  semSecaoApurada,
} from './formato.js'

// Cartões das 27 UFs: sigla, fração apurada, líder e faixa proporcional.
// UF sem seção apurada vira estado de espera, sem líder nem faixa preenchida.
export default function Estados({ dados }) {
  const ufs = dados.ufs || []
  if (!ufs.length) return <p className="vazio">sem dado por estado.</p>

  const nacional = dados.nacional || {}
  const cores = coresCandidatos(nacional)

  return (
    <div className="grade-ufs">
      {ufs.map((uf) => {
        if (semSecaoApurada(uf)) {
          return (
            <div className="uf aguardando" key={uf.uf}>
              <div className="sigla">
                {uf.uf}
                <em>aguardando</em>
              </div>
              <div className="lider">sem seções apuradas ainda</div>
              <div className="faixa espera" />
            </div>
          )
        }

        const cor = cores[uf.lider] || '#b9b2a4'
        const largura = Math.min(
          100,
          Math.max(0, Number(uf.lider_pct) || 0),
        )

        return (
          <div className="uf" style={{ '--cor': cor }} key={uf.uf}>
            <div className="sigla">
              {uf.uf}
              <em>{fracaoSecoes(uf)}</em>
            </div>
            <div className="lider">
              {uf.lider || 'sem dado'} {pct(uf.lider_pct)}%
            </div>
            <div className="faixa">
              <span style={{ width: `${largura}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
