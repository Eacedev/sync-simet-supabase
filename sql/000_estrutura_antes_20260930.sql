-- Estrutura de public.medicoes_simet capturada em 2026-09-30, ANTES de adicionar
-- a coluna de detalhe (medicoes jsonb) e as colunas de mediana/percentil.
--
-- Para que serve: recriar a tabela do zero se algo der muito errado. NAO contem
-- dados -- o volume (2.843.402 linhas, 440 MB) nao justifica uma copia, e os
-- dados de cada dia sao recolhiveis da API do SIMET apenas dentro de 24h.
--
-- ATENCAO no rollback: 16 views e materialized views dependem desta tabela.
-- Um "drop table medicoes_simet cascade" destruiria todas elas. Se precisar
-- restaurar, prefira sempre operar por dados na tabela existente
-- (delete + insert do dia afetado) em vez de recriar a tabela.

create table public.medicoes_simet (
  co_entidade              bigint  not null,
  dia                      date    not null,
  nome_provedor            text,
  asn                      bigint,
  total_medicoes           integer,
  media_download_mbps      numeric,
  media_upload_mbps        numeric,
  media_latencia_ms        numeric,
  media_perda_pacote       numeric,
  media_jitter_upload_ms   numeric,
  media_jitter_download_ms numeric,
  agent_id                 text,
  tipo                     text,
  constraint medicoes_simet_pkey primary key (co_entidade, dia)
);

-- A PK em (co_entidade, dia) e o que o upsert do job usa como onConflict.
-- Sem ela o upsert falha ou duplica.
create index idx_medicoes_simet_dia         on public.medicoes_simet using btree (dia);
create index idx_medicoes_simet_co_entidade on public.medicoes_simet using btree (co_entidade);

-- Sem reloptions na captura: toast_tuple_target e os parametros de autovacuum
-- so passam a existir com a migracao do detalhe.
