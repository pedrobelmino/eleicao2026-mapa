package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
)

func requisitar(t *testing.T, aplicacao *app, caminho string) *httptest.ResponseRecorder {
	t.Helper()
	requisicao := httptest.NewRequest(http.MethodGet, caminho, nil)
	resposta := httptest.NewRecorder()
	aplicacao.handler().ServeHTTP(resposta, requisicao)
	return resposta
}

func decodificarReplay(t *testing.T, resposta *httptest.ResponseRecorder) replayResposta {
	t.Helper()
	var corpo replayResposta
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar replay: %v", err)
	}
	return corpo
}

func TestReplay2022(t *testing.T) {
	aplicacao := novaAppDeTeste(t)
	resposta := requisitar(t, aplicacao, "/api/replay?modo=2022")

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}

	corpo := decodificarReplay(t, resposta)
	if !corpo.Disponivel {
		t.Fatalf("disponivel = false (nota: %s)", corpo.Nota)
	}
	if corpo.Modo != "2022" {
		t.Errorf("modo = %q, quer 2022", corpo.Modo)
	}
	if len(corpo.Frames) < 10 {
		t.Fatalf("frames = %d, quer pelo menos 10", len(corpo.Frames))
	}
	if len(corpo.Frames) > limiteFramesReplay+1 {
		t.Errorf("frames = %d, acima do limite %d", len(corpo.Frames), limiteFramesReplay)
	}
	if len(corpo.Derivado) == 0 {
		t.Error("derivado vazio: o modelo de fila por UF tem de estar rotulado")
	}
	// 26 estados + DF + o código de voto no exterior (ZZ), que o TSE publica na
	// mesma tabela. ZZ não tem seção no recorte por seção (secoes = 0), então
	// não entra na fila de fechamento e não é desenhado no mapa — mas está em
	// ufs_base, porque a base é o retrato do arquivo, não do desenho.
	if len(corpo.UFsBase) != 28 {
		t.Errorf("ufs_base = %d, quer 28 (27 UFs + ZZ do exterior)", len(corpo.UFsBase))
	}
	for sigla, base := range corpo.UFsBase {
		if sigla == "ZZ" {
			continue
		}
		if base.SecoesTotal <= 0 {
			t.Errorf("%s: secoes_total = %d, quer > 0", sigla, base.SecoesTotal)
		}
	}

	// O último frame é o arquivo fechado: toda UF em 100% das seções.
	ultimo := corpo.Frames[len(corpo.Frames)-1]
	if ultimo.PctApurado != 100 {
		t.Errorf("último pct_apurado = %v, quer 100", ultimo.PctApurado)
	}
	for sigla, base := range corpo.UFsBase {
		if ultimo.UFs[sigla] != base.SecoesTotal {
			t.Errorf("%s: seções apuradas no último frame = %d, quer %d",
				sigla, ultimo.UFs[sigla], base.SecoesTotal)
		}
	}

	// Soma por UF tem de fechar com o total do frame, e nada anda para trás.
	anterior := map[string]int64{}
	for _, frame := range corpo.Frames {
		var soma int64
		for sigla, base := range corpo.UFsBase {
			apuradas := frame.UFs[sigla]
			if apuradas < anterior[sigla] {
				t.Fatalf("frame %d: %s andou para trás (%d -> %d)",
					frame.Indice, sigla, anterior[sigla], apuradas)
			}
			if apuradas > base.SecoesTotal {
				t.Fatalf("frame %d: %s com %d seções apuradas de %d",
					frame.Indice, sigla, apuradas, base.SecoesTotal)
			}
			anterior[sigla] = apuradas
			soma += apuradas
		}
		if soma != frame.SecoesApuradas {
			t.Fatalf("frame %d: soma por UF = %d, campo secoes_apuradas = %d",
				frame.Indice, soma, frame.SecoesApuradas)
		}
		if frame.SecoesApuradas > frame.SecoesTotal {
			t.Fatalf("frame %d: %d apuradas de %d no total",
				frame.Indice, frame.SecoesApuradas, frame.SecoesTotal)
		}
	}

	// O ritmo é o modelo de fila: UFs menores fecham antes das maiores.
	if corpo.Frames[0].UFs["RR"] == 0 && len(corpo.Frames) > 2 {
		t.Log("aviso: RR ainda em zero no primeiro frame (amostragem do início da série)")
	}
}

