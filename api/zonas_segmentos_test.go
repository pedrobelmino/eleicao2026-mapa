package main

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

// zonaTeste é o recorte de /api/uf/CE/zonas usado nestes testes.
type zonaTeste struct {
	Zona           int64   `json:"zona"`
	CodTSE         int64   `json:"cd_tse"`
	Municipio      string  `json:"municipio"`
	VV             int64   `json:"vv"`
	V13            int64   `json:"v13"`
	V22            int64   `json:"v22"`
	VOutros        int64   `json:"voutros"`
	Validos        int64   `json:"validos"`
	Secoes         int64   `json:"secoes"`
	SecoesTotal    int64   `json:"secoes_total"`
	SecoesApuradas int64   `json:"secoes_apuradas"`
	PctApurado     float64 `json:"pct_apurado"`
	AlturaM        float64 `json:"altura_m"`
	BarLula        float64 `json:"bar_lula"`
	BarFlavio      float64 `json:"bar_flavio"`
	BarOutros      float64 `json:"bar_outros"`
	BarNaoApurado  float64 `json:"bar_nao_apurado"`
}

func zonasDeTeste(t *testing.T) []zonaTeste {
	t.Helper()

	aplicacao := novaAppDeTeste(t)
	requisicao := httptest.NewRequest(http.MethodGet, "/api/uf/CE/zonas", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200: %s", resposta.Code, resposta.Body.String())
	}

	var corpo struct {
		Zonas []zonaTeste `json:"zonas"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if len(corpo.Zonas) == 0 {
		t.Fatal("nenhuma zona na resposta")
	}
	return corpo.Zonas
}

// somaEmCentavos evita erro de ponto flutuante ao conferir "soma = 100".
func somaEmCentavos(valores ...float64) int64 {
	var soma float64
	for _, valor := range valores {
		soma += valor
	}
	return int64(math.Round(soma * 100))
}

// Com os dados oficiais fechados a barra é só candidato: os quatro segmentos
// somam 100 e não sobra concreto.
func TestUFZonasSegmentosSomam100(t *testing.T) {
	for _, zona := range zonasDeTeste(t) {
		if zona.SecoesApuradas != zona.SecoesTotal {
			t.Errorf("zona %d-%d: secoes_apuradas=%d != secoes_total=%d nos dados reais",
				zona.CodTSE, zona.Zona, zona.SecoesApuradas, zona.SecoesTotal)
		}
		if zona.Validos != zona.V13+zona.V22+zona.VOutros {
			t.Errorf("zona %d-%d: validos=%d != v13+v22+voutros=%d",
				zona.CodTSE, zona.Zona, zona.Validos, zona.V13+zona.V22+zona.VOutros)
		}
		if soma := somaEmCentavos(zona.BarLula, zona.BarFlavio, zona.BarOutros, zona.BarNaoApurado); soma != 10000 {
			t.Errorf("zona %d-%d: soma dos segmentos = %d centésimos, quer 10000 (%v/%v/%v/%v)",
				zona.CodTSE, zona.Zona, soma,
				zona.BarLula, zona.BarFlavio, zona.BarOutros, zona.BarNaoApurado)
		}
		if zona.PctApurado != 100 {
			t.Errorf("zona %d-%d: pct_apurado=%v, quer 100", zona.CodTSE, zona.Zona, zona.PctApurado)
		}
		if zona.BarNaoApurado != 0 {
			t.Errorf("zona %d-%d: bar_nao_apurado=%v, quer 0 (apuração completa)",
				zona.CodTSE, zona.Zona, zona.BarNaoApurado)
		}
		if zona.AlturaM <= 0 {
			t.Errorf("zona %d-%d: altura_m=%v, quer > 0", zona.CodTSE, zona.Zona, zona.AlturaM)
		}
	}
}

// No modo demo (APURACAO_DEMO=CE=78) cada zona apura menos seções do que tem:
// é o que desenha o segmento de concreto no topo da barra.
func TestUFZonasApuracaoDemo(t *testing.T) {
	t.Setenv("APURACAO_DEMO", "CE=78")

	zonas := zonasDeTeste(t)
	comConcreto := 0
	for _, zona := range zonas {
		if zona.SecoesApuradas >= zona.SecoesTotal {
			t.Errorf("zona %d-%d: secoes_apuradas=%d não é menor que secoes_total=%d no modo demo",
				zona.CodTSE, zona.Zona, zona.SecoesApuradas, zona.SecoesTotal)
		}
		if zona.PctApurado >= 100 {
			t.Errorf("zona %d-%d: pct_apurado=%v, quer < 100 no modo demo",
				zona.CodTSE, zona.Zona, zona.PctApurado)
		}
		if zona.BarNaoApurado <= 0 {
			t.Errorf("zona %d-%d: bar_nao_apurado=%v, quer > 0 no modo demo",
				zona.CodTSE, zona.Zona, zona.BarNaoApurado)
		}
		if soma := somaEmCentavos(zona.BarLula, zona.BarFlavio, zona.BarOutros, zona.BarNaoApurado); soma != 10000 {
			t.Errorf("zona %d-%d: soma dos segmentos = %d centésimos, quer 10000 (%v/%v/%v/%v)",
				zona.CodTSE, zona.Zona, soma,
				zona.BarLula, zona.BarFlavio, zona.BarOutros, zona.BarNaoApurado)
		}
		// Os votos contados são só das seções apuradas: área apurada da barra
		// casa com secoes_apuradas/secoes_total.
		areaApurada := zona.BarLula + zona.BarFlavio + zona.BarOutros
		if math.Abs(areaApurada-zona.PctApurado) > 0.011 {
			t.Errorf("zona %d-%d: área apurada %v difere de pct_apurado %v",
				zona.CodTSE, zona.Zona, areaApurada, zona.PctApurado)
		}
		comConcreto++
	}

	if comConcreto != len(zonas) {
		t.Fatalf("zonas com concreto = %d, quer %d", comConcreto, len(zonas))
	}
}

// O GeoJSON de zonas carrega os mesmos segmentos (é ele que alimenta as
// extrusões empilhadas do front).
func TestUFZonasGeoJSONSegmentos(t *testing.T) {
	t.Setenv("APURACAO_DEMO", "CE=78")

	aplicacao := novaAppDeTeste(t)
	requisicao := httptest.NewRequest(http.MethodGet, "/api/uf/CE/zonas.geojson", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200: %s", resposta.Code, resposta.Body.String())
	}

	var colecao struct {
		Features []struct {
			Properties struct {
				Zona           int64   `json:"zona"`
				V13            int64   `json:"v13"`
				V22            int64   `json:"v22"`
				VOutros        int64   `json:"voutros"`
				Validos        int64   `json:"validos"`
				SecoesTotal    int64   `json:"secoes_total"`
				SecoesApuradas int64   `json:"secoes_apuradas"`
				PctApurado     float64 `json:"pct_apurado"`
				BarLula        float64 `json:"bar_lula"`
				BarFlavio      float64 `json:"bar_flavio"`
				BarOutros      float64 `json:"bar_outros"`
				BarNaoApurado  float64 `json:"bar_nao_apurado"`
			} `json:"properties"`
		} `json:"features"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &colecao); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if len(colecao.Features) == 0 {
		t.Fatal("nenhuma feature de zona")
	}

	for _, feature := range colecao.Features {
		props := feature.Properties
		if props.SecoesApuradas >= props.SecoesTotal {
			t.Errorf("feature zona %d: secoes_apuradas=%d não é menor que secoes_total=%d",
				props.Zona, props.SecoesApuradas, props.SecoesTotal)
		}
		if soma := somaEmCentavos(props.BarLula, props.BarFlavio, props.BarOutros, props.BarNaoApurado); soma != 10000 {
			t.Errorf("feature zona %d: soma dos segmentos = %d centésimos, quer 10000",
				props.Zona, soma)
		}
	}
}

