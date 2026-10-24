package main

// Escore de SUSPEITA por IP — 0 a 100 — com sinais explícitos.
//
// A regra que manda neste arquivo: VOLUME NUNCA É SINAL. Amanhã (25/10) tem
// visitante legítimo conectado por horas, atualizando o painel e recebendo
// eventos; ele faz centenas de requisições do mesmo IP. Se quantidade de
// requisição pesasse, a defesa acusaria o visitante. Então cada sinal vale UMA
// vez por IP e nenhum deles conta requisições.
//
// Espelho de scripts/defesa/suspeita.py (o vigia usa a versão Python). Os dois
// são conferidos contra o MESMO fixture, scripts/defesa/suspeita_fixture.json,
// por suspeita_test.go (Go) e por `suspeita.py --conferir` (Python): se um dos
// lados mudar de comportamento sozinho, o teste acusa.
//
// Sinais e pesos (aplicados uma vez, mesmo que ocorram N vezes):
//
//	caminho_sensivel  35  /admin, /.env, /.git, /wp-login.php, /phpmyadmin…
//	injecao           40  SQLi, path traversal, XSS no alvo (caminho + query)
//	metodo_anomalo    15  PROPFIND, PUT, TRACE, DELETE…
//	sondagem_interna  35  /api/interno/* (rota de administração do site)
//	ua_anomalo        15  sem UA, UA de scanner, ou UA falsificado (iOS antigo)
//	regularidade      15  intervalo quase fixo por >30 min, SEM UA de navegador
//	reincidencia      15  3+ respostas 403/404 e voltou depois da primeira
//
// O que NÃO conta: /api/home, /api/estados, /mapa, /assets/*, /api/visita,
// estáticos e o polling de quem tem UA de navegador real.

