# AGENTS.md — eleicao2026-mapa

Mapa interativo da apuração presidencial 2026, no ar em https://eleicao2026.belmino.dev. Duas rotas
públicas, sem login: `/` (placar, regiões, fenômeno, insights, UFs, fontes, linha do tempo) e `/mapa`
(MapLibre com drill-down país → UF → município → local de votação). Todo número vem do feed público
do TSE; estimativa só aparece marcada como estimativa.

## Stack (lida de api/go.mod, web/package.json, Dockerfiles e compose.yaml)

- Go 1.24.0; build em `golang:alpine`, runtime em `alpine:3.20` (tags flutuantes, sem digest)
- API com biblioteca padrão + `modernc.org/sqlite` 1.44.3 (SQLite puro-Go, `CGO_ENABLED=0`) e
  `oschwald/maxminddb-golang` 1.13.1 (GeoIP local). Sem framework HTTP.
- Front: React 19.3.1, `react-dom` 19.3.1, MapLibre GL 5.24.0, Vite 8.3.5 (`@vitejs/plugin-react` 6.1.2);
  sem `react-router`, roteamento próprio em `web/src/router.jsx`
- Build do front em `node:22-alpine` (`npm ci` + `npm run build`), servido por `nginx:alpine`
- Host medido: Go 1.26.0, Node v22.22.1, Compose v5.5.1 (o override de teste exige >= 2.24 pelo `!override`)

## Comandos

- subir/atualizar produção: `docker compose -p eleicao2026-mapa up -d --build`
- estado e saúde: `docker compose -p eleicao2026-mapa ps` (`api` e `web` healthy) e
  `curl -s http://127.0.0.1:8110/api/health`
- stack de teste (projeto e porta separados):
  `docker compose -p eleicao2026-teste -f compose.yaml -f compose.teste.yaml up -d --build`
- build da API: `cd api && go build .` (gera `api/api`, ignorado pelo git) — compila
- build do front: `cd web && npm run build` (saída em `web/dist`, ignorada pelo git) — compila
- testar a API: `cd api && go test ./...` (~6 min: cada teste carrega os dados)
- testar o front e lint: não existem no projeto (`package.json` só tem `dev`, `build`, `preview`)
- regressão de UI: `bash scripts/regressao/regressao.sh --rapido` (6 itens, ~8 min)
- ataques: `bash scripts/seguranca/teste_ataques.sh` (não altera estado; exit 1 se algo falhar)
- provas `scripts/provas/*.mjs`: exigem `NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules`

## Estrutura

- `api/` — Go: `main.go` (rotas e boot), `seguranca.go` (token bucket, limites), `metricas.go` e
  `painel_metricas.go`; testes `*_test.go` ao lado de cada arquivo
- `web/` — React/Vite: `src/`, `public/`, `nginx.conf` (borda, CSP, rate limit), `Dockerfile`
- `web/src/components/` — mapa, placar, cards, rodapé; `web/src/pages/` — `Home`, `Mapa`, `Landing`
- `dados/` — JSON pré-gerado do TSE + malhas IBGE (55 MB), montado somente-leitura em `/dados`
- `scripts/` — pipeline: `prepara_2022.py`, `fotos_*.py`, `coleta_apuracao.sh`, `turno_vigia.py`
- `scripts/provas/` — Playwright; `scripts/regressao/` — runner + `CHECKLIST.json`; `scripts/seguranca/` — ataques
- `_provas/` — prints e `resultado.json` das rodadas (181 MB no disco)

## Regras

- Portas: front só em `127.0.0.1:8110`; API na `8080` interna, sem `ports:`. Não publicar 8110 em
  `0.0.0.0` nem abrir a 8080 — o túnel é a única porta de entrada.
- Túnel: `hermes-tunel-belmino.service` (`~/.cloudflared/belmino-eleicao.yml`) aponta para 8110.
  O hostname é `eleicao2026.belmino.dev` — singular, não `eleicoes`.
- `.env` (0600) fica fora do git e é o único lugar do `METRICAS_TOKEN`. Sem token a rota privada
  responde 403 (falha fechada); o token não vai para código, log nem README.
- `./dados` entra como `:ro`: dado se gera pelos scripts, não à mão dentro do container.
- Não mexer em `ELEICAO`/`TURNO` para "forçar" dado: turno errado só troca 404 por 404.

## Pegadinhas reais

- Ordem de subida: `web` tem `depends_on: api: condition: service_healthy` — subir só o front trava.
- O nginx resolve `api` no boot. Recriar a API (`up -d api`) dá IP novo e o proxy fica no antigo:
  depois de recriar, `docker compose -p eleicao2026-mapa exec -T web nginx -s reload`.
- A API carrega os JSON no boot: `publico.json` novo sem `restart api` não aparece. A `web` é estática.
- O `/mapa` precisa do dado municipal/urna coletado antes: município, zona e local saem do dump por
  seção do TSE, um arquivo por UF publicado ao fim do turno. No 2º turno não existe dado municipal
  do 2º turno — a API devolve `municipal.aviso`/`dados_aviso` e o rodapé mostra a linha "Atenção".
- `/api/fonte` 503 antes de o TSE publicar é esperado, não defeito: o site segue 200 com o último
  retrato e o aviso de que a apuração não começou.
- O container `api` roda com o uid do dono (`UID_PAINEL`): como root, ele cria arquivo em
  `~/.hermes/painel_publico` e quebra a escrita do painel Python em 8099.
- `nginx:alpine` é tag flutuante (o comentário do `nginx.conf` fala em 1.29): builds diferentes,
  nginx possivelmente diferente.
- `_provas/regressao/<AAAAMMDD-HHMM>/` não está no `.gitignore`: cada rodada aparece como untracked.
