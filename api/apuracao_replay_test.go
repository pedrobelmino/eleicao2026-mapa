package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// O replay da apuração é o item do ROADMAP que o Pedro pediu: a apuração
// preenchendo o mapa no tempo, com % apurado e o placar acompanhando. O eixo é
// a ORDEM DAS SEÇÕES porque o dump do TSE por seção não traz horário de
// fechamento — o teste cobra justamente essa declaração, para ninguém
// "consertar" o relógio inventando horário.

func decodificarApuracao(t *testing.T, corpo []byte) apuracaoReplayResposta {
	t.Helper()
	var resposta apuracaoReplayResposta
	if err := json.Unmarshal(corpo, &resposta); err != nil {
		t.Fatalf("decodificar /api/replay: %v", err)
	}
	return resposta
}

func TestReplayApuracaoPorSecao(t *testing.T) {
	aplicacao := novaAppDeTeste(t)
	inicio := time.Now()
	primeira := requisitar(t, aplicacao, "/api/replay")
	demora := time.Since(inicio)

	if primeira.Code != http.StatusOK {
		t.Fatalf("status = %d, quer 200", primeira.Code)
	}
	corpo := decodificarApuracao(t, primeira.Body.Bytes())

	if !corpo.Disponivel {
		t.Fatalf("disponivel = false (nota: %s)", corpo.Nota)
	}
	if corpo.Eleicao != aplicacao.cfg.Eleicao {
		t.Errorf("eleicao = %q, quer %q", corpo.Eleicao, aplicacao.cfg.Eleicao)
	}
	if corpo.Turno != "1º turno" {
		t.Errorf("turno = %q, quer 1º turno", corpo.Turno)
	}
	if corpo.GeradoEm == "" {
		t.Error("gerado_em vazio: o carimbo do arquivo do TSE tem de aparecer")
	}

	// A declaração do eixo é o ponto central: sem horário por seção, o replay
	// diz que o relógio do TSE está indisponível e usa a ordem das seções.
	if corpo.Eixo != eixoOrdemDeSecoes {
		t.Errorf("eixo = %q, quer %q", corpo.Eixo, eixoOrdemDeSecoes)
	}
	if corpo.Relogio != relogioIndisponivel {
		t.Errorf("relogio = %q, quer %q", corpo.Relogio, relogioIndisponivel)
	}
	if !strings.Contains(strings.ToLower(corpo.Nota), "relógio do tse indisponível") {
		t.Errorf("nota sem a declaração de relógio indisponível: %q", corpo.Nota)
	}

	if len(corpo.Passos) != numeroPassosApuracao {
		t.Fatalf("passos = %d, quer %d", len(corpo.Passos), numeroPassosApuracao)
	}
	if len(corpo.Candidatos) != 2 {
		t.Errorf("candidatos = %d, quer 2 (os dois que a base traz por UF)", len(corpo.Candidatos))
	}

	primeiro := corpo.Passos[0]
	if primeiro.PctApurado != 0 || primeiro.SecoesApuradas != 0 {
		t.Errorf("primeiro passo = %.2f%% com %d seções, quer 0%% e 0",
			primeiro.PctApurado, primeiro.SecoesApuradas)
	}
	for _, chave := range []string{chaveVotos13, chaveVotos22, chaveVotosOutros} {
		if primeiro.Votos[chave] != 0 {
			t.Errorf("primeiro passo com %s = %d votos, quer 0", chave, primeiro.Votos[chave])
		}
	}

	ultimo := corpo.Passos[len(corpo.Passos)-1]
	if ultimo.PctApurado != 100 {
		t.Errorf("último pct_apurado = %v, quer 100", ultimo.PctApurado)
	}
	if ultimo.SecoesApuradas != ultimo.SecoesTotal {
		t.Errorf("último passo: %d seções de %d", ultimo.SecoesApuradas, ultimo.SecoesTotal)
	}
	if len(ultimo.UF) != 27 {
		t.Errorf("UFs no último passo = %d, quer 27", len(ultimo.UF))
	}
	if len(corpo.UFsBase) != 27 {
		t.Errorf("ufs_base = %d, quer 27", len(corpo.UFsBase))
	}

	// Nada anda para trás: % apurado, seções apuradas, seções por UF e votos.
	for indice, passo := range corpo.Passos {
		if passo.Indice != indice {
			t.Fatalf("passo %d com i = %d", indice, passo.Indice)
		}
		if passo.SecoesTotal != corpo.SecoesTotal {
			t.Fatalf("passo %d: secoes_total = %d, quer %d", indice, passo.SecoesTotal, corpo.SecoesTotal)
		}
		if indice == 0 {
			continue
		}
		anterior := corpo.Passos[indice-1]
		if passo.PctApurado < anterior.PctApurado {
			t.Fatalf("passo %d: pct_apurado andou para trás (%.2f -> %.2f)",
				indice, anterior.PctApurado, passo.PctApurado)
		}
		if passo.SecoesApuradas < anterior.SecoesApuradas {
			t.Fatalf("passo %d: seções apuradas andaram para trás (%d -> %d)",
				indice, anterior.SecoesApuradas, passo.SecoesApuradas)
		}
		for _, chave := range []string{chaveVotos13, chaveVotos22, chaveVotosOutros, chaveVotosBrancos, chaveVotosNulos} {
			if passo.Votos[chave] < anterior.Votos[chave] {
				t.Fatalf("passo %d: votos[%s] andaram para trás (%d -> %d)",
					indice, chave, anterior.Votos[chave], passo.Votos[chave])
			}
		}
		// O % apurado tem de ser coerente com as seções, não um número solto.
		esperado := 100 * float64(passo.SecoesApuradas) / float64(passo.SecoesTotal)
		if diferenca := esperado - passo.PctApurado; diferenca > 0.01 || diferenca < -0.01 {
			t.Fatalf("passo %d: %d/%d seções = %.2f%%, campo diz %.2f%%",
				indice, passo.SecoesApuradas, passo.SecoesTotal, esperado, passo.PctApurado)
		}
		var soma int64
		for _, apuradas := range passo.UF {
			soma += apuradas
		}
		if soma != passo.SecoesApuradas {
			t.Fatalf("passo %d: soma por UF = %d, campo secoes_apuradas = %d",
				indice, soma, passo.SecoesApuradas)
		}
		if passo.PctApurado > 100 || passo.SecoesApuradas > passo.SecoesTotal {
			t.Fatalf("passo %d acima de 100%%: %.2f%% / %d de %d",
				indice, passo.PctApurado, passo.SecoesApuradas, passo.SecoesTotal)
		}
	}

	// O placar muda de fato entre o começo, o meio e o fim: é o que o Pedro
	// pediu ver acontecendo.
	meio := corpo.Passos[len(corpo.Passos)/2]
	if meio.Votos[chaveVotos13] == 0 || meio.Votos[chaveVotos22] == 0 {
		t.Errorf("passo do meio sem votos dos dois candidatos: %v", meio.Votos)
	}
	if meio.Votos[chaveVotos13] == ultimo.Votos[chaveVotos13] {
		t.Error("votos do 13 não mudaram entre o meio e o fim")
	}

	// O último passo é o arquivo inteiro: bate com o agregado publicado por UF.
	if aplicacao.dados() != nil && aplicacao.dados().Publico != nil {
		var esperadoLula, esperadoFlavio int64
		for _, uf := range aplicacao.dados().Publico.UFs {
			for _, candidato := range uf.Candidatos {
				switch candidato.Nome {
				case "LULA":
					esperadoLula += candidato.Votos
				case "FLAVIO BOLSONARO":
					esperadoFlavio += candidato.Votos
				}
			}
		}
		if ultimo.Votos[chaveVotos13] != esperadoLula {
			t.Errorf("último passo: votos do 13 = %d, publico.json diz %d",
				ultimo.Votos[chaveVotos13], esperadoLula)
		}
		if ultimo.Votos[chaveVotos22] != esperadoFlavio {
			t.Errorf("último passo: votos do 22 = %d, publico.json diz %d",
				ultimo.Votos[chaveVotos22], esperadoFlavio)
		}
	}

	// Todas as UFs fechadas no fim, contra a base (é o que faz o mapa pintar).
	for sigla, base := range corpo.UFsBase {
		if base.SecoesTotal <= 0 {
			t.Errorf("%s: secoes_total = %d na base", sigla, base.SecoesTotal)
		}
		if ultimo.UF[sigla] != base.SecoesTotal {
			t.Errorf("%s: último passo com %d seções, base diz %d",
				sigla, ultimo.UF[sigla], base.SecoesTotal)
		}
	}
	if corpo.Conferencia.SecoesDump != corpo.SecoesTotal {
		t.Errorf("conferência: secoes_dump = %d, secoes_total = %d",
			corpo.Conferencia.SecoesDump, corpo.SecoesTotal)
	}
	if corpo.Conferencia.SecoesPublico == 0 {
		t.Error("conferência sem o agregado por UF")
	}

	t.Logf("montagem do replay: %d passos, %d seções, %s na primeira requisição",
		len(corpo.Passos), corpo.SecoesTotal, demora.Round(time.Millisecond))
}

