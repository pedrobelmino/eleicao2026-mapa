package main

// Conferência do escore de suspeita contra o MESMO fixture que o lado Python
// usa (scripts/defesa/suspeita_fixture.json). É o que impede o painel (Go) e o
// vigia (Python) de divergirem sobre quem é suspeito.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type casoFixture struct {
	Nome     string   `json:"nome"`
	Linhas   []string `json:"linhas"`
	Esperado struct {
		Escore int      `json:"escore"`
		Nivel  string   `json:"nivel"`
		Sinais []string `json:"sinais"`
	} `json:"esperado"`
}

type fixtureSuspeita struct {
	Versao int           `json:"versao"`
	Agora  string        `json:"agora"`
	Casos  []casoFixture `json:"casos"`
}

func carregarFixture(t *testing.T) fixtureSuspeita {
	t.Helper()
	caminho := filepath.Join("..", "scripts", "defesa", "suspeita_fixture.json")
	dados, err := os.ReadFile(caminho)
	if err != nil {
		t.Fatalf("fixture ausente (%s): %v", caminho, err)
	}
	var f fixtureSuspeita
	if err := json.Unmarshal(dados, &f); err != nil {
		t.Fatalf("fixture inválido: %v", err)
	}
	if len(f.Casos) == 0 {
		t.Fatal("fixture sem casos")
	}
	return f
}

func TestSuspeitaConformeFixture(t *testing.T) {
	f := carregarFixture(t)
	agora, err := time.Parse(time.RFC3339, f.Agora)
	if err != nil {
		t.Fatalf("agora do fixture inválido: %v", err)
	}

	for _, caso := range f.Casos {
		caso := caso
		t.Run(caso.Nome, func(t *testing.T) {
			eventos := make([]evento, 0, len(caso.Linhas))
			for _, linha := range caso.Linhas {
				ev, ok := parseLinha(linha)
				if !ok {
					t.Fatalf("linha do fixture não parseia: %q", linha)
				}
				eventos = append(eventos, ev)
			}

			lista := calcularSuspeitos(eventos, agora, 0)
			var achado *suspeito
			for i := range lista {
				if lista[i].IP == primeiroIP(caso.Linhas) {
					achado = &lista[i]
					break
				}
			}
			if achado == nil {
				t.Fatalf("IP do caso não apareceu na lista (minimo=0)")
			}
			if achado.Escore != caso.Esperado.Escore {
				t.Fatalf("escore: esperado %d, obtido %d (sinais %v)",
					caso.Esperado.Escore, achado.Escore, achado.Sinais)
			}
			if achado.Nivel != caso.Esperado.Nivel {
				t.Fatalf("nível: esperado %q, obtido %q", caso.Esperado.Nivel, achado.Nivel)
			}
			if strings.Join(achado.Sinais, ",") != strings.Join(caso.Esperado.Sinais, ",") {
				t.Fatalf("sinais: esperado %v, obtido %v", caso.Esperado.Sinais, achado.Sinais)
			}
			if len(achado.Rotulos) != len(achado.Sinais) {
				t.Fatalf("rótulos (%d) não casam com sinais (%d)", len(achado.Rotulos), len(achado.Sinais))
			}
		})
	}
}

func primeiroIP(linhas []string) string {
	for _, linha := range linhas {
		if ev, ok := parseLinha(linha); ok {
			return ev.IP
		}
	}
	return ""
}

// Volume NÃO pontua: 500 requisições de navegador real no mesmo IP continuam
// limpas. É o caso do visitante que vai passar a apuração conectado.
func TestVolumeNaoPesa(t *testing.T) {
	base := time.Date(2026, 10, 25, 18, 0, 0, 0, time.Local)
	ua := "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
	caminhos := []string{"/index.html", "/mapa", "/api/estados", "/api/home", "/api/visita", "/assets/app.js"}

	eventos := make([]evento, 0, 500)
	for i := 0; i < 500; i++ {
		eventos = append(eventos, evento{
			IP:      "201.17.100.55",
			Quando:  base.Add(time.Duration(i) * 2 * time.Second),
			Status:  200,
			Metodo:  "GET",
			Caminho: caminhos[i%len(caminhos)],
			Host:    "eleicao2026.belmino.dev",
			Alvo:    "GET " + caminhos[i%len(caminhos)] + " HTTP/1.1",
			UA:      ua,
		})
	}

	lista := calcularSuspeitos(eventos, base.Add(time.Hour), 0)
	if len(lista) != 1 {
		t.Fatalf("esperava 1 IP avaliado, veio %d", len(lista))
	}
	if lista[0].Escore != 0 || lista[0].Nivel != NivelLimpo {
		t.Fatalf("visitante com 500 req deveria ficar limpo: %+v", lista[0])
	}
}

// Sem UA nenhum, a mesma quantidade de requisições continua sem escore de
// caminho: o que pesa é máquina (regularidade), não volume.
func TestSinaisNaoMultiplicam(t *testing.T) {
	base := time.Date(2026, 10, 24, 12, 0, 0, 0, time.Local)
	eventos := make([]evento, 0, 20)
	for i := 0; i < 20; i++ {
		eventos = append(eventos, evento{
			IP:      "45.22.33.44",
			Quando:  base.Add(time.Duration(i) * time.Minute),
			Status:  404,
			Metodo:  "GET",
			Caminho: "/admin",
			Host:    "eleicao2026.belmino.dev",
			Alvo:    "GET /admin HTTP/1.1",
			UA:      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36",
		})
	}
	lista := calcularSuspeitos(eventos, base.Add(time.Hour), 0)
	if len(lista) != 1 {
		t.Fatalf("esperava 1 IP, veio %d", len(lista))
	}
	// caminho_sensivel 35 + reincidencia 15 = 50 (regularidade não: UA real).
	if lista[0].Escore != 50 {
		t.Fatalf("20 acessos a /admin deveriam dar 50 (cada sinal vale uma vez), veio %d (%v)",
			lista[0].Escore, lista[0].Sinais)
	}
}
