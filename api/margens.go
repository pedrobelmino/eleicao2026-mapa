package main

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
	"sort"
)

// "De onde está ganhando": a margem do líder nacional em votos e em pontos, por
// área (país, região, UF), os municípios que decidem (margem × peso) e quem
// virou em relação a 2022.
//
// Tudo é soma de voto publicado: nada é estimado. O peso de um município é a
// fatia dele nos votos válidos do país; o índice de decisão é margem em pontos
// × peso — as duas dimensões que o Pedro pediu ("maior margem x maior peso").

type margemArea struct {
	Nome         string  `json:"nome"`
	UFs          int     `json:"ufs,omitempty"`
	VV           int64   `json:"vv"`
	Lider        string  `json:"lider"`
	PartidoLider string  `json:"partido_lider"`
	LiderPct     float64 `json:"lider_pct"`
	Segundo      string  `json:"segundo"`
	SegundoPct   float64 `json:"segundo_pct"`
	MargemVotos  int64   `json:"margem_votos"`
	MargemPontos float64 `json:"margem_pontos"`
	ShareVotos   float64 `json:"share_votos"`
}

type margemUF struct {
	UF           string  `json:"uf"`
	Regiao       string  `json:"regiao"`
	VV           int64   `json:"vv"`
	Lider        string  `json:"lider"`
	PartidoLider string  `json:"partido_lider"`
	LiderPct     float64 `json:"lider_pct"`
	Segundo      string  `json:"segundo"`
	SegundoPct   float64 `json:"segundo_pct"`
	MargemVotos  int64   `json:"margem_votos"`
	MargemPontos float64 `json:"margem_pontos"`
	ShareVotos   float64 `json:"share_votos"`
	// Contribuicao é a margem da UF com sinal: positiva quando a UF entrega
	// votos ao líder nacional, negativa quando entrega ao segundo colocado.
	Contribuicao int64 `json:"contribuicao_votos"`
}

type municipioDecisivo struct {
	UF           string  `json:"uf"`
	Municipio    string  `json:"municipio"`
	CodTSE       int64   `json:"cd_tse"`
	Lider        string  `json:"lider"`
	PartidoLider string  `json:"partido_lider"`
	VV           int64   `json:"vv"`
	ShareVotos   float64 `json:"share_votos"`
	MargemVotos  int64   `json:"margem_votos"`
	MargemPontos float64 `json:"margem_pontos"`
	// Indice = margem em pontos × peso no eleitorado válido do país.
	Indice float64 `json:"indice"`
}

type virada struct {
	UF            string  `json:"uf,omitempty"`
	Municipio     string  `json:"municipio,omitempty"`
	CodTSE        int64   `json:"cd_tse,omitempty"`
	Vencedor2022  string  `json:"vencedor_2022"`
	Partido2022   string  `json:"partido_2022"`
	Vencedor2026  string  `json:"vencedor_2026"`
	Partido2026   string  `json:"partido_2026"`
	Margem2026    int64   `json:"margem_2026_votos"`
	Margem2026Pct float64 `json:"margem_2026_pontos"`
	VV            int64   `json:"vv,omitempty"`
}

type virou struct {
	TotalUFs        int      `json:"total_ufs"`
	TotalMunicipios int      `json:"total_municipios"`
	MunicipiosTotal int      `json:"municipios_apurados"`
	Fonte2022       string   `json:"fonte_2022"`
	UFs             []virada `json:"ufs"`
	Municipios      []virada `json:"municipios"`
}

type margensResposta struct {
	Eleicao   string              `json:"eleicao"`
	Turno     string              `json:"turno"`
	GeradoEm  string              `json:"gerado_em"`
	Fonte     string              `json:"fonte"`
	Nacional  margemArea          `json:"nacional"`
	Regioes   []margemArea        `json:"regioes"`
	UFs       []margemUF          `json:"ufs"`
	Decisivos []municipioDecisivo `json:"decisivos"`
	Virou     *virou              `json:"virou,omitempty"`
	Nota      string              `json:"nota"`
}

type nacionalEntrada struct {
	ST         int64              `json:"st"`
	TS         int64              `json:"ts"`
	PctApurado float64            `json:"pct_apurado"`
	VV         int64              `json:"vv"`
	Candidatos []candidatoPublico `json:"candidatos"`
}

// totaisArea soma votos por candidato em um conjunto de UFs e devolve líder,
// segundo colocado e margem em votos e em pontos.
type totaisArea struct {
	vv     int64
	votos  map[string]int64
	nomes  map[string]string // nome -> partido
	lider  string
	margem int64
}

func novoTotalArea() *totaisArea {
	return &totaisArea{votos: map[string]int64{}, nomes: map[string]string{}}
}

func (t *totaisArea) somar(candidato candidatoPublico) {
	t.votos[candidato.Nome] += candidato.Votos
	if candidato.Partido != "" {
		t.nomes[candidato.Nome] = candidato.Partido
	}
}

