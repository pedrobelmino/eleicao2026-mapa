package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Replay da apuração de 2026 montado a partir do dump do TSE POR SEÇÃO
// (dados/secoes_<UF>.json).
//
// O que o dump traz: zona, seção, local, coordenada e os votos de cada seção.
// O que ele NÃO traz: horário de fechamento da seção. Sem esse carimbo não
// existe eixo de tempo honesto, e horário não se inventa — então o eixo do
// replay é a ORDEM DAS SEÇÕES (UF menor fecha primeiro, seções na ordem do
// arquivo do TSE) e o relógio do TSE sai declarado como indisponível no campo
// `relogio` e na nota da resposta.
//
// Real: votos de cada seção, total de seções por UF, resultado final.
// Derivado: apenas a ORDEM em que as seções entram na conta.

const (
	// numeroPassosApuracao = 61 passos: 0%, 1,67%, ..., 100%. Passo a passo o
	// placar muda e o mapa fecha UFs, com JSON pequeno o bastante para tocar
	// a 60x sem engasgar.
	numeroPassosApuracao = 61

	chaveVotos13      = "13"
	chaveVotos22      = "22"
	chaveVotosOutros  = "outros"
	chaveVotosBrancos = "brancos"
	chaveVotosNulos   = "nulos"

	eixoOrdemDeSecoes   = "ordem_de_secoes"
	relogioIndisponivel = "indisponivel"
)

type passoApuracao struct {
	// Indice é a posição do passo (0-based) — é o mesmo `i` que o mapa lê.
	Indice int `json:"i"`
	// T é o carimbo de tempo do passo. Vazio quando o eixo é a ordem das
	// seções: sem horário do TSE por seção, não há carimbo a mostrar.
	T              string           `json:"t"`
	PctApurado     float64          `json:"pct_apurado"`
	SecoesApuradas int64            `json:"secoes_apuradas"`
	SecoesTotal    int64            `json:"secoes_total"`
	UF             map[string]int64 `json:"uf"`
	Votos          map[string]int64 `json:"votos"`
}

type candidatoApuracao struct {
	Codigo  string `json:"codigo"`
	Nome    string `json:"nome"`
	Partido string `json:"partido,omitempty"`
}

// conferenciaApuracao expõe a diferença conhecida entre o dump por seção e o
// agregado publicado por UF. É número medido, não arredondado para zero.
type conferenciaApuracao struct {
	SecoesDump    int64 `json:"secoes_dump"`
	SecoesPublico int64 `json:"secoes_publico"`
	Diferenca     int64 `json:"diferenca"`
}

type apuracaoReplayResposta struct {
	Eleicao          string                  `json:"eleicao"`
	Turno            string                  `json:"turno"`
	GeradoEm         string                  `json:"gerado_em"`
	FonteGeradaTexto string                  `json:"fonte_gerada_texto,omitempty"`
	Fonte            string                  `json:"fonte"`
	Disponivel       bool                    `json:"disponivel"`
	Eixo             string                  `json:"eixo"`
	Relogio          string                  `json:"relogio"`
	Nota             string                  `json:"nota"`
	Real             []string                `json:"real"`
	Derivado         []string                `json:"derivado"`
	SecoesTotal      int64                   `json:"secoes_total"`
	Candidatos       []candidatoApuracao     `json:"candidatos"`
	Conferencia      conferenciaApuracao     `json:"conferencia"`
	UFsBase          map[string]ufReplayBase `json:"ufs_base"`
	Passos           []passoApuracao         `json:"passos"`
}

// votosSecao são as colunas que o replay consome de cada seção do dump.
type votosSecao struct {
	v13     int32
	v22     int32
	outros  int32
	brancos int32
	nulos   int32
}

// secoesDoReplay é o recorte de uma UF já na ordem em que as seções entram.
type secoesDoReplay struct {
	sigla  string
	linhas []votosSecao
}

// publicoApuracao é o que o replay precisa do publico.json além do que o
// struct `publico` já carrega (turno e o texto do carimbo do arquivo do TSE).
type publicoApuracao struct {
	Eleicao          string `json:"eleicao"`
	Turno            string `json:"turno"`
	FonteGeradaTexto string `json:"fonte_gerada_texto"`
}

