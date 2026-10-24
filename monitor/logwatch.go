package main

// Leitura do log de defesa do nginx (var/defesa/acessos.log) em modo "tail":
// offset guardado em memória, releitura a cada meio segundo, tolerância a
// truncamento (o vigia corta o arquivo em 5 MB) e a linha pela metade.
//
// Duas gerações de formato convivem no MESMO arquivo:
//
//	antiga (5 campos): IP TS STATUS METODO URI
//	nova   (8 campos): IP TS STATUS METODO URI HOST BLOQUEADO "REQUISIÇÃO CRUA" UA...
//
// A linha antiga continua válida: host vira "?" e o alvo é o próprio caminho.
// Nada é inventado para preencher o que não foi registrado.

import (
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// evento é uma linha do log já interpretada.
type evento struct {
	IP        string
	Quando    time.Time
	Status    int
	Metodo    string
	Caminho   string // sem query ($uri)
	Host      string // "?" quando a linha é anterior ao campo host
	Bloqueado bool   // 1 no campo do geo (IP já na lista do vigia)
	Alvo      string // requisição crua, com query (campo entre aspas)
	UA        string
	Bot       bool   // assinatura de user-agent (mesmo critério da contagem anônima)
	Ataque    string // tipo do ataque, "" quando não é ataque
	Canario   bool   // /healthz do próprio docker: não é visitante
	// IPNaoResolvido marca a linha em que o nginx respondeu 400 antes de
	// resolver o IP real (caminho com ".." é rejeitado no parse da linha de
	// requisição, antes do real_ip). Nesses casos o socket mostra o gateway do
	// docker, não o visitante — o painel diz "não resolvido" em vez de mentir.
	IPNaoResolvido bool
}

// hospedeiroDesconhecido é o rótulo das linhas gravadas antes do campo host.
const hospedeiroDesconhecido = "?"

// ipNaoResolvido é o rótulo para o IP que a borda não chegou a resolver.
const ipNaoResolvido = "não resolvido"

// parseLinha interpreta uma linha crua. ok=false para linha vazia/lixo.
//
// O formato tem 7 colunas fixas + a requisição crua entre aspas + UA (que tem
// espaço). A coluna $uri PODE ter espaço (o nginx não escapa espaço com
// escape=default), então contar token na posição 5 é o que errava: numa linha
// `… 404 GET /api/uf/SP' OR 1=1/municipios …` o "host" virava "OR". A leitura
// agora ANCORA nas colunas que têm forma previsível: o campo entre aspas
// delimita o alvo, e as duas colunas à esquerda dele são host e bloqueado.
func parseLinha(linha string) (evento, bool) {
	linha = strings.TrimRight(linha, "\r\n")
	if strings.TrimSpace(linha) == "" {
		return evento{}, false
	}

	var (
		campos []string // colunas fixas, antes da requisição crua
		alvo   string
		ua     string
	)

	if aspa := strings.IndexByte(linha, '"'); aspa >= 0 {
		// formato atual: alvo entre aspas, UA depois do fechamento
		alvo, ua = separarCampoCitado(linha[aspa:])
		campos = strings.Split(strings.TrimSuffix(linha[:aspa], " "), " ")
		if n := len(campos); n >= 6 && ehCampoBloqueado(campos[n-1]) {
			// URI pode ter engolido espaço: host/bloqueado são as duas últimas
			uri := campos[4 : n-2]
			ev := evento{
				IP:      campos[0],
				Metodo:  campos[3],
				Caminho: strings.Join(uri, " "),
				Host:    campos[n-2],
				Alvo:    alvo,
				UA:      ua,
			}
			ev.Bloqueado = campos[n-1] == "1"
			if codigo, err := strconv.Atoi(campos[2]); err == nil {
				ev.Status = codigo
			}
			if instante, err := time.Parse(time.RFC3339, campos[1]); err == nil {
				ev.Quando = instante
			}
			return finalizarEvento(ev)
		}
	} else {
		campos = strings.Split(linha, " ")
		// geração sem aspas, com host/bloqueado: 8ª coluna é o alvo, o resto é UA
		if n := len(campos); n >= 8 && ehCampoBloqueado(campos[6]) {
			alvo = campos[7]
			ua = strings.Join(campos[8:], " ")
			ev := evento{
				IP:      campos[0],
				Metodo:  campos[3],
				Caminho: campos[4],
				Host:    campos[5],
				Alvo:    alvo,
				UA:      ua,
			}
			ev.Bloqueado = campos[6] == "1"
			if codigo, err := strconv.Atoi(campos[2]); err == nil {
				ev.Status = codigo
			}
			if instante, err := time.Parse(time.RFC3339, campos[1]); err == nil {
				ev.Quando = instante
			}
			return finalizarEvento(ev)
		}
	}

	// geração antiga (5 colunas: IP TS STATUS METODO URI), podendo haver
	// espaço dentro da URI: aí tudo depois do método é caminho.
	campos = strings.Split(linha, " ")
	// as gerações antigas fecham a linha com "- -" (host/bloqueado ausentes):
	// não fazem parte do caminho.
	for len(campos) > 5 && campos[len(campos)-1] == "-" {
		campos = campos[:len(campos)-1]
	}
	if len(campos) < 5 {
		return evento{}, false
	}
	ev := evento{
		IP:      campos[0],
		Metodo:  campos[3],
		Caminho: strings.Join(campos[4:], " "),
	}
	if codigo, err := strconv.Atoi(campos[2]); err == nil {
		ev.Status = codigo
	}
	if instante, err := time.Parse(time.RFC3339, campos[1]); err == nil {
		ev.Quando = instante
	}
	return finalizarEvento(ev)
}

// ehCampoBloqueado: a 7ª coluna é 0, 1 ou "-" (linha anterior ao campo).
func ehCampoBloqueado(texto string) bool {
	return texto == "0" || texto == "1" || texto == "-"
}

// finalizarEvento aplica os valores padrão e a classificação comum.
func finalizarEvento(ev evento) (evento, bool) {
	// status não numérico ou instante inválido = linha lixo, não evento.
	if ev.Quando.IsZero() || ev.Status == 0 {
		return evento{}, false
	}
	if ev.Host == "" || ev.Host == "-" {
		ev.Host = hospedeiroDesconhecido
	}
	if ev.Alvo == "" {
		ev.Alvo = ev.Caminho
	}

	// 400 com caminho vazio: o nginx recusou a linha de requisição antes do
	// real_ip (a URI vira o campo vazio e o host cai no default "_" ou no
	// "-" das linhas antigas). O IP que sobrou no log é o do socket — o
	// gateway do docker —, não o do visitante: o painel diz "não resolvido"
	// em vez de culpar a infra.
	if ev.Caminho == "" && (ev.Host == "_" || ev.Host == hospedeiroDesconhecido) {
		ev.IPNaoResolvido = true
		ev.IP = ipNaoResolvido
	}

	ev.Bot = ehBot(ev.UA)
	ev.Canario = ehCanario(ev.Caminho)
	ev.Ataque = classificar(&ev)
	return ev, true
}

// separarCampoCitado lê o campo entre aspas (a requisição crua) e devolve o
// resto da linha como user-agent. Aspas escapadas (\") fazem parte do valor.
func separarCampoCitado(resto string) (string, string) {
	resto = strings.TrimLeft(resto, " ")
	if !strings.HasPrefix(resto, "\"") {
		// Geração antiga, sem aspas no campo da requisição: o alvo é o
		// PRIMEIRO token e o UA é o resto. Ler o campo inteiro como alvo
		// jogava o UA para dentro do alvo e deixava o UA vazio — o que
		// gerava "ua_anomalo" em linha que tinha navegador de verdade.
		if resto == "" || resto == "-" {
			return "", ""
		}
		if i := strings.IndexByte(resto, ' '); i >= 0 {
			return resto[:i], strings.TrimSpace(resto[i+1:])
		}
		return resto, ""
	}

	var sb strings.Builder
	for i := 1; i < len(resto); i++ {
		switch {
		case resto[i] == '\\' && i+1 < len(resto):
			i++
			switch resto[i] {
			case 'n':
				sb.WriteByte('\n')
			case 't':
				sb.WriteByte('	')
			case 'x':
				if i+2 < len(resto) {
					if valor, err := strconv.ParseUint(resto[i+1:i+3], 16, 8); err == nil {
						sb.WriteByte(byte(valor))
						i += 2
						continue
					}
				}
				sb.WriteByte('x')
			default:
				sb.WriteByte(resto[i])
			}
		case resto[i] == '"':
			return sb.String(), strings.TrimSpace(resto[i+1:])
		default:
			sb.WriteByte(resto[i])
		}
	}
	// sem fechamento (linha truncada): devolve o que deu
	return sb.String(), ""
}

func ehCanario(caminho string) bool {
	return caminho == "/healthz" || caminho == "/healthz/"
}

// leitorLog acompanha o arquivo. Uma goroutine só (o painel é uma leitura).
type leitorLog struct {
	caminho  string
	offset   int64
	parcial  []byte
	aoEvento func(evento)
	aoReset  func()
}

func novoLeitor(caminho string, aoEvento func(evento), aoReset func()) *leitorLog {
	return &leitorLog{caminho: caminho, aoEvento: aoEvento, aoReset: aoReset}
}

// passo lê o que apareceu desde a última chamada. Devolve quantas linhas entrou.
func (l *leitorLog) passo() int {
	info, err := os.Stat(l.caminho)
	if err != nil {
		return 0
	}
	tamanho := info.Size()

	if tamanho < l.offset {
		// truncado (vigia corta em 5 MB): recomeça do zero
		l.offset = 0
		l.parcial = nil
		if l.aoReset != nil {
			l.aoReset()
		}
	}
	if tamanho == l.offset {
		return 0
	}

	arquivo, err := os.Open(l.caminho)
	if err != nil {
		return 0
	}
	defer arquivo.Close()

	if _, err := arquivo.Seek(l.offset, io.SeekStart); err != nil {
		return 0
	}
	bruto, err := io.ReadAll(arquivo)
	if err != nil {
		return 0
	}
	l.offset = tamanho

	if len(l.parcial) > 0 {
		bruto = append(l.parcial, bruto...)
		l.parcial = nil
	}
	// linha sem \n no fim é escrita em andamento: guarda para o próximo passo
	if corte := lastIndexByte(bruto, '\n'); corte >= 0 {
		l.parcial = append([]byte(nil), bruto[corte+1:]...)
		bruto = bruto[:corte+1]
	} else {
		l.parcial = append([]byte(nil), bruto...)
		return 0
	}

	linhas := 0
	for _, crua := range strings.Split(string(bruto), "\n") {
		if ev, ok := parseLinha(crua); ok {
			l.aoEvento(ev)
			linhas++
		}
	}
	return linhas
}

func lastIndexByte(dados []byte, alvo byte) int {
	for i := len(dados) - 1; i >= 0; i-- {
		if dados[i] == alvo {
			return i
		}
	}
	return -1
}
