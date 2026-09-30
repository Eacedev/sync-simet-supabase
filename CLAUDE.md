# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

Job de sincronização diária: lê as medições de conectividade das escolas na API pública do SIMET/NIC.br, agrega por escola e faz upsert no Supabase. Todo o repositório são dois arquivos: [sync.mjs](sync.mjs) (o job) e [.github/workflows/sync.yml](.github/workflows/sync.yml) (o agendamento).

Não há `package.json`, build, lint nem testes. A dependência `@supabase/supabase-js` é instalada ad-hoc pelo workflow (`npm install @supabase/supabase-js`) antes de rodar `node sync.mjs`.

## Rodar localmente

```powershell
npm install @supabase/supabase-js
$env:SUPABASE_URL = "https://<projeto>.supabase.co"
$env:SUPABASE_KEY = "<service_role_key>"
node sync.mjs
```

Em produção roda pelo GitHub Actions, com `SUPABASE_URL` e `SUPABASE_KEY` vindo dos secrets do repositório. O workflow também aceita `workflow_dispatch` (execução manual pela aba Actions).

### Variáveis de ambiente opcionais

Existem porque a coleta completa leva ~30 minutos e grava direto na tabela de produção — sem elas não há como testar uma alteração de forma barata.

| Variável | Efeito |
|---|---|
| `SIMET_DRY_RUN=1` | Coleta e agrega normalmente, imprime uma linha de exemplo e **não grava** no Supabase (nem exige credenciais) |
| `SIMET_MAX_PAGINAS=N` | Para depois de N páginas. Use junto com o dry-run; sozinho produziria médias incompletas |
| `SIMET_END_TIME` | Sobrescreve o `end_time`. Serve para recuperar o dia anterior ou inspecionar outro recorte |

```powershell
$env:SIMET_DRY_RUN = "1"; $env:SIMET_MAX_PAGINAS = "12"; node sync.mjs
```

## Pipeline de dados

1. Calcula `end_time` na **meia-noite UTC do dia da execução** e `DIA_ALVO` como o dia anterior. Aborta cedo se o `end_time` já estiver a 24h ou mais no passado, caso em que a API devolveria vazio.
2. Sonda `page=1` com `include_total=true` para obter `total_rows`, e deriva o número de páginas de `total_rows / PAGE_SIZE`.
3. Pagina o restante com `CONCORRENCIA` requisições simultâneas, reusando o mesmo `end_time`. Cada página tem 3 tentativas com backoff; se alguma esgotar, o job aborta **sem gravar nada** — um dia com páginas faltando produziria médias silenciosamente erradas.
4. Agrega incrementalmente, página a página, acumulando soma e contagem por `(co_entidade, dia)`. As medições cruas nunca são todas retidas em memória: são ~300-520 mil por dia, contra ~80 mil escolas no resultado.
5. Descarta medições sem `vel_download_mbps` **ou** sem `vel_upload_mbps`, e as que não pertencem ao `DIA_ALVO`.
6. Divide soma por contagem (cada métrica tem contagem própria, então `null` de um campo não contamina os outros) e faz upsert em lotes de 500 na tabela `medicoes_simet`, com `onConflict: "co_entidade,dia"`.

Consequências ao mexer nisso:

- O upsert depende de uma constraint UNIQUE em `(co_entidade, dia)` no Supabase. Sem ela o upsert falha ou duplica; qualquer mudança na chave de deduplicação precisa ser feita nos dois lados.
- As chaves do objeto montado no passo 6 são exatamente as colunas da tabela. Adicionar um campo exige criar a coluna antes, senão o lote inteiro falha. É também o que impede os metadados de paginação (`total_rows`, `total_pages`, `end_time`), que vêm embutidos em cada registro da API, de vazarem para o banco.
- **O filtro por `DIA_ALVO` é uma trava de segurança, não um detalhe.** Com o `end_time` na meia-noite ele nunca descarta nada, mas impede que uma execução com janela deslocada grave a linha de outro dia com uma média parcial — sobrescrevendo, via upsert, um dia que já estava completo.
- Os metadados (`nome_provedor`, `tipo`, `agent_id`, `asn`) vêm da medição **mais recente** do grupo, escolhida comparando `horario_medicao`. Não dependa da ordem de chegada das páginas: com concorrência ela varia.
- Um erro em qualquer lote do upsert chama `process.exit(1)` — os lotes anteriores já foram gravados, não há transação nem rollback. Reexecutar é seguro por ser upsert idempotente sobre o mesmo `end_time`.

