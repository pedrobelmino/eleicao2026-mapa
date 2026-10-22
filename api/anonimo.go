package main

// Contagem anônima de visitas do mapa — porte de `metricas_publico.py`
// (painel Python) para Go.
//
// Mesmo banco, mesmo sal, mesmo hash: o mapa Go e o painel Python somam no
// MESMO histórico (`visitas.db`). Nada de banco novo, nada de zerar contagem.
//
// Privacidade (a mesma regra do Python, e ela é o ponto do arquivo):
//   * não existe cookie, fingerprint nem pixel de terceiro;
//   * o IP nunca é gravado, logado ou devolvido. Na hora da visita vira
//     hash = sha256(sal|dia|ip)[:32] — o dia entra no hash de propósito, então
//     o mesmo visitante tem hash diferente amanhã e não dá para emendar a
//     trajetória de ninguém entre dias;
//   * do IP sobra só o que o GeoIP devolve: país / estado / cidade. IP
//     privado ou loopback não é geolocalizado (fica "rede local");
//   * user-agent entra resumido ("Chrome · Linux"), nunca a string inteira;
//   * retenção de 180 dias, aplicada na própria escrita.
//
// O sal é segredo local (`<dir>/.salt`, 0600). Se ele já existe, é usado como
// está — gerar outro quebraria a continuidade dos hashes já gravados.

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/oschwald/maxminddb-golang"
	_ "modernc.org/sqlite" // driver puro Go: build sem cgo, roda em alpine
)

const (
	retencaoDias   = 180
	checkpointCada = 200
)

// Fuso de Brasília: -03 desde 2019, sem horário de verão.
var fusoBrasilia = time.FixedZone("BRT", -3*60*60)

// Mesma lista do Python: robô de busca/monitoramento/preview de rede social
// fica registrado com bot=1 e fora de todas as contagens da tela.
var reBot = regexp.MustCompile(`(?i)bot\b|bot/|crawl|spider|slurp|bingpreview|facebookexternalhit|` +
	`telegrambot|whatsapp|headlesschrome|phantomjs|python-requests|python-urllib|aiohttp|` +
	`curl/|wget/|monitor|uptime|pingdom|uptimerobot|semrush|ahrefs|scrapy`)

const esquemaSQL = `
CREATE TABLE IF NOT EXISTS visitas (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    dia      TEXT NOT NULL,
    ip_hash  TEXT NOT NULL,
    pais     TEXT,
    uf       TEXT,
    cidade   TEXT,
    ua       TEXT,
    bot      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_visitas_dia ON visitas(dia);
CREATE INDEX IF NOT EXISTS ix_visitas_hash ON visitas(ip_hash);
CREATE TABLE IF NOT EXISTS geo_cache (
    ip_hash TEXT PRIMARY KEY,
    pais    TEXT,
    uf      TEXT,
    cidade  TEXT
);
`

// visita é o registro gravado. Não existe campo de IP aqui — por construção.
type visita struct {
	TS     string  `json:"ts"`
	Dia    string  `json:"dia"`
	IPHash string  `json:"ip_hash"`
	Pais   *string `json:"pais"`
	UF     *string `json:"uf"`
	Cidade *string `json:"cidade"`
	UA     string  `json:"ua"`
	Bot    bool    `json:"bot"`
}

type anonimo struct {
	db        *sql.DB
	sal       string
	caminhoDB string
	caminhoGeo string
	geo       *maxminddb.Reader
	usarAPI   bool // sem base local, cai na API pública (desligável)

	cacheMu  sync.Mutex
	cacheAPI map[string]tripla

	escritasMu sync.Mutex
	escritas   uint64
}

type tripla struct {
	pais, uf, cidade *string
	valido          bool // false = ainda não consultado
}

