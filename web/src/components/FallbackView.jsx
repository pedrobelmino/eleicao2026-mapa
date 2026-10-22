import NationalScoreboard from './NationalScoreboard.jsx'
import { ResumoLideres } from './Legend.jsx'
import { corDoPartido } from '../mapa.js'
import { numero, pontos } from '../format.js'

export default function FallbackView({ ufs, estados, resumo }) {
  const lista = [...ufs.values()].sort((a, b) =>
    String(a.nome).localeCompare(String(b.nome), 'pt-BR'),
  )

  return (
    <main className="fallback-view">
      <div className="fallback-inner">
        <div className="fallback-alert" role="status">
          <span className="fallback-icon" aria-hidden="true">
            !
          </span>
          <div>
            <strong>seu navegador não tem WebGL — visão simplificada</strong>
            <p>
              O mapa interativo não pôde ser exibido. A apuração continua
              disponível na tabela abaixo, com a cor e a margem de cada estado.
            </p>
          </div>
        </div>

        <div className="fallback-top">
          <NationalScoreboard estados={estados} variante="fallback" />
          <div className="fallback-resumo">
            <span className="eyebrow">Estados por líder</span>
            <ResumoLideres resumo={resumo} />
            <p>
              Dados públicos do TSE. A cor indica o partido do líder; a
              intensidade, a margem de vitória no estado.
            </p>
          </div>
        </div>

        <div className="fallback-table-wrap">
          <table className="fallback-table">
            <caption className="sr-only">
              Resultado da eleição presidencial por estado
            </caption>
            <thead>
              <tr>
                <th scope="col">UF</th>
                <th scope="col">Estado</th>
                <th scope="col" className="col-regiao">
                  Região
                </th>
                <th scope="col">Líder</th>
                <th scope="col" className="col-margem">
                  Margem (pts)
                </th>
                <th scope="col" className="col-votos">
                  Margem (votos)
                </th>
              </tr>
            </thead>
            <tbody>
              {lista.map((uf) => {
                const cor = corDoPartido(uf.partido_lider)
                return (
                  <tr key={uf.uf}>
                    <td>
                      <span
                        className="uf-chip"
                        style={{ '--party-color': cor }}
                      >
                        {uf.uf}
                      </span>
                    </td>
                    <td>
                      <strong>{uf.nome}</strong>
                    </td>
                    <td className="col-regiao">{uf.regiao}</td>
                    <td>
                      <span className="fallback-lider">
                        <i
                          className="party-dot"
                          style={{ background: cor }}
                          aria-hidden="true"
                        />
                        <span>
                          {uf.lider}
                          <small>{uf.partido_lider}</small>
                        </span>
                      </span>
                    </td>
                    <td className="col-margem num">{pontos(uf.margem_pct)}</td>
                    <td className="col-votos num">{numero(uf.margem_votos)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  )
}
