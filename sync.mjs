import { createClient } from "@supabase/supabase-js";

const API_URL =
  "https://api.simet.nic.br/school-measures/v1/getLast24HoursMeasuresAllInep";
const PAGE_SIZE = 1000; // teto da API: pedir mais devolve 1000 do mesmo jeito
const CONCORRENCIA = 8; // acima disso o ganho satura, o gargalo é o backend
const TENTATIVAS = 3;
// O lote é fechado por orçamento de bytes, não por número de linhas: com o
// detalhe, uma escola pode pesar 59 KB e outra 400 bytes, então contar linhas
// não diz quanto o request vai pesar. O teto de linhas é só um segundo freio.
const MAX_LINHAS_LOTE = 250;
const MAX_BYTES_LOTE = 1_000_000;

// Ajudam a testar sem esperar a coleta inteira nem gravar no Supabase
const DRY_RUN = process.env.SIMET_DRY_RUN === "1";
const MAX_PAGINAS = Number(process.env.SIMET_MAX_PAGINAS) || Infinity;
// Permite ensaiar a escrita numa tabela espelho. O dry-run não exercita o
// upsert, que é justamente a parte arriscada: payload, tipos e cache de schema
// do PostgREST só aparecem quando se grava de verdade.
const TABELA = process.env.SIMET_TABELA || "medicoes_simet";
// O detalhe vive numa tabela própria, com a mesma chave (co_entidade, dia).
// Medido em 30/09/2026: com o jsonb na tabela principal a linha ia de 157 para
// 745 bytes e a agregação das matviews de 154 ms para 1111 ms — elas arrastavam
// o detalhe em toda varredura para nunca usá-lo. O TOAST não resolve: nessa
// faixa de tamanho ele não é acionado nem com toast_tuple_target=128.
const TABELA_DETALHE = `${TABELA}_detalhe`;

// A API entrega horario_medicao e dia em UTC, então o recorte segue o dia UTC.
// A janela é [end_time - 24h, end_time), logo end_time na meia-noite UTC de hoje
// devolve exatamente o dia de ontem fechado.
const formatar = (d) => d.toISOString().slice(0, 19).replace("T", " ");
const agora = new Date();
const meiaNoiteUTC = new Date(
  Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate())
);
const END_TIME = process.env.SIMET_END_TIME || formatar(meiaNoiteUTC);
// o último instante antes do end_time pertence ao dia que queremos agregar
const DIA_ALVO = new Date(new Date(END_TIME.replace(" ", "T") + "Z") - 1000)
  .toISOString()
  .slice(0, 10);

// A API só aceita end_time dentro das últimas 24h; passado isso devolve vazio
const horasDesdeEndTime =
  (agora - new Date(END_TIME.replace(" ", "T") + "Z")) / 3_600_000;

// Fonte única da verdade sobre as métricas. `serie` é a chave dentro do jsonb
// de detalhe; `media` e `percentil` dão os nomes das colunas no Supabase.
// Jitter e perda não têm percentil: essas colunas nunca expiram e custariam
// ~5 GB/ano, enquanto os percentis deles seguem calculáveis a partir do
// detalhe enquanto ele existir (180 dias).
const METRICAS = [
  { campo: "vel_download_mbps",    serie: "d",  media: "media_download_mbps",      percentil: "download_mbps" },
  { campo: "vel_upload_mbps",      serie: "u",  media: "media_upload_mbps",        percentil: "upload_mbps" },
  { campo: "latencia_ms",          serie: "l",  media: "media_latencia_ms",        percentil: "latencia_ms" },
  { campo: "perda_pacote_porcent", serie: "p",  media: "media_perda_pacote",       percentil: null },
  { campo: "jitter_upload_ms",     serie: "ju", media: "media_jitter_upload_ms",   percentil: null },
  { campo: "jitter_download_ms",   serie: "jd", media: "media_jitter_download_ms", percentil: null },
];
// o índice 0 de cada tupla é o horário; os demais seguem a ordem de METRICAS
const SERIES = ["h", ...METRICAS.map((m) => m.serie)];

// As médias já vinham como dízimas de 17 dígitos; com os percentis seriam 9
// colunas assim. Os valores do detalhe não passam por aqui: a API devolve no
// máximo 4 casas, então guardá-los como vieram já é exato.
const arredondar = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);

