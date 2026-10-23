import { coresCandidatos, pct } from './formato.js'

// Tabela região / apurado / candidatos / peso no país. O Nordeste ganha
// destaque, como na home antiga.
export default function Regioes({ dados }) {
  const regioes = dados.regioes || []
  if (!regioes.length) return <p className="vazio">sem dado por região.</p>

  const nacional = dados.nacional || {}
  const cores = coresCandidatos(nacional)
  const nomes = (nacional.candidatos || []).slice(0, 2).map((c) => c.nome)

  return (
    <div className="rolagem-x">
      <table className="tabela">
      <thead>
        <tr>
          <th>Região</th>
          <th className="dir">Apurado</th>
          {nomes.map((nome) => (
            <th className="dir" key={nome}>
              {nome}
            </th>
          ))}
          <th className="dir">Peso no país</th>
        </tr>
      </thead>
      <tbody>
        {regioes.map((regiao, indice) => {
          const porNome = {}
          for (const candidato of regiao.candidatos || []) {
            porNome[candidato.nome] = candidato
          }
          const apurado = Math.min(
            100,
            Math.max(0, Number(regiao.pct_apurado) || 0),
          )

          return (
            <tr
              className={regiao.regiao === 'Nordeste' ? 'destaque' : undefined}
              key={`${regiao.regiao}-${indice}`}
            >
              <td>
                <b>{regiao.regiao}</b>
                <div className="mini">
                  <span style={{ width: `${apurado}%` }} />
                </div>
              </td>
              <td className="dir">{pct(regiao.pct_apurado)}%</td>
              {nomes.map((nome) => {
                const candidato = porNome[nome] || {}
                return (
                  <td
                    className="dir"
                    style={{ color: cores[nome] || '#fff' }}
                    key={nome}
                  >
                    {pct(candidato.pct)}%
                  </td>
                )
              })}
              <td className="dir">{pct(regiao.share_votos)}%</td>
            </tr>
          )
        })}
      </tbody>
      </table>
    </div>
  )
}
