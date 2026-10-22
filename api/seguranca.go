package main

// Endurecimento de borda da API: cabeçalhos de segurança, limite de taxa por IP,
// teto de concorrência e validação de parâmetros.
//
// A camada que o público realmente encontra é o nginx do container `web`
// (127.0.0.1:8110) — lá ficam HSTS/CSP/limit_req. Este arquivo é a segunda
// barreira, a que vale quando alguém fala com a API sem passar pelo nginx
// (rede interna do compose, teste local, proxy futuro). Nenhuma das duas
// camadas sozinha é suficiente: nginx protege o HTML, o Go protege o JSON.

import (
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ------------------------------------------------------------------- limites

type limites struct {
	TaxaPorIP      float64 // requisições por segundo, por IP
	RajadaPorIP    float64 // quantas cabem de uma vez (burst)
	MaxSimultaneas int     // requisições em andamento no processo inteiro
	MaxPorIP       int     // requisições simultâneas por IP
}

// limitesDoAmbiente lê os limites do ambiente. Valor ausente, inválido ou <= 0
// cai no padrão: é melhor um limite conhecido do que um limite zero acidental
// (zero bloquearia todo mundo).
func limitesDoAmbiente() limites {
	pradrao := limites{TaxaPorIP: 30, RajadaPorIP: 90, MaxSimultaneas: 128, MaxPorIP: 16}

	l := pradrao
	if v := numeroDoAmbiente("RATE_TAXA_POR_IP"); v > 0 {
		l.TaxaPorIP = v
	}
	if v := numeroDoAmbiente("RATE_RAJADA_POR_IP"); v > 0 {
		l.RajadaPorIP = v
	}
	if v := numeroDoAmbiente("LIMITE_SIMULTANEAS"); v > 0 {
		l.MaxSimultaneas = int(v)
	}
	if v := numeroDoAmbiente("LIMITE_SIMULTANEAS_POR_IP"); v > 0 {
		l.MaxPorIP = int(v)
	}
	if l.RajadaPorIP < 1 {
		l.RajadaPorIP = 1
	}
	return l
}

func numeroDoAmbiente(chave string) float64 {
	bruto := strings.TrimSpace(os.Getenv(chave))
	if bruto == "" {
		return 0
	}
	valor, err := strconv.ParseFloat(bruto, 64)
	if err != nil || valor != valor { // NaN também cai fora
		return 0
	}
	return valor
}

// balde é o estado de um IP: fichas de taxa, requisições em voo e o instante do
// último uso (para a limpeza não deixar o mapa crescer sem teto).
type balde struct {
	tokens float64
	ultimo time.Time
	ativos int
	visto  time.Time
}

type estatisticasLimite struct {
	IPsAtivos     int    `json:"ips_ativos"`
	EmAndamento   int    `json:"em_andamento"`
	Rejeitados429 uint64 `json:"rejeitados_429"`
	Rejeitados503 uint64 `json:"rejeitados_503"`
	TaxaPorIP     float64 `json:"taxa_por_ip"`
	RajadaPorIP   float64 `json:"rajada_por_ip"`
	MaxPorIP      int    `json:"max_por_ip"`
	MaxTotal      int    `json:"max_simultaneas"`
}

type limitador struct {
	cfg limites

	mu            sync.Mutex
	baldes        map[string]*balde
	total         int
	rejeitados429 uint64
	rejeitados503 uint64
}

func novoLimitador(cfg limites) *limitador {
	if cfg.TaxaPorIP <= 0 || cfg.RajadaPorIP <= 0 || cfg.MaxSimultaneas <= 0 || cfg.MaxPorIP <= 0 {
		padrao := limites{TaxaPorIP: 30, RajadaPorIP: 90, MaxSimultaneas: 128, MaxPorIP: 16}
		if cfg.TaxaPorIP > 0 {
			padrao.TaxaPorIP = cfg.TaxaPorIP
		}
		if cfg.RajadaPorIP > 0 {
			padrao.RajadaPorIP = cfg.RajadaPorIP
		}
		if cfg.MaxSimultaneas > 0 {
			padrao.MaxSimultaneas = cfg.MaxSimultaneas
		}
		if cfg.MaxPorIP > 0 {
			padrao.MaxPorIP = cfg.MaxPorIP
		}
		cfg = padrao
	}
	return &limitador{cfg: cfg, baldes: make(map[string]*balde)}
}

// permitir consome uma ficha do IP e reserva uma vaga de concorrência. Quando
// nega, devolve o motivo: "taxa" (rajada estourada), "simultaneas" (o IP já tem
// requisições demais em voo) ou "ocupado" (o processo inteiro está no teto).
func (l *limitador) permitir(ip string) (bool, string) {
	agora := time.Now()

	l.mu.Lock()
	defer l.mu.Unlock()

	if l.total >= l.cfg.MaxSimultaneas {
		l.rejeitados503++
		return false, "ocupado"
	}

	atual := l.baldes[ip]
	if atual == nil {
		atual = &balde{tokens: l.cfg.RajadaPorIP, ultimo: agora}
		l.baldes[ip] = atual
	}

	atual.tokens += agora.Sub(atual.ultimo).Seconds() * l.cfg.TaxaPorIP
	if atual.tokens > l.cfg.RajadaPorIP {
		atual.tokens = l.cfg.RajadaPorIP
	}
	atual.ultimo = agora
	atual.visto = agora

	if atual.tokens < 1 {
		l.rejeitados429++
		return false, "taxa"
	}
	if atual.ativos >= l.cfg.MaxPorIP {
		l.rejeitados429++
		return false, "simultaneas"
	}

	atual.tokens--
	atual.ativos++
	l.total++
	return true, ""
}

func (l *limitador) liberar(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if atual := l.baldes[ip]; atual != nil && atual.ativos > 0 {
		atual.ativos--
	}
	if l.total > 0 {
		l.total--
	}
}

// limpar descarta IPs ociosos. Sem isso o mapa de baldes vira memória crescente
// — um ataque de IPs variados derrubaria o processo por RAM antes de qualquer
// limite de taxa.
func (l *limitador) limpar(ociosidade time.Duration) int {
	agora := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	removidos := 0
	for ip, atual := range l.baldes {
		if atual.ativos == 0 && agora.Sub(atual.visto) > ociosidade {
			delete(l.baldes, ip)
			removidos++
		}
	}
	return removidos
}

func (l *limitador) limpezaAutomatica(intervalo, ociosidade time.Duration) {
	go func() {
		tique := time.NewTicker(intervalo)
		defer tique.Stop()
		for range tique.C {
			if removidos := l.limpar(ociosidade); removidos > 0 {
				log.Printf("limitador: %d IP(s) ociosos descartados", removidos)
			}
		}
	}()
}

func (l *limitador) estatisticas() estatisticasLimite {
	l.mu.Lock()
	defer l.mu.Unlock()

	ativos := 0
	for _, atual := range l.baldes {
		if atual.ativos > 0 || time.Since(atual.visto) < 5*time.Minute {
			ativos++
		}
	}
	return estatisticasLimite{
		IPsAtivos:     ativos,
		EmAndamento:   l.total,
		Rejeitados429: l.rejeitados429,
		Rejeitados503: l.rejeitados503,
		TaxaPorIP:     l.cfg.TaxaPorIP,
		RajadaPorIP:   l.cfg.RajadaPorIP,
		MaxPorIP:      l.cfg.MaxPorIP,
		MaxTotal:      l.cfg.MaxSimultaneas,
	}
}

// withLimite aplica o limitador. 429 para excesso do próprio cliente (ele pode
// tentar de novo depois), 503 para saturação global (a culpa não é dele).
func withLimite(l *limitador, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := ipDoCliente(r)

		liberado, motivo := l.permitir(ip)
		if !liberado {
			if motivo == "ocupado" {
				w.Header().Set("Retry-After", "2")
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{
					"erro": "servidor ocupado, tente de novo em instantes",
				})
				return
			}
			w.Header().Set("Retry-After", "1")
			writeJSON(w, http.StatusTooManyRequests, map[string]string{
				"erro": "muitas requisições",
			})
			return
		}
		defer l.liberar(ip)

		next.ServeHTTP(w, r)
	})
}

