package main

// Painel de monitoramento em tempo real dos acessos que entram por
// *.belmino.dev — servido SÓ na rede interna.
//
//	127.0.0.1:8113   loopback (a própria máquina)
//	192.168.5.179:8113  LAN (nenhum outro endereço é aberto: nunca 0.0.0.0)
//
// Quem decide é o SOCKET, não cabeçalho: o IP vem de RemoteAddr da conexão
// aceita pelo kernel. X-Real-IP, X-Forwarded-For, CF-Connecting-IP e CORS são
// ignorados por construção — não existe código que os leia. Fora de
// 192.168.5.0/24 e do loopback: 403 e nada mais.
//
// Independência: este processo NÃO fala com o container do site. Só lê o log
// que o nginx já escreve (var/defesa/acessos.log). Se ele morrer, o site não
// sente; se o site cair, o painel mostra o silêncio.

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web
var arquivosWeb embed.FS

const (
	versao = "1.0.0"
)

type servidor struct {
	coletor *coletor
	rede    *net.IPNet
	inicio  time.Time
	raiz    string // raiz do projeto (para achar scripts/defesa/bloquear.sh)
}

func main() {
	var (
		enderecos = flag.String("enderecos", envOu("MONITOR_ENDERECOS", "127.0.0.1:8113,192.168.5.179:8113"), "lista de host:porta separada por vírgula (loopback + LAN)")
		rede      = flag.String("rede", envOu("MONITOR_REDE", "192.168.5.0/24"), "rede autorizada (CIDR)")
		caminho   = flag.String("log", envOu("MONITOR_LOG", "var/defesa/acessos.log"), "log de defesa do nginx")
		serie     = flag.String("serie", envOu("MONITOR_SERIE", "var/defesa/monitor_serie_dia.json"), "agregado diário persistido")
		estado    = flag.String("estado", envOu("MONITOR_ESTADO", "var/defesa/estado.json"), "estado do vigia (bloqueios)")
		raiz      = flag.String("raiz", envOu("MONITOR_RAIZ", "."), "raiz do projeto (scripts/defesa/bloquear.sh)")
	)
	flag.Parse()

	_, redeAutorizada, err := net.ParseCIDR(*rede)
	if err != nil {
		log.Fatalf("rede inválida %q: %v", *rede, err)
	}

	coletor := novoColetor(*serie)

	leitor := novoLeitor(*caminho, coletor.registrar, coletor.reset)
	if linhas := leitor.passo(); linhas > 0 {
		log.Printf("semeadura: %d linha(s) já no log", linhas)
	}

	srv := &servidor{coletor: coletor, rede: redeAutorizada, inicio: time.Now(), raiz: *raiz}

	go func() {
		for {
			time.Sleep(500 * time.Millisecond)
			leitor.passo()
		}
	}()
	go func() {
		for {
			coletor.limpar()
			time.Sleep(5 * time.Second)
		}
	}()
	go vigiarEstadoVigia(*estado, coletor)

	listas, err := resolverEnderecos(*enderecos, redeAutorizada)
	if err != nil {
		log.Fatalf("nenhum endereço para escutar: %v", err)
	}

	handler := srv.rotas()
	httpSrv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
		// Sem WriteTimeout: SSE é conexão longa. O corte vem do contexto do
		// cliente (F5/fecha aba) e do keepalive de 15 s.
	}

	var wg sync.WaitGroup
	for _, endereco := range listas {
		ouvinte, err := net.Listen("tcp", endereco)
		if err != nil {
			log.Printf("AVISO: não consegui escutar em %s: %v", endereco, err)
			continue
		}
		log.Printf("painel v%s escutando em http://%s (rede autorizada %s, log %s)",
			versao, endereco, redeAutorizada, *caminho)
		wg.Add(1)
		go func(l net.Listener) {
			defer wg.Done()
			if err := httpSrv.Serve(l); err != nil && err != http.ErrServerClosed {
				log.Printf("servidor em %s parou: %v", l.Addr(), err)
			}
		}(ouvinte)
	}

	sinal := make(chan os.Signal, 1)
	signal.Notify(sinal, syscall.SIGINT, syscall.SIGTERM)
	<-sinal

	ctx, cancelar := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelar()
	_ = httpSrv.Shutdown(ctx)
	coletor.mu.Lock()
	coletor.salvarSerie()
	coletor.mu.Unlock()
	log.Print("encerrado")
}

// rotas monta o mux. TODA rota passa pelo filtro de rede, inclusive estático.
func (s *servidor) rotas() http.Handler {
	mux := http.NewServeMux()

	estatico, err := fs.Sub(arquivosWeb, "web")
	if err != nil {
		log.Fatalf("assets embutidos: %v", err)
	}
	mux.Handle("/", http.FileServer(http.FS(estatico)))
	mux.HandleFunc("/api/monitor/estado", s.handleEstado)
	mux.HandleFunc("/api/monitor/eventos", s.handleSSE)
	mux.HandleFunc("/api/monitor/bloquear", s.handleBloquear)
	mux.HandleFunc("/saude", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})

	return s.soRedeInterna(mux)
}

