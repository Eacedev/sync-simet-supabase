import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

console.log("Buscando dados da API...");
const res = await fetch(
  "https://api.simet.nic.br/school-measures/v1/getLast24HoursMeasuresAllInep"
);
const data = await res.json();
console.log("Total bruto:", data.length);

// Filtra só os que têm download e upload
const comVelocidade = data.filter(
  (m) => m.vel_download_mbps != null && m.vel_upload_mbps != null
);
console.log("Com download/upload:", comVelocidade.length);

// Agrupa por co_entidade
const grupos = {};
for (const m of comVelocidade) {
  const id = m.co_entidade;
  if (!grupos[id]) grupos[id] = [];
  grupos[id].push(m);
}

// Calcula média
const media = (arr, campo) => {
  const valores = arr.map((m) => m[campo]).filter((v) => v != null);
  if (valores.length === 0) return null;
  return valores.reduce((a, b) => a + b, 0) / valores.length;
};

const resultado = Object.entries(grupos).map(([id, medicoes]) => ({
  co_entidade: Number(id),
  dia: medicoes[0].dia,
  nome_provedor: medicoes[0].nome_provedor,
  asn: medicoes[0].asn,
  total_medicoes: medicoes.length,
  media_download_mbps: media(medicoes, "vel_download_mbps"),
  media_upload_mbps: media(medicoes, "vel_upload_mbps"),
  media_latencia_ms: media(medicoes, "latencia_ms"),
  media_perda_pacote: media(medicoes, "perda_pacote_porcent"),
  media_jitter_upload_ms: media(medicoes, "jitter_upload_ms"),
  media_jitter_download_ms: media(medicoes, "jitter_download_ms"),
}));

console.log("Escolas únicas:", resultado.length);

// Salva em lotes de 500
const BATCH = 500;
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
