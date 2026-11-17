/**
 * Página Finanças do módulo meu-bot-finance, independente do app: JavaScript puro (ES module, sem build), servida pelo
 * serviço local (servidor.js) e falando com /v1/finance/* na mesma origem (cookie da página). Porta de
 * src/renderer/finance/finance-page.ts: mesmo comportamento e textos; o que dependia do app (chat, Conta Google,
 * instalação, licença no renderer) ficou de fora. O DOM é montado só com el(): nada de innerHTML com dado da API.
 */

// ---------------------------------------------------------------------------------------------------------------
// API (mesma origem). A licença e o acesso são conferidos pelo servidor; aqui só se traduz o erro.
// ---------------------------------------------------------------------------------------------------------------

const MSG_LICENCA = "O Finanças não está liberado nesta máquina: peça ao admin para incluir o add-on Financeiro na licença (no meu-bot-admin, Suporte › Conta e licença).";
const MSG_SEM_ACESSO = "Abra o Finanças pela página Módulos do meu-bot.";

class ErroApi extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

async function api(method, rota, body) {
  let r;
  try {
    r = await fetch(`/v1/finance${rota}`, {
      method,
      credentials: "same-origin",
      headers: { "X-Finance-Por": "app", Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(typeof AbortSignal.timeout === "function" ? { signal: AbortSignal.timeout(30_000) } : {}),
    });
  } catch (e) {
    throw new ErroApi(e && e.name === "TimeoutError" ? "o serviço do Finanças demorou demais para responder" : "não consegui falar com o serviço do Finanças nesta máquina", "rede", 0);
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const code = j?.error?.code;
    if (code === "finance_license") throw new ErroApi(MSG_LICENCA, code, r.status);
    if (code === "sem_acesso") throw new ErroApi(MSG_SEM_ACESSO, code, r.status);
    throw new ErroApi(j?.error?.message ?? `o financeiro respondeu ${r.status}`, code, r.status);
  }
  return j;
}
const errText = (e) => (e instanceof Error ? e.message : String(e));
const q = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v)); const s = p.toString(); return s === "" ? "" : `?${s}`; };
const enc = encodeURIComponent;

// Tradução das chamadas IPC da página antiga (finance-local.ts) para HTTP.
const fin = {
  estado: () => api("GET", "/estado"),
  lancamentos: (f = {}) => api("GET", `/lancamentos${q({ mes: f.mes, status: f.status, limite: f.limite })}`),
  categorias: async () => (await api("GET", "/categorias")).categorias,
  lancar: async (input) => (await api("POST", input.tipo === "renda" ? "/renda" : "/lancamentos", { ...input, ...(input.tipo === "renda" ? { fonte: input.favorecido } : {}), origem: "app", status: "confirmado" })).lancamento,
  confirmar: async (id, categoria) => (await api("POST", `/lancamentos/${enc(id)}/confirmar`, categoria ? { categoria } : {})).lancamento,
  descartar: async (id) => { await api("POST", `/lancamentos/${enc(id)}/descartar`, {}); },
  corrigir: async (id, patch) => (await api("PUT", `/lancamentos/${enc(id)}`, patch)).lancamento,
  /** Foto do comprovante como data URL (o tipo sai dos primeiros bytes: PNG, WebP, HEIC; o resto como JPEG). null = não está mais na máquina. */
  comprovante: async (sha256) => {
    try {
      const { base64 } = await api("GET", `/comprovantes/${enc(sha256)}`);
      const s = atob(base64.slice(0, 24));
      const tipo = s.charCodeAt(0) === 0x89 && s.charCodeAt(1) === 0x50 ? "image/png" : s.slice(8, 12) === "WEBP" ? "image/webp" : s.slice(4, 12).includes("ftyphei") ? "image/heic" : "image/jpeg";
      return `data:${tipo};base64,${base64}`;
    } catch { return null; }
  },
  linhaSalvar: async (l) => {
    const corpo = { nome: l.nome, tipo: l.tipo, valor: l.valor, ...(l.notas !== undefined ? { notas: l.notas } : {}) };
    if (l.key === undefined) await api("POST", "/linhas", corpo); else await api("PUT", `/linhas/${enc(l.key)}`, corpo);
  },
  linhaRemover: async (key) => { await api("POST", `/linhas/${enc(key)}/remover`, {}); },
  confirmarTodas: () => api("POST", "/pendencias/confirmar-todas", {}),
  contaCriar: async (input) => (await api("POST", "/contas", input)).conta,
  configLer: async () => (await api("GET", "/config")).config,
  config: async (patch) => (await api("PUT", "/config", patch)).config,
  mes: async (mes, patch) => { await api("PUT", `/meses/${enc(mes)}`, patch); },
  fecharMes: async (mes) => { await api("POST", "/fechamento", { mes }); },
  abc: (f) => api("GET", `/abc?${new URLSearchParams({ lado: f.lado, por: f.por, meses: String(f.meses), ...(f.ate ? { ate: f.ate } : {}) }).toString()}`),
};

