package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
)

// Dados municipais e seccionais de uma UF. Tudo é carregado uma única vez no
// boot; nenhuma requisição lê arquivo do disco.

type candidatoMunicipio struct {
	N     string  `json:"n"`
	NMU   string  `json:"nmu"`
	NM    string  `json:"nm"`
	Votos int64   `json:"votos"`
	Pct   float64 `json:"pct"`
}

type municipioEntrada struct {
	CodTSE              int64            `json:"cd_tse"`
	CodIBGE             int64            `json:"cd_ibge"`
	Nome                string           `json:"nome"`
	Votos               map[string]int64 `json:"votos"`
	VotosOutros         int64            `json:"votos_outros"`
	Brancos             int64            `json:"brancos"`
	Nulos               int64            `json:"nulos"`
	Validos             int64            `json:"validos"`
	Total               int64            `json:"total"`
	Secoes              int64            `json:"secoes"`
	SecoesComCoordenada int64            `json:"secoes_com_coordenada"`
	Lider               string           `json:"lider"`
	Margem              int64            `json:"margem"`
	MargemPct           float64          `json:"margem_pct"`
}

type totaisMunicipioEntrada struct {
	Total   int64 `json:"total"`
	Validos int64 `json:"validos"`
	Brancos int64 `json:"brancos"`
	Nulos   int64 `json:"nulos"`
	Secoes  int64 `json:"secoes"`
}

type municipiosArquivo struct {
	UF          string                 `json:"uf"`
	Eleicao     string                 `json:"eleicao"`
	Turno       json.Number            `json:"turno"`
	GeradoEm    string                 `json:"gerado_em"`
	Fonte       string                 `json:"fonte"`
	Candidatos  []candidatoMunicipio   `json:"candidatos"`
	Municipios  []municipioEntrada     `json:"municipios"`
	Totais      totaisMunicipioEntrada `json:"totais"`
	Conferencia json.RawMessage        `json:"conferencia"`
}

type secoesArquivo struct {
	UF         string            `json:"uf"`
	Eleicao    string            `json:"eleicao"`
	Turno      json.Number       `json:"turno"`
	GeradoEm   string            `json:"gerado_em"`
	Fonte      string            `json:"fonte"`
	Campos     []string          `json:"campos"`
	Candidatos map[string]string `json:"candidatos"`
	Municipios map[string]string `json:"municipios"`
	Secoes     []json.RawMessage `json:"secoes"`
}

type totaisMunicipiosResposta struct {
	Total   int64 `json:"total"`
	Validos int64 `json:"validos"`
	Brancos int64 `json:"brancos"`
	Nulos   int64 `json:"nulos"`
	Secoes  int64 `json:"secoes"`
}

type municipioResposta struct {
	CodIBGE      int64   `json:"cd_ibge"`
	CodTSE       int64   `json:"cd_tse"`
	Nome         string  `json:"nome"`
	Total        int64   `json:"total"`
	VV           int64   `json:"vv"`
	Lider        string  `json:"lider"`
	LiderCod     string  `json:"lider_cod"`
	LiderPct     float64 `json:"lider_pct"`
	PartidoLider string  `json:"partido_lider"`
	MargemVotos  int64   `json:"margem_votos"`
	MargemPct    float64 `json:"margem_pct"`
	Secoes       int64   `json:"secoes"`
}

type municipiosResposta struct {
	UF              string                   `json:"uf"`
	Eleicao         string                   `json:"eleicao"`
	Turno           string                   `json:"turno"`
	GeradoEm        string                   `json:"gerado_em"`
	Fonte           string                   `json:"fonte"`
	TotalMunicipios int                      `json:"total_municipios"`
	Totais          totaisMunicipiosResposta `json:"totais"`
	Municipios      []municipioResposta      `json:"municipios"`
}

type totaisZonasResposta struct {
	Total  int64 `json:"total"`
	Secoes int64 `json:"secoes"`
}

type zonaResposta struct {
	Zona         int64   `json:"zona"`
	CodTSE       int64   `json:"cd_tse"`
	Municipio    string  `json:"municipio"`
	Lat          float64 `json:"lat"`
	Lon          float64 `json:"lon"`
	Total        int64   `json:"total"`
	VV           int64   `json:"vv"`
	Lider        string  `json:"lider"`
	LiderCod     string  `json:"lider_cod"`
	PartidoLider string  `json:"partido_lider"`
	MargemVotos  int64   `json:"margem_votos"`
	MargemPct    float64 `json:"margem_pct"`
	Secoes       int64   `json:"secoes"`
	PctApurado   float64 `json:"pct_apurado"`
	AlturaM      float64 `json:"altura_m"`
	RaioM        float64 `json:"raio_m"`
	// LiderPct só é usado no GeoJSON de zonas; não faz parte da resposta tabular.
	LiderPct float64 `json:"-"`
}

