package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// limiteCorpoFonte evita que uma resposta enorme da fonte oficial consuma
	// memória no plantão; 1 MiB cobre com folga os JSONs de resultado.
	limiteCorpoFonte = 1 << 20

	// agenteFonte identifica o mapa para o TSE ao consultar a fonte.
	agenteFonte = "eleicao2026-mapa/1.0 (fonte oficial)"
)

// fonte reúne a eleição, o turno e as URLs derivadas da configuração do TSE.
// Ela é montada uma única vez em novaFonte, de modo que uma configuração
// inválida falhe na inicialização em vez de gerar URLs quebradas no plantão.
type fonte struct {
	Eleicao  string // código da eleição no TSE, só dígitos (2026: 6257 = 1º turno, 6258 = 2º turno)
	Turno    string // "1" ou "2"
	Rotulo   string // "1º turno" ou "2º turno"
	Base     string // TSE_BASE normalizado, sem barra final
	Portal   string // portal público de resultados, sem barra final
	Nacional string // URL do arquivo nacional (br) da eleição
}

// novaFonte valida a configuração e deriva todas as URLs usadas pelo mapa.
// A validação fica aqui, e não nas rotas, para que qualquer URL falsa ou mal
// formada apareça como erro de configuração antes de o servidor atender.
func novaFonte(cfg config) (fonte, error) {
	brutoEleicao := cfg.Eleicao
	eleicao := strings.TrimSpace(brutoEleicao)
	if len(eleicao) < 4 || len(eleicao) > 6 || !somenteDigitosFonte(eleicao) {
		return fonte{}, fmt.Errorf("ELEICAO inválida: %q (esperado só dígitos, ex.: 6257)", brutoEleicao)
	}

	brutoTurno := cfg.Turno
	turno := strings.TrimSpace(brutoTurno)
	var rotulo string
	switch turno {
	case "1":
		rotulo = "1º turno"
	case "2":
		rotulo = "2º turno"
	default:
		return fonte{}, fmt.Errorf("TURNO inválido: %q (esperado 1 ou 2)", brutoTurno)
	}

	base, err := normalizarURLFonte(cfg.TSEBase)
	if err != nil {
		return fonte{}, fmt.Errorf("TSE_BASE inválida: %q (esperado URL absoluta http(s), ex.: https://resultados.tse.jus.br/oficial/ele2026)", cfg.TSEBase)
	}

	portal, err := normalizarURLFonte(cfg.TSEPortal)
	if err != nil {
		return fonte{}, fmt.Errorf("TSE_PORTAL inválida: %q (esperado URL absoluta http(s), ex.: https://resultados.tse.jus.br/)", cfg.TSEPortal)
	}

	codigo := eleicaoNumericaFonte(eleicao)
	nacional := base + "/" + codigo + "/dados/br/br-c0001-e" + eleicaoSeisDigitosFonte(eleicao) + "-u.json"

	return fonte{
		Eleicao:  eleicao,
		Turno:    turno,
		Rotulo:   rotulo,
		Base:     base,
		Portal:   portal,
		Nacional: nacional,
	}, nil
}

// URLUF devolve o arquivo público de uma UF. A rota nunca chama com sigla
// inválida; devolver vazio aqui evita montar uma URL com lixo caso isso mude.
func (f fonte) URLUF(uf string) string {
	sigla := siglaFonte(uf)
	if sigla == "" {
		return ""
	}
	return f.Base + "/" + eleicaoNumericaFonte(f.Eleicao) + "/dados/" +
		sigla + "/" + sigla + "-c0001-e" + eleicaoSeisDigitosFonte(f.Eleicao) + "-u.json"
}

// URLFotos devolve o diretório das fotos dos candidatos da UF. A barra final
// é intencional: o diretório é usado como base para os nomes dos arquivos.
func (f fonte) URLFotos(uf string) string {
	sigla := siglaFonte(uf)
	if sigla == "" {
		return ""
	}
	return f.Base + "/" + eleicaoNumericaFonte(f.Eleicao) + "/fotos/" + sigla + "/"
}

// verificacaoFonte é o resultado do teste de disponibilidade da fonte oficial.
// Status e Erro são omitidos quando não se aplicam, mantendo o JSON enxuto
// para o painel do plantão.
type verificacaoFonte struct {
	OK           bool   `json:"ok"`
	URL          string `json:"url"`
	Status       int    `json:"status,omitempty"`
	Erro         string `json:"erro,omitempty"`
	VerificadoEm string `json:"verificado_em"`
	DuracaoMs    int64  `json:"duracao_ms"`
}