// ------------------------------------------------------------------ IP real

// ipDoCliente devolve o IP do visitante, na mesma ordem que o painel Python usa.
//
// O app escuta em 127.0.0.1 (publicado pelo compose), então o único que fala
// com ele é um proxy local — daí confiar nos cabeçalhos. O nginx sobrescreve
// X-Real-IP com o valor que ele mesmo resolveu, de modo que um cliente não
// consegue forjar o próprio IP pela borda.
func ipDoCliente(r *http.Request) string {
	for _, cabecalho := range []string{"CF-Connecting-IP", "X-Real-IP"} {
		if ip, ok := ipValido(r.Header.Get(cabecalho)); ok {
			return ip
		}
	}
	if encadeado := r.Header.Get("X-Forwarded-For"); encadeado != "" {
		primeiro := strings.Split(encadeado, ",")[0]
		if ip, ok := ipValido(primeiro); ok {
			return ip
		}
	}
	if ip, ok := ipValido(r.RemoteAddr); ok {
		return ip
	}
	return "desconhecido"
}

// ipValido normaliza e valida um endereço vindo de cabeçalho ou socket.
func ipValido(texto string) (string, bool) {
	texto = strings.TrimSpace(texto)
	texto = strings.Trim(texto, `"`)
	if texto == "" || len(texto) > 64 {
		return "", false
	}
	texto = strings.TrimPrefix(texto, "::ffff:")
	if corte := strings.IndexByte(texto, '%'); corte >= 0 { // zona IPv6 (fe80::1%eth0)
		texto = texto[:corte]
	}
	if host, _, err := net.SplitHostPort(texto); err == nil {
		texto = host
	}
	endereco := net.ParseIP(texto)
	if endereco == nil {
		return "", false
	}
	return endereco.String(), true
}

