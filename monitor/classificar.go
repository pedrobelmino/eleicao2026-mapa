package main

// Classificação de ataque e detecção de bot.
//
// Bot: MESMO critério da contagem anônima do site (api/anonimo.go, var reBot)
// — copiado de propósito, não reinventado: o painel de acessos e este têm que
// concordar sobre o que é robô. A única diferença é o acréscimo dos UA de
// scanner de vulnerabilidade em reBot (o resto é idêntico ao original).
//
// Ataque: regra, nunca LLM. Cada evento recebe no máximo UM tipo, pelo critério
// mais específico primeiro. O alvo usado é o caminho COM query (campo 8 do
// log), porque SQLi mora na query e o `$uri` do nginx não a registra.

import (
	"regexp"
	"strings"
)

// Tipos de ataque (rótulos que aparecem no painel).
const (
	AtaqueSensivel  = "arquivo sensível"
	AtaqueTraversal = "path traversal"
	AtaqueSQLi      = "SQLi"
	AtaqueScanner   = "scanner de vulnerabilidade"
	AtaqueMetodo    = "método não permitido"
	AtaqueFlood     = "flood / 429"
)

var (
	// Arquivo/rota que ninguém legítimo pede num mapa eleitoral.
	reSensivel = regexp.MustCompile(`(?i)(^|/)(\.env|\.git|\.aws|\.ssh|\.htaccess|` +
		`\.htpasswd|\.ds_store|\.svn|nginx\.conf|web\.config|id_rsa|wp-config\.php|` +
		`docker-compose\.ya?ml)` + `|/admin|/administrator|/phpmyadmin|/mysql|` +
		`/actuator|/console|/server-status|/server-info|/\.well-known/security`)

	// ../ e variantes codificadas.
	reTraversal = regexp.MustCompile(`(?i)(\.\./|%2e%2e|%252e%252e|\.\.\\|` +
		`/etc/passwd|/etc/shadow|/proc/self|/windows/win\.ini)`)

	// Assinaturas de SQL injection no caminho ou na query.
	reSQLi = regexp.MustCompile(`(?i)('|%27|%22|")\s*(or|and)\s|union[\s+]+select|` +
		`information_schema|sleep\s*\(|benchmark\s*\(|pg_sleep|waitfor[\s+]+delay|` +
		`1\s*=\s*1|1'\s*=\s*'1|xp_cmdshell|;\s*drop\s+table|` +
		`(select|insert|update|delete)[\s+]+.{0,20}from`)

	// Varredura de vulnerabilidade (caminho ou UA).
	reScanner = regexp.MustCompile(`(?i)(wp-admin|wp-login|wp-content|xmlrpc\.php|` +
		`phpmyadmin|/vendor/|/cgi-bin|/shell|/backup|\.php$|/config\.|/actuator|` +
		`/console|/solr|/jenkins|/boaform|/hnap1|/setup\.cgi|/autodiscover|` +
		`/owa/|/manager/html|/struts|/thinkphp|/\.git/|/druid|/jmx-console)`)
	reUAScanner = regexp.MustCompile(`(?i)(sqlmap|nikto|nmap|masscan|zgrab|nuclei|` +
		`dirbuster|gobuster|wpscan|acunetix|nessus|feroxbuster|ffuf|nuclei|` +
		`openvas|zap/|w3af|joomscan|whatweb|censys)`)
)

// ehBot replica api/anonimo.go:54 (reBot) + os UA de scanner.
var reBot = regexp.MustCompile(`(?i)bot\b|bot/|crawl|spider|slurp|bingpreview|facebookexternalhit|` +
	`telegrambot|whatsapp|headlesschrome|phantomjs|python-requests|python-urllib|aiohttp|` +
	`curl/|wget/|monitor|uptime|pingdom|uptimerobot|semrush|ahrefs|scrapy|` +
	`sqlmap|nikto|nmap|masscan|zgrab|nuclei|gobuster|ffuf|wpscan|feroxbuster`)

func ehBot(userAgent string) bool {
	return reBot.MatchString(userAgent)
}

// classificacaoDeMetodo: só o que o site precisa responder. CONNECT/PUT/TRACE
// num mapa público é sonda, não uso.
func metodoSuspeito(metodo string) bool {
	switch metodo {
	case "GET", "HEAD", "POST", "OPTIONS":
		return false
	}
	return true
}

