package main

// Observabilidade privada: contadores de acesso, latência, erros, recusas do
// limitador, saúde dos serviços e o bloco anônimo de visitas.
//
// A rota é privada porque mostra operação, não resultado eleitoral:
//
//	GET /api/interno/metricas   JSON
//	GET /api/interno/painel     HTML (recarrega a cada 20 s)
//
// Credencial: env METRICAS_TOKEN (token longo). Sem credencial → 401; com
// credencial errada → 403; token não configurado → 403 sempre (falha fechada).
// O nginx não registra acesso a /api/interno (o token não vai para o log).
// Cloudflare Access no subdomínio admin é a camada seguinte, fora deste arquivo.

import (
	"crypto/subtle"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	janelaLatencia   = 2048 // amostras guardadas para percentis
	minutosHistorico = 90
	maxRotas         = 120
)

type rotaObs struct {
	requisicoes uint64
	erros       uint64
	somaMS      float64
	maxMS       float64
}

type minutoObs struct {
	requisicoes uint64
	erros       uint64
}

type observador struct {
	inicio time.Time

	mu           sync.Mutex
	total        uint64
	classe2      uint64
	classe3      uint64
	classe4      uint64
	classe5      uint64
	erros        uint64
	latencias    []float64
	posLatencias int
	rotas        map[string]*rotaObs
	minutos      map[string]*minutoObs

	saudeCache  []saudeServico
	saudeQuando time.Time
	saudeMu     sync.Mutex
}

type saudeServico struct {
	Servico    string  `json:"servico"`
	Alvo       string  `json:"alvo"`
	OK         bool    `json:"ok"`
	LatenciaMS float64 `json:"latencia_ms"`
	Detalhe    string  `json:"detalhe,omitempty"`
}

func novoObservador() *observador {
	return &observador{
		inicio:    time.Now(),
		latencias: make([]float64, 0, janelaLatencia),
		rotas:     make(map[string]*rotaObs),
		minutos:   make(map[string]*minutoObs),
	}
}

// withColeta mede uma requisição e classifica o status. Fica por fora do
// limitador de propósito: assim as recusas (429/503) também entram na conta e
// o painel mostra o ataque, não só o tráfego que passou.
func (o *observador) withColeta(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inicio := time.Now()
		registrador := &registradorStatus{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(registrador, r)

		decorrido := time.Since(inicio)
		o.registrar(r.URL.Path, registrador.status, decorrido)
	})
}

func (o *observador) registrar(caminho string, status int, decorrido time.Duration) {
	ms := float64(decorrido.Microseconds()) / 1000.0

	o.mu.Lock()
	defer o.mu.Unlock()

	o.total++
	switch {
	case status >= 500:
		o.classe5++
		o.erros++
	case status >= 400:
		o.classe4++
	case status >= 300:
		o.classe3++
	default:
		o.classe2++
	}

	if len(o.latencias) < janelaLatencia {
		o.latencias = append(o.latencias, ms)
	} else {
		o.latencias[o.posLatencias] = ms
		o.posLatencias = (o.posLatencias + 1) % janelaLatencia
	}

	chave := normalizarRota(caminho)
	if rota := o.rotas[chave]; rota != nil {
		rota.requisicoes++
		rota.somaMS += ms
		if ms > rota.maxMS {
			rota.maxMS = ms
		}
		if status >= 500 {
			rota.erros++
		}
	} else if len(o.rotas) < maxRotas {
		nova := &rotaObs{requisicoes: 1, somaMS: ms, maxMS: ms}
		if status >= 500 {
			nova.erros = 1
		}
		o.rotas[chave] = nova
	}

	minuto := time.Now().Format("2006-01-02T15:04")
	balde := o.minutos[minuto]
	if balde == nil {
		balde = &minutoObs{}
		o.minutos[minuto] = balde
		o.podarMinutos()
	}
	balde.requisicoes++
	if status >= 500 {
		balde.erros++
	}
}

// podarMinutos mantém o histórico curto: o painel é de plantão, não de arquivo.
func (o *observador) podarMinutos() {
	if len(o.minutos) <= minutosHistorico {
		return
	}
	corte := time.Now().Add(-minutosHistorico * time.Minute).Format("2006-01-02T15:04")
	for chave := range o.minutos {
		if chave < corte {
			delete(o.minutos, chave)
		}
	}
}

// normalizarRota agrupa por rota, não por UF: /api/uf/SP/zonas e /api/uf/CE/zonas
// são a mesma linha do painel.
func normalizarRota(caminho string) string {
	if caminho == "" {
		return "/"
	}
	if strings.HasPrefix(caminho, "/api/uf/") {
		partes := strings.Split(caminho, "/")
		if len(partes) >= 5 {
			return "/api/uf/{uf}/" + strings.Join(partes[4:], "/")
		}
		return "/api/uf/{uf}"
	}
	return caminho
}

