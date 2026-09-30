import { createClient } from "@supabase/supabase-js";

const API_URL =
  "https://api.simet.nic.br/school-measures/v1/getLast24HoursMeasuresAllInep";
const PAGE_SIZE = 1000; // teto da API: pedir mais devolve 1000 do mesmo jeito
const CONCORRENCIA = 8; // acima disso o ganho satura, o gargalo é o backend
const TENTATIVAS = 3;
const BATCH = 500;

// Ajudam a testar sem esperar a coleta inteira nem gravar no Supabase
const DRY_RUN = process.env.SIMET_DRY_RUN === "1";
const MAX_PAGINAS = Number(process.env.SIMET_MAX_PAGINAS) || Infinity;

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

const CAMPOS = {
  media_download_mbps: "vel_download_mbps",
  media_upload_mbps: "vel_upload_mbps",
  media_latencia_ms: "latencia_ms",
  media_perda_pacote: "perda_pacote_porcent",
  media_jitter_upload_ms: "jitter_upload_ms",
  media_jitter_download_ms: "jitter_download_ms",
};

async function buscarPagina(pagina, incluirTotal = false) {
  const url =
    `${API_URL}?page=${pagina}&page_size=${PAGE_SIZE}` +
    `&end_time=${encodeURIComponent(END_TIME)}` +
    (incluirTotal ? "&include_total=true" : "");

  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    try {
      const res = await fetch(url);
      const corpo = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${corpo.slice(0, 150)}`);

      const dados = JSON.parse(corpo);
      // fora da janela aceita, a API responde {} com HTTP 200
      if (!Array.isArray(dados))
        throw new Error(`esperava array, veio ${corpo.slice(0, 150)}`);
      return dados;
    } catch (e) {
      if (tentativa === TENTATIVAS)
        throw new Error(
          `página ${pagina} falhou após ${TENTATIVAS} tentativas: ${e.message}`
        );
      await new Promise((r) => setTimeout(r, 5000 * tentativa));
    }
  }
}

// Agrega incrementalmente: guardar as ~300 mil medições cruas em memória seria
// desnecessário, já que só precisamos de soma e contagem por escola.
const grupos = new Map();
let semVelocidade = 0;
let deOutroDia = 0;
let processadas = 0;

function acumular(medicoes) {
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
        total_medicoes: 0,
        somas: {},
        contagens: {},
        horarioRef: "",
      };
      grupos.set(chave, g);
    }

    g.total_medicoes++;
    // metadados vêm da medição mais recente do grupo; comparar o horário mantém
    // o resultado estável mesmo com as páginas chegando fora de ordem
    if (m.horario_medicao > g.horarioRef) {
      g.horarioRef = m.horario_medicao;
      g.nome_provedor = m.nome_provedor;
      g.tipo = m.tipo;
      g.agent_id = m.agent_id;
      g.asn = m.asn;
    }

    for (const campo of Object.values(CAMPOS)) {
      const v = m[campo];
      if (v == null) continue;
      g.somas[campo] = (g.somas[campo] || 0) + v;
      g.contagens[campo] = (g.contagens[campo] || 0) + 1;
    }
  }
}

console.log(`end_time: ${END_TIME} UTC | dia alvo: ${DIA_ALVO}`);
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

const resultado = [...grupos.values()].map((g) => {
  const linha = {
    co_entidade: g.co_entidade,
    dia: g.dia,
    nome_provedor: g.nome_provedor,
    tipo: g.tipo,
    agent_id: g.agent_id,
    asn: g.asn,
    total_medicoes: g.total_medicoes,
  };
  for (const [destino, origem] of Object.entries(CAMPOS)) {
    linha[destino] = g.contagens[origem]
      ? g.somas[origem] / g.contagens[origem]
      : null;
  }
  return linha;
});

console.log("Escolas únicas:", resultado.length);

if (resultado.length === 0) {
  console.warn("Nenhuma medição válida no período. Nada a gravar.");
  process.exit(0);
}

if (DRY_RUN) {
  console.log("SIMET_DRY_RUN=1, nada será gravado. Exemplo de linha:");
  console.log(JSON.stringify(resultado[0], null, 2));
  process.exit(0);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let salvos = 0;
for (let i = 0; i < resultado.length; i += BATCH) {
  const lote = resultado.slice(i, i + BATCH);
  const { error } = await supabase
    .from("medicoes_simet")
    .upsert(lote, { onConflict: "co_entidade,dia" });
  if (error) {
    console.error("Erro no lote", i, error);
    process.exit(1);
  }
  salvos += lote.length;
  console.log(`Salvos: ${salvos}/${resultado.length}`);
}

console.log("Concluído!");
