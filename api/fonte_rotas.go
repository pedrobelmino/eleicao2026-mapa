package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"
)

// janelaCacheFonte é o tempo que um diagnóstico da fonte oficial vale. O
// endpoint vai ser apertado no dia da eleição (é a pergunta "o TSE já
// publicou?"), e cada consulta é uma ida ao TSE: um minuto de cache evita
// transformar o painel em amplificador de requisição contra a fonte oficial.
const janelaCacheFonte = time.Minute

// configResposta expõe o que o site precisa saber sobre a origem dos dados:
// qual eleição, qual turno e de onde os arquivos saem. O front não tem nada
// disso no código — trocar ELEICAO/TURNO no ambiente muda esta resposta.
type configResposta struct {
	Eleicao     string `json:"eleicao"`
	Turno       string `json:"turno"`
	RotuloTurno string `json:"rotulo_turno"`
	TSEBase     string `json:"tse_base"`
	Portal      string `json:"portal"`
	URLNacional string `json:"url_nacional"`
	// Modelos com {uf}: o front monta o link de cada estado sem conhecer o
	// padrão de caminho do TSE.
	URLUF    string `json:"url_uf"`
	URLFotos string `json:"url_fotos"`
}

func (a *app) handleConfig(w http.ResponseWriter, _ *http.Request) {
	modeloUF, modeloFotos := modelosDeURL(a.fonte)
	writeJSON(w, http.StatusOK, configResposta{
		Eleicao:     a.fonte.Eleicao,
		Turno:       a.fonte.Turno,
		RotuloTurno: a.fonte.Rotulo,
		TSEBase:     a.fonte.Base,
		Portal:      a.fonte.Portal,
		URLNacional: a.fonte.Nacional,
		URLUF:       modeloUF,
		URLFotos:    modeloFotos,
	})
}

// modelosDeURL devolve o formato das URLs de UF com o marcador {uf}. Fica
// separado da fonte para não duplicar a regra de zeros do código da eleição.
func modelosDeURL(f fonte) (modeloUF, modeloFotos string) {
	codigo := eleicaoNumericaFonte(f.Eleicao)
	seis := eleicaoSeisDigitosFonte(f.Eleicao)
	modeloUF = f.Base + "/" + codigo + "/dados/{uf}/{uf}-c0001-e" + seis + "-u.json"
	modeloFotos = f.Base + "/" + codigo + "/fotos/{uf}/"
	return modeloUF, modeloFotos
}

// handleFonte responde o diagnóstico da fonte oficial: 200 quando o arquivo do
// turno configurado existe e é JSON, 503 com o motivo quando não. É a resposta
// que a checklist do dia da eleição consulta, e ela nunca derruba o site.
func (a *app) handleFonte(w http.ResponseWriter, r *http.Request) {
	resultado := a.verificarFonte(r.Context())
	if !resultado.OK {
		writeJSON(w, http.StatusServiceUnavailable, resultado)
		return
	}
	writeJSON(w, http.StatusOK, resultado)
}

// verificarFonte consulta o TSE no máximo uma vez por janela. O lock fica
// preso durante a consulta de propósito: se dez abas perguntarem juntas, o TSE
// recebe uma requisição e as outras esperam o mesmo resultado (a consulta tem
// teto de 5 s, então a espera tem teto também).
func (a *app) verificarFonte(ctx context.Context) verificacaoFonte {
	a.fonteMu.Lock()
	defer a.fonteMu.Unlock()

	if !a.fonteCacheEm.IsZero() && time.Since(a.fonteCacheEm) < janelaCacheFonte {
		return a.fonteCache
	}

	consulta, cancelar := context.WithTimeout(ctx, 5*time.Second)
	defer cancelar()

	resultado := a.fonte.verificar(consulta, nil)
	a.fonteCache = resultado
	a.fonteCacheEm = time.Now()

	if resultado.OK {
		log.Printf("fonte oficial ok: %s (%dms)", resultado.URL, resultado.DuracaoMs)
	} else {
		// O plantão precisa saber a hora e o motivo; o corpo da resposta não
		// entra no log (pode ser página de erro do TSE, com tamanho grande).
		log.Printf("fonte oficial indisponível: %s (%dms): %s", resultado.URL, resultado.DuracaoMs, resultado.Erro)
	}

	return resultado
}

// descricaoFonte é a linha única que o boot imprime: em uma olhada o plantão
// vê em qual eleição, em qual turno e de qual URL o painel vai ler.
func descricaoFonte(f fonte) string {
	return fmt.Sprintf("fonte oficial: eleicao=%s (%s) base=%s nacional=%s", f.Eleicao, f.Rotulo, f.Base, f.Nacional)
}