// ipPrivado diz se o endereço não tem região pública (loopback, LAN, link-local).
// Para esses não se chuta geolocalização: ficam como "rede local".
func ipPrivado(ip string) bool {
	endereco := net.ParseIP(ip)
	if endereco == nil {
		return true
	}
	return endereco.IsLoopback() || endereco.IsPrivate() || endereco.IsLinkLocalUnicast() ||
		endereco.IsLinkLocalMulticast() || endereco.IsMulticast() || endereco.IsUnspecified()
}

// ------------------------------------------------------------- cabeçalhos

// withCabecalhosSeguranca põe os cabeçalhos em toda resposta desta API. O nginx
// repete os mesmos nomes para o HTML e esconde os daqui em /api/ para não
// duplicar (proxy_hide_header) — a política vale nas duas camadas.
func withCabecalhosSeguranca(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cabecalhos := w.Header()
		cabecalhos.Set("X-Content-Type-Options", "nosniff")
		cabecalhos.Set("X-Frame-Options", "DENY")
		cabecalhos.Set("Referrer-Policy", "no-referrer")
		cabecalhos.Set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()")
		cabecalhos.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			cabecalhos.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// --------------------------------------------------------------- validação

const (
	limiteURI        = 1024 // URI inteira (caminho + consulta)
	maximoParametros = 8
	maximoNomeParam  = 32
	maximoValorParam = 128
)

// withValidacao recusa cedo o que não é requisição de leitura plausível:
// método, tamanho, quantidade e conteúdo dos parâmetros, caminho com travessia.
func withValidacao(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.RequestURI()) > limiteURI {
			escreverErro(w, http.StatusRequestURITooLong, "requisição longa demais")
			return
		}

		caminho := r.URL.Path
		if strings.Contains(caminho, "..") || strings.ContainsRune(caminho, '\\') ||
			strings.ContainsRune(caminho, 0) {
			writeJSON(w, http.StatusNotFound, map[string]string{"erro": "não encontrado"})
			return
		}

		switch r.Method {
		case http.MethodGet, http.MethodHead:
		default:
			w.Header().Set("Allow", "GET, HEAD")
			escreverErro(w, http.StatusMethodNotAllowed, "método não permitido")
			return
		}

		// Nenhuma rota aceita corpo: GET com corpo é sinal de varredura.
		if r.ContentLength > 0 || len(r.TransferEncoding) > 0 {
			escreverErro(w, http.StatusRequestEntityTooLarge, "corpo não aceito")
			return
		}

		if motivo := consultaInvalida(r.URL.RawQuery); motivo != "" {
			escreverErro(w, http.StatusBadRequest, motivo)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// consultaInvalida devolve "" quando a query string é aceitável. Devolve o
// motivo (texto genérico, sem ecoar o valor recebido) quando não é.
func consultaInvalida(bruta string) string {
	if bruta == "" {
		return ""
	}
	valores, err := url.ParseQuery(bruta)
	if err != nil {
		return "consulta inválida"
	}
	if len(valores) > maximoParametros {
		return "parâmetros demais"
	}
	for nome, lista := range valores {
		if len(nome) > maximoNomeParam || !caracteresSeguros(nome) {
			return "nome de parâmetro inválido"
		}
		if len(lista) > 1 {
			return "parâmetro repetido"
		}
		for _, valor := range lista {
			if len(valor) > maximoValorParam {
				return "valor de parâmetro longo demais"
			}
			if !caracteresSeguros(valor) {
				return "valor de parâmetro inválido"
			}
		}
	}
	return ""
}

// caracteresSeguros aceita só o alfabeto que nossas rotas usam (sigla, dígitos,
// ano). Aspas, sinais de markup, barra invertida e controle ficam de fora — é o
// que impede injeção de SQL/JS/CRLF de chegar perto do handler.
func caracteresSeguros(texto string) bool {
	for _, c := range texto {
		if c < 0x20 || c > 0x7e {
			return false
		}
		switch c {
		case '<', '>', '"', '\'', '`', '\\', ';', '|', '&', '%', '#', '?', '{', '}', '(', ')':
			return false
		}
	}
	return true
}

// parametrosPermitidos diz quais nomes de parâmetro cada rota aceita. Qualquer
// outro nome vira 400 — rota nossa não precisa aceitar o que não usa.
func parametrosPermitidos(caminho string) []string {
	switch {
	case caminho == "/api/replay":
		return []string{"modo"}
	case strings.HasPrefix(caminho, "/api/interno/"):
		// O painel privado aceita a credencial na URL (navegador não manda
		// cabeçalho ao abrir a página). O log do nginx está desligado e o Go
		// omite o token na linha de log.
		return []string{"token"}
	case strings.HasPrefix(caminho, "/api/uf/") && strings.HasSuffix(caminho, "/locais"):
		return []string{"cd"}
	default:
		return nil
	}
}

// conferirParametrosDeRota recusa parâmetro fora da lista da rota.
func conferirParametrosDeRota(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.RawQuery == "" {
		return true
	}
	permitidos := parametrosPermitidos(r.URL.Path)
	for nome := range r.URL.Query() {
		liberado := false
		for _, candidato := range permitidos {
			if nome == candidato {
				liberado = true
				break
			}
		}
		if !liberado {
			escreverErro(w, http.StatusBadRequest, "parâmetro não permitido")
			return false
		}
	}
	return true
}

// escreverErro responde JSON genérico: nunca devolve stack, caminho de arquivo
// nem a entrada recebida.
func escreverErro(w http.ResponseWriter, status int, mensagem string) {
	writeJSON(w, status, map[string]string{"erro": mensagem})
}