type zonasResposta struct {
	UF         string              `json:"uf"`
	Eleicao    string              `json:"eleicao"`
	Turno      string              `json:"turno"`
	TotalZonas int                 `json:"total_zonas"`
	Totais     totaisZonasResposta `json:"totais"`
	Zonas      []zonaResposta      `json:"zonas"`
}

type totaisLocaisResposta struct {
	Total  int64 `json:"total"`
	VV     int64 `json:"vv"`
	Secoes int64 `json:"secoes"`
}

type localSecaoResposta struct {
	Zona    int64   `json:"zona"`
	Secao   int64   `json:"secao"`
	Lat     float64 `json:"lat"`
	Lon     float64 `json:"lon"`
	Total   int64   `json:"total"`
	VV      int64   `json:"vv"`
	V13     int64   `json:"v13"`
	V22     int64   `json:"v22"`
	VOutros int64   `json:"voutros"`
	Lider   string  `json:"lider"`
}

type localResposta struct {
	NrLocal      int64                `json:"nr_local"`
	Lat          float64              `json:"lat"`
	Lon          float64              `json:"lon"`
	Total        int64                `json:"total"`
	VV           int64                `json:"vv"`
	V13          int64                `json:"v13"`
	V22          int64                `json:"v22"`
	VOutros      int64                `json:"voutros"`
	Lider        string               `json:"lider"`
	LiderCod     string               `json:"lider_cod"`
	PartidoLider string               `json:"partido_lider"`
	LiderPct     float64              `json:"lider_pct"`
	MargemVotos  int64                `json:"margem_votos"`
	MargemPct    float64              `json:"margem_pct"`
	Secoes       []localSecaoResposta `json:"secoes"`
}

type locaisMunicipioResposta struct {
	UF          string               `json:"uf"`
	CD          int64                `json:"cd"`
	Municipio   string               `json:"municipio"`
	TotalLocais int                  `json:"total_locais"`
	Totais      totaisLocaisResposta `json:"totais"`
	Locais      []localResposta      `json:"locais"`
}

type propriedadesMunicipioGeo struct {
	CodArea      string  `json:"codarea"`
	CodTSE       int64   `json:"cd_tse"`
	Nome         string  `json:"nome"`
	PartidoLider string  `json:"partido_lider"`
	Lider        string  `json:"lider"`
	LiderPct     float64 `json:"lider_pct"`
	MargemVotos  int64   `json:"margem_votos"`
	MargemPct    float64 `json:"margem_pct"`
	Total        int64   `json:"total"`
	VV           int64   `json:"vv"`
	Secoes       int64   `json:"secoes"`
}

type featureMunicipioGeo struct {
	Type       string                   `json:"type"`
	ID         string                   `json:"id"`
	Properties propriedadesMunicipioGeo `json:"properties"`
	Geometry   json.RawMessage          `json:"geometry"`
}

type colecaoMunicipiosGeo struct {
	Type     string                `json:"type"`
	Features []featureMunicipioGeo `json:"features"`
}

type propriedadesZonaGeo struct {
	Zona         int64   `json:"zona"`
	CodTSE       int64   `json:"cd_tse"`
	Municipio    string  `json:"municipio"`
	Total        int64   `json:"total"`
	PartidoLider string  `json:"partido_lider"`
	Lider        string  `json:"lider"`
	LiderPct     float64 `json:"lider_pct"`
	MargemPct    float64 `json:"margem_pct"`
	VV           int64   `json:"vv"`
	Secoes       int64   `json:"secoes"`
	PctApurado   float64 `json:"pct_apurado"`
	AlturaM      float64 `json:"altura_m"`
}

type geometriaPoligono struct {
	Type        string         `json:"type"`
	Coordinates [][][2]float64 `json:"coordinates"`
}

type featureZonaGeo struct {
	Type       string              `json:"type"`
	ID         string              `json:"id"`
	Properties propriedadesZonaGeo `json:"properties"`
	Geometry   geometriaPoligono   `json:"geometry"`
}

type colecaoZonasGeo struct {
	Type     string           `json:"type"`
	Features []featureZonaGeo `json:"features"`
}

// dadosUF guarda as respostas já montadas no boot para cada UF disponível.
type dadosUF struct {
	Municipios    municipiosResposta
	MunicipiosGeo colecaoMunicipiosGeo
	Zonas         zonasResposta
	ZonasGeo      colecaoZonasGeo
	Locais        map[int64]locaisMunicipioResposta
}

