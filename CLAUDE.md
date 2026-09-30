# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

Job de sincronização diária: lê as medições de conectividade das escolas na API pública do SIMET/NIC.br, agrega por escola e faz upsert no Supabase. O repositório são [sync.mjs](sync.mjs) (o job), [.github/workflows/sync.yml](.github/workflows/sync.yml) (o agendamento) e [sql/](sql/), que guarda o DDL que não vive em lugar nenhum além do Supabase — a estrutura das tabelas e a rotina de retenção do detalhe. Nada em `sql/` roda sozinho; é documentação executável.

A documentação técnica para humanos está em [docs/medicoes-simet.md](docs/medicoes-simet.md): estrutura das tabelas, fluxo, exemplos de consulta e as decisões de arquitetura com os números que as sustentam. Este arquivo aqui é o guia de manutenção; aquele explica o funcionamento e como consumir os dados. Ao mudar o comportamento do job, atualize os dois.

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
| `SIMET_TABELA` | Grava em outra tabela (padrão `medicoes_simet`); o detalhe segue junto, em `<SIMET_TABELA>_detalhe`. Existe porque o dry-run **não** exercita o upsert, que é onde moram os riscos reais — payload, tipos e cache de schema do PostgREST. Crie as duas espelho (`create table X (like medicoes_simet including all)` e `create table X_detalhe (like medicoes_simet_detalhe including all)`) antes de mexer na gravação |

```powershell
$env:SIMET_DRY_RUN = "1"; $env:SIMET_MAX_PAGINAS = "12"; node sync.mjs
```

## Pipeline de dados

1. Calcula `end_time` na **meia-noite UTC do dia da execução** e `DIA_ALVO` como o dia anterior. Aborta cedo se o `end_time` já estiver a 24h ou mais no passado, caso em que a API devolveria vazio.
2. Sonda `page=1` com `include_total=true` para obter `total_rows`, e deriva o número de páginas de `total_rows / PAGE_SIZE`.
3. Pagina o restante com `CONCORRENCIA` requisições simultâneas, reusando o mesmo `end_time`. Cada página tem 3 tentativas com backoff; se alguma esgotar, o job aborta **sem gravar nada** — um dia com páginas faltando produziria médias silenciosamente erradas.
4. Agrupa por `(co_entidade, dia)` **retendo as medições individuais**, uma tupla-array por medição. São ~508 mil por dia e custam ~119 MB de heap, contra os 16 GB do runner. Já foi soma-e-contagem incremental; passou a reter porque mediana e percentil exigem os valores, e porque o detalhe do dia é gravado.
5. Descarta medições sem `vel_download_mbps` **ou** sem `vel_upload_mbps`, e as que não pertencem ao `DIA_ALVO`.
6. Ordena as medições de cada escola por horário, calcula média, mediana, p10 e p90 e faz upsert em **duas** tabelas, ambas com `onConflict: "co_entidade,dia"` e ambas com **uma linha por escola/dia**: os agregados em `medicoes_simet` e as medições individuais num único campo `jsonb` em `medicoes_simet_detalhe`.

Consequências ao mexer nisso:

- O upsert depende de uma constraint UNIQUE em `(co_entidade, dia)` no Supabase. Sem ela o upsert falha ou duplica; qualquer mudança na chave de deduplicação precisa ser feita nos dois lados.
- As chaves do objeto montado no passo 6 são exatamente as colunas da tabela. Adicionar um campo exige criar a coluna antes, senão o lote inteiro falha. É também o que impede os metadados de paginação (`total_rows`, `total_pages`, `end_time`), que vêm embutidos em cada registro da API, de vazarem para o banco.
- **O filtro por `DIA_ALVO` é uma trava de segurança, não um detalhe.** Com o `end_time` na meia-noite ele nunca descarta nada, mas impede que uma execução com janela deslocada grave a linha de outro dia com uma média parcial — sobrescrevendo, via upsert, um dia que já estava completo.
- Os metadados (`nome_provedor`, `tipo`, `agent_id`, `asn`) vêm da medição **mais recente** do grupo, escolhida comparando `horario_medicao` com desempate por `agent_id`. Não dependa da ordem de chegada das páginas: com concorrência ela varia, e o desempate existe justamente para que ela não decida nada.
- Um erro em qualquer lote do upsert chama `process.exit(1)` — os lotes anteriores já foram gravados, não há transação nem rollback. Reexecutar é seguro por ser upsert idempotente sobre o mesmo `end_time`. Cada lote tem 3 tentativas antes de desistir.
- Os lotes são fechados por **orçamento de bytes** (~1 MB, teto de 250 linhas), não por número fixo de linhas. Com o detalhe, uma escola pode pesar 59 KB e outra 400 bytes, então contar linhas não diz quanto o request vai pesar.

### A tabela `medicoes_simet_detalhe`

Três colunas: `co_entidade`, `dia` e `medicoes` (`jsonb`), com a mesma PK da tabela principal.

Custo medido: o `jsonb` ocupa **`103 + n × 96` bytes**, onde `n` é o número de medições. Com a média de 6,35 medições por escola dá ~750 bytes por linha, ou **~60 MB/dia** — ~10,8 GB nos 180 dias de retenção. A tabela agregada passou de 157 para **233 bytes/linha**, custo das 9 colunas de percentil.

