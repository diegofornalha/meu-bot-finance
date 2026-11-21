# meu-bot-finance

O módulo **Finanças** do [meu-bot](https://github.com/diegofornalha/meu-bot). É o financeiro pessoal no WhatsApp, no
chat do app e numa página própria. O app baixa este repositório com git e liga o módulo pela página **Módulos**.

O código é aberto. O uso exige o add-on `meu-bot-finance` na licença da máquina, e o serviço do módulo confere a
licença pelo backend do meu-bot.

## O que tem aqui
- `modulos.json` traz o manifesto lido pelo meu-bot: a ficha (guia, exemplos, primeiros passos) e a página
  (`pagina: {rotulo, porta, caminho}`).
- `financas/servico/` é o serviço na máquina, só em `127.0.0.1:18795`. Ele serve a API `/v1/finance/*` e a página.
  - **Acesso:** só entra quem traz o token desta instalação, que o app cria ao ligar o módulo.
  - **Página:** recebe o token uma vez na URL e passa a usar um cookie `HttpOnly`.
  - **Agente:** o plugin e a CLI usam `Authorization: Bearer`.
- `financas/servico/pontes-crm.js` traz as pontes com o CRM do meu-bot, pela API HTTP do backend.
  - **Vendas, do CRM para o Finanças:** a cada 2 min, só quando o CRM mudou.
  - **Investimentos & ROI, do Finanças para o CRM:** depois de cada escrita no Finanças.
  - As duas exigem o CRM do plano Pro na máquina.
- `financas/pagina/` é a página (HTML, JS e CSS sem build), aberta pelo app num `<webview>` isolado.
- `financas/plugin/` traz o plugin `meu-bot-finance` do OpenClaw (WhatsApp) e a CLI `finance.mjs` do agente.
- `financas/skill-finance-api.md` é a skill que ensina o agente a usar a CLI.
- `financas/instalar.sh`, `desinstalar.sh` e `testar.sh` são os scripts que o meu-bot roda na máquina por SSH.

## Dados
- **Dados:** continuam em `~/.local/share/meu-bot/finance/db` e o módulo nunca os apaga.
- **O financeiro antigo saiu do meu-bot** (issue #312 de lá): este módulo é o único Finanças. O backend do meu-bot
  responde 409 `finance_modulo` em `/v1/finance/*`, com a frase que manda ligar o módulo.
- **Ao ligar:** o plugin e a CLI são gravados na pasta de sempre (`finance/`), por cima do que havia.
- **Ao desligar:** o serviço para e o plugin do WhatsApp é desligado. Os dados ficam; ligar de novo os traz de volta.

## Testes
```
node --test tests/
```
Os testes sobem o serviço e rodam o instalador e o desinstalador no bash, num HOME temporário.