// ---------------------------------------------------------------------------------------------------------------
// DOM: el() como lib/dom.ts, indicador de espera como lib/carregando.ts e a confirmação em dois cliques.
// ---------------------------------------------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined && className !== "") node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Espera: ponto pulsando, o tempo depois de 3 s e o aviso de demora depois de 10 s. O relógio é por rótulo e
// sobrevive às repinturas (só zera depois de o indicador ficar 2 s fora da tela).
const AVISO_DEMORA = "A máquina está respondendo devagar; continuo buscando. Não precisa clicar de novo.";
const inicioEspera = new Map();
function carregando(rotulo) {
  const agora = Date.now();
  const atual = inicioEspera.get(rotulo);
  const desde = atual !== undefined && agora - atual.vistoEm < 2000 ? atual.desde : agora;
  inicioEspera.set(rotulo, { desde, vistoEm: agora });
  const box = el("div", "carregando"); box.setAttribute("role", "status");
  const linha = el("div", "carregando-linha"); const texto = el("span", "", rotulo);
  linha.append(el("span", "wa-pulse"), texto);
  const aviso = el("p", "hint carregando-aviso"); aviso.hidden = true;
  box.append(linha, aviso);
  const pinta = () => { const s = Math.floor((Date.now() - desde) / 1000); texto.textContent = s >= 3 ? `${rotulo} ${s} s` : rotulo; aviso.hidden = s < 10; aviso.textContent = s >= 10 ? AVISO_DEMORA : ""; };
  pinta();
  const timer = window.setInterval(() => { if (!box.isConnected) { window.clearInterval(timer); return; } inicioEspera.set(rotulo, { desde, vistoEm: Date.now() }); pinta(); }, 1000);
  return box;
}

/** No lugar do deps.armConfirm do app: o primeiro clique troca o rótulo por 4 s; o segundo, nesse prazo, executa. */
function armConfirm(b, rotulo, run) {
  if (b.dataset.armado === "1") { window.clearTimeout(Number(b.dataset.timer)); b.dataset.armado = ""; run(); return; }
  const original = b.textContent;
  b.dataset.armado = "1"; b.textContent = rotulo; b.classList.add("armado");
  b.dataset.timer = String(window.setTimeout(() => { b.dataset.armado = ""; b.textContent = original; b.classList.remove("armado"); }, 4000));
}

// ---------------------------------------------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------------------------------------------

const panel = document.getElementById("app");
panel.className = "finance-panel";

const ORIGEM = { whatsapp: "WhatsApp", foto: "foto", chat: "chat", app: "app", agente: "agente", planilha: "planilha" };
const TIPOS = [["corrente", "Conta corrente"], ["cartao", "Cartão de crédito"], ["poupanca", "Poupança"], ["dinheiro", "Dinheiro vivo"], ["outra", "Outra"]];
const dataCurta = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const dataBr = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const ORIGEM_LONGA = { whatsapp: "WhatsApp (o agente lançou)", foto: "foto de comprovante", chat: "chat do app", app: "lançado à mão no app", agente: "o agente lançou" };
const DUVIDA = { categoria: "categoria incerta", valor: "valor lido de foto", duplicado: "parece repetido", conta: "sem conta" };

/** Estado da página: { estado, erro } (era o FinanceInfo do app, sem o "módulo instalado", que aqui é óbvio). */
let info = null;
// Config de moeda do sistema (taxas + moeda de exibição). A LV exibe em dólar; o padrão é real.
let cfg = null;
const MOEDA_INFO_FB = { BRL: { casas: 2, simbolo: "R$" }, PYG: { casas: 0, simbolo: "₲" }, USD: { casas: 2, simbolo: "US$" } };
const infoMoeda = (m) => cfg?.moedaInfo?.[m] ?? MOEDA_INFO_FB[m] ?? MOEDA_INFO_FB.BRL;
const moedaExib = () => cfg?.moedaExibicao ?? "BRL";
const fmtMoeda = (cent, m) => { const { casas, simbolo } = infoMoeda(m); const mult = 10 ** casas; const n = Math.abs(Math.trunc(cent)); const inteiro = Math.floor(n / mult).toLocaleString("pt-BR"); const dec = casas > 0 ? `,${String(n % mult).padStart(casas, "0")}` : ""; return `${cent < 0 ? "-" : ""}${simbolo} ${inteiro}${dec}`; };
const fmt = (cent) => fmtMoeda(cent, moedaExib());
// Minor units → texto editável na moeda (BRL/USD 2 casas, PYG 0): para os campos de valor.
const centParaInput = (cent, m) => { const casas = infoMoeda(m).casas; const mult = 10 ** casas; return casas > 0 ? (Math.abs(cent) / mult).toFixed(casas).replace(".", ",") : String(Math.round(Math.abs(cent) / mult)); };

let ultimos = [];
let pendentes = [];
let categorias = [];
let busy = false; let msg = null;
// Submódulo Curva ABC: aba própria dentro de Finanças. Filtro lembrado enquanto a página vive.
let aba = "geral";
const abcF = { lado: "venda", por: "produto", meses: 3 };
let abc = null; let abcErro = null; let abcCarregando = false;

// Importar do Google Sheets (financeImportarPlanilha / cardImportar) não foi portado: a leitura da planilha usa a
// Conta Google do app (no Mac), que esta página isolada não tem.

async function carregarAbc() {
  abcCarregando = true; abcErro = null; render();
  try { abc = await fin.abc({ ...abcF }); } catch (err) { abc = null; abcErro = errText(err); }
  abcCarregando = false; render();
}

async function refresh() {
  try {
    const estado = await fin.estado();
    cfg = await fin.configLer().catch(() => cfg);
    const [l, p, c] = await Promise.all([fin.lancamentos({ limite: 15 }), fin.lancamentos({ status: "pendente", limite: 100 }), categorias.length > 0 ? Promise.resolve(categorias) : fin.categorias()]);
    ultimos = l.lancamentos; pendentes = p.lancamentos; categorias = c;
    info = { estado, erro: null };
  } catch (e) { info = { estado: null, erro: errText(e) }; }
  render();
}

/** Roda uma ação, mostra o resultado e relê tudo. */
async function agir(run, ok) {
  if (busy) return; busy = true; msg = null; render();
  try { await run(); msg = { text: ok, bad: false }; } catch (e) { msg = { text: errText(e), bad: true }; }
  busy = false; await refresh();
}

