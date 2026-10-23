package main

import (
	"math"
	"net/http"
	"sort"
	"strconv"
)

// Item 6 do ROADMAP — "de onde está ganhando", na granularidade que o mapa
// desenha: o MUNICÍPIO.
//
// `/api/uf/{UF}/margens` devolve uma linha por município da UF com a margem do
// líder (votos e pontos), quem lidera, os votos válidos e a comparação com
// 2022 (virou / não virou + o quanto a vantagem andou em pontos).
//
// Tudo é soma de voto publicado; nada é estimado. A ordem da lista é o critério
// do painel: `margem_votos × vv` (margem absoluta × peso do município),
// decrescente — é o que responde "onde a vitória está sendo feita".
//
// `virou_2022` compara o PARTIDO do líder de agora com o partido do líder de
// 2022 (`dados/eleicao_2022.json`, chave = cd_tse). Município sem par em 2022
// devolve `null` nos dois campos de comparação — nunca um falso "não virou".
//
// `delta_pp_2022` é a variação da vantagem em pontos percentuais NA DIREÇÃO do
// líder atual: vantagem_2026 − vantagem_2022_orientada. Quando o líder é o
// mesmo dos dois pleitos, a vantagem de 2022 já está do mesmo lado; quando
// virou, o sinal de 2022 é invertido (o lado que hoje lidera estava atrás).
// Assim o número é comparável nos dois casos, e negativo significa que a
// vantagem do líder atual ENCOLHEU desde 2022.

type margemMunicipioResposta struct {
	CodArea      string   `json:"codarea"`
	Nome         string   `json:"nome"`
	Lider        string   `json:"lider"`
	MargemVotos  int64    `json:"margem_votos"`
	MargemPct    float64  `json:"margem_pct"`
	VV           int64    `json:"vv"`
	PartidoLider string   `json:"partido_lider"`
	Virou2022    *bool    `json:"virou_2022"`
	DeltaPP2022  *float64 `json:"delta_pp_2022"`
}

type margensUFResposta struct {
	UF              string                    `json:"uf"`
	Eleicao         string                    `json:"eleicao"`
	Turno           string                    `json:"turno"`
	GeradoEm        string                    `json:"gerado_em"`
	Fonte           string                    `json:"fonte"`
	TotalMunicipios int                       `json:"total_municipios"`
	TotalViraram    int                       `json:"total_viraram"`
	Comparacao2022  bool                      `json:"comparacao_2022"`
	Fonte2022       string                    `json:"fonte_2022,omitempty"`
	Municipios      []margemMunicipioResposta `json:"municipios"`
	Nota            string                    `json:"nota"`
}

// margemDeMunicipio devolve a linha pronta, já com a comparação de 2022.
func margemDeMunicipio(municipio municipioResposta, dados2022 *eleicao2022) margemMunicipioResposta {
	linha := margemMunicipioResposta{
		CodArea:      strconv.FormatInt(municipio.CodIBGE, 10),
		Nome:         municipio.Nome,
		Lider:        municipio.Lider,
		MargemVotos:  municipio.MargemVotos,
		MargemPct:    municipio.MargemPct,
		VV:           municipio.VV,
		PartidoLider: municipio.PartidoLider,
	}

	if dados2022 == nil || len(dados2022.Municipios) == 0 {
		return linha
	}
	anterior, existe := dados2022.Municipios[int64Texto(municipio.CodTSE)]
	if !existe || anterior.Validos <= 0 || anterior.PartidoLider == "" {
		// Sem par em 2022: null explícito, não "não virou".
		return linha
	}

	virou := anterior.PartidoLider != municipio.PartidoLider
	linha.Virou2022 = &virou

	vantagemAntes := anterior.MargemPct
	if virou {
		vantagemAntes = -anterior.MargemPct
	}
	delta := arredondar(municipio.MargemPct-vantagemAntes, 2)
	linha.DeltaPP2022 = &delta
	return linha
}

// pesoDeDecisao é o critério do painel: margem absoluta × peso do município.
// O peso é o próprio vv (votos válidos), então a unidade é "votos²" — o que
// importa é a ORDEM, e ela é a do produto pedido (margem × peso).
func pesoDeDecisao(margemVotos, vv int64) float64 {
	return math.Abs(float64(margemVotos)) * float64(vv)
}

func montarMargensUF(municipais map[string]*dadosUF, dados2022 *eleicao2022, eleicao, turno string) map[string]*margensUFResposta {
	resultado := make(map[string]*margensUFResposta, len(municipais))

	siglas := make([]string, 0, len(municipais))
	for sigla := range municipais {
		siglas = append(siglas, sigla)
	}
	sort.Strings(siglas)

	for _, sigla := range siglas {
		dados := municipais[sigla]
		if dados == nil {
			continue
		}

		linhas := make([]margemMunicipioResposta, 0, len(dados.Municipios.Municipios))
		viraram := 0
		for _, municipio := range dados.Municipios.Municipios {
			if municipio.VV <= 0 {
				continue
			}
			linha := margemDeMunicipio(municipio, dados2022)
			if linha.Virou2022 != nil && *linha.Virou2022 {
				viraram++
			}
			linhas = append(linhas, linha)
		}

		sort.SliceStable(linhas, func(i, j int) bool {
			pesoI := pesoDeDecisao(linhas[i].MargemVotos, linhas[i].VV)
			pesoJ := pesoDeDecisao(linhas[j].MargemVotos, linhas[j].VV)
			if pesoI != pesoJ {
				return pesoI > pesoJ
			}
			if linhas[i].VV != linhas[j].VV {
				return linhas[i].VV > linhas[j].VV
			}
			return linhas[i].Nome < linhas[j].Nome
		})

		resposta := &margensUFResposta{
			UF:              sigla,
			Eleicao:         eleicao,
			Turno:           turno,
			GeradoEm:        dados.Municipios.GeradoEm,
			Fonte:           dados.Municipios.Fonte,
			TotalMunicipios: len(linhas),
			TotalViraram:    viraram,
			Comparacao2022:  dados2022 != nil && len(dados2022.Municipios) > 0,
			Municipios:      linhas,
			Nota: "Margem = votos do líder menos votos do segundo colocado no município; " +
				"pontos = essa diferença sobre os votos válidos. Ordem = margem em votos × votos válidos " +
				"(margem absoluta × peso), decrescente. virou_2022 compara o PARTIDO do líder de agora com o " +
				"de 2022 (null quando o município não casa). delta_pp_2022 é a variação da vantagem do líder " +
				"atual em pontos: negativo = a vantagem encolheu desde 2022.",
		}
		if resposta.Comparacao2022 {
			resposta.Fonte2022 = dados2022.Fonte
		} else {
			resposta.Nota += " Comparação com 2022 indisponível (arquivo de 2022 não carregado)."
		}
		resultado[sigla] = resposta
	}

	return resultado
}

func (a *app) handleUFMargens(uf string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if a.margensUF == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"erro": "margens municipais indisponíveis nesta instalação"})
			return
		}
		resposta, existe := a.margensUF[uf]
		if !existe || resposta == nil || len(resposta.Municipios) == 0 {
			writeJSON(w, http.StatusNotFound, map[string]string{"erro": "sem margens municipais para esta UF"})
			return
		}
		writeJSON(w, http.StatusOK, resposta)
	}
}