// O estado só ganha cor de candidato com a apuração fechada; em andamento a
// propriedade sai com pct < 100 e é o front que pinta de concreto.
func TestUfsGeoJSONSecoesApuradas(t *testing.T) {
	t.Setenv("APURACAO_DEMO", "CE=78")

	aplicacao := novaAppDeTeste(t)
	requisicao := httptest.NewRequest(http.MethodGet, "/api/ufs.geojson", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200: %s", resposta.Code, resposta.Body.String())
	}

	var colecao struct {
		Features []struct {
			Properties struct {
				UF             string  `json:"uf"`
				SecoesApuradas int64   `json:"secoes_apuradas"`
				SecoesTotal    int64   `json:"secoes_total"`
				PctApurado     float64 `json:"pct_apurado"`
			} `json:"properties"`
		} `json:"features"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &colecao); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}

	var viuCE, viuFechada bool
	for _, feature := range colecao.Features {
		props := feature.Properties
		if props.SecoesTotal <= 0 {
			t.Errorf("%s: secoes_total=%d, quer > 0", props.UF, props.SecoesTotal)
			continue
		}
		if props.UF == "CE" {
			viuCE = true
			if props.SecoesApuradas >= props.SecoesTotal {
				t.Errorf("CE: secoes_apuradas=%d não é menor que secoes_total=%d no modo demo",
					props.SecoesApuradas, props.SecoesTotal)
			}
			if props.PctApurado >= 100 {
				t.Errorf("CE: pct_apurado=%v, quer < 100", props.PctApurado)
			}
			continue
		}
		if props.SecoesApuradas == props.SecoesTotal {
			viuFechada = true
		}
	}
	if !viuCE {
		t.Error("CE ausente do /api/ufs.geojson")
	}
	if !viuFechada {
		t.Error("nenhuma UF com apuração fechada (100% das seções) no /api/ufs.geojson")
	}
}

// APURACAO_DEMO é lido de forma tolerante: par inválido ou UF fora da tabela
// não podem derrubar o boot nem ligar o modo demo pela metade.
func TestLerApuracaoDemo(t *testing.T) {
	casos := []struct {
		bruto    string
		esperado map[string]float64
	}{
		{"", nil},
		{"   ", nil},
		{"CE=78", map[string]float64{"CE": 78}},
		{"ce=78, rr=100", map[string]float64{"CE": 78, "RR": 100}},
		{"CE=abc,RR=100", map[string]float64{"RR": 100}},
		{"XX=50", nil},
		{"CE=-10", map[string]float64{"CE": 0}},
		{"CE=250", map[string]float64{"CE": 100}},
	}

	for _, caso := range casos {
		obtido := lerApuracaoDemo(caso.bruto)
		if caso.esperado == nil {
			if obtido != nil {
				t.Errorf("lerApuracaoDemo(%q) = %v, quer nil", caso.bruto, obtido)
			}
			continue
		}
		if len(obtido) != len(caso.esperado) {
			t.Errorf("lerApuracaoDemo(%q) = %v, quer %v", caso.bruto, obtido, caso.esperado)
			continue
		}
		for uf, valor := range caso.esperado {
			if obtido[uf] != valor {
				t.Errorf("lerApuracaoDemo(%q)[%s] = %v, quer %v", caso.bruto, uf, obtido[uf], valor)
			}
		}
	}
}