func TestReplay2026(t *testing.T) {
	aplicacao := novaAppDeTeste(t)
	resposta := requisitar(t, aplicacao, "/api/replay?modo=2026")

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}

	corpo := decodificarReplay(t, resposta)
	if !corpo.Disponivel {
		t.Fatalf("disponivel = false (nota: %s)", corpo.Nota)
	}
	if len(corpo.Derivado) != 0 {
		t.Errorf("derivado = %v, quer vazio: as coletas de 2026 são reais", corpo.Derivado)
	}
	if len(corpo.Frames) == 0 {
		t.Fatal("nenhum frame")
	}
	if len(corpo.UFsBase) == 0 {
		t.Error("ufs_base vazio")
	}

	ultimo := corpo.Frames[len(corpo.Frames)-1]
	var soma int64
	for sigla, apuradas := range ultimo.UFs {
		if base, existe := corpo.UFsBase[sigla]; existe && apuradas > base.SecoesTotal {
			t.Errorf("%s: %d seções apuradas de %d", sigla, apuradas, base.SecoesTotal)
		}
		soma += apuradas
	}
	if soma != ultimo.SecoesApuradas {
		t.Errorf("soma por UF = %d, campo secoes_apuradas = %d", soma, ultimo.SecoesApuradas)
	}
}

func TestReplayModoInvalido(t *testing.T) {
	aplicacao := novaAppDeTeste(t)
	resposta := requisitar(t, aplicacao, "/api/replay?modo=1998")
	if resposta.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, quer 400", resposta.Code)
	}
}

func TestReplaySemDadosNaoQuebra(t *testing.T) {
	t.Setenv("DADOS_DIR", "../dados")
	t.Setenv("ELEICAO_2022_FILE", "../dados/nao_existe_2022.json")
	t.Setenv("SERIE_2026_FILE", "../dados/nao_existe_2026.jsonl")
	aplicacao, err := novaApp(carregarConfig())
	if err != nil {
		t.Fatalf("criar aplicação sem as séries: %v", err)
	}

	for _, modo := range []string{"2022", "2026"} {
		resposta := requisitar(t, aplicacao, "/api/replay?modo="+modo)
		if resposta.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, quer 200 mesmo sem a série", modo, resposta.Code)
		}
		corpo := decodificarReplay(t, resposta)
		if corpo.Disponivel {
			t.Errorf("%s: disponivel = true sem arquivo de série", modo)
		}
		if corpo.Nota == "" {
			t.Errorf("%s: sem nota explicando a ausência", modo)
		}
	}
}

