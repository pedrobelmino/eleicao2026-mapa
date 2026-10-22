package main

// Painel de métricas em HTML puro (sem JavaScript): a política de CSP do nginx
// não permite script inline, e a página não precisa de script — recarrega
// sozinha por <meta refresh>. Texto sempre escapado.

import (
	"fmt"
	"html"
	"strconv"
	"strings"
)

type montagemPainel struct {
	GeradoEm string
	Uptime   int64
	Total    uint64
	Classes  map[string]uint64
	TaxaErro float64
	Latencia latenciaResumo
	Rotas    []map[string]any
	Saude    []saudeServico
	Limites  estatisticasLimite
	Anonimo  map[string]any
	Recarga  bool
}

func montarPainelMetricas(m montagemPainel) string {
	var b strings.Builder

	b.WriteString(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">`)
	b.WriteString(`<meta name="viewport" content="width=device-width, initial-scale=1">`)
	b.WriteString(`<meta name="robots" content="noindex, nofollow">`)
	if m.Recarga {
		b.WriteString(`<meta http-equiv="refresh" content="20">`)
	}
	b.WriteString(`<title>Métricas · eleição 2026</title><style>`)
	b.WriteString(`
:root{color-scheme:dark}
body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
header{padding:16px 20px;border-bottom:1px solid #21262d;display:flex;flex-wrap:wrap;gap:16px;align-items:baseline}
h1{font-size:16px;margin:0;letter-spacing:.02em}
.selo{font-size:12px;color:#8b949e}
main{padding:16px 20px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
section{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px 14px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8b949e;margin:0 0 10px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:3px 4px;border-bottom:1px solid #21262d;text-align:left;vertical-align:top}
th{color:#8b949e;font-weight:500}
td.n{text-align:right;font-variant-numeric:tabular-nums}
.ok{color:#3fb950}.ruim{color:#f85149}.aviso{color:#d29922}
.grande{font-size:22px;font-variant-numeric:tabular-nums}
footer{padding:12px 20px;color:#8b949e;font-size:12px;border-top:1px solid #21262d}
</style></head><body>`)

	b.WriteString(`<header><h1>Métricas · eleição 2026</h1>`)
	fmt.Fprintf(&b, `<span class="selo">gerado %s · uptime %s</span>`, html.EscapeString(m.GeradoEm), duracao(m.Uptime))
	b.WriteString(`<span class="selo">recarrega a cada 20 s</span></header><main>`)

	// Acessos
	b.WriteString(`<section><h2>Acessos</h2><table>`)
	fmt.Fprintf(&b, `<tr><td>Requisições</td><td class="n grande">%d</td></tr>`, m.Total)
	fmt.Fprintf(&b, `<tr><td>2xx / 3xx</td><td class="n">%d / %d</td></tr>`, m.Classes["2xx"], m.Classes["3xx"])
	fmt.Fprintf(&b, `<tr><td>4xx / 5xx</td><td class="n">%d / %d</td></tr>`, m.Classes["4xx"], m.Classes["5xx"])
	classeErro := "ok"
	if m.TaxaErro >= 1 {
		classeErro = "aviso"
	}
	if m.TaxaErro >= 5 {
		classeErro = "ruim"
	}
	fmt.Fprintf(&b, `<tr><td>Taxa de erro</td><td class="n %s">%.2f%%</td></tr>`, classeErro, m.TaxaErro)
	b.WriteString(`</table></section>`)

	// Latência
	b.WriteString(`<section><h2>Latência (ms)</h2><table>`)
	fmt.Fprintf(&b, `<tr><td>p50</td><td class="n">%.2f</td></tr>`, m.Latencia.P50)
	fmt.Fprintf(&b, `<tr><td>p95</td><td class="n">%.2f</td></tr>`, m.Latencia.P95)
	fmt.Fprintf(&b, `<tr><td>p99</td><td class="n">%.2f</td></tr>`, m.Latencia.P99)
	fmt.Fprintf(&b, `<tr><td>máx</td><td class="n">%.2f</td></tr>`, m.Latencia.Max)
	fmt.Fprintf(&b, `<tr><td>média</td><td class="n">%.2f</td></tr>`, m.Latencia.Media)
	fmt.Fprintf(&b, `<tr><td>amostras</td><td class="n">%d</td></tr>`, m.Latencia.Amostras)
	b.WriteString(`</table></section>`)

	// Limites
	b.WriteString(`<section><h2>Rate limit</h2><table>`)
	fmt.Fprintf(&b, `<tr><td>recusas 429</td><td class="n">%d</td></tr>`, m.Limites.Rejeitados429)
	fmt.Fprintf(&b, `<tr><td>recusas 503</td><td class="n">%d</td></tr>`, m.Limites.Rejeitados503)
	fmt.Fprintf(&b, `<tr><td>em andamento</td><td class="n">%d / %d</td></tr>`, m.Limites.EmAndamento, m.Limites.MaxTotal)
	fmt.Fprintf(&b, `<tr><td>IPs ativos</td><td class="n">%d</td></tr>`, m.Limites.IPsAtivos)
	fmt.Fprintf(&b, `<tr><td>por IP</td><td class="n">%.0f/s · rajada %.0f · %d simult.</td></tr>`,
		m.Limites.TaxaPorIP, m.Limites.RajadaPorIP, m.Limites.MaxPorIP)
	b.WriteString(`</table></section>`)

	// Saúde
	b.WriteString(`<section><h2>Saúde</h2><table>`)
	for _, servico := range m.Saude {
		classe, marca := "ok", "ok"
		if !servico.OK {
			classe, marca = "ruim", "falha"
		}
		fmt.Fprintf(&b, `<tr><td>%s</td><td class="%s">%s</td><td>%s</td></tr>`,
			html.EscapeString(servico.Servico), classe, marca, html.EscapeString(servico.Detalhe))
	}
	b.WriteString(`</table></section>`)

	// Rotas
	b.WriteString(`<section><h2>Rotas mais chamadas</h2><table><tr><th>rota</th><th>req</th><th>erros</th><th>média</th></tr>`)
	for _, rota := range m.Rotas {
		fmt.Fprintf(&b, `<tr><td>%s</td><td class="n">%v</td><td class="n">%v</td><td class="n">%v ms</td></tr>`,
			html.EscapeString(textoDe(rota["rota"])), rota["requisicoes"], rota["erros"], rota["media_ms"])
	}
	if len(m.Rotas) == 0 {
		b.WriteString(`<tr><td colspan="4">sem requisições ainda</td></tr>`)
	}
	b.WriteString(`</table></section>`)

	// Visitas anônimas
	b.WriteString(`<section><h2>Visitas (anônimas)</h2>`)
	if m.Anonimo == nil {
		b.WriteString(`<p class="aviso">banco de visitas indisponível</p>`)
	} else {
		hoje, _ := m.Anonimo["hoje"].(map[string]any)
		total, _ := m.Anonimo["total"].(map[string]any)
		fmt.Fprintf(&b, `<table><tr><td>hoje</td><td class="n">%v visitas · %v pessoas</td></tr>`,
			hoje["visitas"], hoje["pessoas"])
		fmt.Fprintf(&b, `<tr><td>total</td><td class="n">%v visitas · %v pessoas</td></tr>`,
			total["visitas"], total["pessoas"])
		if bots, ok := m.Anonimo["bots_filtrados"]; ok {
			fmt.Fprintf(&b, `<tr><td>robôs filtrados</td><td class="n">%v</td></tr>`, bots)
		}
		if fonte, ok := m.Anonimo["fonte_geo"].(string); ok {
			fmt.Fprintf(&b, `<tr><td>geo</td><td>%s</td></tr>`, html.EscapeString(fonte))
		}
		b.WriteString(`</table>`)
	}
	b.WriteString(`</section>`)

	b.WriteString(`</main><footer>`)
	b.WriteString(`métricas locais do processo Go · nenhum IP em claro · token obrigatório`)
	b.WriteString(`</footer></body></html>`)

	return b.String()
}

func textoDe(valor any) string {
	switch v := valor.(type) {
	case string:
		return v
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

func duracao(segundos int64) string {
	if segundos < 60 {
		return strconv.FormatInt(segundos, 10) + "s"
	}
	if segundos < 3600 {
		return strconv.FormatInt(segundos/60, 10) + "min"
	}
	if segundos < 86400 {
		return fmt.Sprintf("%dh%02d", segundos/3600, (segundos%3600)/60)
	}
	dias := segundos / 86400
	return fmt.Sprintf("%dd%02dh", dias, (segundos%86400)/3600)
}

