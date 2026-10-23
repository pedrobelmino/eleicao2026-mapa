import { useState } from 'react'
import { fotoOficial, inicialDe } from '../candidatos.js'

/**
 * Avatar redondo do candidato.
 *
 * - Com foto oficial do TSE: <img> redondo.
 * - Sem foto (ou se o arquivo falhar no navegador): círculo neutro com a
 *   inicial do nome. Nunca cai em rosto de outra pessoa.
 *
 * O nome aparece escrito ao lado em todos os usos, então a imagem é decorativa
 * (alt vazio + aria-hidden) para não repetir o nome no leitor de tela.
 */
export default function Avatar({
  nome,
  partido,
  numero,
  tamanho = 32,
  className = '',
}) {
  const [falhou, setFalhou] = useState(false)
  const foto = fotoOficial({ nome, partido, numero })
  const estilo = { '--avatar': `${tamanho}px` }

  if (!foto || falhou) {
    return (
      <span
        className={`avatar avatar--inicial ${className}`.trim()}
        style={estilo}
        aria-hidden="true"
        title={nome ? `foto oficial não obtida — inicial de ${nome}` : 'foto oficial não obtida'}
      >
        {inicialDe(nome)}
      </span>
    )
  }

  return (
    <img
      className={`avatar ${className}`.trim()}
      style={estilo}
      src={foto.url}
      width={tamanho}
      height={tamanho}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      data-foto-oficial={foto.numero}
      onError={() => setFalhou(true)}
    />
  )
}
