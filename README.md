# eleicao2026-mapa

Mapa interativo da apuração presidencial 2026 — a página pública de
https://eleicao2026.belmino.dev

Duas rotas, sem login:

| Rota | O que é |
|---|---|
| `/` | home com o placar, regiões, fenômeno, insights, UFs, fontes e linha do tempo |
| `/mapa` | mapa MapLibre com drill-down país → UF → município → local de votação |

Tudo que aparece vem do feed público do TSE. Nada é estimado sem estar marcado
como estimativa.

## Arquitetura

```
navegador
   │  https://eleicao2026.belmino.dev        (Cloudflare, túnel nomeado)
   ▼
cloudflared  (hermes-tunel-belmino.service, ~/.cloudflared/belmino-eleicao.yml)
   │  http://127.0.0.1:8110
   ▼
nginx  (container web)      cabeçalhos, CSP, rate limit 40 req/s por IP, mirror da visita
   ├── /            → index.html (React SPA)
   └── /api/        → http://api:8080
                        │
                        ▼
                    Go (container api)   JSON: estados, municípios, zonas, locais, série,
                                          replay 2022, margens, saúde, configuração da fonte
                        │
                        ├── /dados (ro: JSON pré-gerado do TSE + malhas IBGE)
                        └── /metricas (SQLite de visitas anônimas, compartilhado com o painel Python)
```

- **Front**: React 19 + Vite + MapLibre GL. Build estático dentro do container
  `web`; o nginx serve `dist/`. Roteamento próprio (`web/src/router.jsx`), sem
  dependência de react-router.
- **API**: Go 1.24, biblioteca padrão + driver SQLite puro-Go. Carrega todos os
  dados no boot e responde só serialização — não consulta o TSE em tempo de
  requisição (exceto `/api/fonte`, que é diagnóstico e tem cache).
- **Dados**: pipeline TSE (dump de votação por seção) → `dados/municipios_<UF>.json`,
  `dados/secoes_<UF>.json`, `dados/publico.json`, `dados/eleicao_2022.json`,
  `dados/serie_presidente_2026.jsonl`, conferidos por candidato contra o JSON
  oficial da UF (diferença tem de ser 0).
- **Stack de teste**: o mesmo compose em outra porta (8100) e outro projeto
  (`eleicao2026-teste`), para provar antes de tocar em produção.

Volumes: `./dados` é montado somente-leitura em `/dados`;
`~/.hermes/painel_publico` é montado em `/metricas` (escrita, mesmo uid do dono).

## Operação

Todos os comandos rodam em `/home/pedro/eleicao2026-mapa`.

### Subir / atualizar a produção

```bash
docker compose -p eleicao2026-mapa up -d --build     # api + web em 127.0.0.1:8110
docker compose -p eleicao2026-mapa ps                # os dois têm de estar healthy
curl -s http://127.0.0.1:8110/api/health             # 200 e o turno correto
```

O serviço do túnel já está habilitado (`hermes-tunel-belmino.service`) e aponta
para 8110 — subir o compose é o suficiente.

### Stack de teste (nunca mexe em produção)

```bash
docker compose -p eleicao2026-teste -f compose.yaml -f compose.teste.yaml up -d --build
# front em 127.0.0.1:8100, API isolada no mesmo projeto
docker compose -p eleicao2026-teste down
```

`compose.teste.yaml` também aceita `APURACAO_DEMO=CE=78` para simular apuração
parcial. Produção **não** define essa variável.

### Atualizar os dados (durante a apuração)

```bash
cd /home/pedro/monitoramento-eleicoes-presidenciais-governo-ce
python3 coleta_presidente.py           # série da corrida presidencial no TSE
python3 snapshot_publico.py            # grava dados/publico.json (o que a home lê)

cd /home/pedro/eleicao2026-mapa
docker compose -p eleicao2026-mapa restart api     # a API carrega os dados no boot
curl -s http://127.0.0.1:8110/api/health | head -c 200
```

A `web` é estática: não precisa reiniciar quando só os dados mudam.
Para regerar o resultado de 2022 usado no replay:

```bash
python3 scripts/prepara_2022.py        # dados/eleicao_2022.json a partir do arquivo do TSE
```

### Trocar de turno (1º → 2º)

