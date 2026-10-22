// Selos de procedência dos blocos: TSE, CONTA e ESTIMATIVA.
const ROTULOS = {
  TSE: ['TSE', 't-dado'],
  CONTA: ['CONTA', 't-conta'],
  ESTIMATIVA: ['ESTIMATIVA', 't-estimativa'],
}

export default function Selos({ tipos = [] }) {
  return (
    <span className="selos">
      {tipos.map((tipo) => {
        const [nome, classe] = ROTULOS[tipo] || [tipo, 't-conta']
        return (
          <span className={`tag ${classe}`} key={tipo}>
            {nome}
          </span>
        )
      })}
    </span>
  )
}