type latenciaResumo struct {
	P50      float64 `json:"p50"`
	P95      float64 `json:"p95"`
	P99      float64 `json:"p99"`
	Max      float64 `json:"max"`
	Media    float64 `json:"media"`
	Amostras int     `json:"amostras"`
}

func (o *observador) percentis() latenciaResumo {
	if len(o.latencias) == 0 {
		return latenciaResumo{}
	}
	ordenadas := make([]float64, len(o.latencias))
	copy(ordenadas, o.latencias)
	sort.Float64s(ordenadas)

	soma := 0.0
	for _, valor := range ordenadas {
		soma += valor
	}
	pegar := func(fracao float64) float64 {
		indice := int(fracao * float64(len(ordenadas)-1))
		if indice < 0 {
			indice = 0
		}
		if indice >= len(ordenadas) {
			indice = len(ordenadas) - 1
		}
		return arredondarMS(ordenadas[indice])
	}

	return latenciaResumo{
		P50:      pegar(0.50),
		P95:      pegar(0.95),
		P99:      pegar(0.99),
		Max:      arredondarMS(ordenadas[len(ordenadas)-1]),
		Media:    arredondarMS(soma / float64(len(ordenadas))),
		Amostras: len(ordenadas),
	}
}

func arredondarMS(valor float64) float64 {
	return float64(int64(valor*100+0.5)) / 100
}

// resumo devolve o retrato que o painel consome.
func (o *observador) resumo() map[string]any {
	o.mu.Lock()
	total := o.total
	classe2, classe3, classe4, classe5 := o.classe2, o.classe3, o.classe4, o.classe5
	erros := o.erros

	rotas := make([]map[string]any, 0, len(o.rotas))
	for chave, rota := range o.rotas {
		media := 0.0
		if rota.requisicoes > 0 {
			media = rota.somaMS / float64(rota.requisicoes)
		}
		rotas = append(rotas, map[string]any{
			"rota":        chave,
			"requisicoes": rota.requisicoes,
			"erros":       rota.erros,
			"media_ms":    arredondarMS(media),
			"max_ms":      arredondarMS(rota.maxMS),
		})
	}

	minutos := make([]map[string]any, 0, len(o.minutos))
	for chave, balde := range o.minutos {
		minutos = append(minutos, map[string]any{
			"minuto":      chave,
			"requisicoes": balde.requisicoes,
			"erros":       balde.erros,
		})
	}
	latencia := o.percentis()
	o.mu.Unlock()

	sort.Slice(rotas, func(i, j int) bool {
		return rotas[i]["requisicoes"].(uint64) > rotas[j]["requisicoes"].(uint64)
	})
	if len(rotas) > 12 {
		rotas = rotas[:12]
	}
	sort.Slice(minutos, func(i, j int) bool {
		return minutos[i]["minuto"].(string) < minutos[j]["minuto"].(string)
	})
	if len(minutos) > 30 {
		minutos = minutos[len(minutos)-30:]
	}

	taxaErro := 0.0
	if total > 0 {
		taxaErro = arredondarMS(float64(erros) / float64(total) * 100)
	}

	return map[string]any{
		"gerado_em": time.Now().Format(time.RFC3339),
		"uptime_s":  int64(time.Since(o.inicio).Seconds()),
		"http": map[string]any{
			"requisicoes_total": total,
			"por_classe": map[string]uint64{
				"2xx": classe2, "3xx": classe3, "4xx": classe4, "5xx": classe5,
			},
			"erros_5xx":     erros,
			"taxa_erro_pct": taxaErro,
			"latencia_ms":   latencia,
			"rotas":         rotas,
			"por_minuto":    minutos,
		},
	}
}

// --------------------------------------------------------------- credencial

func tokenConfigurado() string {
	return strings.TrimSpace(envOu("METRICAS_TOKEN", ""))
}

// acessoLocalPainel diz se a requisição veio pelo server block local do nginx.
// O bloco `listen 8081` desse nginx é publicado no host apenas em
// 127.0.0.1:8112 (fora do túnel) e injeta `X-Painel-Local: 1` com
// proxy_set_header, sobrescrevendo qualquer valor enviado pelo cliente; o
// server block público (`listen 80`) apaga esse cabeçalho antes de proxiar e
// responde 404 em /api/interno/. Dentro do container o RemoteAddr de uma
// conexão vinda do loopback do host aparece como o IP do gateway Docker
// (medido: 172.17.0.1), então o teste é "marca do proxy + par privado" e não
// "RemoteAddr == 127.0.0.1". Nenhum outro cabeçalho (X-Real-IP,
// X-Forwarded-For, CF-Connecting-IP), Host, query string ou origem CORS
// participa da decisão: cabeçalho forjado por cliente não libera nada.
func acessoLocalPainel(r *http.Request) bool {
	if r.Header.Get("X-Painel-Local") != "1" {
		return false
	}
	ip, ok := ipValido(r.RemoteAddr)
	if !ok {
		return false
	}
	return ipPrivado(ip)
}