Eleição, turno e URLs são configuração, não código. No TSE cada turno é um
código de eleição próprio (2026: `6257` = 1º turno, `6258` = 2º turno), e todas
as URLs saem de `TSE_BASE` + `ELEICAO`:

```
{TSE_BASE}/{eleicao}/dados/{uf}/{uf}-c0001-e{eleicao:06d}-u.json
{TSE_BASE}/{eleicao}/fotos/{uf}/          (fotos oficiais dos candidatos)
```

Passo a passo:

```bash
# 1. edite o .env do projeto (0600, fora do git)
#    ELEICAO=6258
#    TURNO=2
#    TSE_BASE=https://resultados.tse.jus.br/oficial/ele2026
#    TSE_PORTAL=https://resultados.tse.jus.br/
# 2. recrie só o container da API (o env é lido no boot)
docker compose -p eleicao2026-mapa up -d api
# 3. confirme que o serviço está no turno certo
curl -s http://127.0.0.1:8110/api/health    # {"eleicao":"6258","turno":"2",...}
curl -s http://127.0.0.1:8110/api/config    # URLs derivadas do turno
curl -s http://127.0.0.1:8110/api/fonte     # 200 se o arquivo nacional existe no TSE
```

O front não tem nada fixo de turno: rótulo, código e avisos saem de
`/api/estados` e `/api/home`. Trocar só o `.env` muda a interface inteira.

Configuração inválida (turno `3`, eleição com letra, URL relativa) **não** sobe:
o processo sai com código 1 e uma linha explicando o campo errado — sem stack.

Prova automatizada da troca (sobe com 2º turno apontando para URL falsa e exige
falha limpa, sem tela branca e sem panic):

```bash
scripts/provas/turno_configuravel.sh                   # URL falsa, porta 8123
scripts/provas/turno_configuravel.sh --com-url-real    # 2º turno no TSE de verdade
```

### Rollback

**Do app** — as imagens anteriores ficam tagueadas `:rollback`:

```bash
docker tag eleicao2026-mapa-api:rollback eleicao2026-mapa-api:latest
docker tag eleicao2026-mapa-web:rollback eleicao2026-mapa-web:latest
docker compose -p eleicao2026-mapa up -d --no-build --force-recreate
```

**Do túnel** — se o app novo der problema, o painel Python (8099) volta a ser a
origem sem parar o site:

```bash
# em ~/.cloudflared/belmino-eleicao.yml, no bloco do hostname eleicao2026.belmino.dev:
#   service: http://127.0.0.1:8099          (era http://127.0.0.1:8110)
systemctl --user restart hermes-tunel-belmino.service
curl -s -o /dev/null -w '%{http_code}\n' https://eleicao2026.belmino.dev/
```

Para voltar ao app: `service: http://127.0.0.1:8110` e reiniciar o mesmo serviço.
O log do túnel fica em `~/.hermes/logs/tunel-belmino.log`.

## Dia da eleição — checklist

**08h00 — antes de o TSE publicar**

1. `docker compose -p eleicao2026-mapa ps` → `api` e `web` **healthy**.
2. `curl -s http://127.0.0.1:8110/api/health` → `ok:true`, `turno` do dia, `ufs:27`.
3. `curl -s http://127.0.0.1:8110/api/config` → `eleicao`/`turno`/URLs do turno certo.
4. `curl -s http://127.0.0.1:8110/api/fonte` → **200**. Se 503, o TSE ainda não
   publicou o arquivo do turno: é esperado antes do fim da votação, não é defeito
   do painel.
5. `curl -s -o /dev/null -w '%{http_code}\n' https://eleicao2026.belmino.dev/` → 200.
6. Abrir `/` e `/mapa` no celular: home carrega, mapa abre, e com WebGL bloqueado
   a tabela de fallback aparece.

**Fim da votação em diante — apuração**

- A cada 30–60 min: `python3 coleta_presidente.py && python3 snapshot_publico.py`
  e `docker compose restart api`. Sem isso a home congela no último retrato.
- Conferir se `pct_apurado` nacional sobe: `curl -s .../api/estados | head -c 300`.
- 503 em `/api/fonte` por mais de 20 min com o TSE já publicando é sinal de
  URL/configuração errada — volte a configuração anterior e reinicie (`up -d api`).

**Se o TSE atrasar**

- `/api/fonte` responde 503 com o motivo (`HTTP 404`, `inacessível: timeout`).
  O site continua 200 e mostra o último retrato + o aviso de "apuração ainda não
  começou no TSE" (a home já tem esse bloco).
