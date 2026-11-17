#!/usr/bin/env bash
# Liga o módulo Finanças nesta máquina (contrato do meu-bot: MODULO_DIR, MODULO_PAGINA_TOKEN, MODULO_PRODUTO…).
#  1. o serviço (API /v1/finance e a página) em $MODULO_DIR/app, rodando só em 127.0.0.1:$PORTA (systemd de usuário;
#     sem ele, nohup);
#  2. o plugin do WhatsApp e a CLI do agente na pasta de sempre (~/.local/share/meu-bot/finance), agora falando com o
#     serviço do módulo. Os arquivos antigos vão para finance/.antes (o desinstalar.sh os devolve) e o marcador
#     finance/MODULO tira o financeiro antigo do backend do caminho;
#  3. a skill finance-api do agente.
# Os dados (finance/db) ficam onde estão e nunca são apagados. Idempotente.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
export PATH="$HOME/.openclaw/bin:$HOME/.local/bin:/opt/node/bin:/usr/local/bin:$PATH"
PORTA=${FINANCAS_PORTA:-18795}
: "${MODULO_DIR:?rode pelo meu-bot (página Módulos)}"
: "${MODULO_PAGINA_TOKEN:?rode pelo meu-bot (página Módulos)}"
NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "esta máquina não tem node; reinstale o backend do meu-bot pelo seletor"; exit 2; }
FIN=$HOME/.local/share/meu-bot/finance
APP=$MODULO_DIR/app

# 1. Serviço.
rm -rf "$APP.novo"; mkdir -p "$APP.novo"
cp -R "$HERE/servico" "$HERE/pagina" "$APP.novo/"
rm -rf "$APP"; mv "$APP.novo" "$APP"
chmod -R go-rwx "$MODULO_DIR"
echo "serviço do Finanças copiado"

# 2. Plugin e CLI na pasta de sempre (os antigos guardados uma vez, para voltar ao desligar).
mkdir -p "$FIN/db"; chmod 700 "$FIN" "$FIN/db"
if [ ! -f "$FIN/MODULO" ] && [ ! -d "$FIN/.antes" ]; then
  mkdir -p "$FIN/.antes"
  for f in index.js regras.mjs backend.mjs finance.mjs package.json openclaw.plugin.json; do [ -f "$FIN/$f" ] && cp "$FIN/$f" "$FIN/.antes/"; done
fi
for f in index.js regras.mjs backend.mjs finance.mjs package.json openclaw.plugin.json; do cp "$HERE/plugin/$f" "$FIN/"; done
chmod 644 "$FIN"/*.js "$FIN"/*.mjs "$FIN"/*.json; chmod 755 "$FIN/finance.mjs"
echo financas > "$FIN/MODULO"
echo "plugin e CLI do Finanças no lugar (o financeiro antigo do backend sai do caminho)"

# 3. Skill do agente (mantida se você a editou: sem o marcador de versão do meu-bot).
SK="$HOME/.claude/skills/finance-api/SKILL.md"
if [ -f "$SK" ] && ! grep -q "meu-bot-finance skill v" "$SK"; then echo "skill finance-api editada por você (mantida)";
else mkdir -p "$(dirname "$SK")"; cp "$HERE/skill-finance-api.md" "$SK"; echo "skill finance-api instalada"; fi

# Serviço no ar: systemd de usuário quando há; senão nohup com pid.
ENVS="FINANCAS_PORTA=$PORTA MODULO_PAGINA_TOKEN=$MODULO_PAGINA_TOKEN MEU_BOT_FINANCE_DB=$FIN/db"
if systemctl --user show-environment >/dev/null 2>&1; then
  U=$HOME/.config/systemd/user/meu-bot-financas.service
  mkdir -p "$(dirname "$U")"
  cat > "$U" <<UNIT
[Unit]
Description=meu-bot · módulo Finanças (API e página, só 127.0.0.1:$PORTA)
After=network.target

[Service]
Environment=FINANCAS_PORTA=$PORTA
Environment=MODULO_PAGINA_TOKEN=$MODULO_PAGINA_TOKEN
Environment=MEU_BOT_FINANCE_DB=$FIN/db
ExecStart=$NODE $APP/servico/servidor.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable meu-bot-financas.service >/dev/null 2>&1 || true
  systemctl --user restart meu-bot-financas.service
else
  [ -f "$MODULO_DIR/servico.pid" ] && kill "$(cat "$MODULO_DIR/servico.pid")" 2>/dev/null || true
  env $ENVS nohup "$NODE" "$APP/servico/servidor.js" >"$MODULO_DIR/servico.log" 2>&1 </dev/null &
  echo $! > "$MODULO_DIR/servico.pid"
fi
for _ in $(seq 1 20); do (exec 3<>"/dev/tcp/127.0.0.1/$PORTA") 2>/dev/null && break; sleep 0.5; done
(exec 3<>"/dev/tcp/127.0.0.1/$PORTA") 2>/dev/null || { echo "o serviço do Finanças não subiu na porta $PORTA (veja: journalctl --user -u meu-bot-financas ou $MODULO_DIR/servico.log)"; exit 3; }
echo "serviço do Finanças no ar (127.0.0.1:$PORTA)"

# Plugin no OpenClaw (WhatsApp); sem OpenClaw, o Finanças segue pelo chat do app e pela página.
command -v openclaw >/dev/null 2>&1 || { echo "pronto (esta máquina não tem OpenClaw: sem o Finanças no WhatsApp)"; exit 0; }
OUT=$(timeout 120 openclaw plugins install --link "$FIN" --force --accept-capabilities 2>&1 || true)
case "$OUT" in *"unknown option"*|*"Unknown option"*|*"too many arguments"*) OUT=$(timeout 120 openclaw plugins install --link "$FIN" --force 2>&1 || true);; esac
printf '%s\n' "$OUT" | grep -v "^WARNING\|outside ClawHub" | tail -2 || true
timeout 60 openclaw config set plugins.entries.meu-bot-finance.hooks.allowConversationAccess true --strict-json >/dev/null 2>&1 || true
timeout 60 openclaw config set plugins.entries.meu-bot-finance.enabled true --strict-json >/dev/null 2>&1 || true
timeout 60 openclaw plugins reload >/dev/null 2>&1 || true
echo "pronto: Finanças no app, no chat e no WhatsApp"