// lerSecoesDoReplay lê secoes_<UF>.json e devolve os votos por seção na ordem
// do arquivo (a ordem em que o TSE publica). O dump é um array de arrays, com
// os nomes das colunas em `campos`: o índice de cada coluna vem do arquivo,
// nunca de uma posição fixa.
func lerSecoesDoReplay(dadosDir, sigla string) ([]votosSecao, map[string]string, error) {
	caminho := filepath.Join(dadosDir, fmt.Sprintf("secoes_%s.json", sigla))
	conteudo, err := os.ReadFile(caminho)
	if err != nil {
		return nil, nil, err
	}

	var arquivo struct {
		UF         string            `json:"uf"`
		Campos     []string          `json:"campos"`
		Candidatos map[string]string `json:"candidatos"`
		Secoes     []json.RawMessage `json:"secoes"`
	}
	if err := json.Unmarshal(conteudo, &arquivo); err != nil {
		return nil, nil, fmt.Errorf("decodificar %s: %w", filepath.Base(caminho), err)
	}
	// A UF sai do conteúdo do arquivo, nunca do caminho da requisição.
	if arquivo.UF != sigla {
		return nil, nil, fmt.Errorf("%s diz uf=%q (esperado %q)", filepath.Base(caminho), arquivo.UF, sigla)
	}

	indice := make(map[string]int, len(arquivo.Campos))
	for posicao, nome := range arquivo.Campos {
		indice[nome] = posicao
	}
	obrigatorias := []string{"v13", "v22", "voutros"}
	for _, nome := range obrigatorias {
		if _, existe := indice[nome]; !existe {
			return nil, nil, fmt.Errorf("%s sem a coluna %q", filepath.Base(caminho), nome)
		}
	}
	// Brancos e nulos são opcionais: sem a coluna, o campo fica zero em vez de
	// derrubar a UF inteira.
	coluna := func(nome string) int {
		if posicao, existe := indice[nome]; existe {
			return posicao
		}
		return -1
	}
	colBrancos, colNulos := coluna("vbranco"), coluna("vnulo")

	linhas := make([]votosSecao, 0, len(arquivo.Secoes))
	for _, bruta := range arquivo.Secoes {
		valores := make([]json.Number, 0, len(arquivo.Campos))
		if err := json.Unmarshal(bruta, &valores); err != nil {
			// Linha corrompida não derruba a apuração: fica fora da conta.
			continue
		}
		inteiro := func(posicao int) int32 {
			if posicao < 0 || posicao >= len(valores) {
				return 0
			}
			valor, err := valores[posicao].Int64()
			if err != nil {
				flutuante, errFloat := valores[posicao].Float64()
				if errFloat != nil || math.IsNaN(flutuante) || math.IsInf(flutuante, 0) {
					return 0
				}
				return int32(math.Round(flutuante))
			}
			return int32(valor)
		}
		linhas = append(linhas, votosSecao{
			v13:     inteiro(indice["v13"]),
			v22:     inteiro(indice["v22"]),
			outros:  inteiro(indice["voutros"]),
			brancos: inteiro(colBrancos),
			nulos:   inteiro(colNulos),
		})
	}
	if len(linhas) == 0 {
		return nil, nil, fmt.Errorf("%s sem seções válidas", filepath.Base(caminho))
	}
	return linhas, arquivo.Candidatos, nil
}

// carregarSecoesDoReplay lê as 27 UFs. UF que falhar fica de fora com aviso no
// log — o replay segue com o que existe, e a resposta diz que está parcial.
func carregarSecoesDoReplay(dadosDir string) ([]secoesDoReplay, map[string]string, []string) {
	var porUF []secoesDoReplay
	nomes := make(map[string]string, 2)
	var faltando []string

	for _, uf := range tabelaUFs {
		linhas, candidatos, err := lerSecoesDoReplay(dadosDir, uf.Sigla)
		if err != nil {
			log.Printf("aviso: replay da apuração sem %s: %v", uf.Sigla, err)
			faltando = append(faltando, uf.Sigla)
			continue
		}
		for codigo, nome := range candidatos {
			if _, existe := nomes[codigo]; !existe {
				nomes[codigo] = nome
			}
		}
		porUF = append(porUF, secoesDoReplay{sigla: uf.Sigla, linhas: linhas})
	}

	// Ordem do eixo: UF com menos seções fecha primeiro (é o mesmo modelo de
	// fila declarado do replay de 2022), empate resolvido pela sigla para o
	// resultado ser sempre o mesmo.
	sort.Slice(porUF, func(i, j int) bool {
		if len(porUF[i].linhas) != len(porUF[j].linhas) {
			return len(porUF[i].linhas) < len(porUF[j].linhas)
		}
		return porUF[i].sigla < porUF[j].sigla
	})
	return porUF, nomes, faltando
}

