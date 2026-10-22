const PORTAL_TSE = 'https://resultados.tse.jus.br/'

// Fontes por estado: site do TRE e o JSON público do TSE de cada UF.
export default function Fontes({ dados }) {
  const linhas = dados.fontes_ufs || []
  if (!linhas.length) {
    return <p className="vazio">sem dado das fontes por estado.</p>
  }

  return (
    <>
      <table className="tabela fontes-uf">
        <thead>
          <tr>
            <th>UF</th>
            <th>Região</th>
            <th>Fonte estadual</th>
            <th>Dado oficial</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((linha) => (
            <tr key={linha.uf}>
              <td>
                <b>{linha.uf}</b>
                <div className="nome">{linha.nome}</div>
              </td>
              <td>{linha.regiao}</td>
              <td>
                <a
                  href={linha.tre}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  TRE
                </a>
              </td>
              <td>
                <a
                  href={linha.json}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  JSON do TSE
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="nota">
        Os links abrem em nova aba. Portal de resultados do TSE:{' '}
        <a href={PORTAL_TSE} target="_blank" rel="noopener noreferrer">
          resultados.tse.jus.br
        </a>
        .
      </p>
    </>
  )
}