const btn = (label, cls, run) => { const b = el("button", `btn ${cls} btn-small`, label); b.type = "button"; b.disabled = busy; b.addEventListener("click", run); return b; };
/** Botão que pede o segundo clique (descartar, remover). */
const btnArmado = (label, cls, rotulo, run) => { const b = btn(label, cls, () => armConfirm(b, rotulo, run)); return b; };
const input = (placeholder, value = "", max = 80) => { const i = el("input"); i.type = "text"; i.placeholder = placeholder; i.value = value; i.maxLength = max; i.disabled = busy; return i; };
const field = (label, ctl) => { const w = el("label", "admin-field"); w.append(el("span", "hint", label), ctl); return w; };
const option = (value, texto, selected = false) => { const o = el("option", "", texto); o.value = value; o.selected = selected; return o; };
const selectCategoria = (atual, renda) => {
  const s = el("select"); s.disabled = busy;
  for (const c of categorias.filter((x) => x.renda === renda)) s.append(option(c.key, c.nome, c.key === atual));
  return s;
};
/** Onde a página do app tinha um botão que levava ao chat: aqui vira dica (a página isolada não fala com o app). */
const dicaAgente = (frase, extra) => el("p", "hint finance-dica", `Diga ao agente (WhatsApp ou chat do meu-bot): “${frase}”${extra ? `. ${extra}` : ""}`);

/** Cartões recolhíveis (Contas, Lançar à mão): fechados por padrão; o que a pessoa abriu continua aberto ao repintar. */
const abertos = new Set();
const fechados = new Set();
const dobra = (id, titulo, resumo, abertoPorPadrao = false) => {
  const d = el("details", "admin-card admin-logs-card finance-dobra"); d.open = abertoPorPadrao ? !fechados.has(id) : abertos.has(id);
  const sm = el("summary", "admin-card-head"); sm.append(el("strong", "", titulo)); if (resumo) sm.append(el("span", "hint", resumo));
  d.append(sm);
  d.addEventListener("toggle", () => { if (d.open) { abertos.add(id); fechados.delete(id); } else { abertos.delete(id); fechados.add(id); } });
  return d;
};
const card = (titulo, extra) => { const c = el("div", "admin-card"); const h = el("div", "admin-card-head"); h.append(el("strong", "", titulo)); if (extra) h.append(extra); c.append(h); return c; };

/** Lançamento aberto (detalhe e edição) e as fotos de comprovante já lidas da máquina (sha256 → data URL). */
let aberto = null;
let linhaAberta = null;
const fotos = new Map();
const contasDe = () => info?.estado?.contas ?? [];

/** Detalhe de um lançamento: tudo o que se sabe dele, a foto do comprovante (se houver) e a edição de cada campo. */
function detalhe(l) {
  const box = el("div", "finance-detalhe");
  box.append(el("p", "hint", [`Origem: ${ORIGEM_LONGA[l.origem] ?? l.origem}`, l.status === "pendente" ? "pendente" : "confirmado", ...l.duvidas.map((d) => DUVIDA[d] ?? d)].join(" · ")));
  if (l.midia) {
    const sha = l.midia.sha256;
    const foto = fotos.get(sha);
    if (foto === undefined) { box.append(carregando("Carregando o comprovante…")); fotos.set(sha, "carregando"); void fin.comprovante(sha).then((u) => { fotos.set(sha, u); render(); }); }
    else if (foto === "carregando") box.append(carregando("Carregando o comprovante…"));
    else if (foto === null) box.append(el("p", "hint bad-hint", "A foto do comprovante não está mais na máquina."));
    else { const img = el("img", "finance-foto"); img.src = foto; img.alt = `Comprovante: ${l.midia.nome}`; img.addEventListener("click", () => img.classList.toggle("grande")); box.append(img); }
  }
  const f = el("div", "admin-actions");
  const valor = input("48,90", centParaInput(l.valorCent, l.moeda), 20);
  const data = input("dd/mm/aaaa", dataBr(l.data), 12);
  const fav = input("onde / de quem", l.favorecido);
  const cat = selectCategoria(l.categoria, l.valorCent > 0);
  const conta = el("select"); conta.disabled = busy;
  for (const c of [{ key: "", nome: "sem conta" }, ...contasDe()]) conta.append(option(c.key, c.nome, (l.conta ?? "") === c.key));
  const notas = input("notas (opcional)", l.notas ?? "", 500);
  const linhaSel = el("select"); linhaSel.disabled = busy;
  for (const x of [{ key: "", nome: "nenhuma" }, ...(info?.estado?.resumo.dre?.linhas ?? [])]) linhaSel.append(option(x.key, x.nome, (l.linha ?? "") === x.key));
  f.append(field("Valor", valor), field("Data", data), field("Onde", fav), field("Categoria", cat), field("Conta", conta), field("Linha da DRE", linhaSel), field("Notas", notas));
  box.append(f);
  const acoes = el("div", "admin-actions");
  acoes.append(btn("Salvar", "btn-primary", () => {
    const patch = {};
    if (valor.value.trim() !== "" && valor.value.trim() !== centParaInput(l.valorCent, l.moeda)) patch.valor = valor.value.trim();
    if (data.value.trim() !== dataBr(l.data)) patch.data = data.value.trim();
    if (fav.value.trim() !== l.favorecido) patch.favorecido = fav.value.trim();
    if (cat.value !== l.categoria) patch.categoria = cat.value;
    if (conta.value !== (l.conta ?? "")) patch.conta = conta.value === "" ? null : conta.value;
    if (notas.value.trim() !== (l.notas ?? "")) patch.notas = notas.value.trim();
    if (linhaSel.value !== (l.linha ?? "")) patch.linha = linhaSel.value === "" ? null : linhaSel.value;
    if (Object.keys(patch).length === 0) { aberto = null; render(); return; }
    void agir(() => fin.corrigir(l.id, patch), "lançamento corrigido");
  }));
  if (l.status === "pendente") acoes.append(btn("Confirmar", "btn-ghost", () => { void agir(() => fin.confirmar(l.id, cat.value), "confirmado"); }));
  acoes.append(
    btnArmado("Descartar", "btn-ghost", "Confirmar? apaga o lançamento", () => { aberto = null; void agir(() => fin.descartar(l.id), "lançamento descartado"); }),
    btn("Fechar", "btn-ghost", () => { aberto = null; render(); }),
  );
  box.append(acoes);
  return box;
}