import (
	"math"
	"net"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Níveis do escore.
const (
	NivelLimpo     = "limpo"
	NivelObservar  = "observar"
	NivelSuspeito  = "suspeito"
	NivelMalicioso = "malicioso"
)

// Limiares do escore (o vigia avisa no Telegram a partir de suspeito).
const (
	escoreSuspeito  = 60
	escoreMalicioso = 80
	escoreObservar  = 20
)

// PesosSuspeita é aplicado uma única vez por IP.
var PesosSuspeita = map[string]int{
	"caminho_sensivel": 35,
	"injecao":          40,
	"metodo_anomalo":   15,
	"sondagem_interna": 35,
	"ua_anomalo":       15,
	"regularidade":     15,
	"reincidencia":     15,
}

// OrdemSinais é a ordem canônica de apresentação.
var OrdemSinais = []string{
	"caminho_sensivel",
	"injecao",
	"metodo_anomalo",
	"sondagem_interna",
	"ua_anomalo",
	"regularidade",
	"reincidencia",
}

// RotuloSinal é o nome que aparece no painel (o resto do mundo lê português).
var RotuloSinal = map[string]string{
	"caminho_sensivel": "caminho sensível",
	"injecao":          "payload de injeção",
	"metodo_anomalo":   "método anômalo",
	"sondagem_interna": "sondou rota interna",
	"ua_anomalo":       "UA de bot/falsificado",
	"regularidade":     "regularidade de máquina",
	"reincidencia":     "voltou após 403/404",
}

type suspeito struct {
	IP       string   `json:"ip"`
	Host     string   `json:"host"`
	Escore   int      `json:"escore"`
	Nivel    string   `json:"nivel"`
	Sinais   []string `json:"sinais"`
	Rotulos  []string `json:"rotulos"`
	Primeiro string   `json:"primeiro"`
	Ultimo   string   `json:"ultimo"`
	Eventos  int      `json:"eventos"`
	Hosts    []string `json:"hosts"`
}

var (
	reSensivelSuspeita = regexp.MustCompile(`(?i)(^|/)(\.env|\.git|\.aws|\.ssh|\.htaccess|\.htpasswd|` +
		`nginx\.conf|web\.config|id_rsa|wp-config\.php)|/admin|/administrator|/phpmyadmin|` +
		`/wp-login|/wp-admin|/mysql|/actuator|/console|/server-status|/server-info|` +
		`/etc/passwd|/etc/shadow|/\.svn|/\.ds_store`)

	reInjecao = regexp.MustCompile(`(?i)(\.\./|%2e%2e)|/etc/passwd|/etc/shadow|/proc/self|` +
		`('|%27|%22|")\s*(or|and)\s|union[\s+]+select|information_schema|sleep\s*\(|` +
		`benchmark\s*\(|pg_sleep|waitfor[\s+]+delay|1\s*=\s*1|1'\s*=\s*'1|xp_cmdshell|` +
		`<script|%3cscript|onerror\s*=|javascript:`)

	reScannerUA = regexp.MustCompile(`(?i)sqlmap|nikto|nmap|masscan|zgrab|nuclei|dirbuster|` +
		`gobuster|wpscan|acunetix|nessus|feroxbuster|ffuf|openvas|w3af|joomscan|whatweb|` +
		`censys|python-requests|python-urllib|aiohttp|curl/|wget/|go-http-client|okhttp|` +
		`headlesschrome|phantomjs|libwww-perl|zgrab`)

	rePercent = regexp.MustCompile(`(?i)%(20|27|22|3D|2F|3C|3E)`)
	reHTTPFim = regexp.MustCompile(`(?i)\s+HTTP/\d+(?:\.\d+)?\s*$`)
	reMetodo  = regexp.MustCompile(`^[A-Za-z]+\s+`)
)

var metodosNormais = map[string]bool{
	"GET": true, "HEAD": true, "POST": true, "OPTIONS": true,
}

// maxInstantes casa com MAX_INSTANTES do lado Python: o bastante para medir
// regularidade e reincidência sem guardar tráfego inteiro.
const maxInstantes = 400

func normalizarAlvoSuspeita(s string) string {
	s = rePercent.ReplaceAllStringFunc(s, func(m string) string {
		switch strings.ToUpper(m) {
		case "%20":
			return " "
		case "%27":
			return "'"
		case "%22":
			return `"`
		case "%3D":
			return "="
		case "%2F":
			return "/"
		case "%3C":
			return "<"
		case "%3E":
			return ">"
		}
		return m
	})
	return strings.ReplaceAll(s, "+", " ")
}

func limparAlvo(bruto string) string {
	alvo := strings.TrimSpace(bruto)
	alvo = reHTTPFim.ReplaceAllString(alvo, "")
	alvo = reMetodo.ReplaceAllString(alvo, "")
	return strings.TrimSpace(alvo)
}

// ipBorda diz se o IP é da BORDA (Cloudflare) e não de um visitante.
//
// São as faixas OFICIAIS https://www.cloudflare.com/ips-v4 e /ips-v6 — as
// mesmas do `set_real_ip_from` do web/nginx.conf. É por onde TODO visitante
// entra: um IP de borda no log quer dizer que o real_ip não entregou o IP do
// cliente (defeito a corrigir no nginx), nunca que a Cloudflare está atacando.
// Por isso borda não entra no escore, não é acusada e não pode ser bloqueada:
// bloquear a borda derruba o site inteiro. Fica retratada à parte, com rótulo.
func ipBorda(texto string) bool {
	bruto := strings.Trim(strings.TrimSpace(texto), "[]")
	endereco := net.ParseIP(bruto)
	if endereco == nil {
		return false
	}
	for _, rede := range faixasBorda {
		if rede.Contains(endereco) {
			return true
		}
	}
	return false
}

// faixasBorda é a lista oficial, copiada de propósito (não há include remoto).
var faixasBorda = redesDe([]string{
	// IPv4 (15)
	"173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
	"141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
	"197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
	"104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
	// IPv6 (7)
	"2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
	"2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
})

func redesDe(cidrs []string) []*net.IPNet {
	redes := make([]*net.IPNet, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, rede, err := net.ParseCIDR(cidr)
		if err != nil {
			panic("faixa de borda inválida: " + cidr)
		}
		redes = append(redes, rede)
	}
	return redes
}

// ipInfraLocal diz se o IP é da NOSSA infraestrutura: loopback, RFC1918
// (10/8, 172.16/12 — onde moram os gateways do docker, 172.17.0.1 …
// 172.31.255.254 — e 192.168/16), link-local, multicast, reservado e
// não especificado. Também cai aqui o rótulo "não resolvido" (400 antes do
// real_ip: o IP do socket é sempre o gateway do docker).
//
// Essa é a MESMA regra que já protege o bloqueio (`ip_publico` no vigia):
// o que não pode ser bloqueado não pode ser acusado. Sem ela, as nossas
// próprias provas de ataque (que saem do host e chegam ao nginx pelo gateway
// 172.19.0.1) viravam "malicioso 100" no painel — infra nossa, não visitante.
func ipInfraLocal(texto string) bool {
	bruto := strings.TrimSpace(texto)
	if bruto == "" || bruto == ipNaoResolvido {
		return true
	}
	endereco := net.ParseIP(strings.Trim(bruto, "[]"))
	if endereco == nil {
		return false // não é IP: segue o fluxo normal, não é infra declarada
	}
	return endereco.IsLoopback() || endereco.IsPrivate() ||
		endereco.IsLinkLocalUnicast() || endereco.IsLinkLocalMulticast() ||
		endereco.IsMulticast() || endereco.IsUnspecified()
}

// resolverPontos serve só para decidir se o caminho é benigno; as regexes
// continuam vendo o alvo original, inclusive com o "../".
func resolverPontos(caminho string) string {
	partes := strings.Split(caminho, "/")
	saida := make([]string, 0, len(partes))
	for _, parte := range partes {
		baixo := strings.ToLower(strings.ReplaceAll(parte, "%2e", "."))
		switch {
		case baixo == "..":
			if len(saida) > 0 && saida[len(saida)-1] != "" {
				saida = saida[:len(saida)-1]
			}
		case baixo == ".":
			continue
		default:
			saida = append(saida, parte)
		}
	}
	resolvido := strings.Join(saida, "/")
	if !strings.HasPrefix(resolvido, "/") {
		resolvido = "/" + resolvido
	}
	return resolvido
}

// caminhoIgnorado diz se a requisição é tráfego normal do site. Requisição
// nesses caminhos não gera sinal de caminho sensível — é o que impede o
// polling do visitante de amanhã de virar suspeita.
func caminhoIgnorado(uri string) bool {
	caminho := normalizarAlvoSuspeita(uri)
	if i := strings.IndexByte(caminho, '?'); i >= 0 {
		caminho = caminho[:i]
	}
	baixo := strings.ToLower(resolverPontos(caminho))

	switch baixo {
	case "/", "/index.html", "/mapa", "/eleicao", "/api/home", "/api/estados", "/api/visita", "/healthz":
		return true
	}
	if strings.HasPrefix(baixo, "/mapa/") || strings.HasPrefix(baixo, "/assets/") {
		return true
	}
	for _, ext := range []string{".jpg", ".png", ".css", ".js", ".woff2"} {
		if strings.HasSuffix(baixo, ext) {
			return true
		}
	}
	return false
}

// uaFalsificado: assinatura antiga ou contraditória em 2026.
func uaFalsificado(ua string) bool {
	valor := strings.ToLower(ua)
	for _, versao := range []string{"msie 6", "msie 7", "msie 8", "msie 9"} {
		if strings.Contains(valor, versao) {
			return true
		}
	}
	for _, versao := range []string{
		"iphone os 1_", "iphone os 2_", "iphone os 3_", "iphone os 4_",
		"iphone os 5_", "iphone os 6_", "iphone os 7_", "iphone os 8_",
		"iphone os 9_", "iphone os 10_", "iphone os 11_", "iphone os 12_",
	} {
		if strings.Contains(valor, versao) {
			return true
		}
	}
	for _, versao := range []string{"android 1.", "android 2.", "android 3.", "android 4.", "android 5.", "android 6."} {
		if strings.Contains(valor, versao) && !strings.Contains(valor, "chrome/1") {
			return true
		}
	}
	return false
}

// navegadorReal: marcador conhecido e UA não falsificado. Usado só para NÃO
// pontuar regularidade de quem está com o painel aberto.
func navegadorReal(ua string) bool {
	if uaFalsificado(ua) {
		return false
	}
	valor := strings.ToLower(ua)
	for _, marcador := range []string{"chrome/", "firefox/", "safari/", "edg/", "opr/"} {
		if strings.Contains(valor, marcador) {
			return true
		}
	}
	return false
}

func uaAnomalo(ua string) bool {
	if strings.TrimSpace(ua) == "" {
		return true
	}
	if reScannerUA.MatchString(ua) {
		return true
	}
	return uaFalsificado(ua)
}

type estadoIP struct {
	ip           string
	eventos      int
	primeiro     time.Time
	ultimo       time.Time
	temPrimeiro  bool
	temUltimo    bool
	hosts        map[string]int
	sinais       map[string]bool
	erros        int
	primeiraErro time.Time
	temErro      bool
	instantes    []float64
	uaReal       int
}

func novoEstadoIP(ip string) *estadoIP {
	return &estadoIP{ip: ip, hosts: map[string]int{}, sinais: map[string]bool{}}
}

// calcularSuspeitos agrupa os eventos por IP, aplica as regras e devolve só os
// que passaram do mínimo, ordenados por escore desc (empate: IP asc).
// NÃO trava: quem chama (foto) já está com c.mu.RLock preso.
func calcularSuspeitos(eventos []evento, agora time.Time, minimo int) []suspeito {
	estados := make(map[string]*estadoIP)

	for i := range eventos {
		ev := &eventos[i]
		ip := strings.TrimSpace(ev.IP)
		if ip == "" || ip == ipNaoResolvido {
			continue
		}
		// Infra local (loopback, RFC1918, gateway do docker) NUNCA entra no
		// escore: não é visitante, não pode ser bloqueada e não pode ser
		// acusada. O painel mostra o volume dela fora da contagem.
		if ipInfraLocal(ip) {
			continue
		}
		// Borda Cloudflare idem: é o caminho por onde todo visitante entra.
		// Acusar a borda é acusar o correio — e bloqueá-la derruba o site.
		if ipBorda(ip) {
			continue
		}
		est := estados[ip]
		if est == nil {
			est = novoEstadoIP(ip)
			estados[ip] = est
		}

		est.eventos++
		if !est.temPrimeiro || ev.Quando.Before(est.primeiro) {
			est.primeiro = ev.Quando
			est.temPrimeiro = true
		}
		if !est.temUltimo || ev.Quando.After(est.ultimo) {
			est.ultimo = ev.Quando
			est.temUltimo = true
		}
		if ev.Host != "" {
			est.hosts[ev.Host]++
		}
		if len(est.instantes) < maxInstantes {
			est.instantes = append(est.instantes, float64(ev.Quando.UnixNano())/1e9)
		}

		alvo := ev.Alvo
		if alvo == "" {
			alvo = ev.Caminho
		}
		alvo = limparAlvo(alvo)
		uri := ev.Caminho
		if uri == "" {
			uri = alvo
			if i := strings.IndexByte(uri, '?'); i >= 0 {
				uri = uri[:i]
			}
		}

		uriNorm := normalizarAlvoSuspeita(uri)
		alvoNorm := normalizarAlvoSuspeita(alvo)

		// caminho sensível não pontua em caminho benigno; injeção sempre pontua
		// (o SQLi mora na query de "/" e a uri registrada é só "/").
		if !caminhoIgnorado(uri) {
			if reSensivelSuspeita.MatchString(uriNorm) || reSensivelSuspeita.MatchString(alvoNorm) {
				est.sinais["caminho_sensivel"] = true
			}
		}
		if reInjecao.MatchString(alvoNorm) || reInjecao.MatchString(uriNorm) {
			est.sinais["injecao"] = true
		}

		uriBaixo := strings.ToLower(uriNorm)
		if strings.HasPrefix(uriBaixo, "/api/interno") || strings.HasPrefix(uriBaixo, "/interno/") {
			est.sinais["sondagem_interna"] = true
		}
		if !metodosNormais[strings.ToUpper(strings.TrimSpace(ev.Metodo))] {
			est.sinais["metodo_anomalo"] = true
		}
		if uaAnomalo(ev.UA) {
			est.sinais["ua_anomalo"] = true
		}
		if navegadorReal(ev.UA) {
			est.uaReal++
		}

		if ev.Status == 403 || ev.Status == 404 {
			est.erros++
			if !est.temErro || ev.Quando.Before(est.primeiraErro) {
				est.primeiraErro = ev.Quando
				est.temErro = true
			}
		}
	}

	saida := make([]suspeito, 0, len(estados))
	for ip, est := range estados {
		disparados := make(map[string]bool, len(OrdemSinais))
		for chave, valor := range est.sinais {
			if valor {
				disparados[chave] = true
			}
		}
		if regularidadeDe(est) {
			disparados["regularidade"] = true
		}
		if reincidenciaDe(est) {
			disparados["reincidencia"] = true
		}

		sinais := make([]string, 0, len(OrdemSinais))
		escore := 0
		for _, chave := range OrdemSinais {
			if disparados[chave] {
				sinais = append(sinais, chave)
				escore += PesosSuspeita[chave]
			}
		}
		if escore > 100 {
			escore = 100
		}
		if escore < minimo {
			continue
		}

		rotulos := make([]string, 0, len(sinais))
		for _, chave := range sinais {
			rotulos = append(rotulos, RotuloSinal[chave])
		}

		hosts := make([]string, 0, len(est.hosts))
		hostPrincipal, melhor := "", 0
		for host, quantidade := range est.hosts {
			hosts = append(hosts, host)
			if quantidade > melhor || (quantidade == melhor && (hostPrincipal == "" || host < hostPrincipal)) {
				melhor = quantidade
				hostPrincipal = host
			}
		}
		sort.Strings(hosts)

		primeiro, ultimo := "", ""
		if est.temPrimeiro {
			primeiro = est.primeiro.In(time.Local).Format(time.RFC3339)
		}
		if est.temUltimo {
			ultimo = est.ultimo.In(time.Local).Format(time.RFC3339)
		}

		saida = append(saida, suspeito{
			IP:       ip,
			Host:     hostPrincipal,
			Escore:   escore,
			Nivel:    nivelDe(escore),
			Sinais:   sinais,
			Rotulos:  rotulos,
			Primeiro: primeiro,
			Ultimo:   ultimo,
			Eventos:  est.eventos,
			Hosts:    hosts,
		})
	}

	sort.Slice(saida, func(a, b int) bool {
		if saida[a].Escore != saida[b].Escore {
			return saida[a].Escore > saida[b].Escore
		}
		return saida[a].IP < saida[b].IP
	})
	return saida
}

// regularidadeDe: ≥10 requisições, mais de 30 min de janela, intervalo quase
// fixo (desvio/média ≤ 0,15) e nenhum UA de navegador real no meio. Polling de
// navegador tem intervalo fixo por natureza — é justamente o caso que NÃO pode
// pontuar.
func regularidadeDe(est *estadoIP) bool {
	if len(est.instantes) < 10 || est.uaReal > 0 {
		return false
	}
	instantes := append([]float64(nil), est.instantes...)
	sort.Float64s(instantes)
	if instantes[len(instantes)-1]-instantes[0] <= 1800 {
		return false
	}
	n := len(instantes) - 1
	soma := 0.0
	for i := 1; i < len(instantes); i++ {
		soma += instantes[i] - instantes[i-1]
	}
	media := soma / float64(n)
	if media <= 0 {
		return false
	}
	variancia := 0.0
	for i := 1; i < len(instantes); i++ {
		diferenca := (instantes[i] - instantes[i-1]) - media
		variancia += diferenca * diferenca
	}
	desvio := math.Sqrt(variancia / float64(n))
	return desvio/media <= 0.15
}

// reincidenciaDe: tomou 403/404 três vezes e voltou depois da primeira recusa.
func reincidenciaDe(est *estadoIP) bool {
	if est.erros < 3 || !est.temErro {
		return false
	}
	primeira := float64(est.primeiraErro.UnixNano()) / 1e9
	for _, instante := range est.instantes {
		if instante > primeira {
			return true
		}
	}
	return false
}

func nivelDe(escore int) string {
	switch {
	case escore >= escoreMalicioso:
		return NivelMalicioso
	case escore >= escoreSuspeito:
		return NivelSuspeito
	case escore >= escoreObservar:
		return NivelObservar
	}
	return NivelLimpo
}

// infraLocal é o retrato da infra nossa no ring: mostrado no painel FORA da
// contagem de suspeitos (loopback, RFC1918/gateway do docker, não resolvido).
type infraLocal struct {
	IPs     int             `json:"ips"`
	Eventos int             `json:"eventos"`
	Lista   []contagemInfra `json:"lista"`
}

type contagemInfra struct {
	IP      string `json:"ip"`
	Eventos int    `json:"eventos"`
	Rotulo  string `json:"rotulo"`
}

// resumoInfraLocal conta o que ficou de fora do escore, sem esconder o volume:
// se o gateway do docker aparece com 1497 eventos, o painel diz isso — o que
// ele não faz é chamar isso de suspeito.
// NÃO trava: quem chama (foto) já está com c.mu.RLock preso.
func resumoInfraLocal(eventos []evento) infraLocal {
	contagem := map[string]int{}
	for i := range eventos {
		ip := strings.TrimSpace(eventos[i].IP)
		if ipInfraLocal(ip) {
			contagem[ip]++
		}
	}
	saida := infraLocal{IPs: len(contagem), Lista: make([]contagemInfra, 0, len(contagem))}
	for ip, n := range contagem {
		saida.Eventos += n
		saida.Lista = append(saida.Lista, contagemInfra{IP: ip, Eventos: n, Rotulo: rotuloInfra(ip)})
	}
	sort.Slice(saida.Lista, func(a, b int) bool {
		if saida.Lista[a].Eventos != saida.Lista[b].Eventos {
			return saida.Lista[a].Eventos > saida.Lista[b].Eventos
		}
		return saida.Lista[a].IP < saida.Lista[b].IP
	})
	if len(saida.Lista) > 8 {
		saida.Lista = saida.Lista[:8]
	}
	return saida
}

// resumoBorda conta os IPs de borda Cloudflare no ring. Nunca entram no escore:
// aparecem no painel como "borda Cloudflare", separados dos suspeitos e da infra
// local. Borda com volume é SINTOMA (real_ip quebrado), não ataque.
// NÃO trava: quem chama (foto) já está com c.mu.RLock preso.
func resumoBorda(eventos []evento) infraLocal {
	contagem := map[string]int{}
	for i := range eventos {
		ip := strings.TrimSpace(eventos[i].IP)
		if ipBorda(ip) {
			contagem[ip]++
		}
	}
	saida := infraLocal{IPs: len(contagem), Lista: make([]contagemInfra, 0, len(contagem))}
	for ip, n := range contagem {
		saida.Eventos += n
		saida.Lista = append(saida.Lista, contagemInfra{IP: ip, Eventos: n, Rotulo: "borda Cloudflare"})
	}
	sort.Slice(saida.Lista, func(a, b int) bool {
		if saida.Lista[a].Eventos != saida.Lista[b].Eventos {
			return saida.Lista[a].Eventos > saida.Lista[b].Eventos
		}
		return saida.Lista[a].IP < saida.Lista[b].IP
	})
	if len(saida.Lista) > 8 {
		saida.Lista = saida.Lista[:8]
	}
	return saida
}

func rotuloInfra(ip string) string {
	if ip == ipNaoResolvido {
		return "não resolvido (400 antes do real_ip)"
	}
	endereco := net.ParseIP(strings.Trim(ip, "[]"))
	switch {
	case endereco != nil && endereco.IsLoopback():
		return "loopback"
	case endereco != nil && endereco.IsPrivate():
		if strings.HasPrefix(ip, "172.") {
			return "rede privada (gateway do docker)"
		}
		return "rede privada (RFC1918)"
	}
	return "infra local"
}