// verificar consulta o arquivo nacional e diz se a fonte oficial responde com
// JSON. Ele nunca entra em pânico: qualquer falha vira OK=false e uma mensagem
// curta, porque o plantão precisa do diagnóstico, não do corpo da resposta.
func (f fonte) verificar(ctx context.Context, cliente *http.Client) (resultado verificacaoFonte) {
	inicio := time.Now()
	resultado = verificacaoFonte{URL: f.Nacional}
	defer func() {
		resultado.VerificadoEm = time.Now().UTC().Format(time.RFC3339)
		resultado.DuracaoMs = time.Since(inicio).Milliseconds()
	}()

	// Um cliente sem timeout poderia prender a verificação por tempo
	// indeterminado no dia da eleição; quatro segundos bastam para decidir.
	if cliente == nil {
		cliente = &http.Client{Timeout: 4 * time.Second}
	}

	requisicao, err := http.NewRequestWithContext(ctx, http.MethodGet, f.Nacional, nil)
	if err != nil {
		resultado.Erro = fmt.Sprintf("fonte oficial inacessível: %v", err)
		return resultado
	}
	requisicao.Header.Set("Accept", "application/json")
	requisicao.Header.Set("User-Agent", agenteFonte)

	resposta, err := cliente.Do(requisicao)
	if err != nil {
		resultado.Erro = fmt.Sprintf("fonte oficial inacessível: %v", err)
		return resultado
	}
	defer resposta.Body.Close()

	resultado.Status = resposta.StatusCode
	if resposta.StatusCode < http.StatusOK || resposta.StatusCode >= http.StatusMultipleChoices {
		resultado.Erro = fmt.Sprintf("fonte oficial respondeu HTTP %d em %s", resposta.StatusCode, f.Nacional)
		return resultado
	}

	corpo, err := io.ReadAll(io.LimitReader(resposta.Body, limiteCorpoFonte))
	if err != nil {
		resultado.Erro = fmt.Sprintf("fonte oficial inacessível: %v", err)
		return resultado
	}

	var valor any
	if err := json.Unmarshal(corpo, &valor); err != nil {
		resultado.Erro = fmt.Sprintf("resposta da fonte oficial não é JSON válido: %v", err)
		return resultado
	}
	switch valor.(type) {
	case map[string]any, []any:
		// Objeto ou array: é o formato esperado dos arquivos do TSE.
	default:
		resultado.Erro = "resposta da fonte oficial não é JSON válido: conteúdo não é objeto nem array"
		return resultado
	}

	resultado.OK = true
	return resultado
}

// somenteDigitosFonte evita que letras ou sinais passem como código de
// eleição, o que geraria uma URL que o TSE nunca serviria.
func somenteDigitosFonte(valor string) bool {
	if valor == "" {
		return false
	}
	for i := 0; i < len(valor); i++ {
		if valor[i] < '0' || valor[i] > '9' {
			return false
		}
	}
	return true
}

// siglaFonte normaliza a UF para o padrão do TSE: duas letras ASCII
// minúsculas. Qualquer outra coisa vira vazio em vez de URL inválida.
func siglaFonte(uf string) string {
	sigla := strings.ToLower(uf)
	if len(sigla) != 2 {
		return ""
	}
	if sigla[0] < 'a' || sigla[0] > 'z' || sigla[1] < 'a' || sigla[1] > 'z' {
		return ""
	}
	return sigla
}

// eleicaoNumericaFonte remove zeros à esquerda para o caminho da URL, como o
// TSE publica (6258, não 006258). O código todo zerado continua sendo "0".
func eleicaoNumericaFonte(eleicao string) string {
	codigo := strings.TrimLeft(eleicao, "0")
	if codigo == "" {
		return "0"
	}
	return codigo
}

// eleicaoSeisDigitosFonte devolve o código com seis dígitos, que é o formato
// usado no nome dos arquivos do TSE (e006258). Sem isso a URL não existe.
func eleicaoSeisDigitosFonte(eleicao string) string {
	codigo := eleicaoNumericaFonte(eleicao)
	if len(codigo) >= 6 {
		return codigo
	}
	return strings.Repeat("0", 6-len(codigo)) + codigo
}

// normalizarURLFonte aceita apenas URL absoluta http(s), com host e sem query
// ou fragmento, e remove as barras finais para que a composição das rotas não
// produza barras duplicadas.
func normalizarURLFonte(bruto string) (string, error) {
	alvo, err := url.Parse(strings.TrimSpace(bruto))
	if err != nil {
		return "", err
	}
	if !alvo.IsAbs() || alvo.Host == "" {
		return "", fmt.Errorf("URL não absoluta ou sem host")
	}
	esquema := strings.ToLower(alvo.Scheme)
	if esquema != "http" && esquema != "https" {
		return "", fmt.Errorf("esquema %q não é http(s)", alvo.Scheme)
	}
	if alvo.RawQuery != "" || alvo.ForceQuery || alvo.Fragment != "" {
		return "", fmt.Errorf("URL não pode ter query nem fragmento")
	}

	alvo.Scheme = esquema
	return strings.TrimRight(alvo.String(), "/"), nil
}
