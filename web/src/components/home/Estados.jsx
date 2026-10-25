import { coresCandidatos, pct } from './formato.js'

// Cartões das 27 UFs: sigla, % apurado, líder e faixa proporcional.
export default function Estados({ dados }) {
  const ufs = dados.ufs || []
  if (!ufs.length) return <p className="vazio">sem dado por estado.</p>

  const nacional = dados.nacional || {}
  const cores = coresCandidatos(nacional)

  return (
    <div className="grade-ufs">
      {ufs.map((uf) => {
        const cor = cores[uf.lider] || '#b9b2a4'
        const largura = Math.min(
          100,
          Math.max(0, Number(uf.lider_pct) || 0),
        )

        return (
          <div className="uf" style={{ '--cor': cor }} key={uf.uf}>
            <div className="sigla">
              {uf.uf}
              <em>{pct(uf.pct_apurado, 0)}%</em>
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