func ufValida(sigla string) bool {
	for _, uf := range tabelaUFs {
		if uf.Sigla == sigla {
			return true
		}
	}
	return false
}

// carregarDadosMunicipais tenta carregar os arquivos municipais no boot. Qualquer
// ausência ou falha gera apenas aviso no log: a API continua no ar sem esses dados.
func carregarDadosMunicipais(dadosDir string, pub *publico) map[string]*dadosUF {
	caminhoMunicipios := filepath.Join(dadosDir, "municipios.json")
	conteudoMunicipios, err := os.ReadFile(caminhoMunicipios)
	if err != nil {
		log.Printf("aviso: sem dados municipais em %s: %v", caminhoMunicipios, err)
		return nil
	}

	var arquivo municipiosArquivo
	if err := json.Unmarshal(conteudoMunicipios, &arquivo); err != nil {
		log.Printf("aviso: não foi possível decodificar %s: %v", caminhoMunicipios, err)
		return nil
	}

	// A UF sai do próprio arquivo, nunca do caminho da requisição.
	uf := arquivo.UF
	if !ufValida(uf) {
		log.Printf("aviso: municipios.json declara uf=%q fora da tabela; rotas municipais desativadas", uf)
		return nil
	}

	// O nome dos arquivos é montado com a tabela fixa + UF já validada.
	caminhoMalha := filepath.Join(dadosDir, fmt.Sprintf("malha_municipios_%s.geojson", uf))
	conteudoMalha, err := os.ReadFile(caminhoMalha)
	if err != nil {
		log.Printf("aviso: malha municipal de %s indisponível em %s: %v", uf, caminhoMalha, err)
		return nil
	}

	var malha malhaEntrada
	if err := json.Unmarshal(conteudoMalha, &malha); err != nil {
		log.Printf("aviso: não foi possível decodificar %s: %v", caminhoMalha, err)
		return nil
	}

	caminhoSecoes := filepath.Join(dadosDir, fmt.Sprintf("secoes_%s.json", uf))
	conteudoSecoes, err := os.ReadFile(caminhoSecoes)
	if err != nil {
		log.Printf("aviso: seções de %s indisponíveis em %s: %v", uf, caminhoSecoes, err)
		return nil
	}

	var secoes secoesArquivo
	if err := json.Unmarshal(conteudoSecoes, &secoes); err != nil {
		log.Printf("aviso: não foi possível decodificar %s: %v", caminhoSecoes, err)
		return nil
	}

	indiceCampos := make(map[string]int, len(secoes.Campos))
	for indice, nome := range secoes.Campos {
		indiceCampos[nome] = indice
	}
	for _, nome := range []string{"zona", "cd_tse", "lat", "lon", "v13", "v22", "voutros", "total"} {
		if _, existe := indiceCampos[nome]; !existe {
			log.Printf("aviso: secoes_%s.json sem o campo %q; rotas municipais desativadas", uf, nome)
			return nil
		}
	}

	candidatos := make(map[string]candidatoMunicipio, len(arquivo.Candidatos))
	for _, candidato := range arquivo.Candidatos {
		candidatos[candidato.N] = candidato
	}
	partidos := partidosPorCodigo(pub, uf, candidatos)

	municipios, nomesPorCDTSE := montarMunicipios(arquivo, candidatos, partidos)
	municipiosGeo := montarMunicipiosGeo(municipios, malha)
	zonas, zonasGeo, semCoordenada := montarZonas(arquivo, secoes, indiceCampos, candidatos, partidos, nomesPorCDTSE)
	locais := montarLocais(arquivo, secoes, indiceCampos, candidatos, partidos, nomesPorCDTSE)

	respostaMunicipios := municipiosResposta{
		UF:              arquivo.UF,
		Eleicao:         arquivo.Eleicao,
		Turno:           arquivo.Turno.String(),
		GeradoEm:        arquivo.GeradoEm,
		Fonte:           arquivo.Fonte,
		TotalMunicipios: len(municipios),
		Totais: totaisMunicipiosResposta{
			Total:   arquivo.Totais.Total,
			Validos: arquivo.Totais.Validos,
			Brancos: arquivo.Totais.Brancos,
			Nulos:   arquivo.Totais.Nulos,
			Secoes:  arquivo.Totais.Secoes,
		},
		Municipios: municipios,
	}

	log.Printf("dados municipais %s: %d municípios, %d zonas (%d sem coordenada)",
		uf, len(municipios), len(zonas.Zonas), semCoordenada)

	totalLocais := 0
	for _, municipioLocais := range locais {
		totalLocais += municipioLocais.TotalLocais
	}
	log.Printf("dados de locais %s: %d locais agregados em %d municípios", uf, totalLocais, len(locais))

	return map[string]*dadosUF{
		uf: {
			Municipios:    respostaMunicipios,
			MunicipiosGeo: municipiosGeo,
			Zonas:         zonas,
			ZonasGeo:      zonasGeo,
			Locais:        locais,
		},
	}
}