func (t *totaisArea) fechar(vv int64) margemArea {
	t.vv = vv
	nomes := make([]string, 0, len(t.votos))
	for nome := range t.votos {
		nomes = append(nomes, nome)
	}
	sort.Slice(nomes, func(i, j int) bool {
		if t.votos[nomes[i]] != t.votos[nomes[j]] {
			return t.votos[nomes[i]] > t.votos[nomes[j]]
		}
		return nomes[i] < nomes[j]
	})

	area := margemArea{VV: vv}
	if len(nomes) == 0 {
		return area
	}
	area.Lider = nomes[0]
	area.LiderPct = percentual(t.votos[nomes[0]], vv)
	area.PartidoLider = t.nomes[nomes[0]]
	if len(nomes) > 1 {
		area.Segundo = nomes[1]
		area.SegundoPct = percentual(t.votos[nomes[1]], vv)
		area.MargemVotos = t.votos[nomes[0]] - t.votos[nomes[1]]
		area.MargemPontos = arredondar(area.LiderPct-area.SegundoPct, 2)
	}
	return area
}

func arredondar(valor float64, casas int) float64 {
	fator := math.Pow(10, float64(casas))
	return math.Round(valor*fator) / fator
}

// montarMargens calcula a resposta inteira no boot: nenhuma requisição varre a
// base municipal (5.570 municípios) de novo.
func montarMargens(pub *publico, municipais map[string]*dadosUF, dados2022 *eleicao2022, eleicao, turno string) *margensResposta {
	if pub == nil {
		return nil
	}

	var nacional nacionalEntrada
	if len(pub.Nacional) > 0 {
		if err := json.Unmarshal(pub.Nacional, &nacional); err != nil {
			log.Printf("aviso: nacional de publico.json ilegível (%v); /api/margens sem números nacionais", err)
			nacional = nacionalEntrada{}
		}
	}

	resposta := &margensResposta{
		Eleicao:   eleicao,
		Turno:     turno,
		GeradoEm:  pub.GeradoEm,
		Fonte:     pub.Fonte,
		Decisivos: []municipioDecisivo{},
		Regioes:   []margemArea{},
		UFs:       []margemUF{},
		Nota: "Margem = votos do líder menos votos do segundo colocado. " +
			"Peso = fatia da área nos votos válidos do país. " +
			"Índice de decisão = margem em pontos × peso.",
	}

	areaNacional := novoTotalArea()
	for _, candidato := range nacional.Candidatos {
		areaNacional.somar(candidato)
	}
	resposta.Nacional = areaNacional.fechar(nacional.VV)

	porRegiao := map[string]*totaisArea{}
	ufsPorRegiao := map[string]int{}
	for _, uf := range pub.UFs {
		area := porRegiao[uf.Regiao]
		if area == nil {
			area = novoTotalArea()
			porRegiao[uf.Regiao] = area
		}
		for _, candidato := range uf.Candidatos {
			area.somar(candidato)
		}
		ufsPorRegiao[uf.Regiao]++
	}

	regioes := make([]string, 0, len(porRegiao))
	for regiao := range porRegiao {
		regioes = append(regioes, regiao)
	}
	sort.Strings(regioes)

	for _, regiao := range regioes {
		var vv int64
		for _, uf := range pub.UFs {
			if uf.Regiao == regiao {
				vv += uf.VV
			}
		}
		area := porRegiao[regiao].fechar(vv)
		area.Nome = regiao
		area.UFs = ufsPorRegiao[regiao]
		area.ShareVotos = percentual(vv, nacional.VV)
		resposta.Regioes = append(resposta.Regioes, area)
	}
	sort.SliceStable(resposta.Regioes, func(i, j int) bool {
		return resposta.Regioes[i].ShareVotos > resposta.Regioes[j].ShareVotos
	})

	for _, uf := range pub.UFs {
		area := novoTotalArea()
		for _, candidato := range uf.Candidatos {
			area.somar(candidato)
		}
		fechada := area.fechar(uf.VV)
		item := margemUF{
			UF:           uf.UF,
			Regiao:       uf.Regiao,
			VV:           uf.VV,
			Lider:        fechada.Lider,
			PartidoLider: fechada.PartidoLider,
			LiderPct:     fechada.LiderPct,
			Segundo:      fechada.Segundo,
			SegundoPct:   fechada.SegundoPct,
			MargemVotos:  fechada.MargemVotos,
			MargemPontos: fechada.MargemPontos,
			ShareVotos:   percentual(uf.VV, nacional.VV),
		}
		if fechada.Lider == resposta.Nacional.Lider {
			item.Contribuicao = fechada.MargemVotos
		} else {
			item.Contribuicao = -fechada.MargemVotos
		}
		resposta.UFs = append(resposta.UFs, item)
	}
	sort.SliceStable(resposta.UFs, func(i, j int) bool {
		return math.Abs(float64(resposta.UFs[i].MargemVotos)) > math.Abs(float64(resposta.UFs[j].MargemVotos))
	})

	// Municípios decisivos e viradas: uma passada única na base municipal.
	decisivos := make([]municipioDecisivo, 0, 64)
	viradas := make([]virada, 0, 512)
	municipiosApurados := 0

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

		for _, municipio := range dados.Municipios.Municipios {
			if municipio.VV <= 0 {
				continue
			}
			municipiosApurados++
			share := percentual(municipio.VV, nacional.VV)
			indice := arredondar(math.Abs(municipio.MargemPct)*share, 4)
			decisivos = append(decisivos, municipioDecisivo{
				UF:           sigla,
				Municipio:    municipio.Nome,
				CodTSE:       municipio.CodTSE,
				Lider:        municipio.Lider,
				PartidoLider: municipio.PartidoLider,
				VV:           municipio.VV,
				ShareVotos:   share,
				MargemVotos:  municipio.MargemVotos,
				MargemPontos: municipio.MargemPct,
				Indice:       indice,
			})

			if dados2022 == nil || len(dados2022.Municipios) == 0 {
				continue
			}
			anterior, existe := dados2022.Municipios[int64Texto(municipio.CodTSE)]
			if !existe || anterior.Validos <= 0 {
				continue
			}
			if anterior.PartidoLider == municipio.PartidoLider || anterior.PartidoLider == "" {
				continue
			}
			viradas = append(viradas, virada{
				UF:            sigla,
				Municipio:     municipio.Nome,
				CodTSE:        municipio.CodTSE,
				Vencedor2022:  anterior.Lider,
				Partido2022:   anterior.PartidoLider,
				Vencedor2026:  municipio.Lider,
				Partido2026:   municipio.PartidoLider,
				Margem2026:    municipio.MargemVotos,
				Margem2026Pct: municipio.MargemPct,
				VV:            municipio.VV,
			})
		}
	}

	sort.SliceStable(decisivos, func(i, j int) bool {
		if decisivos[i].Indice != decisivos[j].Indice {
			return decisivos[i].Indice > decisivos[j].Indice
		}
		return decisivos[i].VV > decisivos[j].VV
	})
	if len(decisivos) > 40 {
		decisivos = decisivos[:40]
	}
	resposta.Decisivos = decisivos

	if dados2022 != nil && len(dados2022.Municipios) > 0 {
		ufsViradas := make([]virada, 0, 8)
		for _, uf := range resposta.UFs {
			anterior, existe := dados2022.UFs[uf.UF]
			if !existe || anterior.PartidoLider == "" {
				continue
			}
			if anterior.PartidoLider == uf.PartidoLider {
				continue
			}
			ufsViradas = append(ufsViradas, virada{
				UF:            uf.UF,
				Vencedor2022:  anterior.Lider,
				Partido2022:   anterior.PartidoLider,
				Vencedor2026:  uf.Lider,
				Partido2026:   uf.PartidoLider,
				Margem2026:    uf.MargemVotos,
				Margem2026Pct: uf.MargemPontos,
				VV:            uf.VV,
			})
		}
		sort.SliceStable(ufsViradas, func(i, j int) bool {
			return ufsViradas[i].VV > ufsViradas[j].VV
		})
		sort.SliceStable(viradas, func(i, j int) bool {
			if viradas[i].VV != viradas[j].VV {
				return viradas[i].VV > viradas[j].VV
			}
			return viradas[i].Municipio < viradas[j].Municipio
		})

		resposta.Virou = &virou{
			TotalUFs:        len(ufsViradas),
			TotalMunicipios: len(viradas),
			MunicipiosTotal: municipiosApurados,
			Fonte2022:       dados2022.Fonte,
			UFs:             ufsViradas,
			Municipios:      viradas,
		}
	} else {
		resposta.Nota += " A comparação com 2022 está indisponível (dados de 2022 não carregados)."
	}

	return resposta
}

// int64Texto evita depender do formato de strconv nas chaves do JSON de 2022.
func int64Texto(valor int64) string {
	if valor == 0 {
		return "0"
	}
	negativo := valor < 0
	if negativo {
		valor = -valor
	}
	var digitos [20]byte
	posicao := len(digitos)
	for valor > 0 {
		posicao--
		digitos[posicao] = byte('0' + valor%10)
		valor /= 10
	}
	if negativo {
		posicao--
		digitos[posicao] = '-'
	}
	return string(digitos[posicao:])
}

func (a *app) handleMargens(w http.ResponseWriter, _ *http.Request) {
	if a.margens == nil {
		writeJSON(w, http.StatusOK, map[string]string{
			"erro": "margens indisponíveis nesta instalação",
		})
		return
	}
	writeJSON(w, http.StatusOK, a.margens)
}
