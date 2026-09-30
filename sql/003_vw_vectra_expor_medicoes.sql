-- Expoe o detalhe das medicoes na view consumida via API pelo cliente.
--
-- O LEFT JOIN e obrigatorio: com INNER JOIN a view perderia toda escola sem
-- detalhe. Isso inclui qualquer dia anterior a 30/09/2026, os dias ja purgados
-- (>180 dias) e - enquanto a primeira coleta nova nao rodar - todas as linhas.
-- A coluna vem null nesses casos, e null aqui NAO significa escola sem
-- medicoes: para isso existe total_medicoes.
--
-- A coluna nova entra no fim para nao deslocar as existentes, o que permite
-- CREATE OR REPLACE e nao quebra consumidores que leem por posicao.
--
-- ATENCAO ao desempenho: o row_number() desta view obriga o Postgres a
-- materializar e ordenar as ~80 mil linhas COM o json antes de devolver a
-- primeira, entao LIMIT nao ajuda. Medido com o detalhe populado:
--   com row_number() ... 471 ms, 70 MB de sort em disco
--   sem row_number() ...   5,6 ms
-- O custo e do row_number(), nao deste join (a view ja levava 173 ms antes).
-- A coluna id que ele gera nao e um identificador estavel: e recalculada a
-- cada consulta. Trocar por co_entidade resolveria, mas muda o contrato com o
-- cliente e precisa ser combinado com ele antes.

create or replace view public.vw_vectra_simet_24h as
 select row_number() over (order by ms.dia desc, ms.co_entidade) as id,
    now() as created_at,
    ms.co_entidade,
    ms.dia,
    ms.dia::timestamp without time zone as horario_medicao,
    ms.media_download_mbps as vel_download_mbps,
    ms.media_upload_mbps as vel_upload_mbps,
    ms.media_latencia_ms as latencia_ms,
    ms.media_perda_pacote as perda_pacote_porcent,
    ms.media_jitter_upload_ms as jitter_upload_ms,
    ms.media_jitter_download_ms as jitter_download_ms,
    ms.asn,
    ms.nome_provedor,
    ms.total_medicoes,
    ms.agent_id,
    ms.tipo,
    d.medicoes
   from medicoes_simet ms
   left join medicoes_simet_detalhe d
     on d.co_entidade = ms.co_entidade and d.dia = ms.dia
  where ms.dia >= (current_date - '1 day'::interval) and ms.dia < current_date
  order by ms.dia desc;