func TestReplayApuracaoServidoDoCache(t *testing.T) {
	aplicacao := novaAppDeTeste(t)

	primeira := requisitar(t, aplicacao, "/api/replay")
	if primeira.Code != http.StatusOK {
		t.Fatalf("primeira requisição: status %d", primeira.Code)
	}
	inicio := time.Now()
	segunda := requisitar(t, aplicacao, "/api/replay")
	demora := time.Since(inicio)
	if segunda.Code != http.StatusOK {
		t.Fatalf("segunda requisição: status %d", segunda.Code)
	}
	if primeira.Body.String() != segunda.Body.String() {
		t.Error("as duas respostas são diferentes: a série devia ser estável")
	}
	// Do cache a resposta é serialização, não leitura de 27 arquivos.
	if demora > 300*time.Millisecond {
		t.Errorf("segunda requisição levou %s: o cache não está servindo", demora.Round(time.Millisecond))
	}
}

func TestReplayApuracaoSemDumpNaoQuebra(t *testing.T) {
	// Sem os arquivos por seção o replay não some nem entra em pânico: a
	// resposta sai com disponivel=false e a nota explica o motivo.
	aplicacao := &app{cfg: config{DadosDir: t.TempDir(), Eleicao: "6257", Turno: "1"}}
	resposta := montarApuracaoReplay(aplicacao)
	if resposta.Disponivel {
		t.Error("disponivel = true sem dump por seção")
	}
	if resposta.Nota == "" {
		t.Error("sem nota explicando a ausência do dump")
	}
	if resposta.Eixo != eixoOrdemDeSecoes || resposta.Relogio != relogioIndisponivel {
		t.Errorf("eixo/relogio = %q/%q sem dump", resposta.Eixo, resposta.Relogio)
	}
	if resposta.Eleicao != "6257" || resposta.Turno != "1º turno" {
		t.Errorf("identificação perdida sem dump: %q / %q", resposta.Eleicao, resposta.Turno)
	}
}