// baseDoReplay monta o retrato por UF que o mapa usa para pintar (total de
// seções, líder, partido e margem do resultado final).
func baseDoReplay(porUF []secoesDoReplay, pub *publico) map[string]ufReplayBase {
	base := make(map[string]ufReplayBase, len(porUF))
	publicoPorUF := make(map[string]ufPublico, len(pub.UFs))
	for _, uf := range pub.UFs {
		publicoPorUF[uf.UF] = uf
	}
	for _, uf := range porUF {
		referencia := ufReplayBase{SecoesTotal: int64(len(uf.linhas))}
		if dados, existe := publicoPorUF[uf.sigla]; existe {
			referencia.Lider = dados.Lider
			referencia.PartidoLider = dados.Candidatos[0].Partido
			referencia.LiderPct = dados.LiderPct
			referencia.MargemVotos = dados.MargemVotos
			referencia.MargemPct = margemPercentual(dados.MargemVotos, dados.VV)
			for _, candidato := range dados.Candidatos {
				if candidato.Nome == dados.Lider {
					referencia.PartidoLider = candidato.Partido
					break
				}
			}
		}
		base[uf.sigla] = referencia
	}
	return base
}

// montarPassosDaApuracao acumula as seções na ordem do eixo e grava um passo a
// cada fatia de 1/60 da apuração. Uma passada só: nenhuma seção é contada duas
// vezes e nada anda para trás.
func montarPassosDaApuracao(porUF []secoesDoReplay) []passoApuracao {
	var total int64
	for _, uf := range porUF {
		total += int64(len(uf.linhas))
	}
	if total == 0 {
		return nil
	}

	passos := make([]passoApuracao, 0, numeroPassosApuracao)
	alvoDoPasso := func(indice int) int64 {
		return int64(math.Round(float64(indice) * float64(total) / float64(numeroPassosApuracao-1)))
	}

	apuradasPorUF := make(map[string]int64, len(porUF))
	votos := map[string]int64{
		chaveVotos13: 0, chaveVotos22: 0, chaveVotosOutros: 0,
		chaveVotosBrancos: 0, chaveVotosNulos: 0,
	}
	var acumuladas int64

	gravar := func(indice int) {
		copiaUF := make(map[string]int64, len(apuradasPorUF))
		for sigla, quantidade := range apuradasPorUF {
			copiaUF[sigla] = quantidade
		}
		copiaVotos := make(map[string]int64, len(votos))
		for chave, valor := range votos {
			copiaVotos[chave] = valor
		}
		pct := 100 * float64(acumuladas) / float64(total)
		if indice == numeroPassosApuracao-1 {
			pct = 100
		}
		passos = append(passos, passoApuracao{
			Indice:         indice,
			T:              "",
			PctApurado:     math.Round(pct*100) / 100,
			SecoesApuradas: acumuladas,
			SecoesTotal:    total,
			UF:             copiaUF,
			Votos:          copiaVotos,
		})
	}

	proximo := 1
	// Passo 0 é o começo: nenhuma seção apurada, nenhum voto (é o instante em
	// que o mapa está todo em concreto).
	gravar(0)
	for _, uf := range porUF {
		for _, linha := range uf.linhas {
			acumuladas += 1
			apuradasPorUF[uf.sigla] += 1
			votos[chaveVotos13] += int64(linha.v13)
			votos[chaveVotos22] += int64(linha.v22)
			votos[chaveVotosOutros] += int64(linha.outros)
			votos[chaveVotosBrancos] += int64(linha.brancos)
			votos[chaveVotosNulos] += int64(linha.nulos)
			// Um mesmo ponto de contagem pode satisfazer mais de um passo
			// quando o total é pequeno: grava todos os pendentes.
			for proximo < numeroPassosApuracao && acumuladas >= alvoDoPasso(proximo) {
				gravar(proximo)
				proximo += 1
			}
		}
	}
	// Passos que sobraram (só acontece com eixo vazio ou arredondamento) saem
	// com o estado final, para a série sempre terminar em 100%.
	for proximo < numeroPassosApuracao {
		gravar(proximo)
		proximo += 1
	}
	return passos
}

