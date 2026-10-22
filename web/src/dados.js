function margemPercentual(margemVotos, votosValidos) {
  const margem = Number(margemVotos)
  const vv = Number(votosValidos)
  if (!Number.isFinite(margem) || !Number.isFinite(vv) || vv <= 0) return 0
  return Math.round((margem / vv) * 100 * 100) / 100
}

/**
 * Junta as propriedades do GeoJSON (nome, região, margem) com os dados
 * eleitorais de /api/estados (candidatos, votos válidos). A chave é a sigla.
 */
export function indexarUFs(estados, geojson) {
  const porUF = new Map()

  for (const feature of geojson?.features || []) {
    const props = feature.properties || {}
    if (!props.uf) continue
    porUF.set(props.uf, {
      ...props,
      candidatos: [],
      margem_pct: Number(props.margem_pct) || 0,
    })
  }

  for (const uf of estados?.ufs || []) {
    const atual = porUF.get(uf.uf) || {}
    const candidatos = [...(uf.candidatos || [])].sort(
      (a, b) => Number(b.votos || 0) - Number(a.votos || 0),
    )
    const partidoLider =
      atual.partido_lider ||
      candidatos.find((c) => c.nome === uf.lider)?.partido ||
      ''
    const margemPct =
      Number.isFinite(Number(atual.margem_pct)) && atual.margem_pct !== undefined
        ? Number(atual.margem_pct)
        : margemPercentual(uf.margem_votos, uf.vv)

    porUF.set(uf.uf, {
      ...atual,
      ...uf,
      nome: atual.nome || uf.uf,
      regiao: uf.regiao || atual.regiao || '',
      partido_lider: partidoLider,
      margem_pct: margemPct,
      candidatos,
    })
  }

  return porUF
}

export function resumoLideres(porUF) {
  const resumo = { PL: 0, PT: 0, outros: 0, total: 0 }
  for (const uf of porUF.values()) {
    resumo.total += 1
    if (uf.partido_lider === 'PL') resumo.PL += 1
    else if (uf.partido_lider === 'PT') resumo.PT += 1
    else resumo.outros += 1
  }
  return resumo
}