// partidosPorCodigo casa o código do candidato (municipios.json) com o partido
// publicado em publico.json, usando o nome curto como chave.
func partidosPorCodigo(pub *publico, uf string, candidatos map[string]candidatoMunicipio) map[string]string {
	resultado := make(map[string]string)
	if pub == nil {
		return resultado
	}

	var candidatosUF []candidatoPublico
	for _, ufPublico := range pub.UFs {
		if ufPublico.UF == uf {
			candidatosUF = ufPublico.Candidatos
			break
		}
	}
	if len(candidatosUF) == 0 {
		return resultado
	}

	partidoPorNome := make(map[string]string, len(candidatosUF))
	for _, candidato := range candidatosUF {
		partidoPorNome[candidato.Nome] = candidato.Partido
	}

	for codigo, candidato := range candidatos {
		if partido, existe := partidoPorNome[candidato.NMU]; existe {
			resultado[codigo] = partido
			continue
		}
		if partido, existe := partidoPorNome[candidato.NM]; existe {
			resultado[codigo] = partido
		}
	}
	return resultado
}

func nomeCandidato(codigo string, candidatos map[string]candidatoMunicipio) string {
	if candidato, existe := candidatos[codigo]; existe && candidato.NMU != "" {
		return candidato.NMU
	}
	return codigo
}

func nomeCandidatoZona(codigo string, nomesSecoes map[string]string, candidatos map[string]candidatoMunicipio) string {
	if nome := nomesSecoes[codigo]; nome != "" {
		return nome
	}
	return nomeCandidato(codigo, candidatos)
}

func montarMunicipios(arquivo municipiosArquivo, candidatos map[string]candidatoMunicipio, partidos map[string]string) ([]municipioResposta, map[int64]string) {
	nomesPorCDTSE := make(map[int64]string, len(arquivo.Municipios))
	municipios := make([]municipioResposta, 0, len(arquivo.Municipios))

	for _, municipio := range arquivo.Municipios {
		nomesPorCDTSE[municipio.CodTSE] = municipio.Nome

		codigoLider := municipio.Lider
		votosLider := municipio.Votos[codigoLider]
		nomeLider := nomeCandidato(codigoLider, candidatos)
		partidoLider := partidos[codigoLider]

		if codigoLider == "outros" {
			votosLider = municipio.VotosOutros
			nomeLider = "outros candidatos"
			partidoLider = ""
		}

		municipios = append(municipios, municipioResposta{
			CodIBGE:      municipio.CodIBGE,
			CodTSE:       municipio.CodTSE,
			Nome:         municipio.Nome,
			Total:        municipio.Total,
			VV:           municipio.Validos,
			Lider:        nomeLider,
			LiderCod:     codigoLider,
			LiderPct:     percentual(votosLider, municipio.Validos),
			PartidoLider: partidoLider,
			MargemVotos:  municipio.Margem,
			MargemPct:    municipio.MargemPct,
			Secoes:       municipio.Secoes,
		})
	}

	sort.SliceStable(municipios, func(i, j int) bool {
		if municipios[i].Total != municipios[j].Total {
			return municipios[i].Total > municipios[j].Total
		}
		return municipios[i].CodIBGE < municipios[j].CodIBGE
	})
	return municipios, nomesPorCDTSE
}

func montarMunicipiosGeo(municipios []municipioResposta, malha malhaEntrada) colecaoMunicipiosGeo {
	geometrias := make(map[string]json.RawMessage, len(malha.Features))
	for _, feature := range malha.Features {
		if feature.Properties.CodArea == "" || len(feature.Geometry) == 0 {
			continue
		}
		geometrias[feature.Properties.CodArea] = feature.Geometry
	}

	features := make([]featureMunicipioGeo, 0, len(municipios))
	semGeometria := 0
	for _, municipio := range municipios {
		codArea := strconv.FormatInt(municipio.CodIBGE, 10)
		geometria, existe := geometrias[codArea]
		if !existe {
			semGeometria++
			continue
		}
		features = append(features, featureMunicipioGeo{
			Type: "Feature",
			ID:   codArea,
			Properties: propriedadesMunicipioGeo{
				CodArea:      codArea,
				CodTSE:       municipio.CodTSE,
				Nome:         municipio.Nome,
				PartidoLider: municipio.PartidoLider,
				Lider:        municipio.Lider,
				LiderPct:     municipio.LiderPct,
				MargemVotos:  municipio.MargemVotos,
				MargemPct:    municipio.MargemPct,
				Total:        municipio.Total,
				VV:           municipio.VV,
				Secoes:       municipio.Secoes,
			},
			Geometry: geometria,
		})
	}
	if semGeometria > 0 {
		log.Printf("aviso: %d municípios sem geometria na malha municipal", semGeometria)
	}

	return colecaoMunicipiosGeo{
		Type:     "FeatureCollection",
		Features: features,
	}
}

