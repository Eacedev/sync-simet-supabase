-- Retencao do detalhe: apaga as linhas de medicoes_simet_detalhe com mais de
-- 180 dias. As medias e os percentis ficam em medicoes_simet para sempre.
--
-- Sem isso o detalhe cresce ~58 MB/dia (~20 GB/ano) num plano que inclui 8 GB
-- de disco; com o corte, estabiliza em ~10 GB.
--
-- APLICAR SO DEPOIS de alguns dias saudaveis com a coleta nova. Nao ha pressa:
-- os primeiros 180 dias de detalhe nao existem ainda.
--
-- Mensal, nao diario, de proposito: a diferenca entre reter 180 e 195 dias nao
-- interessa a ninguem, e poucas operacoes grandes causam menos bloat que muitas
-- pequenas. As 08:30 fica fora da janela dos REFRESH de matview (08:00) e da
-- coleta do GitHub Actions.
--
-- Com a tabela separada isto e um DELETE numa tabela que nenhuma view agregada
-- le. Enquanto o detalhe morava na tabela principal, a mesma purga seria um
-- UPDATE de 80 mil linhas/dia gerando bloat justamente onde as matviews leem.

select cron.schedule('limpa_detalhe_simet_180d', '30 8 1 * *', $$
  delete from public.medicoes_simet_detalhe
   where dia < current_date - 180
$$);

-- Para conferir depois:
--   select jobid, jobname, schedule, active from cron.job
--    where jobname = 'limpa_detalhe_simet_180d';
--   select status, return_message, start_time
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname='limpa_detalhe_simet_180d')
--    order by start_time desc limit 5;

-- Para remover:
--   select cron.unschedule('limpa_detalhe_simet_180d');