func TestMargens(t *testing.T) {
	aplicacao := novaAppDeTeste(t)
	resposta := requisitar(t, aplicacao, "/api/margens")

	if resposta.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", resposta.Code)
	}

	var corpo margensResposta
	if err := json.Unmarshal(resposta.Body.Bytes(), &corpo); err != nil {
		t.Fatalf("decodificar margens: %v", err)
	}

	if corpo.Nacional.Lider == "" || corpo.Nacional.VV <= 0 {
		t.Fatalf("nacional incompleto: %+v", corpo.Nacional)
	}
	if corpo.Nacional.MargemVotos <= 0 {
		t.Errorf("margem nacional = %d, quer positiva", corpo.Nacional.MargemVotos)
	}
	if len(corpo.Regioes) != 5 {
		t.Errorf("regiões = %d, quer 5", len(corpo.Regioes))
	}
	if len(corpo.UFs) != 27 {
		t.Errorf("UFs = %d, quer 27", len(corpo.UFs))
	}

	// Peso e margem: a soma dos pesos por UF não pode passar de 100%.
	var somaPeso float64
	for _, uf := range corpo.UFs {
		somaPeso += uf.ShareVotos
		if uf.MargemVotos < 0 {
			t.Errorf("%s: margem negativa (%d) — a margem é sempre do líder", uf.UF, uf.MargemVotos)
		}
	}
	if somaPeso < 99 || somaPeso > 101 {
		t.Errorf("soma dos pesos por UF = %.2f%%, quer ~100%%", somaPeso)
	}

	// A contribuição assinada fecha com a margem do país MEDIDA COM OS DOIS
	// PRIMEIROS DE CADA UF — que é o corte que a base pública traz (dois
	// candidatos por UF). O placar nacional oficial usa a lista completa, então
	// a diferença entre os dois é o voto de terceiro que não entra no corte:
	// ela existe, é pequena e está declarada aqui em vez de escondida.
	var contribuicao int64
	for _, uf := range corpo.UFs {
		contribuicao += uf.Contribuicao
	}

	publico := aplicacao.dados.Publico
	var esperado int64
	for _, uf := range publico.UFs {
		for _, candidato := range uf.Candidatos {
			switch candidato.Nome {
			case corpo.Nacional.Lider:
				esperado += candidato.Votos
			case corpo.Nacional.Segundo:
				esperado -= candidato.Votos
			}
		}
	}
	if contribuicao != esperado {
		t.Errorf("soma das contribuições = %d, margem do país com os dois primeiros de cada UF = %d",
			contribuicao, esperado)
	}
	diferenca := float64(contribuicao-corpo.Nacional.MargemVotos) / float64(corpo.Nacional.MargemVotos)
	if diferenca > 0.01 || diferenca < -0.01 {
		t.Errorf("contribuições (%d) se afastam mais de 1%% da margem nacional (%d): %.2f%%",
			contribuicao, corpo.Nacional.MargemVotos, diferenca*100)
	}

	if len(corpo.Decisivos) == 0 || len(corpo.Decisivos) > 40 {
		t.Fatalf("decisivos = %d, quer entre 1 e 40", len(corpo.Decisivos))
	}
	ordenado := sort.SliceIsSorted(corpo.Decisivos, func(i, j int) bool {
		return corpo.Decisivos[i].Indice > corpo.Decisivos[j].Indice
	})
	if !ordenado {
		t.Error("decisivos fora de ordem por índice (margem × peso)")
	}
	primeiro := corpo.Decisivos[0]
	if primeiro.Indice <= 0 || primeiro.Municipio == "" || primeiro.UF == "" {
		t.Errorf("primeiro decisivo incompleto: %+v", primeiro)
	}

	if corpo.Virou == nil {
		t.Fatal("virou ausente: a comparação com 2022 tinha de estar disponível")
	}
	if corpo.Virou.Fonte2022 == "" {
		t.Error("virou sem fonte de 2022")
	}
	if corpo.Virou.MunicipiosTotal < 5000 {
		t.Errorf("municípios apurados = %d, quer a base inteira", corpo.Virou.MunicipiosTotal)
	}
	for _, item := range corpo.Virou.UFs {
		if item.Partido2022 == item.Partido2026 {
			t.Errorf("%s listada como virada, mas o partido é o mesmo (%s)", item.UF, item.Partido2022)
		}
	}
	for _, item := range corpo.Virou.Municipios {
		if item.Partido2022 == item.Partido2026 {
			t.Errorf("%s/%s listada como virada com o mesmo partido", item.UF, item.Municipio)
		}
	}
}

func TestMargensTotalDeDecisivos(t *testing.T) {
	aplicacao := novaAppDeTeste(t)
	if aplicacao.margens == nil {
		t.Fatal("margens não calculadas no boot")
	}
	// Nenhum decisivo pode ter margem zero: município empatado não decide nada.
	for _, item := range aplicacao.margens.Decisivos {
		if item.MargemVotos <= 0 {
			t.Errorf("%s/%s com margem %d", item.UF, item.Municipio, item.MargemVotos)
		}
	}
}
