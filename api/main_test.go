package main

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func novaAppDeTeste(t *testing.T) *app {
	t.Helper()
	t.Setenv("DADOS_DIR", "../dados")

	aplicacao, err := novaApp(carregarConfig())
	if err != nil {
		t.Fatalf("criar aplicação com os dados reais: %v", err)
	}
	return aplicacao
}

func TestHealth(t *testing.T) {
	t.Setenv("ELEICAO", "6257")
	t.Setenv("TURNO", "2")
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}
	if origem := resposta.Header().Get("Access-Control-Allow-Origin"); origem != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, quer %q", origem, "*")
	}
	if contentType := resposta.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Errorf("Content-Type = %q, quer application/json", contentType)
	}

	var corpo struct {
		OK       bool   `json:"ok"`
		Eleicao  string `json:"eleicao"`
		Turno    string `json:"turno"`
		GeradoEm string `json:"gerado_em"`
		UFs      int    `json:"ufs"`
		Features int    `json:"features"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if !corpo.OK {
		t.Error("ok = false, quer true")
	}
	if corpo.Eleicao != "6257" {
		t.Errorf("eleicao = %q, quer %q", corpo.Eleicao, "6257")
	}
	if corpo.Turno != "2" {
		t.Errorf("turno = %q, quer %q", corpo.Turno, "2")
	}
	if corpo.GeradoEm == "" {
		t.Error("gerado_em vazio")
	}
	if corpo.UFs != 27 {
		t.Errorf("ufs = %d, quer 27", corpo.UFs)
	}
	if corpo.Features != 27 {
		t.Errorf("features = %d, quer 27", corpo.Features)
	}
}

func TestUfsGeoJSON(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/ufs.geojson", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}

	var colecao struct {
		Type     string `json:"type"`
		Features []struct {
			Properties struct {
				CodArea      string  `json:"codarea"`
				UF           string  `json:"uf"`
				Lider        string  `json:"lider"`
				PartidoLider string  `json:"partido_lider"`
				MargemPct    float64 `json:"margem_pct"`
			} `json:"properties"`
			Geometry json.RawMessage `json:"geometry"`
		} `json:"features"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &colecao); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if colecao.Type != "FeatureCollection" {
		t.Errorf("type = %q, quer FeatureCollection", colecao.Type)
	}
	if len(colecao.Features) != 27 {
		t.Fatalf("features = %d, quer 27", len(colecao.Features))
	}

	var encontrada bool
	for _, feature := range colecao.Features {
		if feature.Properties.CodArea != "35" {
			continue
		}
		encontrada = true
		if feature.Properties.UF != "SP" {
			t.Errorf("properties.uf do codarea 35 = %q, quer SP", feature.Properties.UF)
		}
		if feature.Properties.Lider == "" {
			t.Error("properties.lider do codarea 35 vazio")
		}
		if feature.Properties.PartidoLider == "" {
			t.Error("properties.partido_lider do codarea 35 vazio")
		}
		if math.Abs(feature.Properties.MargemPct-13.73) > 0.0001 {
			t.Errorf("properties.margem_pct do codarea 35 = %v, quer 13.73", feature.Properties.MargemPct)
		}
		if len(feature.Geometry) == 0 {
			t.Error("geometry do codarea 35 vazia")
		}
	}
	if !encontrada {
		t.Fatal("feature com codarea 35 não encontrada")
	}
}

func TestEstados(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/estados", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}

	var corpo struct {
		Eleicao  string            `json:"eleicao"`
		Turno    string            `json:"turno"`
		GeradoEm string            `json:"gerado_em"`
		Fonte    string            `json:"fonte"`
		Nacional json.RawMessage   `json:"nacional"`
		UFs      []json.RawMessage `json:"ufs"`
	}
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}
	if len(corpo.UFs) != 27 {
		t.Errorf("ufs = %d, quer 27", len(corpo.UFs))
	}
	if len(corpo.Nacional) == 0 || string(corpo.Nacional) == "null" {
		t.Error("nacional ausente")
	}
	if corpo.GeradoEm == "" {
		t.Error("gerado_em vazio")
	}
	if corpo.Fonte == "" {
		t.Error("fonte vazia")
	}
	if corpo.Eleicao == "" {
		t.Error("eleicao vazia")
	}
	if corpo.Turno == "" {
		t.Error("turno vazio")
	}
}
