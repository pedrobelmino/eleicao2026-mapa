package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Testes do nível urna/prédio (item 10 do roadmap — CIDADE-URNA).
//
// O prédio de um local é desenhado com a altura dos votos VÁLIDOS apurados e o
// topo em concreto proporcional às seções ainda não apuradas. Para esse
// segmento existir, `pct_apurado` do local precisa vir do mesmo denominador
// oficial usado pelas zonas: seções do dump (100% na apuração encerrada) e
// corte pelo fator do modo demo quando APURACAO_DEMO estiver ativo.

type corpoLocais struct {
	UF          string `json:"uf"`
	CD          int64  `json:"cd"`
	Municipio   string `json:"municipio"`
	TotalLocais int    `json:"total_locais"`
	Totais      struct {
		Total  int64 `json:"total"`
		VV     int64 `json:"vv"`
		Secoes int64 `json:"secoes"`
	} `json:"totais"`
	Locais []struct {
		NrLocal         int64   `json:"nr_local"`
		Lat             float64 `json:"lat"`
		Lon             float64 `json:"lon"`
		Total           int64   `json:"total"`
		VV              int64   `json:"vv"`
		PctApurado      float64 `json:"pct_apurado"`
		SecoesApuradas  int     `json:"secoes_apuradas"`
		SecoesEsperadas int     `json:"secoes_esperadas"`
		Secoes          []struct {
			Zona       int64   `json:"zona"`
			Secao      int64   `json:"secao"`
			Total      int64   `json:"total"`
			VV         int64   `json:"vv"`
			PctApurado float64 `json:"pct_apurado"`
		} `json:"secoes"`
	} `json:"locais"`
}

func locaisDeFortaleza(t *testing.T, aplicacao *app) corpoLocais {
	t.Helper()

	requisicao := httptest.NewRequest(http.MethodGet, "/api/uf/CE/locais?cd=13897", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200: %s", resposta.Code, resposta.Body.String())
	}

	var corpo corpoLocais
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar locais de Fortaleza: %v", err)
	}
	if len(corpo.Locais) == 0 {
		t.Fatal("Fortaleza sem locais na resposta")
	}
	return corpo
}

// Apuração encerrada (produção, sem APURACAO_DEMO): todo prédio está 100%
// apurado, então o segmento de concreto é zero em todos eles.
func TestUFLocaisApuracaoCompleta(t *testing.T) {
	t.Setenv("APURACAO_DEMO", "")
	aplicacao := novaAppDeTeste(t)
	corpo := locaisDeFortaleza(t, aplicacao)

	if corpo.TotalLocais != 196 || len(corpo.Locais) != 196 {
		t.Fatalf("total_locais = %d (len %d), quer 196", corpo.TotalLocais, len(corpo.Locais))
	}
	if corpo.Totais.Secoes != 5335 {
		t.Fatalf("totais.secoes = %d, quer 5335", corpo.Totais.Secoes)
	}
	if corpo.Totais.VV != 1490423 {
		t.Fatalf("totais.vv = %d, quer 1490423", corpo.Totais.VV)
	}

	somaSecoes := 0
	somaVV := int64(0)
	for _, local := range corpo.Locais {
		if local.PctApurado != 100 {
			t.Fatalf("local %d: pct_apurado = %v, quer 100 na apuração encerrada",
				local.NrLocal, local.PctApurado)
		}
		if local.SecoesApuradas != local.SecoesEsperadas {
			t.Fatalf("local %d: apuradas %d != esperadas %d",
				local.NrLocal, local.SecoesApuradas, local.SecoesEsperadas)
		}
		if local.SecoesApuradas != len(local.Secoes) {
			t.Fatalf("local %d: secoes_apuradas %d != seções listadas %d",
				local.NrLocal, local.SecoesApuradas, len(local.Secoes))
		}
		if local.Lat == -1 || local.Lon == -1 {
			t.Fatalf("local %d: coordenada sentinela do TSE na lista", local.NrLocal)
		}
		somaSecoes += len(local.Secoes)
		somaVV += local.VV
	}

	if somaSecoes != int(corpo.Totais.Secoes) {
		t.Fatalf("soma das seções dos locais = %d, quer %d", somaSecoes, corpo.Totais.Secoes)
	}
	if somaVV != corpo.Totais.VV {
		t.Fatalf("soma dos votos válidos dos locais = %d, quer %d", somaVV, corpo.Totais.VV)
	}
}

// Modo demo (APURACAO_DEMO=CE=78): o denominador continua sendo o total de
// seções do dump, mas só uma fração entra na apuração — é isso que acende o
// segmento de concreto no topo do prédio. O teste garante também que a
// apuração simulada NUNCA inventa seção: esperadas continua 5.335.
func TestUFLocaisApuracaoDemo(t *testing.T) {
	t.Setenv("APURACAO_DEMO", "CE=78")
	aplicacao := novaAppDeTeste(t)
	corpo := locaisDeFortaleza(t, aplicacao)

	if len(corpo.Locais) != 196 {
		t.Fatalf("len(locais) = %d, quer 196", len(corpo.Locais))
	}

	somaEsperadas := 0
	somaApuradas := 0
	parciais := 0
	for _, local := range corpo.Locais {
		if local.SecoesEsperadas < local.SecoesApuradas {
			t.Fatalf("local %d: esperadas %d < apuradas %d",
				local.NrLocal, local.SecoesEsperadas, local.SecoesApuradas)
		}
		if local.SecoesApuradas != len(local.Secoes) {
			t.Fatalf("local %d: apuradas %d != seções listadas %d",
				local.NrLocal, local.SecoesApuradas, len(local.Secoes))
		}
		if local.PctApurado < 100 {
			parciais++
		}
		if local.PctApurado < 0 || local.PctApurado > 100 {
			t.Fatalf("local %d: pct_apurado fora de 0..100: %v", local.NrLocal, local.PctApurado)
		}
		// Local que ainda não apurou nada continua no mapa, na posição dele:
		// coordenada (0,0) seria o golfo da Guiné e fundiria vários locais.
		if local.Lat == 0 && local.Lon == 0 {
			t.Fatalf("local %d: caiu na coordenada 0,0 no modo demo", local.NrLocal)
		}
		somaEsperadas += local.SecoesEsperadas
		somaApuradas += local.SecoesApuradas
	}

	if parciais == 0 {
		t.Fatal("nenhum local parcial no modo demo: o segmento de concreto não teria onde aparecer")
	}
	if somaEsperadas != 5335 {
		t.Fatalf("soma das seções esperadas = %d, quer 5335 (o demo não pode inventar seção)", somaEsperadas)
	}
	if somaApuradas >= somaEsperadas {
		t.Fatalf("soma das apuradas (%d) deveria ser menor que as esperadas (%d) no demo",
			somaApuradas, somaEsperadas)
	}

	// A mesma requisição sem o fator: apuração completa, 5.335 apuradas.
	t.Setenv("APURACAO_DEMO", "")
	completa := locaisDeFortaleza(t, novaAppDeTeste(t))
	apuradasCompletas := 0
	for _, local := range completa.Locais {
		apuradasCompletas += local.SecoesApuradas
	}
	if apuradasCompletas != 5335 {
		t.Fatalf("apuração completa: %d apuradas, quer 5335", apuradasCompletas)
	}
}