function linhaLanc(l, comAcoes) {
  const wrap = el("div", "finance-item");
  const row = el("div", `finance-row${l.status === "pendente" ? " pendente" : ""}${aberto === l.id ? " aberto" : ""}`);
  wrap.append(row);
  const main = el("div", "finance-row-main finance-clicavel");
  main.tabIndex = 0; main.setAttribute("role", "button"); main.title = "Ver detalhes e editar";
  const alternar = () => { aberto = aberto === l.id ? null : l.id; render(); };
  main.addEventListener("click", alternar);
  main.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); alternar(); } });
  main.append(el("span", "finance-data", dataCurta(l.data)), el("strong", "finance-fav", l.favorecido || "(sem nome)"), el("span", "hint finance-meta", [l.categoriaNome, l.contaNome, ORIGEM[l.origem] ?? l.origem].filter(Boolean).join(" · ")));
  if (l.midia) main.append(el("span", "finance-clip", "📎"));
  const vcell = el("span", `finance-valor ${l.valorCent < 0 ? "gasto" : "renda"}`, l.valorExib);
  if (l.moeda !== moedaExib() || l.moedaOriginal) vcell.title = `registrado: ${l.moedaOriginal ? l.valorOriginal : l.valor}`;
  row.append(main, vcell);
  if (comAcoes) {
    const acoes = el("div", "finance-acoes");
    if (l.duplicadoDe) acoes.append(el("span", "hint bad-hint", "parece repetido"));
    const sel = selectCategoria(l.categoria, l.valorCent > 0);
    acoes.append(sel, btn("Confirmar", "btn-primary", () => { void agir(() => fin.confirmar(l.id, sel.value), `confirmado em ${sel.selectedOptions[0]?.textContent ?? ""}`); }));
    acoes.append(btnArmado("Descartar", "btn-ghost", "Confirmar? apaga o lançamento", () => { void agir(() => fin.descartar(l.id), "lançamento descartado"); }));
    row.append(acoes);
  }
  if (aberto === l.id) wrap.append(detalhe(l));
  return wrap;
}

