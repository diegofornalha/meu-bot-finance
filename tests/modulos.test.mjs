// Testes do módulo Finanças: manifesto, serviço (token, cookie, licença, API, página), plugin falando com o serviço e
// o instalador/desinstalador rodados de verdade no bash, num HOME temporário. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";

const require = createRequire(import.meta.url);
const RAIZ = new URL("..", import.meta.url).pathname;
const MOD = join(RAIZ, "financas");
const portaLivre = () => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = "T".repeat(48);

test("manifesto: produto do repositório, módulo financas com página na porta do serviço, scripts que existem", () => {
  const m = JSON.parse(readFileSync(join(RAIZ, "modulos.json"), "utf8"));
  assert.equal(m.produto, "meu-bot-finance");
  assert.equal(m.modulos.length, 1);
  const f = m.modulos[0];
  assert.equal(f.id, "financas");
  assert.match(f.versao, /^\d+\.\d+\.\d+$/);
  for (const s of ["instalar.sh", "desinstalar.sh", f.testar]) assert.ok(existsSync(join(MOD, s)), s);
  assert.deepEqual(f.pagina, { rotulo: "Finanças", porta: 18795, caminho: "/" });
  // A mesma porta em todo lugar: o serviço, o plugin, o instalador e o teste.
  assert.match(readFileSync(join(MOD, "servico/servidor.js"), "utf8"), /FINANCAS_PORTA \|\| 18795/);
  assert.match(readFileSync(join(MOD, "plugin/backend.mjs"), "utf8"), /FINANCAS_PORTA \|\| 18795/);
  for (const s of ["instalar.sh", "testar.sh"]) assert.match(readFileSync(join(MOD, s), "utf8"), /PORTA=\$\{FINANCAS_PORTA:-18795\}/, s);
  assert.ok(f.exemplos.length <= 6);
  for (const p of f.passos) assert.match(p.conclui, /^(credenciais|ligado|testado|manual|opcao:\w+)$/);
});

test("licença: o add-on na lista e sem vencer; cache, nova tentativa espaçada e validade sem o backend", async () => {
  const { produtoOk, createLicenca } = require(join(MOD, "servico/licenca.js"));
  assert.equal(produtoOk({ status: "active", produtos: ["meu-bot-finance"] }), true);
  assert.equal(produtoOk({ status: "active", produtos: [] }), false);
  assert.equal(produtoOk({ status: "expired", produtos: ["meu-bot-finance"] }), false);
  assert.equal(produtoOk({ status: "active", produtos: ["meu-bot-finance"], expiresAt: "2020-01-01T00:00:00Z" }), false);
  assert.equal(produtoOk(null), false);
  let t = 0; let leituras = 0; let falha = false;
  const lic = createLicenca({ agora: () => t, ler: async () => { leituras++; if (falha) throw new Error("fora"); return { status: "active", produtos: ["meu-bot-finance"] }; } });
  await lic.atualizar(); assert.equal(lic.ok(), true); assert.equal(leituras, 1);
  t = 30_000; await lic.atualizar(); assert.equal(leituras, 1, "cache de 60 s");
  falha = true; t = 70_000; await lic.atualizar(); assert.equal(leituras, 2); assert.equal(lic.ok(), true, "backend fora: a última boa vale");
  t = 75_000; await lic.atualizar(); assert.equal(leituras, 2, "nova tentativa só depois de 15 s");
  t = 11 * 60_000; await lic.atualizar(); assert.equal(lic.ok(), false, "passados 10 min sem o backend, sem licença");
});

