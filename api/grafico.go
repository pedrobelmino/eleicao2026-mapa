package main

import (
	"fmt"
	"html"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// pontoGrafico representa um ponto do eixo X com a contagem de cada série.
type pontoGrafico struct {
	Rotulo string
	Humano int
	Bot    int
}

const (
	graficoCorHumano = "#3fb950"
	graficoCorBot    = "#8b949e"
	graficoCorTexto  = "#e6edf3"
)

// graficoEstilo concentra o CSS interno do bloco. Não há nenhum recurso externo.
const graficoEstilo = `<style>
.grafico-barras {
  margin: 0;
  padding: 16px;
  background: transparent;
  color: #e6edf3;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  line-height: 1.3;
}
.grafico-barras figcaption {
  margin: 0 0 10px;
  color: #e6edf3;
  font-size: 15px;
  font-weight: 700;
}
.grafico-barras svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
  background: transparent;
}
.grafico-barras .grade {
  stroke: #30363d;
  stroke-width: 1;
}
.grafico-barras .eixo {
  stroke: #484f58;
  stroke-width: 1;
}
.grafico-barras .rotulo {
  fill: #e6edf3;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.grafico-barras .rotulo-y {
  font-size: 11px;
}
.grafico-barras .valor {
  fill: #e6edf3;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  font-weight: 600;
}
.grafico-barras .legenda {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 10px;
  color: #e6edf3;
  font-size: 12px;
}
.grafico-barras .legenda-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.grafico-barras .quadrado {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
.grafico-barras .quadrado-humano {
  background: #3fb950;
}
.grafico-barras .quadrado-bot {
  background: #8b949e;
}
</style>`

// graficoBarrasSVG devolve um bloco HTML com um gráfico de barras agrupadas em
// SVG inline. Toda a apresentação fica no próprio bloco, sem JavaScript, CDN,
// imagens ou CSS externos.
func graficoBarrasSVG(pontos []pontoGrafico, titulo string, largura, altura int) string {
	if len(pontos) == 0 {
		return `<p class="vazio">sem dados</p>`
	}

	// Dimensões de segurança para chamadas com valores ausentes ou inválidos.
	if largura <= 0 {
		largura = 760
	}
	if altura <= 0 {
		altura = 400
	}

	// Margens internas do viewBox. A inferior cresce um pouco quando há rótulos
	// longos, que são desenhados inclinados.
	margemEsquerda := 62.0
	if largura < 360 {
		margemEsquerda = 44
	}
	margemDireita := 22.0
	margemSuperior := 28.0
	margemInferior := graficoMargemInferior(pontos, altura)

	plotEsquerda := margemEsquerda
	plotDireita := float64(largura) - margemDireita
	plotTopo := margemSuperior
	plotBase := float64(altura) - float64(margemInferior)
	if plotDireita <= plotEsquerda+12 {
		plotDireita = plotEsquerda + 12
	}
	if plotBase <= plotTopo+12 {
		plotBase = plotTopo + 12
	}
	plotLargura := plotDireita - plotEsquerda
	plotAltura := plotBase - plotTopo

	maximo, passo := graficoEscalaY(pontos)
	grupoLargura := plotLargura / float64(len(pontos))

	// Cada série ocupa no máximo 32% do grupo, deixando um vão no centro.
	larguraBarra := grupoLargura * 0.32
	if larguraBarra > 30 {
		larguraBarra = 30
	}
	if larguraBarra < 1 {
		larguraBarra = 1
	}
	vao := math.Min(6, grupoLargura*0.08)

	var b strings.Builder
	b.WriteString(`<figure class="grafico-barras">`)
	b.WriteString(graficoEstilo)
	fmt.Fprintf(&b, `<figcaption>%s</figcaption>`, html.EscapeString(titulo))
	fmt.Fprintf(
		&b,
		`<svg viewBox="0 0 %d %d" width="100%%" height="auto" preserveAspectRatio="xMidYMid meet" role="img" aria-label="%s">`,
		largura,
		altura,
		html.EscapeString("gráfico de barras: "+titulo),
	)

	// Quatro linhas de grade horizontais, com rótulos numéricos inteiros.
	b.WriteString(`<g class="grade">`)
	for i := 1; i <= 4; i++ {
		valor := passo * i
		y := plotBase - (float64(valor)/float64(maximo))*plotAltura
		fmt.Fprintf(
			&b,
			`<line class="grade" x1="%s" y1="%s" x2="%s" y2="%s" />`,
			graficoNumero(plotEsquerda), graficoNumero(y),
			graficoNumero(plotDireita), graficoNumero(y),
		)
		fmt.Fprintf(
			&b,
			`<text class="rotulo rotulo-y" x="%s" y="%s" text-anchor="end" dominant-baseline="middle">%d</text>`,
			graficoNumero(plotEsquerda-8), graficoNumero(y), valor,
		)
	}
	b.WriteString(`</g>`)

	// Eixos e o rótulo zero da base.
	fmt.Fprintf(
		&b,
		`<line class="eixo" x1="%s" y1="%s" x2="%s" y2="%s" />`,
		graficoNumero(plotEsquerda), graficoNumero(plotTopo),
		graficoNumero(plotEsquerda), graficoNumero(plotBase),
	)
	fmt.Fprintf(
		&b,
		`<line class="eixo" x1="%s" y1="%s" x2="%s" y2="%s" />`,
		graficoNumero(plotEsquerda), graficoNumero(plotBase),
		graficoNumero(plotDireita), graficoNumero(plotBase),
	)
	fmt.Fprintf(
		&b,
		`<text class="rotulo rotulo-y" x="%s" y="%s" text-anchor="end" dominant-baseline="middle">0</text>`,
		graficoNumero(plotEsquerda-8), graficoNumero(plotBase),
	)

	// Barras agrupadas. Mesmo valores zero geram um retângulo de altura zero.
	b.WriteString(`<g class="barras">`)
	for i, p := range pontos {
		centro := plotEsquerda + grupoLargura*(float64(i)+0.5)
		xHumano := centro - vao/2 - larguraBarra
		xBot := centro + vao/2
		alturaHumano := graficoAlturaBarra(p.Humano, maximo, plotAltura)
		alturaBot := graficoAlturaBarra(p.Bot, maximo, plotAltura)
		yHumano := plotBase - alturaHumano
		yBot := plotBase - alturaBot

		fmt.Fprintf(
			&b,
			`<rect class="barra barra-humano" x="%s" y="%s" width="%s" height="%s" fill="%s" />`,
			graficoNumero(xHumano), graficoNumero(yHumano),
			graficoNumero(larguraBarra), graficoNumero(alturaHumano), graficoCorHumano,
		)
		fmt.Fprintf(
			&b,
			`<rect class="barra barra-bot" x="%s" y="%s" width="%s" height="%s" fill="%s" />`,
			graficoNumero(xBot), graficoNumero(yBot),
			graficoNumero(larguraBarra), graficoNumero(alturaBot), graficoCorBot,
		)

		// O valor só aparece em gráficos com poucos pontos e se for positivo.
		if len(pontos) <= 14 {
			if p.Humano > 0 {
				fmt.Fprintf(
					&b,
					`<text class="valor" x="%s" y="%s" text-anchor="middle">%d</text>`,
					graficoNumero(xHumano+larguraBarra/2),
					graficoNumero(math.Max(plotTopo+9, yHumano-5)),
					p.Humano,
				)
			}
			if p.Bot > 0 {
				fmt.Fprintf(
					&b,
					`<text class="valor" x="%s" y="%s" text-anchor="middle">%d</text>`,
					graficoNumero(xBot+larguraBarra/2),
					graficoNumero(math.Max(plotTopo+9, yBot-5)),
					p.Bot,
				)
			}
		}
	}
	b.WriteString(`</g>`)

	// Rótulos do eixo X. Acima de 12 pontos, mostra um a cada 2 ou 3 para
	// evitar sobreposição; textos longos são inclinados em -45 graus.
	passoRotulo := 1
	switch {
	case len(pontos) > 20:
		passoRotulo = 3
	case len(pontos) > 12:
		passoRotulo = 2
	}
	b.WriteString(`<g class="rotulos-x">`)
	for i, p := range pontos {
		if i%passoRotulo != 0 {
			continue
		}
		centro := plotEsquerda + grupoLargura*(float64(i)+0.5)
		rotulo := html.EscapeString(p.Rotulo)
		if utf8.RuneCountInString(p.Rotulo) > 4 {
			y := plotBase + 13
			fmt.Fprintf(
				&b,
				`<text class="rotulo rotulo-x" x="%s" y="%s" text-anchor="end" transform="rotate(-45 %s %s)">%s</text>`,
				graficoNumero(centro), graficoNumero(y),
				graficoNumero(centro), graficoNumero(y), rotulo,
			)
		} else {
			y := plotBase + 17
			fmt.Fprintf(
				&b,
				`<text class="rotulo rotulo-x" x="%s" y="%s" text-anchor="middle">%s</text>`,
				graficoNumero(centro), graficoNumero(y), rotulo,
			)
		}
	}
	b.WriteString(`</g>`)

	b.WriteString(`</svg>`)
	b.WriteString(`<div class="legenda"><span class="legenda-item"><span class="quadrado quadrado-humano" aria-hidden="true"></span>humano</span><span class="legenda-item"><span class="quadrado quadrado-bot" aria-hidden="true"></span>bot</span></div>`)
	b.WriteString(`</figure>`)
	return b.String()
}

// graficoEscalaY calcula o topo do eixo em quatro passos "bonitos" (1, 2 ou 5
// vezes uma potência de dez). O mínimo de 1 evita passos fracionários para os
// valores inteiros usados nas barras.
func graficoEscalaY(pontos []pontoGrafico) (maximo int, passo int) {
	maior := 0
	for _, p := range pontos {
		if p.Humano > maior {
			maior = p.Humano
		}
		if p.Bot > maior {
			maior = p.Bot
		}
	}
	passo = graficoPassoBonito(maior)
	maximo = passo * 4
	if maximo < passo {
		maximo = passo
	}
	return maximo, passo
}

// graficoPassoBonito arredonda o alvo (quarto do máximo) para 1, 2 ou 5 vezes
// uma potência de dez, sempre para cima.
func graficoPassoBonito(maior int) int {
	if maior <= 4 {
		return 1
	}
	alvo := float64(maior) / 4
	potencia := math.Pow(10, math.Floor(math.Log10(alvo)))
	normalizado := alvo / potencia
	var bonito float64
	switch {
	case normalizado <= 1:
		bonito = 1
	case normalizado <= 2:
		bonito = 2
	case normalizado <= 5:
		bonito = 5
	default:
		bonito = 10
	}
	passo := bonito * potencia
	if passo < 1 {
		return 1
	}
	return int(math.Ceil(passo))
}

// graficoAlturaBarra converte um valor inteiro em altura no viewBox. Barras
// positivas muito pequenas ganham 1 px para continuarem visíveis.
func graficoAlturaBarra(valor, maximo int, altura float64) float64 {
	if valor <= 0 || maximo <= 0 {
		return 0
	}
	h := (float64(valor) / float64(maximo)) * altura
	if h < 1 {
		return 1
	}
	if h > altura {
		return altura
	}
	return h
}

// graficoMargemInferior reserva espaço para os rótulos inclinados do eixo X.
func graficoMargemInferior(pontos []pontoGrafico, altura int) int {
	maiorRotulo := 0
	for _, p := range pontos {
		if n := utf8.RuneCountInString(p.Rotulo); n > maiorRotulo {
			maiorRotulo = n
		}
	}
	if maiorRotulo <= 4 {
		return 46
	}
	margem := 44 + int(math.Min(float64(maiorRotulo)*4.5, 76))
	limite := altura / 3
	if limite < 46 {
		limite = 46
	}
	if margem > limite {
		margem = limite
	}
	return margem
}

// graficoNumero formata coordenadas com até duas casas, sem zeros inúteis.
func graficoNumero(v float64) string {
	s := strconv.FormatFloat(v, 'f', 2, 64)
	s = strings.TrimRight(s, "0")
	s = strings.TrimRight(s, ".")
	if s == "" || s == "-0" {
		return "0"
	}
	return s
}
