package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestGraficoBarrasSVG(t *testing.T) {
	pontosBase := []pontoGrafico{
		{Rotulo: "Norte", Humano: 37, Bot: 12},
		{Rotulo: "Sul", Humano: 8, Bot: 21},
		{Rotulo: "Centro", Humano: 0, Bot: 0},
	}

	// Massa usada no caso de muitos rótulos: 24 pontos, 8 devem aparecer.
	pontos24 := make([]pontoGrafico, 24)
	for i := range pontos24 {
		pontos24[i] = pontoGrafico{
			Rotulo: fmt.Sprintf("P%02d", i),
			Humano: i + 1,
			Bot:    i,
		}
	}

	casos := []struct {
		nome     string
		pontos   []pontoGrafico
		titulo   string
		largura  int
		altura   int
		conferir func(t *testing.T, saida string)
	}{
		{
			nome:    "estrutura do bloco",
			pontos:  pontosBase,
			titulo:  "Distribuição",
			largura: 640,
			altura:  320,
			conferir: func(t *testing.T, saida string) {
				t.Helper()
				if !strings.HasPrefix(saida, "<figure") {
					t.Fatalf("o bloco deveria começar com <figure: %.60q", saida)
				}
				if !strings.HasSuffix(saida, "</figure>") {
					t.Fatalf("o bloco deveria terminar com </figure>: %.60q", saida)
				}
				for _, trecho := range []string{
					"<figcaption>Distribuição</figcaption>",
					`viewBox="0 0 640 320"`,
					`width="100%"`,
					`height="auto"`,
					`preserveAspectRatio=`,
					`class="legenda"`,
				} {
					if !strings.Contains(saida, trecho) {
						t.Errorf("trecho obrigatório ausente: %q", trecho)
					}
				}
			},
		},
		{
			nome:    "sem recursos externos",
			pontos:  pontosBase,
			titulo:  "Seguro",
			largura: 640,
			altura:  320,
			conferir: func(t *testing.T, saida string) {
				t.Helper()
				for _, proibido := range []string{"script", "http://", "https://", "href=", "src=", "url("} {
					if strings.Contains(saida, proibido) {
						t.Errorf("saída contém recurso proibido %q", proibido)
					}
				}
			},
		},
		{
			nome:    "duas barras por ponto",
			pontos:  pontosBase,
			titulo:  "Contagem",
			largura: 640,
			altura:  320,
			conferir: func(t *testing.T, saida string) {
				t.Helper()
				if got, quer := strings.Count(saida, "<rect"), 2*len(pontosBase); got != quer {
					t.Errorf("quantidade de <rect de barra = %d; quer %d", got, quer)
				}
			},
		},
		{
			nome:    "texto escapado",
			pontos:  []pontoGrafico{{Rotulo: "<b>Alerta</b>", Humano: 3, Bot: 1}},
			titulo:  "Escapes & cia",
			largura: 500,
			altura:  260,
			conferir: func(t *testing.T, saida string) {
				t.Helper()
				if !strings.Contains(saida, "&lt;b&gt;Alerta&lt;/b&gt;") {
					t.Errorf("rótulo <b> não foi escapado: %q", saida)
				}
				if strings.Contains(saida, "<b>") {
					t.Errorf("HTML do rótulo vazou sem escape")
				}
				if !strings.Contains(saida, "Escapes &amp; cia") {
					t.Errorf("título não foi escapado corretamente")
				}
			},
		},
		{
			nome:    "sem dados",
			pontos:  nil,
			titulo:  "Vazio",
			largura: 500,
			altura:  260,
			conferir: func(t *testing.T, saida string) {
				t.Helper()
				if saida != `<p class="vazio">sem dados</p>` {
					t.Errorf("saída inesperada para lista vazia: %q", saida)
				}
			},
		},
		{
			nome:    "rótulos espaçados",
			pontos:  pontos24,
			titulo:  "Muitos pontos",
			largura: 900,
			altura:  380,
			conferir: func(t *testing.T, saida string) {
				t.Helper()
				visiveis := 0
				for i := 0; i < 24; i++ {
					rotulo := fmt.Sprintf("P%02d", i)
					ocorrencias := strings.Count(saida, rotulo)
					if ocorrencias > 1 {
						t.Errorf("rótulo %q aparece %d vezes", rotulo, ocorrencias)
					}
					if ocorrencias == 1 {
						visiveis++
						if i%3 != 0 {
							t.Errorf("rótulo %q deveria ter sido omitido", rotulo)
						}
					}
				}
				if visiveis != 8 {
					t.Errorf("rótulos visíveis = %d; quer 8 (um a cada três)", visiveis)
				}
			},
		},
	}

	for _, tc := range casos {
		t.Run(tc.nome, func(t *testing.T) {
			saida := graficoBarrasSVG(tc.pontos, tc.titulo, tc.largura, tc.altura)
			tc.conferir(t, saida)
		})
	}
}