// Método R-7: é exatamente o que percentile_cont do Postgres faz, então dá para
// conferir qualquer coluna rodando percentile_cont sobre o próprio jsonb.
// A mediana com n par cai aqui como caso particular.
function percentil(ordenados, q) {
  if (ordenados.length === 0) return null;
  const h = (ordenados.length - 1) * q;
  const piso = Math.floor(h);
  const teto = Math.ceil(h);
  if (piso === teto) return ordenados[piso];
  return ordenados[piso] + (h - piso) * (ordenados[teto] - ordenados[piso]);
}

// Ordena as medições de uma escola por horário. O desempate pelos valores é
// necessário porque o sort do V8 é estável: sem ele, medições que dividem o
// horário manteriam a ordem de chegada das páginas, que varia com a
// concorrência e tornaria a linha irreproduzível entre execuções.
function compararTupla(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] == null) return -1;
    if (b[i] == null) return 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Mesmo padrão de retry para a coleta e para a gravação. O upsert não tinha
// nenhum: um 5xx transitório no meio dos lotes matava o job e o dia junto,
// já que a API só guarda 24h.
async function comTentativas(descricao, executar) {
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    try {
      return await executar();
    } catch (e) {
      if (tentativa === TENTATIVAS)
        throw new Error(
          `${descricao} falhou após ${TENTATIVAS} tentativas: ${e.message}`
        );
      await new Promise((r) => setTimeout(r, 5000 * tentativa));
    }
  }
}