// TestMontarPassosApuracaoPequeno cobre o caso de total pequeno, em que vários
// passos caem no mesmo ponto de contagem: a série continua comparável a si
// mesma (monotônica, 61 passos, termina no total).
func TestMontarPassosApuracaoPequeno(t *testing.T) {
	porUF := []secoesDoReplay{
		{sigla: "RR", linhas: []votosSecao{{v13: 10, v22: 20}, {v13: 1, v22: 2}}},
		{sigla: "SP", linhas: []votosSecao{{v13: 5, v22: 5}, {v13: 0, v22: 0}, {v13: 3, v22: 1}}},
	}
	passos := montarPassosDaApuracao(porUF)
	if len(passos) != numeroPassosApuracao {
		t.Fatalf("passos = %d, quer %d", len(passos), numeroPassosApuracao)
	}
	ultimo := passos[len(passos)-1]
	if ultimo.SecoesApuradas != 5 || ultimo.SecoesTotal != 5 || ultimo.PctApurado != 100 {
		t.Fatalf("último passo = %d/%d (%.2f%%)", ultimo.SecoesApuradas, ultimo.SecoesTotal, ultimo.PctApurado)
	}
	if ultimo.Votos[chaveVotos13] != 19 || ultimo.Votos[chaveVotos22] != 28 {
		t.Fatalf("votos finais = %v", ultimo.Votos)
	}
	for indice := 1; indice < len(passos); indice++ {
		if passos[indice].SecoesApuradas < passos[indice-1].SecoesApuradas {
			t.Fatalf("passo %d andou para trás", indice)
		}
		if passos[indice].UF["RR"] < passos[indice-1].UF["RR"] {
			t.Fatalf("passo %d: RR andou para trás", indice)
		}
	}
}