## Agendamento

O horário desejado é **21:40 de Brasília**, logo após o dia UTC fechar (21:00 BRT). Como o cron do GitHub Actions é sempre em UTC e o Brasil não usa mais horário de verão (UTC-3 fixo), isso é `40 0 * * *`.

Disparando às 00:40 UTC, o `end_time` cai na meia-noite UTC daquele mesmo dia e o `DIA_ALVO` é o dia UTC anterior, recém-fechado. Sobram ~23h de margem antes de o dia sair do ar, contra ~32 min de coleta.

### O cron é "não antes de", não um horário

**O Actions atrasa este workflow em horas, e o atraso varia.** Medido nas execuções reais:

| Cron | Execuções | Atraso |
|---|---|---|
| `00 23 * * *` (23:00 UTC) | 00:38, 00:48, 00:52, 01:01 UTC | 1h38 – 2h01 |
| `40 2 * * *` (02:40 UTC) | 08:59, 09:00 UTC | ~6h20 |

Foi isso que fez o job aparecer rodando às 06:00 BRT com um cron ajustado para 23:40 BRT. Não adianta "compensar" o atraso adiantando o cron: ele não é estável.

Isso não corrompe dados. O `end_time` é derivado da meia-noite UTC e não do relógio do runner, então um atraso de 6h coleta exatamente o mesmo dia. O que o atraso consome é a margem de 24h da retenção — só vira problema perto de 23h, o que nunca se aproximou.

Se o horário exato passar a importar, o cron do Actions não serve: seria preciso um agendador externo (pg_cron no próprio Supabase, ou um serviço de cron) chamando a API do GitHub para disparar o `workflow_dispatch`.

O job tem `timeout-minutes: 75`. A coleta real levou **32 min** em 30/09/2026 e o volume cresce, então os 45 min iniciais deixavam pouca folga.

Em caso de falha, um passo com `if: failure()` abre uma issue com a label `sync-simet` e o link do log. Se já houver uma issue aberta com essa label, ele comenta nela em vez de abrir outra, para uma sequência de falhas não virar uma enxurrada. Isso exige `permissions: issues: write` no workflow. O alerta existe porque a perda é silenciosa e a janela de recuperação é de um dia só; se o time preferir receber em Slack ou Teams, troque o corpo desse passo por um POST ao webhook, mantendo o `if: failure()`.

### Números de uma execução real (30/09/2026, dia alvo 29/09)

Use como referência ao avaliar se algo saiu do normal:

```
end_time: 2026-09-30 00:00:00 UTC | dia alvo: 2026-09-29
Total de medições: 520543 em 521 páginas
Páginas: 521/521 (32.1 min)
Medições válidas: 508657 | sem download/upload: 11886
Escolas únicas: 80155
Salvos: 80155/80155
```

Nenhuma medição foi descartada por pertencer a outro dia, o que confirma o alinhamento da janela.

## API do SIMET

A API é pública, sem autenticação, e tem rate limit de 400 req/s (cabeçalhos `X-RateLimit-*`). Não há documentação publicada: `/docs`, `/openapi.json` e `/swagger.json` retornam 404.

**A chamada sem parâmetros não funciona mais.** Ela responde HTTP 500 (`{"error":"500 - Internal server error"}`) de forma persistente, porque o volume cresceu além do que o backend consegue serializar de uma vez: são ~520 mil medições em 24h, e crescendo. A única forma de obter os dados hoje é paginando.

### Parâmetros de paginação