type acumuladoZona struct {
	codTSE        int64
	zona          int64
	total         int64
	secoes        int64
	v13           int64
	v22           int64
	voutros       int64
	somaLat       float64
	somaLon       float64
	comCoordenada int64
}

func montarZonas(arquivo municipiosArquivo, secoes secoesArquivo, indiceCampos map[string]int, candidatos map[string]candidatoMunicipio, partidos map[string]string, nomesPorCDTSE map[int64]string) (zonasResposta, colecaoZonasGeo, int) {
	nomesSecoes := make(map[int64]string, len(secoes.Municipios))
	for chave, nome := range secoes.Municipios {
		codigo, err := strconv.ParseInt(chave, 10, 64)
		if err != nil {
			continue
		}
		nomesSecoes[codigo] = nome
	}

	porZona := make(map[[2]int64]*acumuladoZona)
	for _, secaoBruta := range secoes.Secoes {
		var partes []json.RawMessage
		if err := json.Unmarshal(secaoBruta, &partes); err != nil {
			continue
		}

		chave := [2]int64{
			valorInt64(partes, indiceCampos, "cd_tse"),
			valorInt64(partes, indiceCampos, "zona"),
		}
		acumulado := porZona[chave]
		if acumulado == nil {
			acumulado = &acumuladoZona{codTSE: chave[0], zona: chave[1]}
			porZona[chave] = acumulado
		}

		acumulado.total += valorInt64(partes, indiceCampos, "total")
		acumulado.secoes++
		acumulado.v13 += valorInt64(partes, indiceCampos, "v13")
		acumulado.v22 += valorInt64(partes, indiceCampos, "v22")
		acumulado.voutros += valorInt64(partes, indiceCampos, "voutros")

		lat, temLat := valorCoordenada(partes, indiceCampos, "lat")
		lon, temLon := valorCoordenada(partes, indiceCampos, "lon")
		if temLat && temLon {
			acumulado.somaLat += lat
			acumulado.somaLon += lon
			acumulado.comCoordenada++
		}
	}

	var maiorTotal int64
	for _, acumulado := range porZona {
		if acumulado.total > maiorTotal {
			maiorTotal = acumulado.total
		}
	}

	zonas := make([]zonaResposta, 0, len(porZona))
	semCoordenada := 0
	for _, acumulado := range porZona {
		if acumulado.comCoordenada == 0 {
			// A zona sem coordenada fica fora da lista, mas seus votos continuam
			// somados no total geral (que vem de arquivo.Totais).
			semCoordenada++
			continue
		}

		lat := acumulado.somaLat / float64(acumulado.comCoordenada)
		lon := acumulado.somaLon / float64(acumulado.comCoordenada)
		codigoLider, votosLider := liderDaZona(acumulado.v13, acumulado.v22, acumulado.voutros)
		nomeLider := "outros candidatos"
		partidoLider := ""
		if codigoLider != "outros" {
			nomeLider = nomeCandidatoZona(codigoLider, secoes.Candidatos, candidatos)
			partidoLider = partidos[codigoLider]
		}

		vv := acumulado.v13 + acumulado.v22 + acumulado.voutros
		margem := votosLider - segundoColocado(acumulado.v13, acumulado.v22, acumulado.voutros)

		municipio := nomesSecoes[acumulado.codTSE]
		if municipio == "" {
			municipio = nomesPorCDTSE[acumulado.codTSE]
		}

		proporcao := 0.0
		if maiorTotal > 0 {
			proporcao = math.Sqrt(float64(acumulado.total) / float64(maiorTotal))
		}

		zonas = append(zonas, zonaResposta{
			Zona:         acumulado.zona,
			CodTSE:       acumulado.codTSE,
			Municipio:    municipio,
			Lat:          lat,
			Lon:          lon,
			Total:        acumulado.total,
			VV:           vv,
			Lider:        nomeLider,
			LiderCod:     codigoLider,
			PartidoLider: partidoLider,
			MargemVotos:  margem,
			MargemPct:    percentual(margem, vv),
			Secoes:       acumulado.secoes,
			// O dump do 1º turno está completo. No 2º turno ao vivo esse campo
			// vem do TSE, junto com o restante da parcial.
			PctApurado: 100.0,
			AlturaM:    math.Round(6000 + 96000*proporcao),
			RaioM:      math.Round(2200 + 4800*proporcao),
			LiderPct:   percentual(votosLider, vv),
		})
	}

	sort.SliceStable(zonas, func(i, j int) bool {
		if zonas[i].Total != zonas[j].Total {
			return zonas[i].Total > zonas[j].Total
		}
		if zonas[i].CodTSE != zonas[j].CodTSE {
			return zonas[i].CodTSE < zonas[j].CodTSE
		}
		return zonas[i].Zona < zonas[j].Zona
	})

	resposta := zonasResposta{
		UF:         arquivo.UF,
		Eleicao:    arquivo.Eleicao,
		Turno:      arquivo.Turno.String(),
		TotalZonas: len(zonas),
		Totais: totaisZonasResposta{
			Total:  arquivo.Totais.Total,
			Secoes: arquivo.Totais.Secoes,
		},
		Zonas: zonas,
	}

	features := make([]featureZonaGeo, 0, len(zonas))
	for _, zona := range zonas {
		anel := anelHexagono(zona.Lat, zona.Lon, zona.RaioM)
		features = append(features, featureZonaGeo{
			Type: "Feature",
			ID:   strconv.FormatInt(zona.CodTSE, 10) + "-" + strconv.FormatInt(zona.Zona, 10),
			Properties: propriedadesZonaGeo{
				Zona:         zona.Zona,
				CodTSE:       zona.CodTSE,
				Municipio:    zona.Municipio,
				Total:        zona.Total,
				PartidoLider: zona.PartidoLider,
				Lider:        zona.Lider,
				LiderPct:     zona.LiderPct,
				MargemPct:    zona.MargemPct,
				VV:           zona.VV,
				Secoes:       zona.Secoes,
				PctApurado:   zona.PctApurado,
				AlturaM:      zona.AlturaM,
			},
			Geometry: geometriaPoligono{
				Type:        "Polygon",
				Coordinates: [][][2]float64{anel},
			},
		})
	}

	return resposta, colecaoZonasGeo{
		Type:     "FeatureCollection",
		Features: features,
	}, semCoordenada
}