async function buscarPagina(pagina, incluirTotal = false) {
  const url =
    `${API_URL}?page=${pagina}&page_size=${PAGE_SIZE}` +
    `&end_time=${encodeURIComponent(END_TIME)}` +
    (incluirTotal ? "&include_total=true" : "");

  return comTentativas(`página ${pagina}`, async () => {
    const res = await fetch(url);
    const corpo = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${corpo.slice(0, 150)}`);

    const dados = JSON.parse(corpo);
    // fora da janela aceita, a API responde {} com HTTP 200
    if (!Array.isArray(dados))
      throw new Error(`esperava array, veio ${corpo.slice(0, 150)}`);
    return dados;
  });
}

// Agrega por escola guardando as medições individuais. São ~508 mil por dia,
// o que custa ~119 MB de heap (medido) contra os 16 GB do runner — cabe, e é
// o que permite gravar o detalhe e calcular mediana e percentis.
const grupos = new Map();
let semVelocidade = 0;
let deOutroDia = 0;
let processadas = 0;
let recebidas = 0;

function acumular(medicoes) {
  recebidas += medicoes.length;
  for (const m of medicoes) {
    if (m.vel_download_mbps == null || m.vel_upload_mbps == null) {
      semVelocidade++;
      continue;
    }
    // com end_time na meia-noite isso não deve acontecer, mas é a garantia de
    // que nunca sobrescrevemos a linha de outro dia com uma média parcial
    if (m.dia !== DIA_ALVO) {
      deOutroDia++;
      continue;
    }
    processadas++;

    const chave = `${m.co_entidade}|${m.dia}`;
    let g = grupos.get(chave);
    if (!g) {
      g = {
        co_entidade: Number(m.co_entidade),
        dia: m.dia,
        medicoes: [],
        chaveRef: "",
      };
      grupos.set(chave, g);
    }

    // uma tupla-array por medição, não um objeto: com meio milhão de medições,
    // repetir as chaves custaria centenas de MB de heap
    const tupla = [m.horario_medicao.slice(11)];
    for (const met of METRICAS) tupla.push(m[met.campo] ?? null);
    g.medicoes.push(tupla);

    // metadados vêm da medição mais recente do grupo; o desempate por agent_id
    // mantém o resultado estável quando duas medições dividem o horário — sem
    // ele seria a ordem de chegada das páginas a decidir
    const chaveRef = `${m.horario_medicao}|${m.agent_id ?? ""}`;
    if (chaveRef > g.chaveRef) {
      g.chaveRef = chaveRef;
      g.nome_provedor = m.nome_provedor;
      g.tipo = m.tipo;
      g.agent_id = m.agent_id;
      g.asn = m.asn;
    }
  }
}

console.log(`end_time: ${END_TIME} UTC | dia alvo: ${DIA_ALVO}`);
if (TABELA !== "medicoes_simet") console.log(`Tabela de destino: ${TABELA}`);
if (horasDesdeEndTime >= 24) {
  console.error(
    `end_time está ${horasDesdeEndTime.toFixed(1)}h no passado; a API só aceita ` +
      `as últimas 24h e devolveria vazio. O dia ${DIA_ALVO} não é mais recuperável.`
  );
  process.exit(1);
}
if (horasDesdeEndTime > 20) {
  console.warn(
    `Atenção: faltam apenas ${(24 - horasDesdeEndTime).toFixed(1)}h para o dia ` +
      `${DIA_ALVO} sair do ar. A coleta leva ~30 min.`
  );
}

const primeira = await buscarPagina(1, true);
if (primeira.length === 0) {
  console.warn("A API não retornou medições para esse período. Nada a gravar.");
  process.exit(0);
}

const totalRows = primeira[0].total_rows;
if (totalRows == null) {
  console.error("include_total não retornou total_rows; abortando.");
  process.exit(1);
}
// total_pages vem calculado para o page_size da requisição; derivar de
// total_rows evita depender disso
const totalPaginas = Math.min(Math.ceil(totalRows / PAGE_SIZE), MAX_PAGINAS);
console.log(`Total de medições: ${totalRows} em ${totalPaginas} páginas`);

acumular(primeira);

let proxima = 2;
let concluidas = 1;
const inicio = Date.now();

async function trabalhador() {
  while (true) {
    const pagina = proxima++;
    if (pagina > totalPaginas) return;
    acumular(await buscarPagina(pagina));
    concluidas++;
    if (concluidas % 25 === 0 || concluidas === totalPaginas) {
      const min = ((Date.now() - inicio) / 60_000).toFixed(1);
      console.log(`Páginas: ${concluidas}/${totalPaginas} (${min} min)`);
    }
  }
}

try {
  await Promise.all(
    Array.from({ length: Math.min(CONCORRENCIA, totalPaginas) }, trabalhador)
  );
} catch (e) {
  // gravar um dia com páginas faltando produziria médias silenciosamente erradas
  console.error(`Coleta incompleta: ${e.message}`);
  console.error("Nada foi gravado. Reexecute ainda hoje para recuperar o dia.");
  process.exit(1);
}

console.log(
  `Medições válidas: ${processadas} | sem download/upload: ${semVelocidade}` +
    (deOutroDia ? ` | de outro dia (descartadas): ${deOutroDia}` : "")
);

// A paginação da API não é perfeitamente estável: duas coletas com o mesmo
// end_time podem devolver alguns registros a mais ou a menos, porque o OFFSET
// do backend não tem uma ordenação determinística por baixo. O efeito medido é
// pequeno (~0,01%), mas só dá para saber que aconteceu comparando o total
// recebido com o total anunciado.
if (totalPaginas === Math.ceil(totalRows / PAGE_SIZE) && recebidas !== totalRows) {
  const delta = recebidas - totalRows;
  console.warn(
    `Atenção: a API anunciou ${totalRows} medições e entregou ${recebidas} ` +
      `(${delta > 0 ? "+" : ""}${delta}, ${((delta / totalRows) * 100).toFixed(3)}%). ` +
      `Instabilidade da paginação; as médias do dia saem com essa amostra.`
  );
}

const resultado = [];
const detalhes = [];

for (const g of grupos.values()) {
  g.medicoes.sort(compararTupla);

  const linha = {
    co_entidade: g.co_entidade,
    dia: g.dia,
    nome_provedor: g.nome_provedor,
    tipo: g.tipo,
    agent_id: g.agent_id,
    asn: g.asn,
    total_medicoes: g.medicoes.length,
  };

  const detalhe = { h: g.medicoes.map((t) => t[0]) };

  METRICAS.forEach((met, i) => {
    const coluna = i + 1; // o índice 0 da tupla é o horário
    detalhe[met.serie] = g.medicoes.map((t) => t[coluna]);

    // cada métrica tem o próprio n: uma latência nula não pode encolher a
    // amostra de download nem contaminar a média dele
    const valores = [];
    for (const t of g.medicoes) if (t[coluna] != null) valores.push(t[coluna]);
    valores.sort((a, b) => a - b);

    linha[met.media] = valores.length
      ? arredondar(valores.reduce((a, b) => a + b, 0) / valores.length)
      : null;

    if (met.percentil) {
      linha[`mediana_${met.percentil}`] = arredondar(percentil(valores, 0.5));
      linha[`p10_${met.percentil}`] = arredondar(percentil(valores, 0.1));
      linha[`p90_${met.percentil}`] = arredondar(percentil(valores, 0.9));
    }
  });

  resultado.push(linha);
  detalhes.push({ co_entidade: g.co_entidade, dia: g.dia, medicoes: detalhe });
}

// nada impede um agente defeituoso medindo a cada minuto (1440 medições ~ 59 KB
// numa linha só); acompanhar o máximo revela a deriva antes de virar incidente
const maxMedicoes = resultado.reduce((a, l) => Math.max(a, l.total_medicoes), 0);
console.log(
  `Escolas únicas: ${resultado.length} | máx. de medições numa escola: ${maxMedicoes}`
);

if (resultado.length === 0) {
  console.warn("Nenhuma medição válida no período. Nada a gravar.");
  process.exit(0);
}

if (DRY_RUN) {
  const i = Math.max(
    0,
    resultado.findIndex((l) => l.total_medicoes >= 5)
  );
  const exemplo = resultado[i];
  const detalhe = detalhes[i].medicoes;
  console.log(`SIMET_DRY_RUN=1, nada será gravado. Exemplo de ${TABELA}:`);
  console.log(JSON.stringify(exemplo, null, 2));
  console.log(
    `${TABELA_DETALHE} (${exemplo.total_medicoes} medições, 3 primeiras de cada série):`
  );
  for (const s of SERIES) {
    console.log(
      `  ${s.padEnd(2)}: ${JSON.stringify(detalhe[s].slice(0, 3))}` +
        ` (${detalhe[s].length} itens)`
    );
  }
  console.log(
    `bytes por linha — agregada: ${JSON.stringify(exemplo).length} | ` +
      `detalhe: ${JSON.stringify(detalhes[i]).length}`
  );
  process.exit(0);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Fecha os lotes por orçamento de bytes para o request não estourar por causa
// de poucas escolas com centenas de medições.
function lotear(linhas) {
  const lotes = [];
  let atual = [];
  let bytes = 0;
  for (const linha of linhas) {
    const tamanho = JSON.stringify(linha).length;
    if (
      atual.length &&
      (atual.length >= MAX_LINHAS_LOTE || bytes + tamanho > MAX_BYTES_LOTE)
    ) {
      lotes.push(atual);
      atual = [];
      bytes = 0;
    }
    atual.push(linha);
    bytes += tamanho;
  }
  if (atual.length) lotes.push(atual);
  return lotes;
}

async function gravar(tabela, linhas) {
  const lotes = lotear(linhas);
  let salvos = 0;
  for (const [i, lote] of lotes.entries()) {
    try {
      await comTentativas(`${tabela} lote ${i + 1}/${lotes.length}`, async () => {
        const { error } = await supabase
          .from(tabela)
          .upsert(lote, { onConflict: "co_entidade,dia" });
        if (error) throw new Error(error.message);
      });
    } catch (e) {
      // os lotes anteriores já foram gravados: não há transação nem rollback.
      // Reexecutar é seguro por ser upsert idempotente sobre o mesmo end_time.
      console.error(`Erro ao gravar em ${tabela}: ${e.message}`);
      console.error(
        `Parou no lote ${i + 1} de ${lotes.length}; ${salvos} linhas gravadas.`
      );
      process.exit(1);
    }
    salvos += lote.length;
    if ((i + 1) % 20 === 0 || i === lotes.length - 1) {
      console.log(`${tabela}: ${salvos}/${linhas.length}`);
    }
  }
}

// A agregada vai primeiro: é o que as views consomem. Se o detalhe falhar
// depois, o dia continua correto para quem lê médias e percentis, e basta
// reexecutar para completar.
await gravar(TABELA, resultado);
await gravar(TABELA_DETALHE, detalhes);

console.log("Concluído!");
