/**
 * pontes-crm.js — as duas pontes entre o Finanças e o CRM do meu-bot, agora rodando no serviço do módulo (antes moravam
 * no server.js do backend). A regra de cada uma não mudou (crm-finance-vendas.js e finance-crm-sync.js, copiados como
 * estavam); muda só como se chega ao CRM: pela API HTTP do backend desta máquina, com a chave do .env dele.
 *  - Vendas (CRM → Finanças): box que chega a "Vendido" num pipeline de vendas vira entrada. O serviço confere o `seq`
 *    do CRM (GET /v1/crm/status) a cada 2 min e só sincroniza quando ele mudou (GET /v1/crm/export traz o CRM cru).
 *  - Investimentos (Finanças → CRM): depois de uma rajada de escritas no Finanças, upsert do pipeline "Investimentos
 *    & ROI" (POST /v1/crm/import).
 * Só com o Finanças liberado; o CRM é do Pro, e sem ele a API do CRM responde 403 (a ponte fica quieta). Falha de
 * ponte nunca atrapalha o Finanças.
 */
'use strict';

const http = require('node:http');
const { sincronizarVendas } = require('./crm-finance-vendas');
const { sincronizarInvestimentos } = require('./finance-crm-sync');

/** Cliente da API do CRM no backend desta máquina. `be` = { key, host, port } (licenca.js › backendEnv). */
function crmHttp(be) {
  function chamar(method, caminho, body, por = 'financas') {
    const data = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      if (be.key === '') return reject(Object.assign(new Error('backend do meu-bot não encontrado nesta máquina'), { status: 0 }));
      const req = http.request({ host: be.host, port: be.port, path: `/v1/crm${caminho}`, method, timeout: 30_000, headers: { Authorization: `Bearer ${be.key}`, Accept: 'application/json', 'X-Crm-Por': por, ...(data === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }) } }, (res) => {
        let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; });
        res.on('end', () => {
          let j = null; try { j = s === '' ? null : JSON.parse(s); } catch { j = null; }
          if (res.statusCode === 200) return resolve(j);
          reject(Object.assign(new Error(j?.error?.message ?? `o CRM respondeu ${res.statusCode}`), { status: res.statusCode }));
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('o CRM não respondeu a tempo'), { status: 0 })));
      req.on('error', (e) => reject(Object.assign(e, { status: 0 })));
      if (data !== null) req.write(data);
      req.end();
    });
  }
  return {
    status: () => chamar('GET', '/status'),
    /** O CRM cru como as pontes leem (`store`), num retrato tirado agora. */
    async retrato() {
      const d = await chamar('GET', '/export');
      const pipelines = Array.isArray(d?.pipelines) ? d.pipelines : [];
      const boxes = Array.isArray(d?.boxes) ? d.boxes : [];
      const contatos = Array.isArray(d?.contatos) ? d.contatos : [];
      return { seq: d?.seq ?? null, store: { listPipelines: () => pipelines, listBoxes: (k) => boxes.filter((b) => b.pipelineKey === k), getContato: (k) => contatos.find((c) => c.key === k) ?? null } };
    },
    importar: (bundle, por) => chamar('POST', '/import', bundle, por),
  };
}

/**
 * Liga as pontes ao serviço. `financeApi()` dá a API do Finanças (abre o db na 1ª vez); `liberado()` diz se o Finanças
 * está na licença; `crm` é o cliente (crmHttp). Devolve `aposEscrita()` (chamar depois de POST/PUT no Finanças) e
 * `parar()`. `intervaloMs` e `atrasoMs` são injetáveis para teste.
 */
function ligarPontes({ financeApi, liberado, crm, log = () => {}, intervaloMs = 120_000, atrasoMs = 10_000, esperaEscritaMs = 1500 }) {
  let seqVisto = null;
  let rodando = false;
  let avisouSemCrm = false;
  const quieto = (e) => {
    // 403: o CRM não está no plano desta máquina; 0: backend fora. Avisa uma vez, sem encher o log.
    if (e.status === 403 || e.status === 0) { if (!avisouSemCrm) { avisouSemCrm = true; log(`pontes com o CRM em espera: ${e.message}`); } return; }
    log(`ponte com o CRM falhou: ${e.message}`);
  };
  async function rodadaVendas() {
    if (rodando || !liberado()) return;
    rodando = true;
    try {
      const st = await crm.status();
      if (st?.seq === seqVisto) return;
      const { seq, store } = await crm.retrato();
      const r = await sincronizarVendas({ store, importar: crm.importar }, financeApi());
      seqVisto = r.pipelineCriado ? null : seq;
      avisouSemCrm = false;
      if (r.criados || r.atualizados || r.removidos || r.pipelineCriado || r.erros.length) log(`crm→finanças (vendas): ${r.criados} novas, ${r.atualizados} atualizadas, ${r.removidos} removidas${r.pipelineCriado ? `; pipeline ${r.pipelineCriado} criado` : ''}`);
    } catch (e) { quieto(e); } finally { rodando = false; }
  }
  let timerEscrita = null;
  function aposEscrita() {
    if (timerEscrita !== null) return;
    timerEscrita = setTimeout(() => {
      timerEscrita = null;
      if (!liberado()) return;
      Promise.resolve().then(() => sincronizarInvestimentos(financeApi(), crm)).catch(quieto);
    }, esperaEscritaMs);
    timerEscrita.unref?.();
  }
  const primeira = setTimeout(() => { void rodadaVendas(); }, atrasoMs); primeira.unref?.();
  const ciclo = setInterval(() => { void rodadaVendas(); }, intervaloMs); ciclo.unref?.();
  return { aposEscrita, rodadaVendas, parar: () => { clearTimeout(primeira); clearInterval(ciclo); if (timerEscrita) clearTimeout(timerEscrita); } };
}

module.exports = { crmHttp, ligarPontes };