type acumuladoLocal struct {
	codTSE        int64
	nrLocal       int64
	total         int64
	v13           int64
	v22           int64
	voutros       int64
	somaLat       float64
	somaLon       float64
	comCoordenada int64
	secoes        []localSecaoResposta
}

// montarLocais agrega as seções por (cd_tse, nr_local) uma única vez no boot.
// O resultado é indexado por cd_tse e já contém os totais e a ordenação final.
func montarLocais(arquivo municipiosArquivo, secoes secoesArquivo, indiceCampos map[string]int, candidatos map[string]candidatoMunicipio, partidos map[string]string, nomesPorCDTSE map[int64]string) map[int64]locaisMunicipioResposta {
	nomesSecoes := make(map[int64]string, len(secoes.Municipios))
	for chave, nome := range secoes.Municipios {
		codigo, err := strconv.ParseInt(chave, 10, 64)
		if err != nil {
			continue
		}
		nomesSecoes[codigo] = nome
	}

	porLocal := make(map[[2]int64]*acumuladoLocal)
	for _, secaoBruta := range secoes.Secoes {
		var partes []json.RawMessage
		if err := json.Unmarshal(secaoBruta, &partes); err != nil {
			continue
		}

		codTSE := valorInt64(partes, indiceCampos, "cd_tse")
		nrLocal := valorInt64(partes, indiceCampos, "nr_local")
		chave := [2]int64{codTSE, nrLocal}
		acumulado := porLocal[chave]
		if acumulado == nil {
			acumulado = &acumuladoLocal{codTSE: codTSE, nrLocal: nrLocal}
			porLocal[chave] = acumulado
		}

		total := valorInt64(partes, indiceCampos, "total")
		v13 := valorInt64(partes, indiceCampos, "v13")
		v22 := valorInt64(partes, indiceCampos, "v22")
		voutros := valorInt64(partes, indiceCampos, "voutros")

		acumulado.total += total
		acumulado.v13 += v13
		acumulado.v22 += v22
		acumulado.voutros += voutros

		lat, lon, temCoordenada := coordenadaDaSecao(partes, indiceCampos)
		if temCoordenada {
			acumulado.somaLat += lat
			acumulado.somaLon += lon
			acumulado.comCoordenada++
		}

		codigoLider, _ := liderDaZona(v13, v22, voutros)
		nomeLider := "outros candidatos"
		if codigoLider != "outros" {
			nomeLider = nomeCandidatoZona(codigoLider, secoes.Candidatos, candidatos)
		}

		acumulado.secoes = append(acumulado.secoes, localSecaoResposta{
			Zona:    valorInt64(partes, indiceCampos, "zona"),
			Secao:   valorInt64(partes, indiceCampos, "secao"),
			Lat:     lat,
			Lon:     lon,
			Total:   total,
			VV:      v13 + v22 + voutros,
			V13:     v13,
			V22:     v22,
			VOutros: voutros,
			Lider:   nomeLider,
		})
	}

	resultado := make(map[int64]locaisMunicipioResposta)
	for _, acumulado := range porLocal {
		resposta, existe := resultado[acumulado.codTSE]
		if !existe {
			municipio := nomesSecoes[acumulado.codTSE]
			if municipio == "" {
				municipio = nomesPorCDTSE[acumulado.codTSE]
			}
			resposta = locaisMunicipioResposta{
				UF:        arquivo.UF,
				CD:        acumulado.codTSE,
				Municipio: municipio,
				Locais:    make([]localResposta, 0),
			}
		}

		lat, lon := 0.0, 0.0
		if acumulado.comCoordenada > 0 {
			lat = acumulado.somaLat / float64(acumulado.comCoordenada)
			lon = acumulado.somaLon / float64(acumulado.comCoordenada)
		}

		codigoLider, votosLider := liderDaZona(acumulado.v13, acumulado.v22, acumulado.voutros)
		nomeLider := "outros candidatos"
		partidoLider := ""
		if codigoLider != "outros" {
			nomeLider = nomeCandidatoZona(codigoLider, secoes.Candidatos, candidatos)
			partidoLider = partidos[codigoLider]
		}

		vv := acumulado.v13 + acumulado.v22 + acumulado.voutros
		margem := votosLider - segundoColocado(acumulado.v13, acumulado.v22, acumulado.voutros)

		resposta.Locais = append(resposta.Locais, localResposta{
			NrLocal:      acumulado.nrLocal,
			Lat:          lat,
			Lon:          lon,
			Total:        acumulado.total,
			VV:           vv,
			V13:          acumulado.v13,
			V22:          acumulado.v22,
			VOutros:      acumulado.voutros,
			Lider:        nomeLider,
			LiderCod:     codigoLider,
			PartidoLider: partidoLider,
			LiderPct:     percentual(votosLider, vv),
			MargemVotos:  margem,
			MargemPct:    percentual(margem, vv),
			Secoes:       acumulado.secoes,
		})
		resposta.Totais.Total += acumulado.total
		resposta.Totais.VV += vv
		resposta.Totais.Secoes += int64(len(acumulado.secoes))
		resultado[acumulado.codTSE] = resposta
	}

	for codigo, resposta := range resultado {
		sort.SliceStable(resposta.Locais, func(i, j int) bool {
			if resposta.Locais[i].Total != resposta.Locais[j].Total {
				return resposta.Locais[i].Total > resposta.Locais[j].Total
			}
			return resposta.Locais[i].NrLocal < resposta.Locais[j].NrLocal
		})
		for indice := range resposta.Locais {
			sort.SliceStable(resposta.Locais[indice].Secoes, func(i, j int) bool {
				if resposta.Locais[indice].Secoes[i].Zona != resposta.Locais[indice].Secoes[j].Zona {
					return resposta.Locais[indice].Secoes[i].Zona < resposta.Locais[indice].Secoes[j].Zona
				}
				return resposta.Locais[indice].Secoes[i].Secao < resposta.Locais[indice].Secoes[j].Secao
			})
		}
		resposta.TotalLocais = len(resposta.Locais)
		resultado[codigo] = resposta
	}

	return resultado
}

