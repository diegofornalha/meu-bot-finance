/**
 * backend.mjs — como os scripts do Finanças (finance.mjs, o plugin meu-bot-finance) falam com o serviço do módulo nesta
 * máquina: 127.0.0.1:<porta> com o token desta instalação (o arquivo que o app cria ao ligar o módulo). Mesmo contrato
 * de antes (quando a API morava no backend do meu-bot): `financeApi(method, caminho, body)` e erros com `.code`
 * (`backend_fora`, `finance_license`, `http`), para o index.js e a CLI não mudarem. Sem npm.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const MODULO = path.join(os.homedir(), ".local", "share", "meu-bot", "modulos", "financas");
export const TOKEN_FILE = process.env.MODULO_PAGINA_TOKEN || path.join(MODULO, "pagina.token");
export const PORTA = Number(process.env.FINANCAS_PORTA || 18795);

const token = () => { try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; } };

/** Uma chamada a /v1/finance<caminho>. Devolve o JSON; lança Error com .code e .status em falha. */
export function financeApi(method, caminho, body, { por = "agente", timeoutMs = 30_000 } = {}) {
  const t = token();
  if (t === "") { const e = new Error(`o módulo Finanças não está ligado nesta máquina (sem ${TOKEN_FILE}): ligue pela página Módulos do meu-bot`); e.code = "backend_fora"; return Promise.reject(e); }
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORTA, path: `/v1/finance${caminho}`, method, headers: { Accept: "application/json", Authorization: `Bearer ${t}`, "X-Finance-Por": por, ...(data === null ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }) }, timeout: timeoutMs }, (res) => {
      let s = ""; res.setEncoding("utf8"); res.on("data", (c) => { s += c; });
      res.on("end", () => {
        let j = null; try { j = s === "" ? null : JSON.parse(s); } catch { j = null; }
        if (res.statusCode === 200) return resolve(j);
        const msg = j?.error?.message ?? `o serviço do Finanças respondeu ${res.statusCode}`;
        const e = new Error(msg); e.status = res.statusCode; e.code = j?.error?.code ?? "http"; e.extra = j?.error; reject(e);
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("o serviço do Finanças não respondeu a tempo"), { code: "backend_fora" })));
    req.on("error", (err) => { const e = new Error(err.code === "ECONNREFUSED" ? "o serviço do Finanças não está rodando nesta máquina (religue o módulo pela página Módulos)" : err.message); e.code = "backend_fora"; reject(e); });
    if (data !== null) req.write(data);
    req.end();
  });
}