// novoAnonimo abre (ou cria) o banco e o GeoIP. Diretório ausente ou sem
// escrita devolve erro: métrica nunca derruba o app, o chamador decide.
func novoAnonimo() (*anonimo, error) {
	dir := envOu("METRICAS_DIR", "/metricas")
	caminhoDB := envOu("METRICAS_DB", filepath.Join(dir, "visitas.db"))
	caminhoSal := envOu("METRICAS_SAL", filepath.Join(dir, ".salt"))
	caminhoGeo := envOu("METRICAS_GEO", filepath.Join(dir, "geo", "dbip-city-lite.mmdb"))

	if err := os.MkdirAll(filepath.Dir(caminhoDB), 0o755); err != nil {
		return nil, err
	}
	if err := testarEscrita(filepath.Dir(caminhoDB)); err != nil {
		return nil, err
	}

	sal, err := lerOuCriarSal(caminhoSal)
	if err != nil {
		return nil, err
	}

	db, err := sql.Open("sqlite", caminhoDB)
	if err != nil {
		return nil, err
	}
	// Um escritor só: o painel Python escreve no mesmo arquivo e o SQLite
	// resolve o resto pelo WAL + busy_timeout.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	if _, err := db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(esquemaSQL); err != nil {
		db.Close()
		return nil, err
	}

	contagem := &anonimo{
		db:        db,
		sal:       sal,
		caminhoDB: caminhoDB,
		caminhoGeo: caminhoGeo,
		cacheAPI:  make(map[string]tripla),
		usarAPI:   envOu("METRICAS_GEO_API", "1") != "0",
	}

	if leitor, err := maxminddb.Open(caminhoGeo); err == nil {
		contagem.geo = leitor
	} else if !os.IsNotExist(err) {
		log.Printf("GeoIP: base %s ilegível (%v) — região ficará sem identificação", caminhoGeo, err)
	}

	log.Printf("contagem anônima: banco %s · geo: %s", caminhoDB, contagem.fonteGeo())
	return contagem, nil
}

func lerTudo(arquivo *os.File) []byte {
	info, err := arquivo.Stat()
	if err != nil {
		return nil
	}
	conteudo := make([]byte, info.Size())
	if _, err := arquivo.ReadAt(conteudo, 0); err != nil {
		return nil
	}
	return conteudo
}

// testarEscrita garante que o diretório do banco aceita escrita antes de a
// primeira visita chegar (arquivo criado por root numa pasta do usuário é o
// jeito clássico de o painel parar de contar).
func testarEscrita(dir string) error {
	sonda := filepath.Join(dir, ".escrita-ok")
	arquivo, err := os.OpenFile(sonda, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	arquivo.Close()
	return os.Remove(sonda)
}

func lerOuCriarSal(caminho string) (string, error) {
	if conteudo, err := os.ReadFile(caminho); err == nil {
		if texto := strings.TrimSpace(string(conteudo)); texto != "" {
			return texto, nil
		}
	}
	bruto := make([]byte, 32)
	if _, err := rand.Read(bruto); err != nil {
		return "", err
	}
	texto := hex.EncodeToString(bruto)
	if err := os.WriteFile(caminho, []byte(texto+"\n"), 0o600); err != nil {
		return "", err
	}
	_ = os.Chmod(caminho, 0o600)
	return texto, nil
}

func (a *anonimo) disponivel() bool { return a != nil && a.db != nil }

func (a *anonimo) caminhoBanco() string { return a.caminhoDB }

func (a *anonimo) fechar() {
	if a == nil {
		return
	}
	if a.geo != nil {
		a.geo.Close()
	}
	if a.db != nil {
		a.db.Close()
	}
}

// hashIP é o coração do anonimato: sal + dia + ip, truncado em 32 hex.
func (a *anonimo) hashIP(ip, dia string) string {
	if ip == "" {
		ip = "sem-ip"
	}
	soma := sha256.Sum256([]byte(a.sal + "|" + dia + "|" + ip))
	return hex.EncodeToString(soma[:])[:32]
}

// registrar grava UMA visita e devolve o que foi gravado.
func (a *anonimo) registrar(ip, userAgent string, quando time.Time) (visita, error) {
	momento := quando.In(fusoBrasilia).Truncate(time.Second)
	dia := momento.Format("2006-01-02")

	limpo := ""
	if normalizado, ok := ipValido(ip); ok {
		limpo = normalizado
	}
	chave := a.hashIP(limpo, dia)

	var pais, uf, cidade *string
	if limpo != "" && !ipPrivado(limpo) {
		pais, uf, cidade = a.geolocaliza(chave, limpo, dia)
	}

	registro := visita{
		TS:     momento.Format("2006-01-02T15:04:05-07:00"),
		Dia:    dia,
		IPHash: chave,
		Pais:   pais,
		UF:     uf,
		Cidade: cidade,
		UA:     resumoUA(userAgent),
		Bot:    ehBot(userAgent),
	}

	corte := momento.AddDate(0, 0, -retencaoDias).Format("2006-01-02")
	transacao, err := a.db.Begin()
	if err != nil {
		return registro, err
	}
	_, err = transacao.Exec(
		"INSERT INTO visitas(ts, dia, ip_hash, pais, uf, cidade, ua, bot) VALUES(?,?,?,?,?,?,?,?)",
		registro.TS, registro.Dia, registro.IPHash, registro.Pais, registro.UF,
		registro.Cidade, registro.UA, boolParaInt(registro.Bot),
	)
	if err != nil {
		transacao.Rollback()
		return registro, err
	}
	if _, err := transacao.Exec("DELETE FROM visitas WHERE dia < ?", corte); err != nil {
		transacao.Rollback()
		return registro, err
	}
	if err := transacao.Commit(); err != nil {
		return registro, err
	}

	a.escritasMu.Lock()
	a.escritas++
	precisaCheckpoint := a.escritas%checkpointCada == 0
	a.escritasMu.Unlock()
	if precisaCheckpoint {
		// O WAL é compartilhado com o painel Python: sem checkpoint ele cresce.
		if _, err := a.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
			log.Printf("checkpoint do WAL de visitas falhou: %v", err)
		}
	}

	return registro, nil
}

