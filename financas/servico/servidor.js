/**
 * servidor.js — o serviço do módulo Finanças na máquina (só 127.0.0.1). Serve a API /v1/finance/* (finance-api.js, a
 * mesma do backend do meu-bot de antes) e a página (../pagina), que o app abre num <webview> pelo túnel SSH.
 *
 * Quem pode entrar: só quem traz o token desta instalação (o arquivo que o app cria ao ligar o módulo, 0600, caminho em
 * MODULO_PAGINA_TOKEN). A página chega com `?token=` uma vez: o serviço grava um cookie HttpOnly e redireciona para a
 * mesma rota sem o token (ele não fica no histórico nem na barra). O agente (plugin e CLI) manda `Authorization: Bearer`.
 *
 * Licença: o add-on meu-bot-finance na licença da máquina, lida do backend do meu-bot (GET /v1/meu-bot/license, que já
 * confere a assinatura), em cache por 60 s. Sem o backend, a última lida vale por 10 min; depois, sem licença.
 *
 * Os dados ficam onde sempre ficaram (~/.local/share/meu-bot/finance/db). Node puro, sem npm.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFinanceApi } = require('./finance-api');
const { createLicenca, backendEnv } = require('./licenca');
const { crmHttp, ligarPontes } = require('./pontes-crm');

const HOME = os.homedir();
const PORTA = Number(process.env.FINANCAS_PORTA || 18795);
const TOKEN_ARQ = process.env.MODULO_PAGINA_TOKEN || path.join(HOME, '.local', 'share', 'meu-bot', 'modulos', 'financas', 'pagina.token');
const DB = process.env.MEU_BOT_FINANCE_DB || path.join(HOME, '.local', 'share', 'meu-bot', 'finance', 'db');
const PAGINA = path.join(__dirname, '..', 'pagina');
const COOKIE = 'financas';
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
// A página só carrega o que vem daqui; comprovantes chegam como data:/blob:.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const log = (m) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);

function json(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', ...extra });
  res.end(data);
}
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('corpo grande demais')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** O token desta instalação (relido se o arquivo mudar: religar o módulo não reinicia a conferência). */
let tokenCache = { mtime: -1, valor: null };
function tokenAtual() {
  try {
    const st = fs.statSync(TOKEN_ARQ);
    if (st.mtimeMs !== tokenCache.mtime) tokenCache = { mtime: st.mtimeMs, valor: fs.readFileSync(TOKEN_ARQ, 'utf8').trim() || null };
  } catch { tokenCache = { mtime: -1, valor: null }; }
  return tokenCache.valor;
}
const igual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function cookieDe(req) {
  for (const p of String(req.headers.cookie || '').split(';')) { const [k, ...v] = p.trim().split('='); if (k === COOKIE) return v.join('='); }
  return null;
}
/** O pedido traz o token (bearer do agente ou cookie da página)? */
function autorizado(req) {
  const t = tokenAtual();
  if (t === null) return false;
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ') && igual(auth.slice(7).trim(), t)) return true;
  return igual(cookieDe(req), t);
}

function servirArquivo(res, rota) {
  const nome = rota === '/' ? 'index.html' : rota.slice(1);
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(nome)) return json(res, 404, { error: { message: 'não encontrado', code: 'nao_encontrado' } });
  let data;
  try { data = fs.readFileSync(path.join(PAGINA, nome)); } catch { return json(res, 404, { error: { message: 'não encontrado', code: 'nao_encontrado' } }); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(nome)], 'Content-Length': data.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(data);
}

/** O resultado da importação no contrato do meu-bot: a frase, umas linhas de amostra e se dá para importar. */
function respostaPlanilha(r) {
  const dataCurta = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const partes = [`${r.lidas} linha(s) lida(s)`, r.jaImportadas > 0 ? `${r.jaImportadas} já importada(s)` : '', r.totalErros > 0 ? `${r.totalErros} com problema` : ''].filter(Boolean).join(' · ');
  const mensagem = r.simulado
    ? `Prévia: ${r.aImportar} lançamento(s) a importar (${partes}). Colunas: ${Object.values(r.colunas || {}).join(', ') || 'nenhuma reconhecida'}.`
    : `Importado: ${r.importadas} lançamento(s) (${partes}).`;
  const linhas = [
    ...r.erros.slice(0, 3).map((e) => `linha ${e.linha}: ${e.motivo}`),
    ...r.amostra.slice(0, 5).map((l) => `${dataCurta(l.data)} · ${l.favorecido} · ${l.valorExib} · ${l.categoriaNome}`),
  ];
  return { mensagem, linhas, podeImportar: r.simulado && r.aImportar > 0 };
}

