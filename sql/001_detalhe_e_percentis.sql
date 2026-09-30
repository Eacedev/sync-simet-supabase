-- Migracao que acompanha a versao do sync.mjs que grava o detalhe das medicoes.
-- APLICAR ANTES de subir o script: uma chave sem coluna correspondente faz o
-- lote inteiro do upsert falhar.
--
-- Depois de aplicar, o PostgREST ainda pode servir o schema antigo do cache.
-- Um "notify pgrst, 'reload schema'" resolve; confirme com um upsert de UMA
-- linha antes de rodar a coleta inteira.

-- 1) Percentis ficam na tabela principal: sao 9 colunas numeric, baratas, e e
-- onde as views ja procuram os agregados. Jitter e perda ficam de fora porque
-- estas colunas nunca expiram (as 6 metricas custariam ~5 GB/ano) e os
-- percentis delas seguem calculaveis do detalhe enquanto ele viver.
alter table public.medicoes_simet
  add column if not exists mediana_download_mbps numeric,
  add column if not exists p10_download_mbps     numeric,
  add column if not exists p90_download_mbps     numeric,
  add column if not exists mediana_upload_mbps   numeric,
  add column if not exists p10_upload_mbps       numeric,
  add column if not exists p90_upload_mbps       numeric,
  add column if not exists mediana_latencia_ms   numeric,
  add column if not exists p10_latencia_ms       numeric,
  add column if not exists p90_latencia_ms       numeric;

-- 2) O detalhe vai para uma tabela propria, com a MESMA chave. Continua uma
-- linha por escola/dia; o que muda e so onde ela mora.
--
-- Por que separado, medido em 30/09/2026 com 20 mil linhas:
--   jsonb na tabela principal -> 745 bytes/linha, agregacao em 1111 ms
--   tabela separada           -> 157 bytes/linha, agregacao em  154 ms  (7,2x)
-- A diferenca vem de as 16 views e as 3 matviews de REFRESH diario lerem so os
-- agregados: com o jsonb inline elas arrastavam ~590 bytes por linha para nunca
-- usa-los. O TOAST nao resolve: nessa faixa de tamanho ele nao e acionado nem
-- com toast_tuple_target=128 e storage external (testado).
-- Quem precisa do detalhe paga um join de ~9 ms por dia consultado.
create table if not exists public.medicoes_simet_detalhe (
  co_entidade bigint not null,
  dia         date   not null,
  medicoes    jsonb  not null,
  primary key (co_entidade, dia)
);

-- A PK comeca por co_entidade, entao nao serve para filtrar por dia; este
-- indice atende a purga dos 180 dias e a leitura de um dia pela view.
create index if not exists idx_medicoes_simet_detalhe_dia
  on public.medicoes_simet_detalhe using btree (dia);

-- A purga mensal apaga ~80 mil linhas por dia purgado; com o default
-- (scale_factor 0.2) o autovacuum demoraria demais a recolher o espaco.
alter table public.medicoes_simet_detalhe
  set (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 10000);

comment on table public.medicoes_simet_detalhe is
  'Medicoes individuais de cada escola por dia, uma linha por (co_entidade, dia) '
  '- a mesma chave de medicoes_simet. Separada da principal para nao inflar as '
  'varreduras das 16 views que leem so os agregados. Retencao de 180 dias; '
  'medicoes_simet guarda medias e percentis para sempre.';

comment on column public.medicoes_simet_detalhe.medicoes is
  'Series paralelas alinhadas por indice: h=horario HH:MM:SS, d=download Mbps, '
  'u=upload Mbps, l=latencia ms, p=perda %, ju=jitter upload ms, jd=jitter '
  'download ms. Ordenado por horario. Valores como a API devolveu (4 casas). '
  'Ausencia de linha aqui NAO significa escola sem medicoes - veja '
  'total_medicoes em medicoes_simet.';

comment on column public.medicoes_simet.p10_download_mbps is
  'Percentil 10, metodo R-7 (identico a percentile_cont do Postgres). So e '
  'estatisticamente util com total_medicoes >= 5: 37% das escolas medem menos '
  'que isso por dia, e nesses casos p10 = mediana = p90 = media.';

-- Para ler agregado + detalhe de um dia:
--   select a.*, d.medicoes
--     from public.medicoes_simet a
--     left join public.medicoes_simet_detalhe d using (co_entidade, dia)
--    where a.dia = current_date - 1;
-- O left join importa: dia purgado ou anterior a esta migracao nao tem detalhe.