// normalizarAlvo desfaz o suficiente da codificação de URL para as regras
// enxergarem o ataque: %20 e + viram espaço, %27 vira aspa, %3D vira =.
// Sem isto, "1'%20OR%20'1'='1" não casaria com nenhuma regra de SQLi.
func normalizarAlvo(alvo string) string {
	trocas := []struct{ de, para string }{
		{"%20", " "}, {"+", " "}, {"%27", "'"}, {"%22", `"`},
		{"%3D", "="}, {"%2F", "/"}, {"%3C", "<"}, {"%3E", ">"},
		{"%09", " "}, {"%0A", " "},
	}
	saida := alvo
	for _, troca := range trocas {
		saida = strings.ReplaceAll(saida, troca.de, troca.para)
		saida = strings.ReplaceAll(saida, strings.ToLower(troca.de), troca.para)
	}
	return saida
}

// classificar devolve o tipo de ataque do evento ("" para tráfego normal).
func classificar(ev *evento) string {
	alvo := ev.Alvo
	if alvo == "" {
		alvo = ev.Caminho
	}
	alvo = normalizarAlvo(alvo)
	// o campo do log é a linha de requisição crua: "GET /path HTTP/1.1"
	if ev.Metodo != "" {
		alvo = strings.TrimPrefix(alvo, ev.Metodo+" ")
	}
	if corte := strings.LastIndex(alvo, " HTTP/"); corte > 0 {
		alvo = alvo[:corte]
	}

	if reSensivel.MatchString(alvo) {
		return AtaqueSensivel
	}
	if reTraversal.MatchString(alvo) {
		return AtaqueTraversal
	}
	if reSQLi.MatchString(alvo) {
		return AtaqueSQLi
	}
	if reScanner.MatchString(alvo) || reUAScanner.MatchString(ev.UA) {
		return AtaqueScanner
	}
	if metodoSuspeito(ev.Metodo) {
		return AtaqueMetodo
	}
	// 429 é o rate limit do nginx atuando: é flood por definição, o controle
	// de "muitas requisições do mesmo IP" é contado à parte no coletor.
	if ev.Status == 429 {
		return AtaqueFlood
	}
	return ""
}

// normalizarCaminho reduz cardinalidade para os "top caminhos": id numérico
// vira {id}. Barato e suficiente para leitura humana.
func normalizarCaminho(caminho string) string {
	if caminho == "" {
		return "/"
	}
	partes := strings.Split(caminho, "/")
	for i, parte := range partes {
		if len(parte) >= 4 && soDigitos(parte) {
			partes[i] = "{n}"
		}
	}
	saida := strings.Join(partes, "/")
	if len(saida) > 80 {
		saida = saida[:80] + "…"
	}
	return saida
}

func soDigitos(texto string) bool {
	for _, r := range texto {
		if r < '0' || r > '9' {
			return false
		}
	}
	return texto != ""
}

// resumoUA replica api/anonimo.go:451 (navegador · sistema), com fallback para
// o UA cru quando não é navegador conhecido (curl, scanner, robô).
func resumoUA(userAgent string) string {
	texto := strings.TrimSpace(userAgent)
	if texto == "" {
		return "desconhecido"
	}

	navegador := ""
	for _, candidato := range []struct{ chave, nome string }{
		{"Edg/", "Edge"}, {"OPR/", "Opera"}, {"Firefox/", "Firefox"},
		{"Chrome/", "Chrome"}, {"Safari/", "Safari"},
	} {
		if strings.Contains(texto, candidato.chave) {
			navegador = candidato.nome
			break
		}
	}
	if navegador == "" {
		// não é navegador: devolve o produto (primeiro token) cortado
		produto := texto
		if i := strings.IndexAny(produto, " ;("); i > 0 {
			produto = produto[:i]
		}
		if len(produto) > 32 {
			produto = produto[:32]
		}
		return produto
	}

	sistema := "outro"
	for _, candidato := range []struct{ chave, nome string }{
		{"Android", "Android"}, {"iPhone", "iPhone"}, {"iPad", "iPad"},
		{"Windows", "Windows"}, {"Mac OS X", "macOS"}, {"CrOS", "ChromeOS"},
		{"Linux", "Linux"},
	} {
		if strings.Contains(texto, candidato.chave) {
			sistema = candidato.nome
			break
		}
	}
	return navegador + " · " + sistema
}