/** `aposEscrita`: chamado depois de cada POST/PUT no Finanças que deu certo (a ponte Finanças → CRM). */
function criarServidor({ licenca = createLicenca({ log }), dir = DB, now, aposEscrita = () => {} } = {}) {
  let api = null;
  const financeApi = () => { api ??= createFinanceApi({ dir, licenseOk: () => licenca.ok(), json, readBody, log, ...(now ? { now } : {}) }); return api; };
  const srv = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return json(res, 400, { error: { message: 'endereço inválido' } }); }
    // Entrada da página: troca o ?token= por um cookie e tira o token da URL.
    const q = url.searchParams.get('token');
    if (q !== null && req.method === 'GET') {
      const t = tokenAtual();
      if (t === null || !igual(q, t)) return json(res, 401, { error: { message: 'chave de acesso inválida: abra o Finanças pela página Módulos do meu-bot', code: 'sem_acesso' } });
      url.searchParams.delete('token');
      res.writeHead(303, { Location: `${url.pathname}${url.search}`, 'Set-Cookie': `${COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (!autorizado(req)) return json(res, 401, { error: { message: 'chave de acesso ausente ou inválida: abra o Finanças pela página Módulos do meu-bot', code: 'sem_acesso' } });
    if (url.pathname === '/v1/finance' || url.pathname.startsWith('/v1/finance/')) {
      const mut = req.method === 'POST' || req.method === 'PUT';
      licenca.atualizar().then(() => financeApi().handle(req, res, url)).then(() => { if (mut && res.statusCode === 200) aposEscrita(); }).catch((e) => { log(`finance falhou: ${e.stack || e.message}`); if (!res.headersSent) json(res, 500, { error: { message: e.message, type: 'server_error' } }); });
      return;
    }
    // Planilha do Google que o meu-bot leu (depois da confirmação da pessoa): só o app, pelo bearer, nunca pelo cookie da
    // página. Responde o contrato do meu-bot (`{mensagem, linhas, podeImportar}`): a prévia com `simular`, e importa sem.
    if (url.pathname === '/__meu-bot/planilha' && req.method === 'POST') {
      const auth = String(req.headers.authorization || '');
      if (!auth.startsWith('Bearer ') || !igual(auth.slice(7).trim(), tokenAtual())) return json(res, 401, { error: { message: 'só o meu-bot entrega planilhas', code: 'sem_acesso' } });
      licenca.atualizar().then(async () => {
        if (!licenca.ok()) return json(res, 403, { error: { message: 'o Finanças precisa do add-on meu-bot-finance nesta máquina, ou a licença venceu', code: 'finance_license' } });
        let b;
        try { b = JSON.parse(await readBody(req, 8 * 1024 * 1024)); } catch { return json(res, 400, { error: { message: 'JSON inválido' } }); }
        if (b === null || typeof b !== 'object' || !Array.isArray(b.valores)) return json(res, 400, { error: { message: 'faltam as células da planilha' } });
        try {
          const r = await financeApi().importar({ valores: b.valores, fonte: b.fonte, tipo: b.tipo, simular: b.simular === true }, 'app');
          if (!r.simulado && r.importadas > 0) aposEscrita();
          return json(res, 200, respostaPlanilha(r));
        } catch (e) { return json(res, 400, { error: { message: e instanceof Error ? e.message : String(e) } }); }
      }).catch((e) => { log(`planilha falhou: ${e.stack || e.message}`); if (!res.headersSent) json(res, 500, { error: { message: e.message } }); });
      return;
    }
    if (url.pathname === '/v1/saude' && req.method === 'GET') return licenca.atualizar().then(() => json(res, 200, { ok: true, licenca: licenca.ok() }));
    if (req.method === 'GET') return servirArquivo(res, url.pathname);
    return json(res, 405, { error: { message: 'método não permitido' } });
  });
  srv.financeApi = financeApi;
  srv.licenca = licenca;
  return srv;
}

if (require.main === module) {
  let pontes = null;
  const srv = criarServidor({ aposEscrita: () => pontes?.aposEscrita() });
  pontes = ligarPontes({ financeApi: srv.financeApi, liberado: () => srv.licenca.ok(), crm: crmHttp(backendEnv()), log });
  srv.listen(PORTA, '127.0.0.1', () => log(`financas: ouvindo em 127.0.0.1:${PORTA} (db ${DB})`));
  srv.on('error', (e) => { log(`financas: não subiu: ${e.message}`); process.exit(1); });
}

module.exports = { criarServidor };
