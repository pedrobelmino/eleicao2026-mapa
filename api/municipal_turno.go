package main

import (
	"fmt"
	"sort"
	"strings"
)

// Procedência do dado municipal/urna.
//
// O mapa por município, zona e local de votação lê dados/municipios_<UF>.json e
// dados/secoes_<UF>.json. Esses arquivos NÃO vêm do JSON de resultados do TSE
// (que só publica agregado por partido na UF): vêm do dump aberto
// `votacao_secao_2026_<UF>.zip`, um único arquivo por UF que o TSE sobrescreve
// "ao final de cada turno" (descrição oficial do recurso no portal de dados
// abertos). Ou seja: durante a apuração do 2º turno o dump do 2º turno ainda
// não existe, e os arquivos no disco continuam sendo os do 1º turno.
//
// Sem esta checagem o painel mostraria voto de município do 1º turno com o
// rótulo "2º turno" — o pior defeito possível neste projeto. Então a resposta
// pública carrega a procedência declarada DENTRO do arquivo (campos `eleicao` e
// `turno`, gravados pelo gerador) e a tela avisa quando ela difere do turno
// configurado.
type procedenciaMunicipal struct {
	Eleicao  string `json:"eleicao"`
	Turno    string `json:"turno"`
	GeradoEm string `json:"gerado_em"`
	Aviso    string `json:"aviso"`
}

// procedenciaDoMunicipal consolida a procedência de todas as UFs carregadas.
// Quando as UFs divergem entre si (caso de atualização parcial), vale a mais
// antiga — é a que exige aviso — e a divergência entra no texto.
func (a *app) procedenciaDoMunicipal() procedenciaMunicipal {
	if len(a.municipais) == 0 {
		return procedenciaMunicipal{
			Aviso: "sem dado municipal carregado — município, zona e local de votação estão fora do ar",
		}
	}

	ufs := make([]string, 0, len(a.municipais))
	for uf := range a.municipais {
		ufs = append(ufs, uf)
	}
	sort.Strings(ufs)

	menor := ""
	for _, uf := range ufs {
		eleicao := a.municipais[uf].Municipios.Eleicao
		if menor == "" || eleicao < menor {
			menor = eleicao
		}
	}
	divergentes := 0
	for _, uf := range ufs {
		if a.municipais[uf].Municipios.Eleicao != menor {
			divergentes++
		}
	}
	escolhida := a.municipais[ufs[0]]
	for _, uf := range ufs {
		if a.municipais[uf].Municipios.Eleicao == menor {
			escolhida = a.municipais[uf]
			break
		}
	}

	turnoArquivo := escolhida.Municipios.Turno
	procedencia := procedenciaMunicipal{
		Eleicao:  escolhida.Municipios.Eleicao,
		Turno:    turnoArquivo,
		GeradoEm: escolhida.Municipios.GeradoEm,
	}

	if procedencia.Eleicao == a.cfg.Eleicao {
		if divergentes > 0 {
			procedencia.Aviso = fmt.Sprintf(
				"município, zona e local: %d UF(s) com dump de eleição diferente da majoritária (%s)",
				divergentes, procedencia.Eleicao)
		}
		return procedencia
	}

	// O arquivo é de outro turno/eleição: a tela precisa dizer isso com todas
	// as letras, porque os números municipais NÃO são do turno em exibição.
	procedencia.Aviso = fmt.Sprintf(
		"município, zona e local de votação: dados do %s (eleição %s) — o TSE publica o dump por seção só ao final de cada turno",
		rotuloDoTurno(turnoArquivo), procedencia.Eleicao)
	if divergentes > 0 {
		procedencia.Aviso += fmt.Sprintf(" · %d UF(s) com eleição diferente", divergentes)
	}
	return procedencia
}

// rotuloDoTurno é o rótulo humano do turno gravado no arquivo (não confundir
// com a.fonte.Rotulo, que é o turno CONFIGURADO no ambiente).
func rotuloDoTurno(turno string) string {
	switch turno {
	case "1":
		return "1º turno"
	case "2":
		return "2º turno"
	case "":
		return "turno não declarado"
	}
	if strings.Contains(turno, "turno") { // já vem rotulado do snapshot ("1º turno")
		return turno
	}
	return "turno " + turno
}

// avisoDoSnapshot diz, em uma linha, quando o placar nacional/UF exibido não é
// do turno configurado. É o caso da janela entre a virada e o primeiro voto
// publicado: o snapshot em disco ainda é o do turno anterior (o coletor não tem
// o que publicar do turno novo) e a tela precisa dizer isso em vez de mostrar
// número velho com rótulo novo.
func (a *app) avisoDoSnapshot() string {
	arquivo := a.dados.Publico
	if arquivo.Eleicao == "" || arquivo.Eleicao == a.cfg.Eleicao {
		return ""
	}
	return fmt.Sprintf(
		"placar, estados e margens: dados do %s (eleição %s) — o %s ainda não tem voto publicado no TSE",
		rotuloDoTurno(arquivo.Turno), arquivo.Eleicao, a.fonte.Rotulo)
}
