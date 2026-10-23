package main

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

// Prova do endpoint do item 6: /api/uf/{UF}/margens.
//
// Não é teste de forma só: confere que o total de "viraram" bate com a lista,
// que a ordem é a do painel (margem_votos × vv), que todo codarea existe na
// malha municipal da UF e que o delta em pontos fecha com o arquivo de 2022
// (mesma base que o endpoint usa, conferida por outro caminho: pelo cd_ibge da
// resposta, achando o cd_tse no detalhe municipal).
func TestMargensPorUF(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	requisicao := httptest.NewRequest(http.MethodGet, "/api/uf/CE/margens", nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200 (corpo: %s)", resposta.Code, resposta.Body.String())
	}

	var corpo margensUFResposta
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar resposta: %v", err)
	}

	if corpo.UF != "CE" {
		t.Errorf("uf = %q, quer CE", corpo.UF)
	}
	if len(corpo.Municipios) == 0 {
		t.Fatal("municípios vazios no /api/uf/CE/margens")
	}
	if corpo.TotalMunicipios != len(corpo.Municipios) {
		t.Errorf("total_municipios = %d, lista tem %d", corpo.TotalMunicipios, len(corpo.Municipios))
	}
	if !corpo.Comparacao2022 {
		t.Error("comparacao_2022 = false; dados/eleicao_2022.json deveria estar carregado")
	}

	// A malha da UF é a fonte dos codarea: nenhum município inventado.
	detalhe := aplicacao.dadosDaUF("CE")
	if detalhe == nil {
		t.Fatal("sem detalhe municipal de CE")
	}
	ibgePorCodTSE := make(map[int64]int64, len(detalhe.Municipios.Municipios))
	naMalha := make(map[string]bool, len(detalhe.Municipios.Municipios))
	for _, municipio := range detalhe.Municipios.Municipios {
		ibgePorCodTSE[municipio.CodTSE] = municipio.CodIBGE
		naMalha[strconv.FormatInt(municipio.CodIBGE, 10)] = true
	}

	viraram := 0
	naoViraram := 0
	sem2022 := 0
	anterior := math.Inf(1)

	for indice, linha := range corpo.Municipios {
		if linha.CodArea == "" {
			t.Fatalf("município %q sem codarea", linha.Nome)
		}
		if !naMalha[linha.CodArea] {
			t.Errorf("%s: codarea %q não existe na malha municipal de CE", linha.Nome, linha.CodArea)
		}
		if linha.VV <= 0 {
			t.Errorf("%s: vv = %d, quer > 0", linha.Nome, linha.VV)
		}
		if linha.MargemVotos < 0 || linha.MargemPct < 0 {
			t.Errorf("%s: margem negativa (votos %d, pontos %v)", linha.Nome, linha.MargemVotos, linha.MargemPct)
		}
		if (linha.Virou2022 == nil) != (linha.DeltaPP2022 == nil) {
			t.Errorf("%s: virou_2022 e delta_pp_2022 têm de ser nulos juntos (virou=%v delta=%v)",
				linha.Nome, linha.Virou2022, linha.DeltaPP2022)
		}
		switch {
		case linha.Virou2022 == nil:
			sem2022++
		case *linha.Virou2022:
			viraram++
		default:
			naoViraram++
		}

		// Ordem do painel: margem_votos × vv, decrescente.
		peso := math.Abs(float64(linha.MargemVotos)) * float64(linha.VV)
		if peso > anterior+0.0001 {
			t.Errorf("ordem quebrada no índice %d (%s): peso %.0f depois de %.0f",
				indice, linha.Nome, peso, anterior)
		}
		anterior = peso
		if linha.Virou2022 != nil && *linha.Virou2022 {
			t.Logf("virou: %s (%s -> %s), margem %d votos / %.2f pts, delta %+0.2f pts",
				linha.Nome, dadosPartido2022(aplicacao, linha), linha.PartidoLider,
				linha.MargemVotos, linha.MargemPct, *linha.DeltaPP2022)
		}
	}

	if viraram == 0 {
		t.Error("nenhum município de CE virou em 2022 — a comparação deveria acusar pelo menos um")
	}
	if naoViraram == 0 {
		t.Error("nenhum município de CE manteve o partido do líder — a comparação deveria acusar pelo menos um")
	}
	if corpo.TotalViraram != viraram {
		t.Errorf("total_viraram = %d, lista tem %d", corpo.TotalViraram, viraram)
	}

	// Delta confere com o arquivo de 2022, achando o cd_tse pelo cd_ibge.
	conferidos := 0
	for _, linha := range corpo.Municipios {
		if linha.Virou2022 == nil {
			continue
		}
		var codTSE int64
		for tse, ibge := range ibgePorCodTSE {
			if strconv.FormatInt(ibge, 10) == linha.CodArea {
				codTSE = tse
				break
			}
		}
		if codTSE == 0 {
			t.Errorf("%s: codarea %s sem cd_tse na malha", linha.Nome, linha.CodArea)
			continue
		}
		dados2022, existe := aplicacao.eleicao2022.Municipios[int64Texto(codTSE)]
		if !existe {
			t.Errorf("%s (cd_tse %d): virou_2022 preenchido mas o município não está no arquivo de 2022", linha.Nome, codTSE)
			continue
		}
		vantagemAntes := dados2022.MargemPct
		if *linha.Virou2022 {
			if dados2022.PartidoLider == linha.PartidoLider {
				t.Errorf("%s: virou_2022=true mas o partido de 2022 (%q) é o mesmo de agora (%q)",
					linha.Nome, dados2022.PartidoLider, linha.PartidoLider)
			}
			vantagemAntes = -dados2022.MargemPct
		} else if dados2022.PartidoLider != linha.PartidoLider {
			t.Errorf("%s: virou_2022=false mas o partido mudou (%q -> %q)",
				linha.Nome, dados2022.PartidoLider, linha.PartidoLider)
		}
		esperado := linha.MargemPct - vantagemAntes
		if math.Abs(esperado-*linha.DeltaPP2022) > 0.02 {
			t.Errorf("%s: delta_pp_2022 = %v, esperado %v (margem %v, 2022 %v)",
				linha.Nome, *linha.DeltaPP2022, esperado, linha.MargemPct, dados2022.MargemPct)
		}
		conferidos++
		if conferidos >= 25 {
			break
		}
	}
	if conferidos == 0 {
		t.Error("nenhum delta conferido contra o arquivo de 2022")
	}

	t.Logf("CE: %d municípios, %d viraram, %d mantiveram, %d sem par em 2022, %d deltas conferidos",
		len(corpo.Municipios), viraram, naoViraram, sem2022, conferidos)
}

func dadosPartido2022(aplicacao *app, linha margemMunicipioResposta) string {
	detalhe := aplicacao.dadosDaUF("CE")
	if detalhe == nil {
		return "?"
	}
	for _, municipio := range detalhe.Municipios.Municipios {
		if strconv.FormatInt(municipio.CodIBGE, 10) != linha.CodArea {
			continue
		}
		if anterior, existe := aplicacao.eleicao2022.Municipios[int64Texto(municipio.CodTSE)]; existe {
			return anterior.PartidoLider
		}
	}
	return "?"
}

// A UF sem recursos (ou um recurso desconhecido) responde 404 em JSON — a rota
// nova não pode virar 200 vazio nem 500.
func TestMargensPorUFRotasInvalidas(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	for _, caminho := range []string{
		"/api/uf/ZZ/margens",
		"/api/uf/CE/margenss",
		"/api/uf/CE/margens/extra",
	} {
		requisicao := httptest.NewRequest(http.MethodGet, caminho, nil)
		resposta := httptest.NewRecorder()
		aplicacao.handler().ServeHTTP(resposta, requisicao)
		if resposta.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, quer 404", caminho, resposta.Code)
		}
	}
}