function render() {
  panel.replaceChildren();
  const e = info?.estado ?? null;
  const head = el("div", "guide-head"); const hb = el("div", "tut-body");
  hb.append(el("span", "tut-badge", "financeiro"), el("h2", "", e !== null ? `Finanças · ${e.resumo.nome}` : "Finanças"), el("p", "", "O agente lança o que você conta no WhatsApp ou no chat (e o que você fotografa). Aqui você confere, corrige e faz só o que depende de você."));
  head.append(hb); panel.append(head);
  // Instalação/ativação (installFinance, finance:progress), "Pedir ao admin" (financePedir) e o bloqueio pela licença
  // do renderer (financeOk, proBlockText, blocoPagamento) não foram portados: no módulo, o servidor confere a licença
  // e responde 403 finance_license, que api() traduz na frase para a pessoa.
  const topo = el("div", "admin-actions");
  topo.append(btn(busy ? "Atualizando…" : "Atualizar", "btn-ghost", () => { void refresh(); }));
  panel.append(topo);
  // "Lançar pelo chat" (deps.goToChat) virou dica: a página isolada não abre o chat do app.
  panel.append(dicaAgente("gastei 48 no mercado", "O agente usa o financeiro desta máquina: lança, categoriza e responde. Troque pelo seu gasto de verdade."));
  if (msg) panel.append(el("p", `hint ${msg.bad ? "bad-hint" : "audio-ok"}`, msg.text));
  if (info === null) { panel.append(carregando("Consultando o financeiro desta máquina…")); return; }
  if (e === null) { if (info.erro) { const c = card("Finanças indisponível"); c.append(el("p", "bad-hint", info.erro)); panel.append(c); } return; }

  // Abas do módulo: visão geral do mês e o submódulo Curva ABC.
  const abas = el("div", "fin-abas");
  for (const [id, rot] of [["geral", "Visão geral"], ["abc", "Curva ABC"]]) {
    const t = el("button", `btn btn-small ${aba === id ? "btn-primary" : "btn-ghost"}`, rot); t.type = "button";
    t.addEventListener("click", () => { if (aba === id) return; aba = id; if (id === "abc" && abc === null && !abcCarregando) void carregarAbc(); else render(); });
    abas.append(t);
  }
  panel.append(abas);
  if (aba === "abc") { renderAbc(); return; }

  // Checklist do mês: só o que depende da pessoa.
  const ck = card(`O que depende de você em ${e.resumo.nome}`);
  const lista = el("ul", "admin-health finance-checklist");
  for (const it of e.checklist) {
    const li = el("li", it.feito ? "ok" : ""); li.append(el("span", "", it.titulo));
    if (it.id === "orcamento") {
      // Quanto gastar no mês: vale para os meses seguintes até mudar (o mês novo já começa com ele).
      const o = e.resumo.orcamento;
      const v = input("ex.: 3.000", "", 20);
      li.append(v, btn(o === null ? "Definir orçamento" : "Mudar", "btn-ghost", () => { if (v.value.trim() === "") return; void agir(() => fin.mes(e.mes, { orcamento: v.value }), "orçamento do mês salvo"); }));
    }
    if (!it.feito && it.id === "dinheiro") {
      li.append(btn("Nada em dinheiro este mês", "btn-ghost", () => { void agir(() => fin.mes(e.mes, { dinheiroInformado: true }), "anotado"); }));
      // "Contar ao agente" (deps.goToChat) virou dica.
      li.append(dicaAgente("Este mês gastei em dinheiro: …", "Complete com os gastos em dinheiro vivo (ex.: 20 na feira, 15 no estacionamento); o agente lança cada um."));
    }
    if (!it.feito && it.id === "fechar") li.append(btn(`Fechar ${e.mesAnterior.slice(5, 7)}/${e.mesAnterior.slice(0, 4)}`, "btn-ghost", () => { void agir(() => fin.fecharMes(e.mesAnterior), "mês fechado"); }));
    lista.append(li);
  }
  ck.append(lista);

  // Pendências.
  let pendCard = null;
  if (pendentes.length > 0) {
    const extra = btn("Confirmar todas", "btn-ghost", () => { void agir(() => fin.confirmarTodas(), "pendências confirmadas"); });
    const pc = card(`Para confirmar (${pendentes.length})`, extra);
    pc.append(el("p", "hint", "O agente lançou e ficou na dúvida (categoria, valor de foto ou possível repetição). Confira a categoria e confirme: ele aprende e da próxima vez já acerta."));
    for (const l of pendentes) pc.append(linhaLanc(l, true));
    pendCard = pc;
  }

  // Mês atual.
  const r = e.resumo;
  const mc = card(`Mês atual · ${r.nome}`);
  const nums = el("div", "finance-nums");
  // Investimento com retorno: o que se gastou, o teto do mês, o que voltou (direto + indireto) e o ROI.
  const roiTxt = (v) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v}%`);
  const orcTile = r.orcamento ?? null;
  const tiles = [
    ["Gastos (investido)", r.gastos, "gasto", orcTile ? `${orcTile.usadoPct}% do orçamento` : ""],
    ["Orçamento do mês", orcTile ? orcTile.valor : "—", "", orcTile ? (orcTile.restanteCent >= 0 ? `restam ${orcTile.restante}` : `passou ${fmt(-orcTile.restanteCent)}`) : "defina no checklist"],
    ["Ganhos", r.ganhos ?? "R$ 0,00", "renda", `diretos ${r.ganhoDireto ?? "R$ 0,00"} · indiretos ${r.ganhoIndireto ?? "R$ 0,00"}`],
    // Projetado até o fim do mês (investimento = orçamento; ganhos no ritmo de hoje); embaixo, o de hoje para comparar.
    ...(r.projecao
      ? [["ROI do mês projetado", roiTxt(r.projecao.roiTotal), (r.projecao.roiTotal ?? 0) < 0 ? "gasto" : "renda", `hoje ${roiTxt(r.roiTotal ?? null)} · projetado só diretos ${roiTxt(r.projecao.roiDireto)} · ${r.projecao.base === "real" ? "mês encerrado: é o real" : `até o dia ${r.projecao.diasMes}: investimento ${r.projecao.gastos}${r.projecao.base === "orcamento" ? " (o orçamento)" : " (no ritmo de hoje)"}, ganhos ${r.projecao.ganhos} no ritmo de hoje`}`]]
      : [["ROI do mês", roiTxt(r.roiTotal ?? null), (r.roiTotal ?? 0) < 0 ? "gasto" : "renda", `só diretos ${roiTxt(r.roiDireto ?? null)}`]]),
  ];
  // O ROI projetado é o número da página: vem primeiro e em destaque.
  const ordem = [...tiles.filter((t) => t[0].includes("projetado")), ...tiles.filter((t) => !t[0].includes("projetado"))];
  for (const [rot, v, cls, sub] of ordem) { const b = el("div", `finance-num${rot.includes("projetado") ? " destaque" : ""}`); b.append(el("span", "hint", rot), el("strong", `finance-valor ${cls}`, v)); if (sub) b.append(el("span", "hint finance-sub", sub)); nums.append(b); }
  mc.append(nums);
  const o = r.orcamento ?? null; // backend antigo não manda o orçamento
  if (o !== null) {
    const linha = el("div", "finance-orcamento");
    const bar = el("div", `finance-bar${o.usadoPct >= 100 ? " estourou" : o.usadoPct >= 80 ? " alerta" : ""}`); const fill = el("span", "finance-bar-fill"); fill.style.width = `${Math.min(100, Math.max(0, o.usadoPct))}%`; bar.append(fill);
    linha.append(el("span", "", `Orçamento ${o.valor} · ${o.usadoPct}% usado · ${o.restanteCent >= 0 ? `restam ${o.restante}` : `passou ${fmt(-o.restanteCent)}`}`), bar);
    mc.append(linha);
  } else mc.append(el("p", "hint", "Sem orçamento ainda: diga quanto quer gastar no mês (no checklist) e o agente acompanha e avisa antes de estourar."));
  const ac = e.acumulado;
  if (ac !== undefined && (ac.gastosCent > 0 || ac.ganhosCent > 0)) mc.append(el("p", "hint finance-acumulado", `Desde o início: investido ${ac.gastos} · ganhos ${ac.ganhos} · ROI ${roiTxt(ac.roiTotal)} (só diretos ${roiTxt(ac.roiDireto)})`));
  mc.append(el("span", "hint", "Onde o dinheiro está indo"));
  const gastosCat = r.porCategoria.filter((c) => c.cent < 0);
  const maior = Math.max(1, ...gastosCat.map((c) => -c.cent));
  if (gastosCat.length === 0) mc.append(el("p", "hint", "Nenhum gasto lançado ainda este mês. Conte um ao agente: \"gastei 48 no mercado\"."));
  for (const c of gastosCat) {
    const linha = el("div", "finance-bar-row");
    const bar = el("div", "finance-bar"); const fill = el("span", "finance-bar-fill"); fill.style.width = `${Math.round((-c.cent / maior) * 100)}%`; bar.append(fill);
    linha.append(el("span", "finance-bar-nome", c.nome), bar, el("span", "finance-bar-valor", fmt(-c.cent)));
    mc.append(linha);
  }

  // Contas.
  const total = e.contas.reduce((n, c) => n + c.saldoExibCent, 0);
  const cc = dobra("contas", "Contas do Agente", e.contas.length === 0 ? "nenhuma ainda" : `${e.contas.length} · saldo ${fmt(total)}`);
  if (e.contas.length === 0) cc.append(el("p", "hint", "Nenhuma conta ainda. Crie as que você usa (banco, cartão, dinheiro vivo): o agente lança em cada uma pelo jeito de pagar."));
  for (const c of e.contas) {
    const row = el("div", "finance-row"); const m = el("div", "finance-row-main");
    m.append(el("strong", "finance-fav", c.nome), el("span", "hint finance-meta", `${TIPOS.find(([k]) => k === c.tipo)?.[1] ?? c.tipo} · ${c.moeda}${c.padrao ? " · padrão" : ""}`));
    const vc = el("span", `finance-valor ${c.saldoExibCent < 0 ? "gasto" : "renda"}`, c.saldoExib); if (c.moeda !== moedaExib()) vc.title = `na moeda da conta: ${c.saldo}`;
    row.append(m, vc); cc.append(row);
  }
  const nova = el("div", "admin-actions");
  const nome = input("Nubank, Itaú, Carteira…"); const tipo = el("select"); tipo.disabled = busy; for (const [k, t] of TIPOS) tipo.append(option(k, t));
  const moedaSel = el("select"); moedaSel.disabled = busy; for (const mo of (cfg?.moedas ?? ["BRL", "PYG", "USD"])) moedaSel.append(option(mo, `${mo} · ${infoMoeda(mo).simbolo}`, mo === "BRL"));
  const saldo = input("saldo hoje (opcional)", "", 20);
  nova.append(field("Nova conta", nome), field("Tipo", tipo), field("Moeda", moedaSel), field("Saldo", saldo), btn("Criar conta", "btn-ghost", () => { if (nome.value.trim() === "") return; void agir(() => fin.contaCriar({ nome: nome.value, tipo: tipo.value, moeda: moedaSel.value, ...(saldo.value.trim() !== "" ? { saldoInicial: saldo.value } : {}) }), "conta criada"); }));
  cc.append(nova);

  // Moeda do sistema: em qual moeda você vê tudo (US$ na LV) e as taxas que convertem (unidades por 1 US$).
  const naoUsd = (cfg?.moedas ?? ["BRL", "PYG", "USD"]).filter((x) => x !== "USD");
  const moedaCard = dobra("moeda", "Moeda & taxas", `vê em ${moedaExib()}${naoUsd.length > 0 ? ` · ${naoUsd.map((x) => `1 US$ = ${(cfg?.taxas?.[x] ?? 0).toLocaleString("pt-BR")} ${x}`).join(" · ")}` : ""}`);
  moedaCard.append(el("p", "hint", "O financeiro aceita gasto em real, guaraní ou dólar; aqui você escolhe em qual moeda ver tudo. A conversão usa as taxas abaixo, que você define — nada é buscado na internet."));
  const moedaForm = el("div", "admin-actions");
  const exibSel = el("select"); exibSel.disabled = busy; for (const mo of (cfg?.moedas ?? ["BRL", "PYG", "USD"])) exibSel.append(option(mo, `${mo} · ${infoMoeda(mo).simbolo}`, mo === moedaExib()));
  const taxaInputs = {};
  const campos = [field("Ver em", exibSel)];
  for (const mo of naoUsd) { const ti = input(`${mo} por 1 US$`, cfg?.taxas?.[mo] ? String(cfg.taxas[mo]) : "", 15); taxaInputs[mo] = ti; campos.push(field(`1 US$ = ? ${mo}`, ti)); }
  moedaForm.append(...campos, btn("Salvar moeda", "btn-ghost", () => {
    const taxas = {};
    for (const [mo, ti] of Object.entries(taxaInputs)) { const v = Number(String(ti.value ?? "").replace(/\./g, "").replace(",", ".")); if (Number.isFinite(v) && v > 0) taxas[mo] = v; }
    void agir(() => fin.config({ moedaExibicao: exibSel.value, taxas }), "moeda atualizada");
  }));
  moedaCard.append(moedaForm);

  // Lançar à mão.
  const lc = dobra("lancar", "Lançar à mão", "o agente lança pelo WhatsApp e pelo chat");
  const f = el("div", "admin-actions");
  const valor = input("48,90", "", 20); const fav = input("onde / de quem"); const tipoL = el("select"); tipoL.disabled = busy;
  for (const [k, t] of [["gasto", "Gasto (investimento)"], ["direto", "Ganho direto"], ["indireto", "Ganho indireto"]]) tipoL.append(option(k, t));
  let cat = selectCategoria("mercado", false);
  tipoL.addEventListener("change", () => { const ganho = tipoL.value !== "gasto"; const novo = selectCategoria(tipoL.value === "indireto" ? "ganho-indireto" : ganho ? "ganho-direto" : "mercado", ganho); cat.replaceWith(novo); cat = novo; });
  f.append(field("Valor", valor), field("Tipo", tipoL), field("Onde", fav), field("Categoria", cat), btn("Lançar", "btn-primary", () => {
    if (valor.value.trim() === "") return;
    void agir(() => fin.lancar({ valor: valor.value, favorecido: fav.value, tipo: tipoL.value === "gasto" ? "gasto" : "renda", ...(tipoL.value === "indireto" ? { retorno: "indireto" } : tipoL.value === "direto" ? { retorno: "direto" } : {}), categoria: cat.value }), "lançado");
  }));
  lc.append(f);

  // DRE do mês: as fontes de ganho e os custos que certamente existem, com previsto (recorrente) e realizado.
  const dre = r.dre ?? { linhas: [], aDefinir: [], custoPrevistoCent: 0, ganhoDiretoPrevistoCent: 0, ganhoIndiretoPrevistoCent: 0, resultadoPrevistoCent: 0, resultadoPrevisto: "R$ 0,00" };
  const dreCard = dobra("dre", `DRE do mês · ${r.nome}`, `resultado previsto ${dre.resultadoPrevisto}${dre.aDefinir.length > 0 ? ` · ${dre.aDefinir.length} a definir` : ""}`, true);
  dreCard.append(el("p", "hint", "Previsto vale todo mês até você mudar. Custo evitado (uma ferramenta que você deixaria de contratar) conta como ganho indireto. Ligue um lançamento a uma linha no detalhe dele para ter o realizado."));
  const GRUPOS = [["ganho-direto", "Ganhos diretos (receita que entra)"], ["ganho-indireto", "Ganhos indiretos (custo evitado, tempo poupado)"], ["custo", "Custos (o que o agente custa)"]];
  const tabela = el("div", "finance-dre");
  const cab = el("div", "finance-dre-row cab"); cab.append(el("span", "", ""), el("span", "hint", "Previsto/mês"), el("span", "hint", "Realizado")); tabela.append(cab);
  for (const [tipoG, titulo] of GRUPOS) {
    const ls = dre.linhas.filter((x) => x.tipo === tipoG);
    tabela.append(el("div", "finance-dre-grupo", titulo));
    if (ls.length === 0) tabela.append(el("div", "finance-dre-vazio hint", tipoG === "ganho-direto" ? "nenhuma fonte de receita ainda (ex.: vendas pelo WhatsApp, clientes atendidos pelo agente)" : tipoG === "ganho-indireto" ? "nada ainda (ex.: ferramenta que você não precisa contratar, horas de atendimento poupadas)" : "nenhum custo previsto"));
    for (const ln of ls) {
      const row = el("div", `finance-dre-row${linhaAberta === ln.key ? " aberto" : ""}`);
      const nm = el("span", "finance-clicavel finance-dre-nome", ln.nome); nm.tabIndex = 0; nm.setAttribute("role", "button"); nm.title = "Editar a linha";
      const abrir = () => { linhaAberta = linhaAberta === ln.key ? null : ln.key; render(); };
      nm.addEventListener("click", abrir); nm.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); abrir(); } });
      row.append(nm, el("span", `finance-dre-num${ln.previstoCent === null ? " a-definir" : ""}`, ln.previsto), el("span", "finance-dre-num", ln.realizado));
      tabela.append(row);
      if (ln.notas && linhaAberta !== ln.key) tabela.append(el("div", "finance-dre-nota hint", ln.notas));
      if (linhaAberta === ln.key) {
        const ed = el("div", "admin-actions finance-dre-edicao");
        const vn = input("nome", ln.nome); const vv = input("a definir", ln.previstoCent === null ? "" : centParaInput(ln.previstoCent, moedaExib()), 20);
        const vt = el("textarea", "finance-dre-notas"); vt.rows = 3; vt.value = ln.notas ?? ""; vt.placeholder = "anotações: por que essa linha existe, de onde vem o valor"; vt.disabled = busy;
        ed.append(field("Nome", vn), field("Previsto por mês", vv), field("Anotações", vt), btn("Salvar", "btn-primary", () => { linhaAberta = null; void agir(() => fin.linhaSalvar({ key: ln.key, nome: vn.value, tipo: ln.tipo, valor: vv.value.trim() === "" ? null : vv.value, notas: vt.value }), "linha salva"); }));
        ed.append(
          btnArmado("Remover", "btn-ghost", "Confirmar? tira a linha da DRE", () => { linhaAberta = null; void agir(() => fin.linhaRemover(ln.key), "linha removida"); }),
          btn("Fechar", "btn-ghost", () => { linhaAberta = null; render(); }),
        );
        tabela.append(ed);
      }
    }
  }
  const tot = el("div", "finance-dre-row total"); tot.append(el("strong", "", "= Resultado previsto do mês"), el("strong", `finance-dre-num finance-valor ${dre.resultadoPrevistoCent < 0 ? "gasto" : "renda"}`, dre.resultadoPrevisto), el("span", "", "")); tabela.append(tot);
  dreCard.append(tabela);
  if (dre.aDefinir.length > 0) dreCard.append(el("p", "hint", `A definir: ${dre.aDefinir.join(", ")}. A linha já entra na DRE; o valor conta quando você preencher.`));
  const novaLinha = el("div", "admin-actions");
  const nNome = input("ex.: Leona que não precisa contratar"); const nTipo = el("select"); nTipo.disabled = busy;
  for (const [k, t] of [["ganho-indireto", "Ganho indireto"], ["ganho-direto", "Ganho direto"], ["custo", "Custo"]]) nTipo.append(option(k, t));
  const nValor = input("a definir", "", 20);
  novaLinha.append(field("Nova linha", nNome), field("Tipo", nTipo), field("Previsto por mês", nValor), btn("Adicionar", "btn-ghost", () => { if (nNome.value.trim() === "") return; void agir(() => fin.linhaSalvar({ nome: nNome.value, tipo: nTipo.value, valor: nValor.value.trim() === "" ? null : nValor.value }), "linha adicionada"); }));
  dreCard.append(novaLinha);

  // Últimos lançamentos.
  const uc = card("Últimos lançamentos");
  if (ultimos.length === 0) uc.append(el("p", "hint", "Nada lançado ainda."));
  for (const l of ultimos) uc.append(linhaLanc(l, false));
  // Ordem: o mês e o que o agente lançou primeiro; depois o que depende da pessoa; contas e lançar à mão no fim.
  panel.append(mc, dreCard, uc, ck, ...(pendCard ? [pendCard] : []), cc, moedaCard, lc);
}

/** Submódulo Curva ABC: filtros (compras/vendas, por quem ou por categoria, período), resumo das classes e a tabela. */
function renderAbc() {
  // O cartão "Importar do Google Sheets" ficava aqui, ao lado da curva; não portado (Conta Google do app).
  const filtros = el("div", "admin-actions");
  const sel = (opts, atual, set) => {
    const s = el("select"); for (const [v, r] of opts) s.append(option(v, r, v === atual));
    s.disabled = abcCarregando; s.addEventListener("change", () => { set(s.value); void carregarAbc(); }); return s;
  };
  filtros.append(
    field("O quê", sel([["compra", "Compras (saídas)"], ["venda", "Vendas (entradas)"]], abcF.lado, (v) => { abcF.lado = v; })),
    field("Agrupar por", sel([["produto", "Produto"], ["favorecido", abcF.lado === "venda" ? "Cliente" : "Fornecedor"], ["categoria", "Categoria"]], abcF.por, (v) => { abcF.por = v; })),
    field("Período", sel([["1", "Este mês"], ["3", "Últimos 3 meses"], ["6", "Últimos 6 meses"], ["12", "Últimos 12 meses"]], String(abcF.meses), (v) => { abcF.meses = Number(v); })),
    btn(abcCarregando ? "Calculando…" : "Recalcular", "btn-ghost", () => { void carregarAbc(); }),
  );
  const c = card("Curva ABC"); c.append(filtros);
  c.append(el("p", "hint", "Classe A: os poucos itens que somam até 80% do valor. B: até 95%. C: o resto (muitos itens, pouco valor)."));
  panel.append(c);
  if (abcErro !== null) { c.append(el("p", "hint bad-hint", abcErro)); return; }
  if (abc === null) { c.append(abcCarregando ? carregando("Calculando a Curva ABC…") : el("p", "hint", "Escolha os filtros.")); return; }
  const quem = abc.por === "produto" ? "produtos" : abc.por === "categoria" ? "categorias" : abc.lado === "venda" ? "clientes" : "fornecedores";
  const periodo = abc.de === abc.ate ? `${abc.ate.slice(5)}/${abc.ate.slice(0, 4)}` : `${abc.de.slice(5)}/${abc.de.slice(0, 4)} a ${abc.ate.slice(5)}/${abc.ate.slice(0, 4)}`;
  const sem = abc.semProduto && abc.semProduto.lancamentos > 0 ? el("p", "hint bad-hint", `${abc.semProduto.lancamentos} ${abc.lado === "venda" ? "venda(s)" : "compra(s)"} sem produto informado (${abc.semProduto.valor}) ficaram fora desta curva: na planilha, preencha a coluna Produto.`) : null;
  if (abc.itens.length === 0) { c.append(el("p", "hint", abc.por === "produto" ? `Nenhuma ${abc.lado === "venda" ? "venda" : "compra"} com produto em ${periodo}. Importe a planilha do Junior com as colunas Produto e Quantidade.` : `Nenhuma ${abc.lado === "venda" ? "venda" : "compra"} lançada em ${periodo}.`)); if (sem) c.append(sem); return; }
  const A = abc.classes.A;
  c.append(el("p", "", `${abc.lado === "venda" ? "Vendas" : "Compras"} de ${periodo}: ${abc.total} em ${abc.itens.length} ${quem}. ${A.itens} ${A.itens === 1 ? "concentra" : "concentram"} ${A.pct.toLocaleString("pt-BR")}% do valor (classe A).`));
  const resumo = el("div", "fin-abc-classes");
  for (const k of ["A", "B", "C"]) { const x = abc.classes[k]; const b = el("div", `fin-abc-classe fin-abc-${k}`); b.append(el("strong", "", `Classe ${k}`), el("span", "", `${x.itens} ${x.itens === 1 ? "item" : "itens"} · ${x.valor} · ${x.pct.toLocaleString("pt-BR")}%`)); resumo.append(b); }
  c.append(resumo); if (sem) c.append(sem);
  const wrap = el("div", "fin-abc-wrap"); const t = el("table", "fin-abc");
  const th = el("tr"); const comUn = abc.por === "produto";
  for (const h of ["#", abc.por === "produto" ? "Produto" : abc.por === "categoria" ? "Categoria" : abc.lado === "venda" ? "Cliente" : "Fornecedor", "Valor", "%", "Acumulado", ...(comUn ? ["Peças"] : []), "Lançam.", "Classe"]) th.append(el("th", "", h));
  t.append(th);
  for (const i of abc.itens) {
    const tr = el("tr", `fin-abc-${i.classe}`);
    tr.append(el("td", "", String(i.pos)), el("td", "", i.nome), el("td", "num", i.valor), el("td", "num", `${i.pct.toLocaleString("pt-BR")}%`), el("td", "num", `${i.acumPct.toLocaleString("pt-BR")}%`), ...(comUn ? [el("td", "num", i.unidades > 0 ? i.unidades.toLocaleString("pt-BR") : "—")] : []), el("td", "num", String(i.qtd)), el("td", "fin-abc-tag", i.classe));
    t.append(tr);
  }
  wrap.append(t); c.append(wrap);
}

render();
void refresh();