// coordenadaDaSecao devolve a coordenada da seção somente quando lat e lon
// existem e não são o sentinela -1 usado pelo TSE para "sem coordenada".
func coordenadaDaSecao(partes []json.RawMessage, indice map[string]int) (float64, float64, bool) {
	lat, temLat := valorCoordenada(partes, indice, "lat")
	lon, temLon := valorCoordenada(partes, indice, "lon")
	if !temLat || !temLon || lat == -1 || lon == -1 {
		return 0, 0, false
	}
	return lat, lon, true
}

func liderDaZona(v13, v22, voutros int64) (string, int64) {
	codigo := "13"
	votos := v13
	if v22 > votos {
		codigo, votos = "22", v22
	}
	if voutros > votos {
		codigo, votos = "outros", voutros
	}
	return codigo, votos
}

func segundoColocado(v13, v22, voutros int64) int64 {
	valores := []int64{v13, v22, voutros}
	sort.Slice(valores, func(i, j int) bool {
		return valores[i] > valores[j]
	})
	return valores[1]
}

func anelHexagono(lat, lon, raioMetros float64) [][2]float64 {
	raioLat := raioMetros / 110540
	cosseno := math.Cos(lat * math.Pi / 180)
	if math.Abs(cosseno) < 1e-9 {
		cosseno = 1e-9
	}
	raioLon := raioMetros / (111320 * cosseno)

	anel := make([][2]float64, 0, 7)
	for indice := 0; indice < 6; indice++ {
		angulo := 2 * math.Pi * float64(indice) / 6
		anel = append(anel, [2]float64{
			lon + raioLon*math.Cos(angulo),
			lat + raioLat*math.Sin(angulo),
		})
	}
	return append(anel, anel[0])
}

