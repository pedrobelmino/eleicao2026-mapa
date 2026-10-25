package main

import (
	"encoding/json"
	"fmt"
)

// Procedência do RETRATO PÚBLICO (dados/publico.json).
//
// publico.json alimenta placar, regiões, insights, estados e a malha por UF.
// Ele é escrito pelo coletor quando o TSE publica o arquivo de resultados do
// turno configurado — e, enquanto esse arquivo não existe, o que está no disco
// é o retrato do turno ANTERIOR (a virada de turno troca ELEICAO/TURNO no
// ambiente, não o dado do TSE).
//
// Sem esta checagem o painel mostra "2º turno · apuração 100%" com número do
// 1º turno — o pior defeito possível neste projeto, porque o número é real mas
// não é do turno que a tela afirma. `incoerente` é o portão único: quando ele
// é verdadeiro, /api/estados, /api/home e /api/ufs.geojson servem payload
// ZERADO (sem_dado) em vez de servir número de outro turno, e o front troca os
// cards pelo estado de espera.
type procedenciaSnapshot struct {
	Incoerente bool   `json:"incoerente"`
	Eleicao    string `json:"eleicao"`
	Turno      string `json:"turno"`
	GeradoEm   string `json:"gerado_em"`
	Aviso      string `json:"aviso"`
}

// numeroDoTurno extrai o ordinal de turno tanto de "2" (ambiente) quanto de
// "2º turno" / "1º turno" (o que o gerador grava no arquivo). Devolve "" quando
// não há ordinal — e aí não se afirma nada sobre o turno.
func numeroDoTurno(valor string) string {
	for _, r := range valor {
		if r >= '1' && r <= '9' {
			return string(r)
		}
	}
	return ""
}

// procedenciaDoSnapshot lê a procedência declarada DENTRO do arquivo (campos
// `eleicao`, `turno` e `sem_dado`) e a compara com o que está configurado no
// painel (ELEICAO/TURNO do ambiente).
//
//	incoerente = o retrato em disco não é do turno que a tela exibe
func (a *app) procedenciaDoSnapshot() procedenciaSnapshot {
	arquivo := a.dados.Publico
	procedencia := procedenciaSnapshot{
		Eleicao:  arquivo.Eleicao,
		Turno:    arquivo.Turno,
		GeradoEm: arquivo.GeradoEm,
	}

	turnoArquivo := numeroDoTurno(arquivo.Turno)
	turnoPainel := numeroDoTurno(a.cfg.Turno)
	eleicaoDiferente := arquivo.Eleicao != "" && arquivo.Eleicao != a.cfg.Eleicao
	// O código da eleição identifica o turno no TSE (6257 = 1º turno, 6258 =
	// 2º turno): é a chave FORTE, a que o gerador grava no arquivo. O ordinal
	// do turno só decide quando o retrato é antigo e não declara eleição.
	incoerente := eleicaoDiferente
	if arquivo.Eleicao == "" && turnoArquivo != "" && turnoPainel != "" {
		incoerente = turnoArquivo != turnoPainel
	}

	switch {
	case incoerente:
		procedencia.Incoerente = true
		procedencia.Aviso = fmt.Sprintf(
			"placar, estados e margens: dados do %s (eleição %s) — o TSE ainda não publicou voto do %s",
			rotuloDoTurno(arquivo.Turno), arquivo.Eleicao, a.fonte.Rotulo)
	case arquivo.SemDado:
		// O coletor gravou um retrato declarando que não há voto do turno:
		// não há número coerente para exibir (e o arquivo pode nem ter UF).
		procedencia.Incoerente = true
		procedencia.Aviso = fmt.Sprintf(
			"o TSE ainda não publicou voto do %s — placar zerado até o primeiro arquivo chegar",
			a.fonte.Rotulo)
	}

	return procedencia
}

// nacionalZerado é o objeto `nacional` do payload de espera: mesmo formato que
// o front lê (pct_apurado/st/ts/vv + candidatos), com todos os totais em zero.
const nacionalZerado = `{"pct_apurado":0,"st":0,"ts":0,"vv":0,"tv":0,"vb":0,"tvn":0,"te":0,"comparecimento":0,"candidatos":[]}`

// publicoZerado é o corpo de /api/home quando o retrato em disco é incoerente
// com o turno do painel. Mantém as chaves que o front consulta (para nenhum
// componente quebrar por campo ausente) e zera os números.
type publicoZerado struct {
	Eleicao      string          `json:"eleicao"`
	Turno        string          `json:"turno"`
	GeradoEm     string          `json:"gerado_em"`
	Fonte        string          `json:"fonte"`
	SemDado      bool            `json:"sem_dado"`
	Incoerente   bool            `json:"incoerente"`
	Andamento    string          `json:"andamento"`
	Nacional     json.RawMessage `json:"nacional"`
	UFs          []struct{}      `json:"ufs"`
	Regioes      []struct{}      `json:"regioes"`
	Insights     []struct{}      `json:"insights"`
	Serie        []struct{}      `json:"serie"`
	Proximo      any             `json:"proximo"`
	DadosEleicao string          `json:"dados_eleicao"`
	DadosTurno   string          `json:"dados_turno"`
	DadosAviso   string          `json:"dados_aviso"`
}

func (a *app) montarPublicoZerado() publicoZerado {
	procedencia := a.procedenciaDoSnapshot()
	return publicoZerado{
		Eleicao:      a.cfg.Eleicao,
		Turno:        a.cfg.Turno,
		Fonte:        a.fonte.Nacional,
		SemDado:      true,
		Incoerente:   true,
		Andamento:    "n",
		Nacional:     json.RawMessage(nacionalZerado),
		UFs:          []struct{}{},
		Regioes:      []struct{}{},
		Insights:     []struct{}{},
		Serie:        []struct{}{},
		Proximo:      nil,
		DadosEleicao: procedencia.Eleicao,
		DadosTurno:   procedencia.Turno,
		DadosAviso:   procedencia.Aviso,
	}
}

// malhaZerada é o corpo de /api/ufs.geojson no estado de espera: nenhuma UF
// com número. A geometria não é servida porque não há o que colorir — quem
// desenha o mapa está desmontado nesse estado.
type malhaZerada struct {
	Type       string     `json:"type"`
	Features   []struct{} `json:"features"`
	SemDado    bool       `json:"sem_dado"`
	Incoerente bool       `json:"incoerente"`
}