// soRedeInterna é a única barreira de acesso. RemoteAddr vem do kernel, não do
// cabeçalho: nenhum header é lido aqui (nem para liberar, nem para negar).
func (s *servidor) soRedeInterna(proximo http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip, ok := ipDaConexao(r.RemoteAddr)
		if !ok || !s.autorizado(ip) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprintf(w, "403 — acesso restrito à rede interna (%s e loopback)\n", s.rede)
			return
		}

		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "+
				"script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		proximo.ServeHTTP(w, r)
	})
}

func (s *servidor) autorizado(ip net.IP) bool {
	if ip.IsLoopback() {
		return true
	}
	if ip.To4() == nil && ip.To16() == nil {
		return false
	}
	return s.rede.Contains(ip)
}

func ipDaConexao(remoteAddr string) (net.IP, bool) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(strings.TrimSpace(host))
	if ip == nil {
		return nil, false
	}
	return ip, true
}

// handleEstado devolve o retrato completo (fallback de polling: 2 s).
func (s *servidor) handleEstado(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	foto := s.coletor.foto()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	codificador := json.NewEncoder(w)
	codificador.SetIndent("", " ")
	_ = codificador.Encode(foto)
}

// handleSSE empurra o retrato a cada mudança (ou a cada 2 s, no máximo). O
// navegador reconecta sozinho; se o EventSource falhar duas vezes, o JS cai
// para polling de 2 s e diz isso na tela.
func (s *servidor) handleSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "sem suporte a streaming", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	fmt.Fprintf(w, "retry: 3000\nevent: ola\ndata: {\"versao\":%q}\n\n", versao)
	flusher.Flush()

	tique := time.NewTicker(time.Second)
	defer tique.Stop()
	batida := time.NewTicker(15 * time.Second)
	defer batida.Stop()

	ultimaAssinatura := ""
	ultimoEnvio := time.Time{}
	eventos := 0

	for {
		select {
		case <-r.Context().Done():
			return

		case <-batida.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()

		case <-tique.C:
			foto := s.coletor.foto()
			assinatura := assinaturaDe(&foto)
			agora := time.Now()
			if assinatura == ultimaAssinatura && agora.Sub(ultimoEnvio) < 2*time.Second {
				continue
			}
			dados, err := json.Marshal(foto)
			if err != nil {
				continue
			}
			eventos++
			fmt.Fprintf(w, "id: %d\nevent: estado\ndata: %s\n\n", eventos, dados)
			flusher.Flush()
			ultimaAssinatura = assinatura
			ultimoEnvio = agora
		}
	}
}

// assinaturaDe resume "mudou alguma coisa?" — se os números das janelas não
// mexeram, não vale gastar banda.
func assinaturaDe(foto *snapshot) string {
	var sb strings.Builder
	for _, nome := range []string{"5m", "1h", "24h"} {
		j := foto.Janelas[nome]
		fmt.Fprintf(&sb, "%s:%d:%d:%d:%d;", nome, j.Total, j.Humano, j.Bot, j.Ataques)
	}
	fmt.Fprintf(&sb, "%d", foto.Lidos)
	return sb.String()
}

// handleBloquear é o botão de bloqueio MANUAL do painel. Não existe bloqueio
// automático por acúmulo de sinais: quem decide é o Pedro, aqui ou na linha de
// comando (scripts/defesa/bloquear.sh). O pedido só chega por causa do filtro
// de socket (loopback/LAN) aplicado em toda rota.
func (s *servidor) handleBloquear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusMethodNotAllowed)
		fmt.Fprintln(w, "405 — use POST com {\"ip\":\"...\",\"motivo\":\"...\"}")
		return
	}

	var pedido struct {
		IP     string `json:"ip"`
		Motivo string `json:"motivo"`
	}
	corpo := http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(corpo).Decode(&pedido); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintln(w, "400 — JSON inválido")
		return
	}

	ip := net.ParseIP(strings.TrimSpace(pedido.IP))
	if ip == nil || ip.IsUnspecified() {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintf(w, "400 — IP inválido: %q\n", pedido.IP)
		return
	}
	motivo := resumirMotivo(pedido.Motivo)

	script := filepath.Join(s.raiz, "scripts", "defesa", "bloquear.sh")
	if _, err := os.Stat(script); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, "500 — script ausente: %s (%v)\n", script, err)
		return
	}

	ctx, cancelar := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancelar()
	comando := exec.CommandContext(ctx, "/usr/bin/env", "bash", script, ip.String(), motivo)
	comando.Dir = s.raiz
	saida, err := comando.CombinedOutput()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	codificador := json.NewEncoder(w)
	codificador.SetIndent("", " ")
	if err != nil {
		log.Printf("bloqueio manual %s FALHOU: %v · %s", ip, err, strings.TrimSpace(string(saida)))
		w.WriteHeader(http.StatusInternalServerError)
		_ = codificador.Encode(map[string]any{
			"ok": false, "ip": ip.String(), "motivo": motivo,
			"erro": err.Error(), "saida": strings.TrimSpace(string(saida)),
		})
		return
	}
	log.Printf("BLOQUEIO MANUAL pelo painel: %s · %s", ip, motivo)
	_ = codificador.Encode(map[string]any{
		"ok": true, "ip": ip.String(), "motivo": motivo,
		"saida": strings.TrimSpace(string(saida)),
	})
}