test("serviço: só com o token; ?token= vira cookie e sai da URL; licença conferida na API; página com CSP", async () => {
  const HOME = mkdtempSync(join(tmpdir(), "fin-srv-"));
  const arq = join(HOME, "pagina.token"); writeFileSync(arq, TOKEN, { mode: 0o600 });
  process.env.MODULO_PAGINA_TOKEN = arq;
  const { criarServidor } = require(join(MOD, "servico/servidor.js"));
  let liberado = true;
  const srv = criarServidor({ licenca: { atualizar: async () => {}, ok: () => liberado }, dir: join(HOME, "db") }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${base}/v1/finance/estado`)).status, 401, "sem token");
    assert.equal((await fetch(`${base}/v1/finance/estado`, { headers: { authorization: "Bearer errado" } })).status, 401);
    assert.equal((await fetch(`${base}/?token=errado`, { redirect: "manual" })).status, 401);
    const entra = await fetch(`${base}/?token=${TOKEN}&x=1`, { redirect: "manual" });
    assert.equal(entra.status, 303);
    assert.equal(entra.headers.get("location"), "/?x=1", "o token sai da URL");
    const ck = entra.headers.get("set-cookie");
    assert.match(ck, /HttpOnly/); assert.match(ck, /SameSite=Strict/);
    const cookie = ck.split(";")[0];
    const est = await fetch(`${base}/v1/finance/estado`, { headers: { cookie } });
    assert.equal(est.status, 200, await est.clone().text());
    assert.equal((await fetch(`${base}/v1/finance/estado`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200, "bearer do agente");
    liberado = false;
    const bloq = await fetch(`${base}/v1/finance/estado`, { headers: { cookie } });
    assert.equal(bloq.status, 403); assert.equal((await bloq.json()).error.code, "finance_license");
    liberado = true;
    if (existsSync(join(MOD, "pagina/index.html"))) {
      const pg = await fetch(`${base}/`, { headers: { cookie } });
      assert.equal(pg.status, 200);
      assert.match(pg.headers.get("content-security-policy"), /default-src 'none'/);
      assert.match(await pg.text(), /app\.js/);
    }
    assert.equal((await fetch(`${base}/../servico/servidor.js`, { headers: { cookie } })).status, 404, "fora da pasta da página, nada");
    assert.equal((await fetch(`${base}/servidor.js`, { headers: { cookie } })).status, 404);
    // O plugin (a CLI e o WhatsApp) fala com o serviço pelo bearer do arquivo do token.
    process.env.FINANCAS_PORTA = String(srv.address().port);
    const { financeApi } = await import(`${join(MOD, "plugin/backend.mjs")}?t=${Date.now()}`);
    const j = await financeApi("GET", "/estado");
    assert.ok(j !== null && typeof j === "object");
  } finally { srv.close(); delete process.env.FINANCAS_PORTA; }
});

test("instalar e desinstalar de verdade: serviço no ar, financeiro antigo guardado e devolvido, dados intactos", { skip: spawnSync("bash", ["-c", "command -v node"]).status !== 0 }, async () => {
  const HOME = mkdtempSync(join(tmpdir(), "fin-inst-"));
  const FIN = join(HOME, ".local/share/meu-bot/finance");
  const MODULO_DIR = join(HOME, ".local/share/meu-bot/modulos/financas");
  mkdirSync(join(FIN, "db"), { recursive: true }); mkdirSync(MODULO_DIR, { recursive: true });
  writeFileSync(join(FIN, "backend.mjs"), "// antigo\n");
  writeFileSync(join(FIN, "package.json"), '{"version":"1.4.0"}\n');
  writeFileSync(join(FIN, "db", "lancamentos.json"), "[]\n");
  const tok = join(MODULO_DIR, "pagina.token"); writeFileSync(tok, TOKEN, { mode: 0o600 });
  const porta = await portaLivre();
  // Sem systemd de usuário (o macOS não tem): o instalador cai no nohup. Sem OpenClaw: termina sem o WhatsApp.
  const env = { ...process.env, HOME, MODULO_DIR, MODULO_PAGINA_TOKEN: tok, MODULO_ID: "financas", MODULO_PRODUTO: "meu-bot-finance", FINANCAS_PORTA: String(porta), PATH: `${join(process.execPath, "..")}:/usr/bin:/bin` };
  const inst = spawnSync("bash", [join(MOD, "instalar.sh")], { cwd: MOD, env, encoding: "utf8", timeout: 60_000 });
  try {
    assert.equal(inst.status, 0, inst.stdout + inst.stderr);
    assert.equal(readFileSync(join(FIN, "MODULO"), "utf8").trim(), "financas");
    assert.equal(readFileSync(join(FIN, ".antes", "backend.mjs"), "utf8"), "// antigo\n", "o antigo guardado");
    assert.match(readFileSync(join(FIN, "backend.mjs"), "utf8"), /serviço do módulo/);
    assert.equal(JSON.parse(readFileSync(join(FIN, "package.json"), "utf8")).version, "2.0.0");
    assert.ok(existsSync(join(HOME, ".claude/skills/finance-api/SKILL.md")));
    assert.equal(statSync(MODULO_DIR).mode & 0o077, 0, "pasta do módulo só do dono");
    const r = await fetch(`http://127.0.0.1:${porta}/v1/saude`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);
    const t = spawnSync("bash", [join(MOD, "testar.sh")], { cwd: MOD, env, encoding: "utf8" });
    assert.match(t.stdout, /^ferramenta\tlancar\t/m);
    assert.match(t.stdout, /^teste=erro .*licença/m, "sem backend do meu-bot, a licença não libera");
    // Ligar de novo não perde o antigo guardado.
    assert.equal(spawnSync("bash", [join(MOD, "instalar.sh")], { cwd: MOD, env, encoding: "utf8", timeout: 60_000 }).status, 0);
    assert.equal(readFileSync(join(FIN, ".antes", "backend.mjs"), "utf8"), "// antigo\n");
  } finally {
    const des = spawnSync("bash", [join(MOD, "desinstalar.sh")], { cwd: MOD, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(des.status, 0, des.stdout + des.stderr);
  }
  assert.equal(existsSync(join(FIN, "MODULO")), false);
  assert.equal(readFileSync(join(FIN, "backend.mjs"), "utf8"), "// antigo\n", "o antigo devolvido");
  assert.equal(JSON.parse(readFileSync(join(FIN, "package.json"), "utf8")).version, "1.4.0");
  assert.equal(readFileSync(join(FIN, "db", "lancamentos.json"), "utf8"), "[]\n", "os dados ficam");
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(fetch(`http://127.0.0.1:${porta}/v1/saude`), "o serviço parou");
});

test("pontes com o CRM pelo HTTP do backend: venda concluída vira entrada; escrita no Finanças sobe o pipeline de investimentos; seq igual não relê; 403 fica quieto", async () => {
  const { crmHttp, ligarPontes } = require(join(MOD, "servico/pontes-crm.js"));
  const { criarServidor } = require(join(MOD, "servico/servidor.js"));
  const HOME = mkdtempSync(join(tmpdir(), "fin-crm-"));
  const pipeline = { key: "p_vendas", name: "Vendas", stages: [{ key: "s_neg", name: "Negociando" }, { key: "s_vend", name: "Vendido" }], fields: [{ key: "f_prod", name: "Produto", type: "TEXT" }, { key: "f_valor", name: "Valor", type: "TEXT" }, { key: "f_cli", name: "Cliente", type: "TEXT" }] };
  const box = { key: "bx1", pipelineKey: "p_vendas", name: "Venda da Ana", stageKey: "s_vend", fields: { f_prod: "Camiseta", f_valor: "120", f_cli: "Ana" }, contatos: [], createdAt: Date.parse("2026-11-10T12:00:00Z"), updatedAt: Date.parse("2026-11-10T12:00:00Z"), etapaDesde: Date.parse("2026-11-10T12:00:00Z") };
  const chamadas = []; let proibido = false;
  const crmFalso = (await import("node:http")).createServer((req, res) => {
    let s = ""; req.on("data", (c) => { s += c; }); req.on("end", () => {
      chamadas.push(`${req.method} ${req.url}`);
      const j = (st, b) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== "Bearer kb") return j(401, { error: { message: "chave" } });
      if (proibido) return j(403, { error: { message: "o CRM precisa do Pro" } });
      if (req.url === "/v1/crm/status") return j(200, { seq: 7 });
      if (req.url === "/v1/crm/export") return j(200, { seq: 7, pipelines: [pipeline], boxes: [box], contatos: [] });
      if (req.url === "/v1/crm/import" && req.method === "POST") { const b = JSON.parse(s); return j(200, { pipeline: { key: b.pipeline.key } }); }
      j(404, { error: { message: "rota" } });
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => crmFalso.once("listening", r));
  const srv = criarServidor({ licenca: { atualizar: async () => {}, ok: () => true }, dir: join(HOME, "db") });
  const logs = [];
  const pontes = ligarPontes({ financeApi: srv.financeApi, liberado: () => true, crm: crmHttp({ key: "kb", host: "127.0.0.1", port: crmFalso.address().port }), log: (m) => logs.push(m), intervaloMs: 1e9, atrasoMs: 1e9, esperaEscritaMs: 10 });
  try {
    await pontes.rodadaVendas();
    const vendas = srv.financeApi().store.listLanc().filter((l) => String(l.ref ?? l.externo ?? "").startsWith("crm:") || l.origem === "crm");
    assert.equal(vendas.length, 1, JSON.stringify(logs));
    assert.equal(vendas[0].valorCent, 12000);
    assert.equal(vendas[0].produto, "Camiseta");
    const exports = () => chamadas.filter((c) => c === "GET /v1/crm/export").length;
    assert.equal(exports(), 1);
    await pontes.rodadaVendas();
    assert.equal(exports(), 1, "seq igual: não relê o CRM");
    pontes.aposEscrita();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(chamadas.includes("POST /v1/crm/import"), "investimentos subiram para o CRM");
    proibido = true; chamadas.length = 0;
    await pontes.rodadaVendas(); await pontes.rodadaVendas();
    assert.equal(logs.filter((l) => /em espera/.test(l)).length, 1, "sem o Pro: avisa uma vez e fica quieto");
  } finally { pontes.parar(); crmFalso.close(); }
});
