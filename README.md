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
nginx  (container web)      cabeçalhos, CSP, rate limit 40 req/s por IP, mirror da visita,
   │                        lista de bloqueio por IP (geo) e log de defesa
   ├── /            → index.html (React SPA)
   └── /api/        → http://api:8080
                        │
                        ▼
                    Go (container api)   JSON: estados, municípios, zonas, locais, série,
                                          replay 2022, margens, saúde, configuração da fonte
                        │
                        ├── /dados (ro: JSON pré-gerado do TSE + malhas IBGE)
                        ├── /metricas (SQLite de visitas anônimas, compartilhado com o painel Python)
                        └── /defesa (ro: estado do vigia de ataques, para o painel)

painel privado (SÓ 127.0.0.1:8112)
   │  nginx `listen 8081`, servidor separado, mesmo container
   └── /api/interno/ → http://api:8080/api/interno/   (sem token: é local)
```

Dois `server` no nginx, e isso é requisito duro: o site público (`listen 80`,
publicado em `127.0.0.1:8110`) responde **404** em `/api/interno/*` mesmo com
token válido; o painel existe apenas no `listen 8081`, publicado em
`127.0.0.1:8112`, porta que o túnel não conhece. Isolamento por porta, não por
token — a liberação sem token se apoia nesse isolamento (ver abaixo).

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

Todos os comandos rodam na raiz do repositório — nos exemplos, `~/eleicao2026-mapa` (ajuste ao seu caminho).

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
cd ~/monitoramento-eleicoes-presidenciais-governo-ce
python3 coleta_presidente.py           # série da corrida presidencial no TSE
python3 snapshot_publico.py            # grava dados/publico.json (o que a home lê)

cd ~/eleicao2026-mapa
docker compose -p eleicao2026-mapa restart api     # a API carrega os dados no boot
curl -s http://127.0.0.1:8110/api/health | head -c 200
```

A `web` é estática: não precisa reiniciar quando só os dados mudam.
Para regerar o resultado de 2022 usado no replay:

```bash
python3 scripts/prepara_2022.py        # dados/eleicao_2022.json a partir do arquivo do TSE
```

### Trocar de turno (1º → 2º) — AUTOMÁTICO desde 24/10/2026

Eleição, turno e URLs são configuração, não código. No TSE cada turno é um
código de eleição próprio (2026: `6257` = 1º turno, `6258` = 2º turno), e todas
as URLs saem de `TSE_BASE` + `ELEICAO`:

```
{TSE_BASE}/{eleicao}/dados/{uf}/{uf}-c0001-e{eleicao:06d}-u.json
{TSE_BASE}/{eleicao}/fotos/{uf}/          (fotos oficiais dos candidatos)
```

**Quem vira agora é o vigia, não a mão.** O timer
`hermes-eleicao-turno.timer` (systemd --user) chama
`scripts/turno_vigia.py` a cada 10 min no dia da eleição e a cada 60 min fora dele
(a cadência é decidida pelo próprio script, em `~/.hermes/eleicao_turno/config.json`).

O que ele faz quando o 6258 passa a ter voto publicado (soma de `vap` > 0):

```bash
# 1. backup do .env ao lado (.env.bak-turno-AAAAMMDD-HHMMSS, 0600)
# 2. grava ELEICAO=6258 e TURNO=2 no .env
# 3. docker compose -p eleicao2026-mapa up -d api        (a web NÃO é recriada)
#    + docker compose exec -T web nginx -s reload        (o proxy resolve "api" no boot)
# 4. valida pela rota pública, como o usuário vê:
#      /api/health  -> 200 com turno=2 e eleicao=6258
#      /api/config  -> url_nacional .../6258/dados/br/br-c0001-e006258-u.json
#      /api/fonte   -> 200
# 5. avisa no Telegram (sucesso). Se QUALQUER validação falhar:
#    volta o .env do backup, sobe a api de novo, valida a volta e avisa o erro
#    no Telegram com o log. Nunca fica meio virado.
```

Idempotência: com o `.env` já no 6258 o script sai sem tocar em nada
(estado em `~/.hermes/eleicao_turno/estado.json`) e **nunca vira de volta**.
Rodar 10 vezes seguidas não muda nada depois da primeira.

Ensaiar a virada sem tocar em produção (TSE e API de mentira + `.env` falso em
diretório temporário; confere no fim que o `.env` real tem o mesmo hash):

```bash
python3 scripts/turno_vigia.py --ensaio          # cenário sucesso + falha (rollback)
python3 scripts/turno_vigia.py --forcar          # checagem real agora, ignorando a cadência
```

**Desligar o automático** (o painel fica como está, sem virar sozinho):

```bash
systemctl --user disable --now hermes-eleicao-turno.timer   # para de checar
systemctl --user disable --now hermes-eleicao-coleta.timer  # para de coletar
```

**Reverter à mão** (volta ao 1º turno ou desfaz uma virada):

```bash
ls -1 ~/eleicao2026-mapa/.env.bak-turno-*        # backups das viradas
cp ~/eleicao2026-mapa/.env.bak-turno-AAAAMMDD-HHMMSS ~/eleicao2026-mapa/.env
docker compose -p eleicao2026-mapa up -d api
docker compose -p eleicao2026-mapa exec -T web nginx -s reload
curl -s http://127.0.0.1:8110/api/health                   # turno esperado
# e limpe o estado para o vigia poder agir de novo:
rm ~/.hermes/eleicao_turno/estado.json
```

**Logs:**

| o quê | onde |
|---|---|
| vigia de turno (script) | `~/.hermes/logs/eleicao-turno-vigia.log` |
| vigia no systemd | `journalctl --user -u hermes-eleicao-turno -n 100` |
| coleta + publicação | `~/.hermes/logs/eleicao-coleta.log` |
| coleta no systemd | `journalctl --user -u hermes-eleicao-coleta -n 100` |
| api (dentro do container) | `docker compose -p eleicao2026-mapa logs api --tail 100` |

### Coleta automática durante a apuração

`hermes-eleicao-coleta.timer` roda `scripts/coleta_apuracao.sh` a cada 10 min.
Fora do dia da eleição (e das 36 h seguintes) o script sai na primeira linha, sem
tocar no TSE. No dia ele:

1. roda `coleta_presidente.py` e `snapshot_publico.py` no repositório do painel
   (os dois têm detecção automática de turno: usam o 6258 só quando ele tem voto);
2. **só publica** se o snapshot for da MESMA eleição que o `.env` do site. Snapshot
   de outro turno, ou com `sem_dado=true`, não sobrescreve o dado do site;
3. reinicia a api (ela carrega `publico.json` em memória no boot) e confere
   `/api/health` com o `gerado_em` do arquivo novo.

### O dado municipal/urna do 2º turno (limite conhecido, com aviso na tela)

Município, zona e local de votação **não** saem do JSON de resultados: saem do dump
aberto por seção (`votacao_secao_2026_<UF>.zip`, CDN do TSE), que é **um arquivo por
UF, atualizado "ao final de cada turno"** (descrição oficial do recurso). Medido em
24/10/2026: o dump tinha 2.584.325 linhas, todas `NR_TURNO=1`, geradas em 06/10/2026.
Ou seja: **durante a apuração do 2º turno não existe dado municipal do 2º turno** —
e o JSON por UF (`-u.json`) só publica agregado por partido, sem município (`-m`,
`-v`, `-b` respondem 404).

Por isso a API carrega a procedência declarada dentro dos arquivos
(`eleicao`, `turno`) e devolve em `/api/estados` e `/api/config`:

- `municipal.aviso` — preenchido quando `municipios_<UF>.json`/`secoes_<UF>.json`
  são de outro turno;
- `dados_aviso` — o mesmo para o snapshot nacional/UF (`publico.json`).

Quando qualquer um dos dois existe, o rodapé do mapa mostra a linha
**Atenção** dizendo de que turno é o dado. Número de um turno com rótulo de outro
nunca aparece sem essa linha.

Prova da tela (abre o /mapa num stack de teste com `ELEICAO=6258 TURNO=2` e confere
que o aviso aparece escrito, e que o da API é o mesmo da tela):

```bash
docker compose -p eleicao2026-teste -f compose.yaml -f compose.teste.yaml \
  up -d --build api web            # com ELEICAO=6258 TURNO=2 no ambiente
NODE_PATH=$HOME/.hermes/hermes-agent/node_modules \
  node scripts/provas/aviso_procedencia.mjs --base http://127.0.0.1:8100 \
  --out _provas --prefix aviso_teste     # ok:true e problemas: []
```

### Troca manual (ainda vale para depurar à mão)

```bash
# 1. edite o .env do projeto (0600, fora do git): ELEICAO=6258 / TURNO=2
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
scripts/seguranca/teste_ataques.sh                       # contra 127.0.0.1:8110 (83 casos)
scripts/seguranca/teste_ataques.sh http://127.0.0.1:8100 # contra a stack de teste
scripts/seguranca/teste_ataques.sh https://eleicao2026.belmino.dev   # pela internet, como o mundo vê
```

Cobre flood (429), injeção SQL/JS em caminho e parâmetro, path traversal, injeção de cabeçalho por
CRLF, payload de 2 MB, métodos não permitidos, acesso direto a arquivo de dados, listagem de
diretório, 404 sem stack, e o painel de métricas nas três frentes: **200 sem token** em
`127.0.0.1:8112` (a decisão de 24/10), **401/403 fora do loopback** (API direto pela rede do
compose, sem a marca, inclusive com `X-Real-IP`/`X-Forwarded-For` forjados) e **404 no site público**
— local e pela borda real — com ou sem token válido e com `X-Real-IP`/`X-Forwarded-For`/
`CF-Connecting-IP`/`X-Painel-Local` forjados. Prova também as portas (8110 e 8112 só em loopback,
8112 inalcançável pelo IP de LAN) e a trava `ip_borda`: IP de faixa Cloudflare nunca entra no escore
de suspeita nem na lista de bloqueio (`--bloquear` recusa). A defesa entra pelo autoteste do vigia e
pela lista de bloqueio sem faixa privada. O flood é o último caso de propósito: ele satura o balde
do próprio IP. Caso que não pôde ser medido (túnel fora, compose parado) sai como `SKIP` e conta no
resumo — pular não é passar.

**Painel privado de métricas** — acessos, latência p50/p95/p99, erros, recusas do limitador, saúde
da stack, visitas anônimas, série temporal com gráfico e o estado da defesa:

```
GET /api/interno/metricas   # JSON
GET /api/interno/painel     # HTML, recarrega a cada 20 s
```

Só em `http://127.0.0.1:8112`. **Na própria máquina não precisa de token** (decisão de
24/10/2026): abrir `http://127.0.0.1:8112/api/interno/painel` já responde 200. Fora do loopback
a credencial `METRICAS_TOKEN` (`.env`, 0600, fora do git) continua obrigatória — sem credencial
→ 401, token errado → 403, sem token configurado → 403 (falha fechada). Pelo hostname público as
duas rotas são **404**, com ou sem token: no servidor público o caminho não existe
(`location ^~ /api/interno/ { return 404; }`).

Como o acesso local é decidido (o atalho fácil é errado): **não** se olha `X-Real-IP`,
`X-Forwarded-For` nem `Host` — todos forjáveis. Medido nesta máquina, uma conexão do host para
uma porta publicada em `127.0.0.1` chega ao container com `RemoteAddr` = IP do gateway docker
(`172.17.0.1`), então "`RemoteAddr` é 127.0.0.1" não existe dentro do container. A regra é:
`X-Painel-Local: 1` **e** par de rede privado. A marca só é escrita pelo `server` do `listen 8081`
(`proxy_set_header` sobrescreve o que o cliente mandou) e o `server` público a apaga antes de
proxiar (`proxy_set_header X-Painel-Local "";`). Consequência: marca forjada pela borda não
passa, e mesmo que passasse o par não seria privado.

Ver o painel da própria máquina (sem token):

```bash
xdg-open "http://127.0.0.1:8112/api/interno/painel"
painel-eleicao          # atalho local (~/.local/bin): abre no navegador padrão
```

Ver de outra máquina, **sem expor nada**: túnel SSH pela porta que já é loopback.

```bash
# na sua máquina, com acesso SSH a esta:
ssh -N -L 8112:127.0.0.1:8112 pedro@<ip-desta-máquina>
# depois abra http://127.0.0.1:8112/api/interno/painel?token=... no navegador local
```

O túnel Cloudflare (`~/.cloudflared/belmino-eleicao.yml`) aponta só para `127.0.0.1:8110`; não
existe hostname público apontando para 8112. Não adicione um.

### Monitor de acessos `*.belmino.dev` (painel 8113, SÓ rede interna)

```
http://192.168.5.179:8113        # de qualquer máquina da LAN
http://127.0.0.1:8113            # na própria máquina
```

Mostra, em tempo real (SSE), quem entra pela borda `*.belmino.dev`: req/s por status
(2xx/3xx/4xx/5xx), visitantes únicos (1 min e 1 h), top IPs/hosts/caminhos/user-agents, bots
ativos, ataques classificados por tipo, insights gerados por regra (sem LLM), série de 60 min por
minuto e de 7 dias por dia separando humano × bot × ataque, filtros de 5 min / 1 h / 24 h e botão
de pausar o ao vivo.

**Por que só a LAN alcança** — três motivos independentes, todos no servidor:

1. o processo (`monitor/bin/monitor-ataques`, systemd `--user` `hermes-eleicao-monitor.service`)
   escuta **somente** `127.0.0.1:8113` e `192.168.5.179:8113` — nunca `0.0.0.0`. O binário recusa
   `0.0.0.0` na configuração e cai para o IP atual da LAN se o DHCP mudar o endereço;
2. toda requisição passa por um filtro que olha o **IP do socket** (`RemoteAddr`, o que o kernel
   aceitou), liberando só `192.168.5.0/24` e loopback; o resto recebe `403`. Nenhum cabeçalho
   (`X-Real-IP`, `X-Forwarded-For`, `CF-Connecting-IP`, `X-Painel-Local`) é lido — forjar header
   não abre nada;
3. não existe hostname público apontando para 8113 no túnel, e o nginx público responde **404**
   em `/monitor` e `/api/monitor/` (inclusive com cabeçalho forjado).

**Onde vêm os dados** — o `log_format defesa` do nginx grava, por requisição: IP real (o
`real_ip_header CF-Connecting-IP` da borda resolve o visitante, não o Cloudflare), instante,
status, método, caminho, **host**, flag de bloqueio, a requisição crua entre aspas (com query) e o
user-agent. O host é o que separa `eleicao2026.belmino.dev` de `belmino.dev`/`www.belmino.dev` de
scanner batendo no IP. As linhas antigas (sem host) continuam válidas e aparecem como `?`. O hub
(`belmino.dev`/`www`, porta 8111) grava no mesmo arquivo o mesmo formato — sem isso esses dois
domínios nunca apareceriam. O log é truncado em 5 MB pelo vigia; por isso a janela de 24 h pode
aparecer como **parcial** — o painel diz o que está vendo, não estima.

**Borda Cloudflare no painel** — `GET /api/monitor/estado` traz o campo `borda`
(`{"ips":1,"eventos":3,"lista":[{"ip":"2a06:98c0:3600::103","eventos":3,"rotulo":"borda Cloudflare"}]}`).
Esses IPs **não** aparecem em `suspeitos`: a faixa de borda é o caminho de todo visitante, e um IP
dela no log é sintoma de `real_ip` quebrado (ver "Segurança e observabilidade"). A tela mostra a
linha "borda Cloudflare (nunca suspeita, nunca bloqueada)" acima da lista de suspeitos.

**Trocar o binário exige restart** (lição de 24/10/2026): `go build -o monitor/bin/monitor-ataques
./monitor` grava no disco, mas o processo antigo continua com o código velho em memória — a API só
passa a devolver o campo novo depois de `systemctl --user restart hermes-eleicao-monitor.service`.
Confira com `ps -o pid,lstart -C monitor-ataques` (a hora de início tem de ser posterior ao build).

**Como desligar** (o site público não depende dele):

```bash
systemctl --user stop hermes-eleicao-monitor.service      # para o painel
systemctl --user disable hermes-eleicao-monitor.service   # não sobe no boot
# desfazer a coleta no log (volta ao formato de 5 campos, sem host):
#   git -C ~/eleicao2026-mapa revert <commit-deste-painel> -- web/nginx.conf
#   docker compose -p eleicao2026-mapa up -d --no-deps web
# desfazer o espelho do hub:
#   git -C ~/monitoramento-eleicoes-presidenciais-governo-ce checkout hub/servidor_hub.py
#   systemctl --user restart hub-belmino.service
```

**Como interpretar os insights** — são regras, não opinião de modelo, e cada uma só fala quando o
número existe:

| frase | regra |
|---|---|
| `pico Nx acima da média dos últimos 25 min` | req/s dos últimos 5 min ÷ média dos 25 min anteriores ≥ 3 (≥ 20 req) |
| `IP X tentou N caminhos de <tipo> em 5 min` | mesmo IP com ≥ 8 caminhos sensíveis/traversal/scanner na janela |
| `nenhum ataque há N` | último evento classificado como ataque faz mais de 1 h |
| `N bots ativos nos últimos 5 min` | IPs distintos com UA de robô (mesmo `reBot` da contagem anônima) |
| `host concentra N% do tráfego` | host com maior volume na última hora |
| `N respostas 5xx em 5 min` | erro de backend, **não** é ataque |
| `N IP(s) bloqueados na borda` | lido de `var/defesa/estado.json` (o vigia) |
| `janela de 24 h parcial` | o log truncou e não cobre as 24 h |

Tipos de ataque (um por evento, o mais específico primeiro): **arquivo sensível** (`.env`, `.git`,
`/admin`, `nginx.conf`…), **path traversal** (`../`, `%2e%2e`, `/etc/passwd`), **SQLi** (aspas com
`OR/AND`, `UNION SELECT`, `sleep(`, `1=1`), **scanner de vulnerabilidade** (`wp-admin`,
`xmlrpc.php`, `*.php`, UA de `sqlmap`/`nuclei`/`nikto`…), **método não permitido** (fora de
GET/HEAD/POST/OPTIONS) e **flood / 429** (429 do nginx ou ≥ 120 req/min do mesmo IP).
IP `não resolvido` = requisição recusada pelo nginx no parse da linha (ex. `/../etc/passwd`), antes
do `real_ip` rodar: o painel mostra isso em vez de atribuir o ataque ao gateway do docker.

**Resiliência** — o painel é processo separado: não fala com o container do site, só lê o arquivo
de log. `systemctl --user stop` nele não muda nada na 8110; se ele morrer, `Restart=always` em 2 s
o levanta; e derrubar o site só faz o painel mostrar silêncio.


**Gráfico** — série de acessos por hora (24 h) e por dia (14 dias), separando humano × bot, com
total do dia, pico do dia, pico da hora e top países/cidades. Sai do mesmo `visitas.db` da contagem
anônima (nada de tabela nova) e é **SVG gerado no Go** (`api/grafico.go`): zero JavaScript, zero
CDN, zero requisição externa — a CSP do nginx continua fechada e o painel é um documento só.

**Defesa automática contra ataque** (`hermes-eleicao-defesa.timer`, systemd --user, 1 min):

Só **volume/surto** bloqueia sozinho — todo o resto virou escore de suspeita, que identifica e avisa.

| limiar que BLOQUEIA sozinho | padrão | env |
|---|---|---|
| requisições do mesmo IP em 60 s | 120 | `LIMITE_REQ_MIN` |
| respostas 429 em 60 s | 20 | `LIMITE_429` |
| janela do bloqueio (renovável) | 30 min | `DURACAO_MIN` |

**Escore de suspeita por IP** (`monitor/suspeita.go` e `scripts/defesa/suspeita.py`, espelhos
conferidos contra o mesmo fixture `scripts/defesa/suspeita_fixture.json`): 0 a 100, cada sinal vale
**uma vez** por IP — quantidade de requisição nunca pontua.

| sinal | peso | o que é |
|---|---|---|
| `caminho_sensivel` | 35 | `/admin`, `/.env`, `/.git`, `/wp-login`, `/phpmyadmin`, `/etc/passwd`… |
| `injecao` | 40 | SQLi, path traversal, XSS no alvo (caminho + query) |
| `metodo_anomalo` | 15 | PROPFIND, PUT, TRACE, DELETE… |
| `sondagem_interna` | 35 | `/api/interno/*` (rota de administração do site) |
| `ua_anomalo` | 15 | UA vazio, UA de scanner (sqlmap, nikto…) ou falsificado (iOS/MSIE antigo) |
| `regularidade` | 15 | intervalo quase fixo (desvio/média ≤ 0,15) por >30 min **sem UA de navegador** |
| `reincidencia` | 15 | 3+ respostas 403/404 e voltou depois da primeira recusa |

Faixas: `limpo` < 20 ≤ `observar` < 60 ≤ `suspeito` < 80 ≤ `malicioso`. A partir de **60** o vigia
manda **um** aviso no Telegram — e **não bloqueia**: o aviso traz o comando `bloquear.sh` e a decisão
é do Pedro. O painel 8113 mostra a lista "Suspeitos por escore" com os sinais de cada IP.

**Como ajustar os limiares** (o vigia é `python` chamado pelo timer a cada 1 min: mudar constante
vale no ciclo seguinte, **não precisa reiniciar nada**):

| limiar | onde vive | como mexer |
|---|---|---|
| surto / 429 / janela do bloqueio | topo de `scripts/defesa/vigia_ataques.py` e env do timer | `LIMITE_REQ_MIN` (120), `LIMITE_429` (20), `DURACAO_MIN` (30 min), `MANUAL_DURACAO_MIN` (240 min) — os 4 leem `os.environ`, então `Environment=` em `scripts/defesa/systemd/hermes-eleicao-defesa.service` também vale |
| faixas de nível do escore | `ESCORE_SUSPEITO` (60), `ESCORE_MALICIOSO` (80) | mudar aqui; o painel usa os mesmos cortes em `monitor/suspeita.go` (conferir os dois) |
| pesos dos sinais | `scripts/defesa/suspeita.py` **e** `monitor/suspeita.go` | são espelhos conferidos contra `suspeita_fixture.json`: mude nos dois, rode `--autoteste` (caso [5]) e `go test ./...` |
| anti-spam do Telegram | ver a tabela de anti-spam acima | `AVISO_IP_JANELA_S`, `AVISO_RENOVACAO_S` (6 h), `RESUMO_INTERVALO_S` (30 min), `RESUMO_MIN_SUSPEITOS` (4), `MAX_AVISOS_POR_CICLO` (3) |
| retenção do log | `LIMITE_LOG_BYTES` (5 MB) | env do timer |

Depois de qualquer ajuste, a prova é a mesma de sempre: `python3 scripts/defesa/vigia_ataques.py
--autoteste`, `python3 scripts/defesa/prova_antispam.py` e (se mexeu no painel) `cd monitor && go
test -count=1 ./...`.

**Infra local NUNCA pontua** (corrigido em 24/10/2026, defeito medido em produção): loopback
(`127.0.0.0/8`, `::1`), faixas privadas (`10/8`, `172.16/12` — onde ficam os gateways do docker,
`172.17.0.1`…`172.31.255.254` — e `192.168/16`), link-local, multicast, reservado e o rótulo
`não resolvido` (400 antes do `real_ip`) ficam **fora do escore**, pela mesma regra que já protege o
bloqueio (`ip_publico` no vigia). O painel mostra essa parte à parte, em `infra_local`
(`ips`, `eventos`, `lista`), nunca na contagem de suspeitos. Motivo: as nossas próprias provas de
ataque saem do host e chegam ao nginx pelo gateway do docker — sem essa trava, o `172.19.0.1`
aparecia como `malicioso 100` (`caminho_sensivel` + `injecao`) por causa de linhas de teste nossas
(`/.env`, `/.git`, `/api/interno`, `OR 1=1`), e o `127.0.0.1` idem.

**Borda Cloudflare NUNCA é suspeita nem pode ser bloqueada** (corrigido em 24/10/2026, defeito
medido em produção): as 22 faixas oficiais (`https://www.cloudflare.com/ips-v4` + `/ips-v6` — as
mesmas do `set_real_ip_from` em `web/nginx.conf`) ficam **fora do escore** e **fora da lista de
bloqueio**, pela função `ip_borda()` do vigia e `ipBorda()` do painel. Motivo: é por ali que todo
visitante entra — bloquear a borda derruba o site inteiro, e acusar a borda é acusar o correio.
Um IP de borda no log é **sintoma, não ataque**: significa que o `real_ip` não entregou o IP do
visitante e o scanner ficou invisível atrás do IP da Cloudflare. O painel mostra esses IPs em
campo próprio (`borda`: `ips`, `eventos`, `lista` com rótulo `borda Cloudflare`), separado dos
suspeitos e da infra local. O caso real: `2a06:98c0:3600::103` (faixa `2a06:98c0::/29`) apareceu
com escore 35 em `belmino.dev` porque o `set_real_ip_from` não tinha as faixas IPv6 da borda.
Conferir a lista oficial contra a do código:

```bash
curl -s https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6   # fonte oficial
grep -c 'set_real_ip_from' web/nginx.conf                                      # 4 locais + 22 borda
python3 scripts/defesa/vigia_ataques.py --autoteste                            # caso [8] prova a trava
```

Se a Cloudflare publicar faixa nova, ela entra nos **três** lugares na mesma mudança:
`web/nginx.conf` (`set_real_ip_from`), `FAIXAS_BORDA` do `vigia_ataques.py` e `faixasBorda` do
`monitor/suspeita.go`. Divergir é o defeito: o nginx passa a confiar numa faixa que o escore não
conhece (ou o contrário) e o IP da borda volta a virar "suspeito".

**Leitura do log** (`monitor/logwatch.go`, `suspeita._extrair_linha`): o formato tem 7 colunas fixas,
a requisição crua entre aspas e o UA com espaços; a coluna `$uri` **pode vir vazia** (400 antes do
`real_ip`) e **pode conter espaço** (o `escape=default` não escapa espaço). Por isso a leitura ancora
nas colunas previsíveis — as duas colunas à esquerda do campo entre aspas são host e bloqueado — em
vez de contar token na posição. Três gerações de linha convivem no arquivo (5 colunas; sem aspas;
atual) e cada uma tem caso de teste com **linha real** em `monitor/infra_local_test.go`.

**O que NÃO conta** (é o que protege o visitante legítimo de amanhã): `/`, `/index.html`, `/mapa`,
`/eleicao`, `/api/home`, `/api/estados`, `/api/visita`, `/healthz`, `/assets/*` e estáticos
(`.js`, `.css`, `.png`, `.jpg`, `.woff2`) não geram sinal de caminho; e `regularidade` é desligada
para qualquer IP com UA de navegador real. Volume puro também não conta: 300 requisições em 10 min
do mesmo IP dão escore **0**.

**Anti-spam do aviso** (uma mensagem por IP a cada **6 h**, valendo para suspeita, bloqueio e
renovação — um único ledger em `estado.json`, campo `suspeita.avisos`):

| o que sai no Telegram | regra | constante | ajuste |
|---|---|---|---|
| suspeita de um IP (escore ≥ 60) | 1 por IP / 6 h | `AVISO_IP_JANELA_S` | `= 6 * 3600` |
| bloqueio e renovação de um IP | 1 por IP / 6 h, contando os dois juntos | `AVISO_RENOVACAO_S` | `= 6 * 3600` |
| consolidado de suspeitos | mais de 3 novos no mesmo ciclo, no máximo a cada 30 min | `RESUMO_MIN_SUSPEITOS`, `RESUMO_INTERVALO_S` | `4`, `1800` |
| avisos individuais num ciclo | teto de 3 | `MAX_AVISOS_POR_CICLO` | `= 3` |

O **bloqueio nunca é adiado** pelo anti-spam: ele acontece sempre (a lista é a defesa). O que é
suprimido é a mensagem — fica no log (`~/.hermes/logs/eleicao-defesa.log`, linha
`aviso ... SUPRIMIDO`), no `--status` e no painel. Defeito medido em 24/10/2026: com
`AVISO_RENOVACAO_S = 600`, o 2º surto do mesmo IP em 10 min reenviava "segue bloqueado" — um
scanner que repica a cada 5 min virava metralhadora no canal. Prova: `scripts/defesa/prova_antispam.py`
roda o `ciclo()` real com relógio injetado (2 surtos em 10 min = 1 mensagem; o mesmo IP em +6h01 =
1 mensagem nova) e o caso [9] do `--autoteste` cobre a mesma regra sem tocar em nginx nem canal.
Para mudar a janela, altere a constante e rode os dois — o `--autoteste` reprova se o valor sair de
21600.

Como funciona, por ciclo:

1. lê o que é novo em `var/defesa/acessos.log` (log do nginx no formato
   `IP instante status método caminho` — sem query string, para o token nunca entrar em log);
2. agrega por IP e aplica os limiares de surto. **IP privado, loopback, link-local ou reservado
   nunca é bloqueado** — é a trava que mantém o túnel, o nginx e o painel de pé, e tem teste próprio
   (`vigia_ataques.py --autoteste`, incluindo o fixture do escore);
3. acumula o escore de suspeita das mesmas linhas e decide os avisos (anti-spam), sem bloquear;
4. escreve `var/defesa/bloqueios.conf` (`<ip> 1;`), roda `nginx -t` e recarrega o container `web`;
   o `geo $bloqueado_ip` do nginx devolve **403 só para aquele IP**. Todo o resto continua 200;
5. grava o estado em `var/defesa/estado.json` (o painel lê daí) e conta os bloqueios;
6. avisa no Telegram com IP, motivo, contagem e horário — bloqueio e renovação juntos, no máximo
   **1 mensagem por IP a cada 6 h** (`AVISO_RENOVACAO_S`);
7. ao vencer a janela, o IP sai da lista sozinho e o nginx recarrega.

Operação:

```bash
python3 scripts/defesa/vigia_ataques.py --status          # bloqueios ativos, contador, última execução
python3 scripts/defesa/vigia_ataques.py --suspeitos       # escore por IP agora (não envia nada)
python3 scripts/defesa/vigia_ataques.py --autoteste      # faixa privada + fixture + borda + anti-spam
python3 scripts/defesa/vigia_ataques.py --ensaio         # decide e imprime, sem tocar em nada
bash scripts/defesa/bloquear.sh 45.22.33.44 "escore 100 no painel"   # bloqueio MANUAL
bash scripts/defesa/desbloquear.sh 45.22.33.44           # desbloqueio manual (um IP)
bash scripts/defesa/desbloquear.sh --todos               # lista inteira
bash scripts/defesa/prova_bloqueio.sh                    # prova ponta a ponta (ataca e desbloqueia)
python3 scripts/defesa/prova_antispam.py                 # anti-spam: 2 surtos em 10 min = 1 aviso
systemctl --user list-timers hermes-eleicao-defesa.timer # cadência
journalctl --user -u hermes-eleicao-defesa -n 50         # ciclos
tail -20 ~/.hermes/logs/eleicao-defesa.log               # bloqueios, renovações, desbloqueios
```

`bloquear.sh <ip> "<motivo>" [--minutos N]` (padrão 240 min): recusa IP não público **e IP de borda
Cloudflare** com exit 65 (`RECUSADO: <ip> é faixa de BORDA...`), testa o nginx antes do reload e a
janela expira sozinha. Bloquear a borda derruba o site para todo mundo — por isso a recusa está no
script, no vigia, no `escrever_bloqueios()` e no `decidir()`, não só na boa vontade de quem chama:

```bash
bash scripts/defesa/bloquear.sh 2a06:98c0:3600::103 "teste"
# RECUSADO: 2a06:98c0:3600::103 é faixa de BORDA da Cloudflare (2a06:98c0::/29 e as outras
# oficiais) — bloquear a borda derrubaria o site inteiro.        (exit 65)
```

Desligar a defesa (o site continua no ar, com o rate limit do nginx):

```bash
systemctl --user disable --now hermes-eleicao-defesa.timer
bash scripts/defesa/desbloquear.sh --todos               # e limpe o que estiver bloqueado
```

Reverter tudo (voltar ao estado de 24/10/2026, sem painel separado nem bloqueio):

```bash
git revert <commit>
docker compose -p eleicao2026-mapa up -d --build        # nginx volta a ter um server só
bash scripts/defesa/desbloquear.sh --todos
```

Privacidade: `var/defesa/acessos.log` é o **único** lugar onde um IP aparece em claro. Fica fora de
qualquer raiz servida, é truncado pelo próprio vigia ao passar de 5 MB e serve só para contar
requisição por IP. A contagem de visitas do mapa continua anônima (hash do dia) e independente dele.

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
NODE_PATH=$HOME/.hermes/hermes-agent/node_modules \
  node scripts/provas/auditoria.mjs --base http://127.0.0.1:8100 --out _provas
NODE_PATH=$HOME/.hermes/hermes-agent/node_modules \
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
