import { milhar, pct } from './formato.js'

function Etiqueta({ tipo }) {
  const classes = {
    TSE: 't-dado',
    CONTA: 't-conta',
    ESTIMATIVA: 't-estimativa',
  }
  return <span className={`tag ${classes[tipo]}`}>{tipo}</span>
}

// Painel do fenômeno: avanço por região e a conta do que falta para virar.
// A projeção é uma ESTIMATIVA com a premissa escrita ao lado; quando não falta
// seção, o bloco mostra o resultado oficial sem inventar projeção.
export default function Fenomeno({ dados }) {
  const nacional = dados.nacional || {}
  const candidatos = nacional.candidatos || []
  const regioes = dados.regioes || []
  const ufs = dados.ufs || []

  if (!candidatos.length) {
    return (
      <p className="vazio">sem dado para o painel do fenômeno neste turno.</p>
    )
  }

  const primeiro = candidatos[0]
  const segundo = candidatos[1] || null

  // 1) Regiões: ordem de entrada = % de seções já apuradas (maior primeiro).
  const comPct = regioes
    .filter(
      (regiao) =>
        regiao.pct_apurado !== null && regiao.pct_apurado !== undefined,
    )
    .sort(
      (a, b) => Number(b.pct_apurado || 0) - Number(a.pct_apurado || 0),
    )

  const barras = comPct.map((regiao, indice) => {
    const nomeRegiao = regiao.regiao || '?'
    const apurado = Math.max(
      0,
      Math.min(100, Number(regiao.pct_apurado) || 0),
    )
    const faltam = regiao.secoes_faltantes
    let faltaTexto
    if (faltam === null || faltam === undefined) {
      faltaTexto = 'seções faltantes sem dado'
    } else if (faltam) {
      faltaTexto = `faltam ${milhar(faltam)} seções`
    } else {
      faltaTexto = 'sem seções faltantes'
    }

    return (
      <div
        className={`barra-regiao${
          nomeRegiao === 'Nordeste' ? ' destaque-nordeste' : ''
        }`}
        key={`${nomeRegiao}-${indice}`}
      >
        <div className="rot">
          <b>{nomeRegiao}</b>
          <span>
            {pct(apurado)}% apurado · {faltaTexto}
          </span>
        </div>
        <div className="trilho">
          <span style={{ width: `${apurado.toFixed(2)}%` }} />
        </div>
      </div>
    )
  })

  const blocoBarras = barras.length ? (
    <>
      <div className="barras-regiao">{barras}</div>
      <p className="nota">
        Ordem de entrada das regiões pelo percentual de seções já apuradas. O{' '}
        <b>Nordeste</b> fica em destaque.
      </p>
    </>
  ) : (
    <p className="vazio">sem dado por região.</p>
  )

  // 2) Votos válidos restantes, UF por UF: (vv/st) × seções que faltam.
  const porUf = []
  for (const uf of ufs) {
    const st = uf.st
    const ts = uf.ts
    const vv = uf.vv
    if (
      st === null ||
      st === undefined ||
      ts === null ||
      ts === undefined ||
      vv === null ||
      vv === undefined ||
      Number(st) <= 0
    ) {
      continue
    }
    const faltam = Math.max(
      0,
      Math.trunc(Number(ts)) - Math.trunc(Number(st)),
    )
    const media = Number(vv) / Number(st)
    porUf.push({
      uf: uf.uf,
      faltam,
      media,
      restante: media * faltam,
    })
  }
  porUf.sort((a, b) => {
    if (b.restante !== a.restante) return b.restante - a.restante
    const ufA = String(a.uf || '')
    const ufB = String(b.uf || '')
    if (ufA < ufB) return -1
    if (ufA > ufB) return 1
    return 0
  })
  const restanteTotal = porUf.reduce((soma, item) => soma + item.restante, 0)

  let faltamTotal
  if (porUf.length) {
    faltamTotal = porUf.reduce((soma, item) => soma + item.faltam, 0)
  } else {
    const ts = nacional.ts
    const st = nacional.st
    faltamTotal =
      ts !== null && ts !== undefined && st !== null && st !== undefined
        ? Math.max(0, Math.trunc(Number(ts)) - Math.trunc(Number(st)))
        : null
  }

  const resultadoOficial = () => {
    const partes = [
      `${primeiro.nome} (${primeiro.partido}) ${milhar(
        primeiro.votos,
      )} votos (${pct(primeiro.pct, 2)}%)`,
    ]
    if (segundo) {
      partes.push(
        `${segundo.nome} (${segundo.partido}) ${milhar(
          segundo.votos,
        )} votos (${pct(segundo.pct, 2)}%)`,
      )
    }
    return partes.join(' · ')
  }

  const conta = []

  if (faltamTotal === 0) {
    conta.push(
      <p key="oficial">
        <Etiqueta tipo="TSE" /> A conta de votos restantes{' '}
        <b>não se aplica</b>: o TSE já apurou 100% das seções. Resultado
        oficial: {resultadoOficial()}.
      </p>,
    )
  } else if (faltamTotal === null) {
    conta.push(
      <p key="sem-faltantes">
        <Etiqueta tipo="TSE" /> Sem dado de seções faltantes para este turno;
        não há conta a fazer.
      </p>,
    )
  } else if (!segundo) {
    conta.push(
      <p key="um-candidato">
        <Etiqueta tipo="TSE" /> Só há um candidato com votos publicados; não
        existe 2º colocado para comparar.
      </p>,
    )
  } else if (primeiro.votos === null || segundo.votos === null) {
    conta.push(
      <p key="sem-votos">
        <Etiqueta tipo="TSE" /> Votos de 1º ou 2º ainda não publicados; a conta
        fica para a próxima parcial.
      </p>,
    )
  } else {
    const diferenca =
      Number(primeiro.votos || 0) - Number(segundo.votos || 0)
    const pontos =
      Number(primeiro.pct || 0) - Number(segundo.pct || 0)

    conta.push(
      <p key="diferenca">
        <Etiqueta tipo="CONTA" /> {primeiro.nome} está{' '}
        <b>{milhar(Math.abs(diferenca))} votos</b> (
        {pct(Math.abs(pontos), 2)} ponto(s)) à frente de {segundo.nome}.
      </p>,
    )

    if (restanteTotal > 0) {
      const necessario = (100 * diferenca) / restanteTotal
      const votosRestantes = milhar(Math.round(restanteTotal))
      const frase =
        necessario <= 100 ? (
          <>
            O 2º colocado precisaria de <b>{pct(necessario)}%</b> dos{' '}
            {votosRestantes} votos válidos restantes estimados para empatar.
          </>
        ) : (
          <>
            O 2º colocado precisaria de <b>{pct(necessario)}%</b> dos{' '}
            {votosRestantes} votos válidos restantes estimados — mais de 100%,
            então nem todos os votos restantes bastariam pela premissa.
          </>
        )

      conta.push(
        <p key="estimativa">
          <Etiqueta tipo="ESTIMATIVA" /> {frase}
        </p>,
      )
      conta.push(
        <p className="nota" key="premissa">
          <b>Premissa da estimativa:</b> os votos válidos restantes de cada UF
          são a média de votos válidos por seção já apurada (vv ÷ st)
          multiplicada pelas seções que faltam. O 1º colocado não recebe nenhum
          desses votos; é o mínimo que o 2º precisa para empatar. Projeção, não
          resultado.
        </p>,
      )
    } else {
      conta.push(
        <p key="sem-base">
          <Etiqueta tipo="ESTIMATIVA" /> Sem base para estimar votos restantes:
          nenhuma UF tem seção apurada com votos válidos publicados.
        </p>,
      )
    }
  }

  let tabela = null
  if (porUf.length && faltamTotal) {
    tabela = (
      <details>
        <summary>Ver a conta por UF ({porUf.length} UFs)</summary>
        <table className="tabela">
          <thead>
            <tr>
              <th>UF</th>
              <th className="dir">Seções faltando</th>
              <th className="dir">Votos válidos por seção</th>
              <th className="dir">Válidos restantes estimados</th>
            </tr>
          </thead>
          <tbody>
            {porUf.map((item) => (
              <tr key={item.uf}>
                <td>
                  <b>{item.uf}</b>
                </td>
                <td className="dir">{milhar(item.faltam)}</td>
                <td className="dir">{pct(item.media)}</td>
                <td className="dir">
                  {milhar(Math.round(item.restante))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="nota">
          A soma das UFs é a base da estimativa; UF sem seção apurada fica fora
          da conta.
        </p>
      </details>
    )
  }

  return (
    <div className="fenomeno">
      {blocoBarras}
      <div className="conta">
        {conta}
        {tabela}
      </div>
    </div>
  )
}
