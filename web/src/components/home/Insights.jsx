const ROTULOS = {
  dado: ['DADO', 't-dado'],
  conta: ['CONTA', 't-conta'],
  estimativa: ['ESTIMATIVA', 't-estimativa'],
}

// Lista de insights publicados pelo painel, cada um com o selo do tipo.
export default function Insights({ dados }) {
  const itens = dados.insights || []

  if (!itens.length) {
    return <p className="vazio">Sem contas para mostrar neste momento.</p>
  }

  return (
    <>
      {itens.map((item, indice) => {
        const [nome, classe] = ROTULOS[item.tipo] || ROTULOS.conta
        return (
          <div className="insight" key={`${item.tipo}-${indice}`}>
            <span className={`tag ${classe}`}>{nome}</span>
            <p>{item.texto}</p>
          </div>
        )
      })}
    </>
  )
}
