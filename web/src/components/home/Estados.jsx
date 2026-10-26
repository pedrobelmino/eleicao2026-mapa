import {
  corDoLider,
  fracaoSecoes,
  pct,
  semSecaoApurada,
} from './formato.js'

// Cartões das 27 UFs: sigla, fração apurada, líder e faixa proporcional.
// UF sem seção apurada vira estado de espera, sem líder nem faixa preenchida.
//
// cor = CANDIDATO (PL azul / PT vermelho), nunca = quem lidera: a cor sai do
// PARTIDO do líder da UF, então a mesma UF pintada de azul continua "PL" e uma
// UF onde o PT lidera fica VERMELHA em vez de herdar o azul de quem está à
// frente no país.
export default function Estados({ dados }) {
  const ufs = dados.ufs || []
  if (!ufs.length) return <p className="vazio">sem dado por estado.</p>

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

        const cor = corDoLider(uf)
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