func boolParaInt(valor bool) int {
	if valor {
		return 1
	}
	return 0
}

// --------------------------------------------------------------- geolocalização

type registroGeo struct {
	Country struct {
		ISOCode string `maxminddb:"iso_code"`
	} `maxminddb:"country"`
	Subdivisions []struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"subdivisions"`
	City struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"city"`
}

func (a *anonimo) geolocaliza(chave, ip, dia string) (*string, *string, *string) {
	if pais, uf, cidade, encontrado := a.doCache(chave); encontrado {
		return pais, uf, cidade
	}

	var pais, uf, cidade *string
	if a.geo != nil {
		var registro registroGeo
		if err := a.geo.Lookup(net.ParseIP(ip), &registro); err == nil {
			if registro.Country.ISOCode != "" {
				valor := strings.ToUpper(registro.Country.ISOCode)
				pais = &valor
			}
			if len(registro.Subdivisions) > 0 {
				if nome := nomeTraduzido(registro.Subdivisions[0].Names); nome != "" {
					valor := nome
					uf = &valor
				}
			}
			if nome := nomeTraduzido(registro.City.Names); nome != "" {
				valor := nome
				cidade = &valor
			}
		}
	} else if a.usarAPI {
		pais, uf, cidade = a.geoPorAPI(chave, ip)
	}

	a.salvarCache(chave, pais, uf, cidade)
	return pais, uf, cidade
}

func nomeTraduzido(nomes map[string]string) string {
	if nomes == nil {
		return ""
	}
	if nome, existe := nomes["pt-BR"]; existe && nome != "" {
		return nome
	}
	return nomes["en"]
}

func (a *anonimo) doCache(chave string) (*string, *string, *string, bool) {
	var pais, uf, cidade sql.NullString
	err := a.db.QueryRow("SELECT pais, uf, cidade FROM geo_cache WHERE ip_hash = ?", chave).
		Scan(&pais, &uf, &cidade)
	if err != nil {
		return nil, nil, nil, false
	}
	return ponteiroDe(pais), ponteiroDe(uf), ponteiroDe(cidade), true
}

func ponteiroDe(valor sql.NullString) *string {
	if !valor.Valid {
		return nil
	}
	texto := valor.String
	return &texto
}

func (a *anonimo) salvarCache(chave string, pais, uf, cidade *string) {
	_, err := a.db.Exec(
		"INSERT OR REPLACE INTO geo_cache(ip_hash, pais, uf, cidade) VALUES(?,?,?,?)",
		chave, pais, uf, cidade,
	)
	if err != nil {
		log.Printf("cache de geo não gravado: %v", err)
	}
}

// geoPorAPI é a reserva quando não há base local. Guarda o resultado pelo hash,
// nunca pelo IP.
func (a *anonimo) geoPorAPI(chave, ip string) (*string, *string, *string) {
	a.cacheMu.Lock()
	if guardado, existe := a.cacheAPI[chave]; existe {
		a.cacheMu.Unlock()
		return guardado.pais, guardado.uf, guardado.cidade
	}
	a.cacheMu.Unlock()

	cliente := &http.Client{Timeout: 3 * time.Second}
	endereco := "http://ip-api.com/json/" + ip + "?fields=status,countryCode,regionName,city&lang=pt-BR"
	resposta, err := cliente.Get(endereco)
	if err != nil {
		return nil, nil, nil
	}
	defer resposta.Body.Close()

	var corpo struct {
		Status      string `json:"status"`
		CountryCode string `json:"countryCode"`
		RegionName  string `json:"regionName"`
		City        string `json:"city"`
	}
	if err := json.NewDecoder(resposta.Body).Decode(&corpo); err != nil || corpo.Status != "success" {
		return nil, nil, nil
	}

	pais, uf, cidade := textoOuNulo(corpo.CountryCode), textoOuNulo(corpo.RegionName), textoOuNulo(corpo.City)
	a.cacheMu.Lock()
	a.cacheAPI[chave] = tripla{pais: pais, uf: uf, cidade: cidade, valido: true}
	a.cacheMu.Unlock()
	return pais, uf, cidade
}