func percentual(parte, todo int64) float64 {
	if todo == 0 {
		return 0
	}
	return math.Round(float64(parte)/float64(todo)*100*100) / 100
}

func valorInt64(partes []json.RawMessage, indice map[string]int, nome string) int64 {
	posicao, existe := indice[nome]
	if !existe || posicao < 0 || posicao >= len(partes) {
		return 0
	}

	var inteiro int64
	if err := json.Unmarshal(partes[posicao], &inteiro); err == nil {
		return inteiro
	}

	var decimal float64
	if err := json.Unmarshal(partes[posicao], &decimal); err != nil {
		return 0
	}
	if math.IsNaN(decimal) || math.IsInf(decimal, 0) {
		return 0
	}
	return int64(math.Round(decimal))
}

func valorCoordenada(partes []json.RawMessage, indice map[string]int, nome string) (float64, bool) {
	posicao, existe := indice[nome]
	if !existe || posicao < 0 || posicao >= len(partes) {
		return 0, false
	}

	bruto := bytes.TrimSpace(partes[posicao])
	if len(bruto) == 0 || bytes.Equal(bruto, []byte("null")) {
		return 0, false
	}

	var valor float64
	if err := json.Unmarshal(bruto, &valor); err != nil {
		return 0, false
	}
	if math.IsNaN(valor) || math.IsInf(valor, 0) {
		return 0, false
	}
	return valor, true
}

func (a *app) dadosDaUF(uf string) *dadosUF {
	if a.municipais == nil {
		return nil
	}
	return a.municipais[uf]
}

func (a *app) handleUFMunicipios(uf string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		dadosDaUF := a.dadosDaUF(uf)
		if dadosDaUF == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"erro": "sem dados municipais para esta UF"})
			return
		}
		writeJSON(w, http.StatusOK, dadosDaUF.Municipios)
	}
}

func (a *app) handleUFMunicipiosGeoJSON(uf string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		dadosDaUF := a.dadosDaUF(uf)
		if dadosDaUF == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"erro": "sem dados municipais para esta UF"})
			return
		}
		escreverGeoJSON(w, http.StatusOK, dadosDaUF.MunicipiosGeo)
	}
}

func (a *app) handleUFZonas(uf string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		dadosDaUF := a.dadosDaUF(uf)
		if dadosDaUF == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"erro": "sem dados municipais para esta UF"})
			return
		}
		writeJSON(w, http.StatusOK, dadosDaUF.Zonas)
	}
}

func (a *app) handleUFZonasGeoJSON(uf string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		dadosDaUF := a.dadosDaUF(uf)
		if dadosDaUF == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"erro": "sem dados municipais para esta UF"})
			return
		}
		escreverGeoJSON(w, http.StatusOK, dadosDaUF.ZonasGeo)
	}
}

func (a *app) handleUFLocais(uf string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dadosDaUF := a.dadosDaUF(uf)
		if dadosDaUF == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"erro": "sem dados municipais para esta UF"})
			return
		}

		cd, valido := codigoMunicipio(r.URL.Query().Get("cd"))
		if !valido {
			writeJSON(w, http.StatusBadRequest, map[string]string{"erro": "parâmetro cd obrigatório"})
			return
		}

		locais, existe := dadosDaUF.Locais[cd]
		if !existe || len(locais.Locais) == 0 {
			writeJSON(w, http.StatusNotFound, map[string]string{"erro": "sem locais para este município"})
			return
		}
		writeJSON(w, http.StatusOK, locais)
	}
}

// codigoMunicipio aceita apenas inteiro positivo; vazio e texto viram 400.
func codigoMunicipio(bruto string) (int64, bool) {
	if bruto == "" {
		return 0, false
	}
	codigo, err := strconv.ParseInt(bruto, 10, 64)
	if err != nil || codigo <= 0 {
		return 0, false
	}
	return codigo, true
}

func escreverGeoJSON(w http.ResponseWriter, status int, valor any) {
	w.Header().Set("Content-Type", "application/geo+json")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(valor); err != nil {
		log.Printf("erro ao codificar resposta GeoJSON: %v", err)
	}
}