`page`, `page_size`, `include_total` e `end_time`. Comportamento medido em 28/09/2026:

- `page_size` é **capado em 1000** — pedir 5000, 10000 ou 50000 devolve 1000 assim mesmo, sem erro. Um dia inteiro dá entre ~290 e ~490 páginas, conforme o movimento do dia.
- `include_total=true` acrescenta `total_rows` e `total_pages` à resposta. O SIMET recomenda usá-lo só na primeira chamada. `total_pages` é calculado para o `page_size` **daquela requisição** — se a sondagem inicial usar um `page_size` diferente do da coleta, esse número não serve; calcule a partir de `total_rows`.
- Os metadados (`total_rows`, `total_pages`, `end_time`) vêm **repetidos dentro de cada registro**, não num envelope. Não existe objeto de paginação; leia-os do primeiro elemento do array.
- `end_time` ausente = "agora". **A janela é ancorada no `end_time`**, não no relógio — ver abaixo. Reusar o mesmo `end_time` devolve exatamente o mesmo `total_rows`: as chamadas são reprodutíveis, então dá para repetir uma página que falhou sem risco de inconsistência. É por isso que o `end_time` tem que ser fixado uma vez e reusado em toda a coleta; sem ele, a janela deslizaria durante os ~30 min de paginação e o `OFFSET` deslocaria registros entre páginas.
- Pedir uma página acima de `total_pages` devolve **HTTP 500**, não um array vazio. O fim da coleta tem que ser controlado por `total_pages`/`total_rows`; um 500 no meio da paginação é ambíguo entre erro real e fim dos dados.

### O modelo da janela (e o limite do `end_time`)

A janela é **`[end_time - 24h, end_time)`**, e a restrição de 24h vale para o **parâmetro**, não para os dados: `end_time` precisa estar dentro das últimas 24h, senão a API devolve `{}` — objeto vazio, com HTTP 200, não um array (mais um motivo para o `Array.isArray` antes de processar). `end_time` no futuro devolve 500.

Isso foi confuso de mapear porque o volume varia muito com o dia da semana, o que faz janelas de 24h parecerem inconsistentes: domingo (27/09/2026) tem ~286 mil medições contra ~484 mil na segunda. Não confunda essa variação com janela truncada.

Consequência boa: **um dia UTC exato é obtível**. `end_time` na meia-noite UTC devolve o dia anterior fechado — verificado com `end_time=2026-09-28 00:00:00`, que rendeu 286.099 registros indo de `2026-09-27 00:00:00` a `2026-09-27 23:59:59`, todos com `dia=2026-09-27`.

Consequência operacional: a recuperação de uma falha é possível **durante todo o dia seguinte** (enquanto a meia-noite alvo estiver a menos de 24h). Passado isso, os dados somem em definitivo — não há backfill de dias antigos, o que torna o alerta de falha do job mais importante que o normal.

### Fuso e o campo `dia`

`horario_medicao` e `dia` estão em **UTC**, não em horário de Brasília. O `dia` gravado no Supabase é portanto o dia UTC, que vira às 21:00 BRT.

Uma janela de "últimas 24h" **sempre atravessa duas datas** — numa amostra de 3.802 registros apareceram `2026-09-28` (3.000) e `2026-09-27` (802), com 22 escolas nas duas. É exatamente por isso que o `end_time` é ancorado na meia-noite: sem esse alinhamento, o agrupamento por `(co_entidade, dia)` misturaria dois dias numa média só.

### Desempenho

Cada página leva ~11-12s, **constante** independente do número da página (não há degradação por `OFFSET`). Sequencialmente, 500 páginas levariam ~1h40. Em paralelo não houve nenhuma falha até 16 requisições simultâneas, mas o ganho satura cedo. Com a concorrência 8 em uso, a coleta real de 521 páginas levou **32 min** — o gargalo é o backend, não o rate limit.

## Ambiente

Node 22 no CI. O script usa top-level `await` e `fetch` nativo (sem polyfill) — manter a extensão `.mjs` e não introduzir `require`.
