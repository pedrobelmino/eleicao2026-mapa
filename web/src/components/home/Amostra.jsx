import { AMOSTRA_PISO, pct } from './formato.js'

// Selo para avisar que a apuração ainda é uma amostra pequena. Acima do piso
// (ou sem número válido) o selo não aparece.
export default function SeloAmostra({ nacional }) {
  const apurado = Number(nacional?.pct_apurado)
  if (apurado >= AMOSTRA_PISO || !Number.isFinite(apurado)) return null

  return (
    <p className="selo-amostra" role="status">
      <b>amostra parcial</b> — {pct(nacional.pct_apurado, 2)}% das seções apuradas
    </p>
  )
}