func tokenDaRequisicao(r *http.Request) string {
	if valor := strings.TrimSpace(r.Header.Get("X-Metricas-Token")); valor != "" {
		return valor
	}
	if valor := r.Header.Get("Authorization"); strings.HasPrefix(valor, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(valor, "Bearer "))
	}
	return strings.TrimSpace(r.URL.Query().Get("token"))
}

// withTokenMetricas é a única porta das rotas internas. Falha fechada: sem
// METRICAS_TOKEN no ambiente, ninguém entra (403) — nunca "aberto por padrão".
// A exceção é o acesso pelo painel local do nginx, marcado pelo próprio proxy
// e restrito a par privado (ver acessoLocalPainel).
func withTokenMetricas(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if acessoLocalPainel(r) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Robots-Tag", "noindex, nofollow")
			next.ServeHTTP(w, r)
			return
		}

		esperado := tokenConfigurado()
		if esperado == "" {
			log.Printf("painel de métricas chamado sem METRICAS_TOKEN configurado — recusado")
			escreverErro(w, http.StatusForbidden, "painel de métricas desativado")
			return
		}

		recebido := tokenDaRequisicao(r)
		if recebido == "" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="metricas"`)
			escreverErro(w, http.StatusUnauthorized, "credencial ausente")
			return
		}
		if subtle.ConstantTimeCompare([]byte(recebido), []byte(esperado)) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="metricas"`)
			escreverErro(w, http.StatusForbidden, "credencial inválida")
			return
		}

		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		next.ServeHTTP(w, r)
	})
}

// ------------------------------------------------------------------ saúde

// saude devolve o estado dos serviços da stack. As sondas são HTTP de verdade
// (o container `api` alcança o `web` pelo nome do serviço no compose) e ficam em
// cache curto para não virar tempestade de probes a cada refresh do painel.
func (a *app) saude() []saudeServico {
	a.obs.saudeMu.Lock()
	defer a.obs.saudeMu.Unlock()

	if time.Since(a.obs.saudeQuando) < 10*time.Second && a.obs.saudeCache != nil {
		return a.obs.saudeCache
	}

	servicos := make([]saudeServico, 0, 4)

	servicos = append(servicos, saudeServico{
		Servico: "api",
		Alvo:    "self",
		OK:      true,
		Detalhe: "uptime " + time.Since(a.obs.inicio).Truncate(time.Second).String(),
	})

	// web: o nginx que serve o mapa. Só responde se o container estiver de pé.
	enderecoWeb := envOu("WEB_HEALTH_URL", "http://web/healthz")
	inicio := time.Now()
	cliente := &http.Client{Timeout: 900 * time.Millisecond}
	okWeb := false
	detalheWeb := ""
	if resposta, err := cliente.Get(enderecoWeb); err != nil {
		detalheWeb = "sem resposta: " + tipoDoErro(err)
	} else {
		resposta.Body.Close()
		okWeb = resposta.StatusCode == http.StatusOK
		detalheWeb = "status " + strconv.Itoa(resposta.StatusCode)
	}
	servicos = append(servicos, saudeServico{
		Servico:    "web",
		Alvo:       enderecoWeb,
		OK:         okWeb,
		LatenciaMS: arredondarMS(float64(time.Since(inicio).Microseconds()) / 1000),
		Detalhe:    detalheWeb,
	})

	// dados: se o publico.json parar de ser regerado no dia da eleição, o mapa
	// congela sem erro nenhum. Aqui a idade do arquivo é o sinal: 6 h é o ponto
	// de atenção, 24 h é falha (fora do dia da eleição a coleta é diária).
	detalheDados := "gerado_em " + a.dados.Publico.GeradoEm
	okDados := false
	momentoDados, errData := time.Parse(time.RFC3339, a.dados.Publico.GeradoEm)
	if errData != nil {
		momentoDados, errData = time.Parse("2006-01-02T15:04:05", a.dados.Publico.GeradoEm)
	}
	if errData == nil {
		idade := time.Since(momentoDados)
		okDados = idade < 24*time.Hour
		detalheDados += " (" + idade.Truncate(time.Minute).String() + " atrás)"
		if idade > 6*time.Hour {
			detalheDados += " — atenção: passou de 6h"
		}
	} else {
		detalheDados = "gerado_em ilegível: " + a.dados.Publico.GeradoEm
	}
	servicos = append(servicos, saudeServico{
		Servico: "dados",
		Alvo:    "dados/publico.json",
		OK:      okDados,
		Detalhe: detalheDados,
	})

	if a.anon != nil && a.anon.disponivel() {
		linhas, tamanho, ultima := a.anon.estadoBanco()
		servicos = append(servicos, saudeServico{
			Servico: "metricas",
			Alvo:    a.anon.caminhoBanco(),
			OK:      true,
			Detalhe: strconv.FormatInt(linhas, 10) + " visitas · " + tamanho + " · última " + ultima,
		})
	} else {
		servicos = append(servicos, saudeServico{
			Servico: "metricas",
			Alvo:    "visitas.db",
			OK:      false,
			Detalhe: "banco de métricas indisponível",
		})
	}

	a.obs.saudeCache = servicos
	a.obs.saudeQuando = time.Now()
	return servicos
}

