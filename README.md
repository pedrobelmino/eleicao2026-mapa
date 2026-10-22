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

## Eleição e turno são parâmetro

O sistema roda com o 1º turno hoje. No dia da eleição troca-se a origem para o 2º turno no TSE via
configuração — sem editar código.

## Privacidade e dados

Dados públicos do TSE. Nenhum dado de eleitor. Visitas do painel são anônimas (sem cookie, sem IP).

## Estado

Fase 1 concluída no painel Python: dados de município e seção do Ceará fechando com o TSE
(184 municípios, 23.765 seções, diferença 0 votos). App Go+React em construção.