// montarApuracaoReplay monta a resposta inteira. Falha em arquivo de UF é
// aviso, não erro fatal; sem nenhuma seção, a resposta sai com
// disponivel=false e a nota explica.
func montarApuracaoReplay(a *app) *apuracaoReplayResposta {
	resposta := &apuracaoReplayResposta{
		Eleicao:    a.cfg.Eleicao,
		Turno:      rotuloTurnoTexto(a.cfg.Turno),
		Fonte:      "TSE — arquivo de votação por seção (dados abertos)",
		Eixo:       eixoOrdemDeSecoes,
		Relogio:    relogioIndisponivel,
		Disponivel: false,
		UFsBase:    map[string]ufReplayBase{},
		Passos:     []passoApuracao{},
		Candidatos: []candidatoApuracao{},
		Real: []string{
			"votos de cada seção",
			"total de seções por UF",
			"resultado final por UF (líder, partido, margem)",
		},
		Derivado: []string{
			"ordem em que as seções entram (UF menor fecha primeiro; seções na ordem do arquivo do TSE)",
		},
	}
	if a.dados() != nil && a.dados().Publico != nil {
		resposta.GeradoEm = a.dados().Publico.GeradoEm
		var extra publicoApuracao
		if len(a.dados().PublicoBruto) > 0 {
			if err := json.Unmarshal(a.dados().PublicoBruto, &extra); err == nil {
				resposta.FonteGeradaTexto = extra.FonteGeradaTexto
			}
		}
		if a.dados().Publico.Fonte != "" {
			resposta.Fonte = a.dados().Publico.Fonte
		}
	}

	porUF, nomes, faltando := carregarSecoesDoReplay(a.cfg.DadosDir)
	if len(porUF) == 0 {
		resposta.Nota = "sem o dump por seção do TSE nesta instalação: o replay da apuração não tem o que tocar"
		return resposta
	}

	passos := montarPassosDaApuracao(porUF)
	if len(passos) == 0 {
		resposta.Nota = "o dump por seção não trouxe seções válidas"
		return resposta
	}

	resposta.Disponivel = true
	resposta.SecoesTotal = passos[len(passos)-1].SecoesTotal
	resposta.Passos = passos
	if a.dados() != nil && a.dados().Publico != nil {
		resposta.UFsBase = baseDoReplay(porUF, a.dados().Publico)
	}

	// Candidatos na ordem do placar do arquivo: os dois que a base traz por UF.
	for _, codigo := range []string{chaveVotos13, chaveVotos22} {
		nome := nomes[codigo]
		if nome == "" {
			continue
		}
		candidato := candidatoApuracao{Codigo: codigo, Nome: nome}
		if a.dados() != nil && a.dados().Publico != nil {
			for _, uf := range a.dados().Publico.UFs {
				for _, publicado := range uf.Candidatos {
					if publicado.Nome == nome {
						candidato.Partido = publicado.Partido
						break
					}
				}
				if candidato.Partido != "" {
					break
				}
			}
		}
		resposta.Candidatos = append(resposta.Candidatos, candidato)
	}

	// Conferência: soma de seções do dump contra o agregado publicado por UF.
	var secoesPublico int64
	if a.dados() != nil && a.dados().Publico != nil {
		for _, uf := range a.dados().Publico.UFs {
			secoesPublico += uf.Ts
		}
	}
	resposta.Conferencia = conferenciaApuracao{
		SecoesDump:    resposta.SecoesTotal,
		SecoesPublico: secoesPublico,
		Diferenca:     resposta.SecoesTotal - secoesPublico,
	}

	resposta.Nota = "Relógio do TSE indisponível — o dump por seção não traz o horário de " +
		"fechamento de cada seção, então o replay usa a ORDEM DE SEÇÕES como eixo e não " +
		"mostra horário inventado. Os votos de cada seção e o total são reais; só a ordem " +
		"em que elas entram é derivada."
	if len(faltando) > 0 {
		resposta.Nota += fmt.Sprintf(" UFs fora da conta nesta instalação: %s.",
			strings.Join(faltando, ", "))
	}
	return resposta
}

// rotuloTurnoTexto devolve "1º turno" a partir do TURNO configurado.
func rotuloTurnoTexto(turno string) string {
	if strings.TrimSpace(turno) == "2" {
		return "2º turno"
	}
	return "1º turno"
}

// handleApuracaoReplay serve GET /api/replay (sem modo): a série de apuração
// por passo. O cálculo custa uma leitura do dump por seção (27 arquivos), então
// ele é feito uma vez e ficado no app — a segunda requisição só serializa.
func (a *app) handleApuracaoReplay(w http.ResponseWriter) {
	a.apuracaoMu.Lock()
	defer a.apuracaoMu.Unlock()

	if a.apuracaoResp == nil {
		a.apuracaoResp = montarApuracaoReplay(a)
		if a.apuracaoResp.Disponivel {
			log.Printf("replay da apuração: %d passos, %d seções em %d UFs (eixo: ordem de seções)",
				len(a.apuracaoResp.Passos), a.apuracaoResp.SecoesTotal, len(a.apuracaoResp.UFsBase))
		} else {
			log.Printf("replay da apuração indisponível: %s", a.apuracaoResp.Nota)
		}
	}
	writeJSON(w, http.StatusOK, a.apuracaoResp)
}