// tipoDoErro resume o erro de rede sem despejar URL com credencial no painel.
func tipoDoErro(err error) string {
	texto := err.Error()
	if corte := strings.Index(texto, ": "); corte > 0 {
		return texto[:corte]
	}
	return texto
}

// ---------------------------------------------------------------- handlers

func (a *app) handleMetricasJSON(w http.ResponseWriter, r *http.Request) {
	corpo := a.obs.resumo()
	corpo["app"] = map[string]any{
		"eleicao":         a.cfg.Eleicao,
		"turno":           a.cfg.Turno,
		"dados_gerado_em": a.dados.Publico.GeradoEm,
		"ufs":             len(a.dados.Publico.UFs),
		"features":        len(a.dados.Malha.Features),
	}
	corpo["limites"] = a.limit.estatisticas()
	corpo["saude"] = a.saude()

	// Série temporal (hora/dia, humano × bot) e estado do vigia de ataques:
	// o painel mostra as duas coisas; o JSON também.
	if a.anon != nil && a.anon.disponivel() {
		if acessos, err := a.anon.acessos(); err != nil {
			corpo["acessos"] = map[string]any{"disponivel": false, "motivo": "erro ao ler a série"}
			log.Printf("série de acessos indisponível: %v", err)
		} else if acessos != nil {
			corpo["acessos"] = acessos
		}
	}
	corpo["defesa"] = lerEstadoDefesa()

	if a.anon != nil && a.anon.disponivel() {
		if resumo, err := a.anon.resumo(14); err != nil {
			corpo["anonimo"] = map[string]any{"disponivel": false, "motivo": "erro ao ler o banco"}
			log.Printf("métricas anônimas indisponíveis: %v", err)
		} else {
			corpo["anonimo"] = resumo
		}
	} else {
		corpo["anonimo"] = map[string]any{
			"disponivel": false,
			"motivo":     "banco de visitas não montado (METRICAS_DIR)",
		}
	}

	writeJSON(w, http.StatusOK, corpo)
}

func (a *app) handleMetricasPainel(w http.ResponseWriter, r *http.Request) {
	corpo := a.obs.resumo()
	saude := a.saude()
	limites := a.limit.estatisticas()
	latencia := corpo["http"].(map[string]any)["latencia_ms"].(latenciaResumo)
	classes := corpo["http"].(map[string]any)["por_classe"].(map[string]uint64)
	rotas := corpo["http"].(map[string]any)["rotas"].([]map[string]any)

	var anonimo map[string]any
	var acessos *acessosResumo
	if a.anon != nil && a.anon.disponivel() {
		anonimo, _ = a.anon.resumo(14)
		acessos, _ = a.anon.acessos()
	}

	// Recarrega a MESMA URL (com o token que já está nela) em vez de montar uma
	// URL nova: assim o token não aparece em atributo nenhum do HTML.
	html := montarPainelMetricas(montagemPainel{
		GeradoEm: corpo["gerado_em"].(string),
		Uptime:   corpo["uptime_s"].(int64),
		Total:    corpo["http"].(map[string]any)["requisicoes_total"].(uint64),
		Classes:  classes,
		TaxaErro: corpo["http"].(map[string]any)["taxa_erro_pct"].(float64),
		Latencia: latencia,
		Rotas:    rotas,
		Saude:    saude,
		Limites:  limites,
		Anonimo:  anonimo,
		Acessos:  acessos,
		Defesa:   lerEstadoDefesa(),
		Recarga:  true,
	})

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write([]byte(html)); err != nil {
		log.Printf("erro ao escrever o painel de métricas: %v", err)
	}
}