func textoOuNulo(texto string) *string {
	if strings.TrimSpace(texto) == "" {
		return nil
	}
	valor := texto
	return &valor
}

func (a *anonimo) fonteGeo() string {
	if a != nil && a.geo != nil {
		return "base local DB-IP City Lite (offline — o IP do visitante não sai desta máquina)"
	}
	if a != nil && a.usarAPI {
		return "API pública ip-api.com (consulta por visita, com cache) — base local indisponível"
	}
	return "nenhuma — região não identificada"
}

// ------------------------------------------------------------------ user-agent

func resumoUA(userAgent string) string {
	texto := strings.TrimSpace(userAgent)
	if texto == "" {
		return "desconhecido"
	}

	navegador := "outro"
	for _, candidato := range []struct{ chave, nome string }{
		{"Edg/", "Edge"}, {"OPR/", "Opera"}, {"Firefox/", "Firefox"},
		{"Chrome/", "Chrome"}, {"Safari/", "Safari"},
	} {
		if strings.Contains(texto, candidato.chave) {
			navegador = candidato.nome
			break
		}
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

func ehBot(userAgent string) bool {
	return reBot.MatchString(userAgent)
}

// ---------------------------------------------------------------- resumo

func (a *anonimo) resumo(diasSerie int) (map[string]any, error) {
	if a == nil || a.db == nil {
		return nil, nil
	}
	if diasSerie < 1 {
		diasSerie = 14
	}

	agora := time.Now().In(fusoBrasilia)
	diaHoje := agora.Format("2006-01-02")
	diaOntem := agora.AddDate(0, 0, -1).Format("2006-01-02")
	desde := agora.AddDate(0, 0, -(diasSerie - 1)).Format("2006-01-02")

	conta := func(consulta string, argumentos ...any) (int, int, error) {
		var visitas, pessoas sql.NullInt64
		err := a.db.QueryRow(consulta, argumentos...).Scan(&visitas, &pessoas)
		return int(visitas.Int64), int(pessoas.Int64), err
	}

	visitasHoje, pessoasHoje, err := conta(
		"SELECT COUNT(*), COUNT(DISTINCT ip_hash) FROM visitas WHERE bot = 0 AND dia = ?", diaHoje)
	if err != nil {
		return nil, err
	}
	visitasOntem, pessoasOntem, err := conta(
		"SELECT COUNT(*), COUNT(DISTINCT ip_hash) FROM visitas WHERE bot = 0 AND dia = ?", diaOntem)
	if err != nil {
		return nil, err
	}
	visitasTotal, pessoasTotal, err := conta(
		"SELECT COUNT(*), COUNT(DISTINCT ip_hash) FROM visitas WHERE bot = 0")
	if err != nil {
		return nil, err
	}

	var bots int
	var primeiro sql.NullString
	if err := a.db.QueryRow("SELECT COUNT(*) FROM visitas WHERE bot = 1").Scan(&bots); err != nil {
		return nil, err
	}
	if err := a.db.QueryRow("SELECT MIN(dia) FROM visitas WHERE bot = 0").Scan(&primeiro); err != nil {
		return nil, err
	}

	regioes, err := a.agrupar(
		"SELECT pais, uf, cidade, COUNT(*), COUNT(DISTINCT ip_hash) FROM visitas"+
			" WHERE bot = 0 GROUP BY pais, uf, cidade ORDER BY 5 DESC, 4 DESC LIMIT 30", true)
	if err != nil {
		return nil, err
	}
	if len(regioes) > 6 {
		regioes = regioes[:6]
	}

	estados, err := a.agrupar(
		"SELECT pais, uf, NULL, COUNT(*), COUNT(DISTINCT ip_hash) FROM visitas"+
			" WHERE bot = 0 GROUP BY pais, uf ORDER BY 5 DESC, 4 DESC LIMIT 8", false)
	if err != nil {
		return nil, err
	}

	serie := make([]map[string]any, 0, diasSerie)
	linhas, err := a.db.Query(
		"SELECT dia, COUNT(*), COUNT(DISTINCT ip_hash) FROM visitas"+
			" WHERE bot = 0 AND dia >= ? GROUP BY dia ORDER BY dia", desde)
	if err != nil {
		return nil, err
	}
	defer linhas.Close()
	for linhas.Next() {
		var dia string
		var visitas, pessoas int
		if err := linhas.Scan(&dia, &visitas, &pessoas); err != nil {
			return nil, err
		}
		rotulo := dia
		if len(dia) == 10 {
			rotulo = dia[8:10] + "/" + dia[5:7]
		}
		serie = append(serie, map[string]any{
			"dia": dia, "rotulo": rotulo, "visitas": visitas, "pessoas": pessoas,
		})
	}

	desdeTotal := ""
	if primeiro.Valid {
		desdeTotal = primeiro.String
	}

	return map[string]any{
		"gerado_em": agora.Truncate(time.Second).Format("2006-01-02T15:04:05-07:00"),
		"hoje":      map[string]any{"dia": diaHoje, "visitas": visitasHoje, "pessoas": pessoasHoje},
		"ontem":     map[string]any{"dia": diaOntem, "visitas": visitasOntem, "pessoas": pessoasOntem},
		"total": map[string]any{
			"visitas": visitasTotal, "pessoas": pessoasTotal, "desde": desdeTotal,
		},
		"regioes":        regioes,
		"estados":        estados,
		"serie":          serie,
		"bots_filtrados": bots,
		"fonte_geo":      a.fonteGeo(),
		"retencao_dias":  retencaoDias,
		"origem":         "visitas.db compartilhado (painel python + mapa Go)",
		"anonimato": "Sem cookies e sem IP guardado: cada visita vira um hash que muda todo dia. " +
			"Do visitante só ficam país/estado/cidade, data/hora e navegador resumido.",
	}, nil
}

// agrupar devolve [{regiao, visitas, pessoas}] para as consultas de região.
func (a *anonimo) agrupar(consulta string, comCidade bool) ([]map[string]any, error) {
	linhas, err := a.db.Query(consulta)
	if err != nil {
		return nil, err
	}
	defer linhas.Close()

	saida := make([]map[string]any, 0, 8)
	for linhas.Next() {
		var pais, uf, cidade sql.NullString
		var visitas, pessoas int
		if err := linhas.Scan(&pais, &uf, &cidade, &visitas, &pessoas); err != nil {
			return nil, err
		}
		saida = append(saida, map[string]any{
			"regiao":  rotuloRegiao(pais.String, uf.String, cidade.String, comCidade),
			"visitas": visitas,
			"pessoas": pessoas,
		})
	}
	return saida, linhas.Err()
}

func rotuloRegiao(pais, uf, cidade string, comCidade bool) string {
	if pais == "" && uf == "" {
		return "não identificado"
	}
	partes := make([]string, 0, 2)
	if comCidade && cidade != "" {
		partes = append(partes, cidade)
	}
	if uf != "" {
		partes = append(partes, uf)
	}
	if len(partes) == 0 {
		if pais != "" {
			return pais
		}
		return "não identificado"
	}
	if pais != "" && pais != "BR" {
		partes = append(partes, pais)
	}
	return strings.Join(partes, " · ")
}

// estadoBanco alimenta a linha "metricas" do painel de saúde.
func (a *anonimo) estadoBanco() (int64, string, string) {
	var linhas int64
	var ultimo sql.NullString
	if err := a.db.QueryRow("SELECT COUNT(*), MAX(ts) FROM visitas").Scan(&linhas, &ultimo); err != nil {
		return 0, "?", "?"
	}
	tamanho := "?"
	if info, err := os.Stat(a.caminhoDB); err == nil {
		tamanho = strconv.FormatInt(info.Size()/1024, 10) + " KB"
	}
	quando := "—"
	if ultimo.Valid && ultimo.String != "" {
		quando = ultimo.String
	}
	return linhas, tamanho, quando
}

// handleVisita é chamado pelo nginx (mirror) quando a página é aberta.
// Responde SEMPRE 204: contagem nunca atrapalha o carregamento do mapa.
func (a *anonimo) handleVisita(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if _, err := a.registrar(ipDoCliente(r), r.UserAgent(), time.Now()); err != nil {
		log.Printf("visita não registrada: %v", err)
	}
	w.WriteHeader(http.StatusNoContent)
}
