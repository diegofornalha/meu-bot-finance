/**
 * licenca.js — o add-on meu-bot-finance está na licença desta máquina? Pergunta ao backend do meu-bot
 * (GET /v1/meu-bot/license, com a chave do .env dele; o backend já conferiu a assinatura) e guarda a resposta por 60 s.
 * Sem o backend, a última resposta boa vale por 10 min; depois disso, sem licença. A regra é a do backend
 * (licenca.js › produtoOk): o produto na lista e a licença sem vencer.
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PRODUTO = 'meu-bot-finance';
const CACHE_MS = 60_000;
const VALIDADE_SEM_BACKEND_MS = 10 * 60_000;

/** O .env do backend do meu-bot nesta máquina (a mesma regra do plugin antigo, backend.mjs). */
function backendEnv() {
  const propria = path.join(os.homedir(), '.local', 'share', 'meu-bot', 'backend');
  const herdada = path.join(os.homedir(), '.hermes', 'agente-rene', 'backend-sdk-claude');
  let dir = propria;
  if (!fs.existsSync(path.join(propria, 'server.js'))) { try { if (fs.readFileSync(path.join(herdada, 'server.js'), 'utf8').includes('meu-bot/hello')) dir = herdada; } catch { /* sem server.js lá */ } }
  const arq = process.env.MEU_BOT_BACKEND_ENV || path.join(dir, '.env');
  const env = {};
  try { for (const l of fs.readFileSync(arq, 'utf8').split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m) env[m[1]] = m[2]; } } catch { /* sem .env */ }
  return { key: env.OPENAI_COMPAT_KEY ?? '', port: Number(env.PORT ?? 8080), host: env.HOST ?? '127.0.0.1' };
}

/** A licença (o `license` do licenseView) libera o Finanças? */
function produtoOk(lic, now = Date.now()) {
  if (lic === null || typeof lic !== 'object') return false;
  if (lic.status === 'expired') return false;
  if (typeof lic.expiresAt === 'string' && Date.parse(lic.expiresAt) < now) return false;
  return Array.isArray(lic.produtos) && lic.produtos.includes(PRODUTO);
}

function lerDoBackend(be) {
  return new Promise((resolve, reject) => {
    if (be.key === '') return reject(new Error('backend do meu-bot não encontrado nesta máquina'));
    const req = http.request({ host: be.host, port: be.port, path: '/v1/meu-bot/license', method: 'GET', headers: { Authorization: `Bearer ${be.key}`, Accept: 'application/json' }, timeout: 10_000 }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; });
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`o backend respondeu ${res.statusCode}`)); try { resolve(JSON.parse(s)?.license ?? null); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('o backend não respondeu a tempo')));
    req.on('error', reject);
    req.end();
  });
}

/** `ler()` injetável para teste; `agora()` também. */
function createLicenca({ ler = () => lerDoBackend(backendEnv()), agora = () => Date.now(), log = () => {} } = {}) {
  let ultima = { lic: null, em: -Infinity, ok: false };
  let tentou = -Infinity;
  let emCurso = null;
  return {
    /** Relê se o cache venceu (uma leitura por vez, no máximo uma tentativa a cada 15 s). Nunca lança. */
    atualizar() {
      if (agora() - ultima.em < CACHE_MS || agora() - tentou < 15_000) return emCurso ?? Promise.resolve();
      tentou = agora();
      emCurso ??= ler().then((lic) => { ultima = { lic, em: agora(), ok: true }; }, (e) => { log(`licença: ${e.message}`); if (agora() - ultima.em > VALIDADE_SEM_BACKEND_MS) ultima = { lic: null, em: -Infinity, ok: false }; }).finally(() => { emCurso = null; });
      return emCurso;
    },
    ok: () => produtoOk(ultima.lic, agora()),
  };
}

module.exports = { createLicenca, produtoOk, backendEnv, PRODUTO };
