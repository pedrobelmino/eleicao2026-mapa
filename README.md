# eleicao2026-mapa

Mapa interativo da apuração presidencial 2026 — subpágina de https://eleicao2026.belmino.dev

## Arquitetura

- **Backend Go**: API JSON (estados, municípios, seções/urnas, série da apuração, margens).
- **Frontend React + Vite + MapLibre GL**: zoom país → estado → cidade → urna, animação da apuração,
  visão "de onde está ganhando", cartão de identidade por estado.
- **docker compose**: sobe front, back e o renderer prettymaps; exposto em 127.0.0.1:8110 e proxeado
  pelo servidor da home (`/mapa`).
- **Dados**: pipeline TSE (dump de votação por seção) → `municipios.json` / `secoes_<UF>.json`,
  conferidos por candidato contra o JSON oficial da UF (diferença tem de ser 0).

## Segurança e observabilidade

**Borda (nginx, 127.0.0.1:8110)** — HSTS, CSP, nosniff, `Referrer-Policy`,
`X-Frame-Options`, `Permissions-Policy`, `Server` sem versão, `autoindex off`, 404 seco para
`.git`/`.env`/`/dados/`/fonte e banco, corpo limitado a 8 KB (413), `limit_req` 40 req/s por IP
com rajada de 200 e `limit_conn` 40 (429 em JSON).

**API (Go)** — segunda barreira: token bucket por IP (40/s, rajada 120), teto de 256 requisições
simultâneas e 24 por IP, validação de URI/parâmetros (414/400), whitelist de parâmetro por rota
(`modo`, `cd`), só GET/HEAD (405), 404/500 em JSON sem stack. Ajuste por env:
`RATE_TAXA_POR_IP`, `RATE_RAJADA_POR_IP`, `LIMITE_SIMULTANEAS`, `LIMITE_SIMULTANEAS_POR_IP`.

**Bateria de ataque** (não altera estado; sai 1 se algo falhar):

```bash
scripts/seguranca/teste_ataques.sh                      # contra 127.0.0.1:8110
scripts/seguranca/teste_ataques.sh http://127.0.0.1:8100  # contra a stack de teste
```

Cobre flood (429), injeção SQL/JS em caminho e parâmetro, path traversal, injeção de cabeçalho por
CRLF, payload de 2 MB, métodos não permitidos, acesso direto a arquivo de dados, listagem de
diretório, 404 sem stack e o painel privado. O flood é o último caso de propósito: ele satura o
balde do próprio IP.

**Painel privado de métricas** (acessos, latência p50/p95/p99, erros, recusas do limitador, saúde
da stack e visitas anônimas):

```
GET /api/interno/metricas   # JSON
GET /api/interno/painel     # HTML, recarrega a cada 20 s
```

Credencial em `METRICAS_TOKEN` (arquivo `.env`, 0600, fora do git). Sem credencial → 401, token
errado → 403, sem token configurado → 403 (falha fechada). O nginx não registra acesso a essas
rotas e o Go omite o token na linha de log. Cloudflare Access no subdomínio admin fica para a
próxima etapa (falta token da API).

**Visitas anônimas** — o nginx espelha a abertura da página (`mirror /_visita`) para a API, que
grava no MESMO `visitas.db` do painel Python (`~/.hermes/painel_publico`, montado em `/metricas`).
Mesmo sal, mesmo `sha256(sal|dia|ip)[:32]`, mesmo GeoIP (DB-IP local), mesmo filtro de robô.
Nenhum IP é gravado, logado ou devolvido; o histórico existente é preservado.

## Eleição e turno são parâmetro

O sistema roda com o 1º turno hoje. No dia da eleição troca-se a origem para o 2º turno no TSE via
configuração — sem editar código.

## Privacidade e dados

Dados públicos do TSE. Nenhum dado de eleitor. Visitas do painel são anônimas (sem cookie, sem IP).

## Estado

Fase 1 concluída no painel Python: dados de município e seção do Ceará fechando com o TSE
(184 municípios, 23.765 seções, diferença 0 votos).

Fase 2 (22/10/2026): app Go+React no ar em `docker compose` — API na 8080 interna, front na
`127.0.0.1:8110`, publicado em https://eleicao2026.belmino.dev/mapa/ pelo proxy do painel Python
(8099). Mapa MapLibre com coroplético por UF, zoom/pan/pinch, hover e cartão por estado.
Provas em `_provas/` (desktop 1440x900 e mobile 390x844, local e público).

```bash
docker compose up -d --build          # sobe api + web (127.0.0.1:8110)
cd api && go test ./...               # 3 testes da API
cd web && npm run build               # build do front (base /mapa/)
```