- Não mexer em `ELEICAO`/`TURNO` para "forçar" dado: código de turno errado só
  troca 404 por 404.
- Se o volume de visitas cair a zero sem o site cair, olhar o túnel:
  `systemctl --user status hermes-tunel-belmino.service` e
  `tail -50 ~/.hermes/logs/tunel-belmino.log`.

**Trocar de turno no dia (se houver 2º turno)**

1. `.env` com `ELEICAO=6258` e `TURNO=2` (as URLs saem daí).
2. `docker compose -p eleicao2026-mapa up -d api`.
3. `/api/health` com `turno:"2"`, `/api/config` com `.../6258/...`, `/api/fonte` 200.
4. `python3 coleta_presidente.py` detecta 6258 sozinho; o snapshot seguinte passa
   a trazer os candidatos do 2º turno.

**Depois**

- `docker compose -p eleicao2026-mapa logs --tail 100 api` sem 500 nem panic.
- `_provas/` guarda os prints do dia (desktop e celular, com e sem WebGL).

## Endpoints públicos

| Rota | Conteúdo |
|---|---|
| `/api/health` | `ok`, `eleicao`, `turno`, `gerado_em`, nº de UFs e features |
| `/api/config` | eleição, turno, rótulo, `TSE_BASE`, portal e URLs derivadas |
| `/api/fonte` | diagnóstico da fonte oficial: 200 se o arquivo existe, 503 com motivo |
| `/api/estados` | apuração por UF |
| `/api/home` | `publico.json` + eleição e turno |
| `/api/ufs.geojson` | malha das UFs com líder e margem |
| `/api/uf/{UF}/municipios`, `/zonas`, `/locais` (+ `.geojson`) | drill-down |
| `/api/serie2022`, `/api/replay`, `/api/margens` | histórico e comparação |
| `/api/estados/identidade` | identidade visual por estado |

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
rotas e o Go omite o token na linha de log.

**Visitas anônimas** — o nginx espelha a abertura da página (`mirror /_visita`) para a API, que
grava no MESMO `visitas.db` do painel Python (`~/.hermes/painel_publico`, montado em `/metricas`).
Mesmo sal, mesmo `sha256(sal|dia|ip)[:32]`, mesmo GeoIP (DB-IP local), mesmo filtro de robô.
Nenhum IP é gravado, logado ou devolvido; o histórico existente é preservado.

## Fontes, créditos e privacidade

- **Dados eleitorais**: Tribunal Superior Eleitoral — arquivos públicos de
  resultado por UF (`resultados.tse.jus.br`), sem intermediação.
- **Malhas**: IBGE (municípios e UFs).
- **Mapa base**: © OpenStreetMap contributors, tiles © CARTO.
- **Privacidade**: sem cookies, sem IP, sem rastreamento. A contagem de visitas
  é anônima (hash do dia). Nenhum dado de eleitor é coletado ou exibido.

O rodapé de ambas as rotas repete esses créditos (`web/src/components/Rodape.jsx`).

## Provas

```bash
cd web && npm run build                 # build do front
cd api && go test ./...                 # suíte da API (leva ~6 min: carrega os dados por teste)
NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
  node scripts/provas/auditoria.mjs --base http://127.0.0.1:8100 --out _provas
NODE_PATH=/home/pedro/.hermes/hermes-agent/node_modules \
  node scripts/provas/captura.mjs --base http://127.0.0.1:8100 --out _provas --prefix prova
```

`auditoria.mjs` percorre todas as rotas em 390x844 e 1440x900, com e sem WebGL,
e reprova se houver scroll horizontal, área de toque menor que o mínimo, print
sem conteúdo, erro de console ou request falho. `captura.mjs` cobre o
drill-down UF → município → local de votação com clique real.

## Estado

Fase 1: dados de município e seção do Ceará fechando com o TSE (184 municípios,
23.765 seções, diferença 0 votos).

Fase 2 (22/10/2026): app Go+React no ar em `docker compose` — API na 8080
interna, front na `127.0.0.1:8110`, publicado em https://eleicao2026.belmino.dev
pelo túnel nomeado (o painel Python em 8099 continua no ar como rollback).
Provas em `_provas/` (desktop 1440x900 e mobile 390x844, com e sem WebGL).