**Por que separada, e não uma coluna em `medicoes_simet`.** Medido em 30/09/2026 sobre 20 mil linhas: com o `jsonb` inline a linha ia de 157 para **745 bytes** e a agregação típica das matviews de **154 ms para 1111 ms — 7,2×**. A causa é que as 16 views, incluindo as 3 matviews com `REFRESH` diário, leem só os agregados: elas arrastariam ~590 bytes por linha para nunca usá-los. Quem precisa do detalhe paga um join de ~9 ms por dia consultado (11 ms inline contra 20 ms com join, para 20 mil linhas).

Não adianta tentar resolver com TOAST: nessa faixa de tamanho ele **não é acionado**, nem com `toast_tuple_target = 128` e `storage external` — testado. O gatilho fica em ~2 KB por tupla e as linhas ficavam logo abaixo dele.

A view `vw_vectra_simet_24h`, consumida via API por cliente externo, expõe o detalhe na coluna `medicoes` (adicionada no fim, para não deslocar as existentes). O `row_number()` dessa view custa caro agora: ele materializa e ordena as 80 mil linhas **com o JSON** antes de devolver a primeira, então `limit` não ajuda — 471 ms e 70 MB de sort em disco, contra 5,6 ms sem ele. O custo é do `row_number()`, não do join. Ver [sql/003](sql/003_vw_vectra_expor_medicoes.sql).

Para ler agregado e detalhe juntos, `left join` (não `join`): dia purgado ou anterior à migração não tem detalhe.

```sql
select a.*, d.medicoes
  from medicoes_simet a
  left join medicoes_simet_detalhe d using (co_entidade, dia)
 where a.dia = current_date - 1;
```

#### O campo `medicoes`

Séries paralelas alinhadas por índice — o item `i` de cada série é a mesma medição:

```json
{"h":["23:44:15","23:58:47"],"d":[205.1322,204.8209],"u":[43.2284,44.725],
 "l":[28.118,35.128],"p":[0,0],"ju":[0.54,0.77],"jd":[0.15,0.21]}
```

`h` = horário `HH:MM:SS` (o dia está na coluna `dia`), `d` = download Mbps, `u` = upload Mbps,
`l` = latência ms, `p` = perda %, `ju`/`jd` = jitter upload/download ms.

- **Ordenado por horário**, com desempate pelos valores. Sem isso, o `sort` estável do V8 manteria a ordem de chegada das páginas e duas execuções do mesmo `end_time` gravariam conteúdo embaralhado — perdendo a checagem mais barata de que a coleta está correta.
- Os valores vão **como a API devolveu**: ela dá no máximo 4 casas decimais, então não há arredondamento a fazer. Só média, mediana e percentis são arredondados (4 casas), porque esses derivam de divisão.
- **Ausência de linha** em `medicoes_simet_detalhe` **não** significa "escola sem medições" — significa detalhe purgado (>180 dias) ou dia coletado antes desta tabela existir. Para ausência de medições, use `total_medicoes` na tabela principal.
- Mediana, p10 e p90 existem só para **download, upload e latência**. Essas colunas nunca expiram e custariam ~5 GB/ano para as 6 métricas; jitter e perda seguem calculáveis do `jsonb` enquanto o detalhe viver.
- Percentil usa o método **R-7**, o mesmo do `percentile_cont` do Postgres. Dá para conferir qualquer coluna rodando `percentile_cont` sobre o próprio `jsonb`. **Com `n` ímpar bate exato; com `n` par, ~1,3% das linhas diferem em 0,0001** — a mediana de n par é a média dos dois centrais, e o `float64` do JS arredonda a 4ª casa para lado diferente do `numeric` do Postgres. São 0,1 kbps: ruído de arredondamento, não erro. Medido no ensaio de 30.927 escolas: 413 divergências, todas de exatamente 0,0001, todas em `n` par.
- **37% das escolas medem menos de 5 vezes por dia** e 4.379 medem uma só. Nesses casos `media = mediana = p10 = p90` — correto, mas vazio. Quem consome deve filtrar por `total_medicoes >= 5` antes de ler p10/p90; um `AVG(p90_download)` sobre todas as escolas não se sustenta.
- A gravação é em duas etapas: primeiro `medicoes_simet`, depois o detalhe. Se o detalhe falhar, o dia continua correto para quem lê médias e percentis — basta reexecutar para completar.

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
- `end_time` ausente = "agora". **A janela é ancorada no `end_time`**, não no relógio — ver abaixo. Reusar o mesmo `end_time` devolve o mesmo `total_rows`, então dá para repetir uma página que falhou sem risco de inconsistência grosseira. **Mas o conteúdo das páginas não é perfeitamente estável**: duas coletas com o mesmo `end_time`, medidas em 30/09/2026, devolveram 6922 e 6921 escolas nas mesmas 8 páginas. O `OFFSET` do backend não tem ordenação determinística por baixo, então registros de fronteira trocam de página entre requisições. O efeito é de ~0,01% e o job apenas avisa quando o total recebido diverge do anunciado — não aborta, porque a amostra continua representativa. Não confunda esse ruído com página faltando. É por isso que o `end_time` tem que ser fixado uma vez e reusado em toda a coleta; sem ele, a janela deslizaria durante os ~30 min de paginação e o `OFFSET` deslocaria registros entre páginas.
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