// resumirMotivo corta o que não pode ir para a linha de comando e mantém o
// texto legível no Telegram e no estado.
func resumirMotivo(motivo string) string {
	limpo := strings.Join(strings.Fields(motivo), " ")
	limpo = strings.Map(func(r rune) rune {
		if r < 32 || r == '"' || r == '\'' || r == ';' || r == '$' || r == '`' {
			return ' '
		}
		return r
	}, limpo)
	limpo = strings.TrimSpace(limpo)
	if limpo == "" {
		return "manual pelo painel"
	}
	if len(limpo) > 120 {
		limpo = limpo[:120]
	}
	return limpo
}

// vigiarEstadoVigia relê o estado do vigia de ataques (bloqueios por IP).
func vigiarEstadoVigia(caminho string, c *coletor) {
	for {
		dados, err := os.ReadFile(caminho)
		if err == nil {
			var estado struct {
				Bloqueios map[string]json.RawMessage `json:"bloqueios"`
				Total     int                        `json:"total_bloqueios"`
				Ultima    string                     `json:"ultima_execucao"`
			}
			if json.Unmarshal(dados, &estado) == nil {
				ips := make([]string, 0, len(estado.Bloqueios))
				for ip := range estado.Bloqueios {
					ips = append(ips, ip)
				}
				c.mu.Lock()
				c.vigiaAtivo = len(estado.Bloqueios)
				c.vigiaTotal = estado.Total
				c.vigiaUltimaExec = estado.Ultima
				c.vigiaIPs = ips
				c.mu.Unlock()
			}
		}
		time.Sleep(10 * time.Second)
	}
}

// resolverEnderecos valida a lista: descarta 0.0.0.0 (nunca!) e, se o IP da LAN
// mudou (DHCP), cai para o IP atual da máquina dentro da rede autorizada.
func resolverEnderecos(lista string, rede *net.IPNet) ([]string, error) {
	saida := make([]string, 0, 2)
	vistos := map[string]bool{}
	lanAtual := ipNaRede(rede)

	for _, item := range strings.Split(lista, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		host, porta, err := net.SplitHostPort(item)
		if err != nil {
			log.Printf("AVISO: endereço %q inválido (use host:porta): %v", item, err)
			continue
		}
		ip := net.ParseIP(host)
		if ip == nil {
			log.Printf("AVISO: endereço %q sem IP: ignorado", item)
			continue
		}
		if ip.IsUnspecified() {
			// 0.0.0.0 abriria o painel para fora. Recusa explícita.
			log.Printf("AVISO: %q é 0.0.0.0 — recusado por política", item)
			continue
		}
		if !ipDaMaquina(ip) {
			if lanAtual == nil {
				log.Printf("AVISO: %s não existe nesta máquina e não achei IP em %s", ip, rede)
				continue
			}
			log.Printf("AVISO: %s não existe nesta máquina; uso o IP atual da LAN: %s", ip, lanAtual)
			ip = lanAtual
		}
		endereco := net.JoinHostPort(ip.String(), porta)
		if vistos[endereco] {
			continue
		}
		vistos[endereco] = true
		saida = append(saida, endereco)
	}
	if len(saida) == 0 {
		return nil, fmt.Errorf("lista vazia depois da validação: %q", lista)
	}
	return saida, nil
}

// ipDaMaquina diz se o IP existe numa interface desta máquina. Endereço que
// não existe não pode ser escutado, e trocar por um qualquer seria abrir porta
// em lugar que ninguém pediu.
func ipDaMaquina(ip net.IP) bool {
	if ip.IsLoopback() {
		return true
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		return false
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		enderecos, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, endereco := range enderecos {
			ipnet, ok := endereco.(*net.IPNet)
			if ok && ipnet.IP.Equal(ip) {
				return true
			}
		}
	}
	return false
}

func ipNaRede(rede *net.IPNet) net.IP {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		enderecos, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, endereco := range enderecos {
			ipnet, ok := endereco.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			if ip != nil && rede.Contains(ip) {
				return ip
			}
		}
	}
	return nil
}

func envOu(chave, padrao string) string {
	if valor := strings.TrimSpace(os.Getenv(chave)); valor != "" {
		return valor
	}
	return padrao
}
