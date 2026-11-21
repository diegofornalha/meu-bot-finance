#!/usr/bin/env bash
# Desliga o módulo Finanças: para o serviço e desliga o plugin do WhatsApp (sem o serviço, a ferramenta do agente só
# daria erro). O financeiro antigo saiu do meu-bot (issue #312): não há página de antes para voltar. Os dados
# (finance/db) ficam; ligar o módulo de novo os traz de volta.
set -uo pipefail
export PATH="$HOME/.openclaw/bin:$HOME/.local/bin:/opt/node/bin:/usr/local/bin:$PATH"
FIN=$HOME/.local/share/meu-bot/finance
if systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user disable --now meu-bot-financas.service >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/meu-bot-financas.service"; systemctl --user daemon-reload 2>/dev/null || true
fi
[ -n "${MODULO_DIR:-}" ] && [ -f "$MODULO_DIR/servico.pid" ] && { kill "$(cat "$MODULO_DIR/servico.pid")" 2>/dev/null || true; rm -f "$MODULO_DIR/servico.pid"; }
echo "serviço do Finanças parado"
rm -rf "$FIN/.antes"
rm -f "$FIN/MODULO"
if command -v openclaw >/dev/null 2>&1; then
  timeout 60 openclaw config set plugins.entries.meu-bot-finance.enabled false --strict-json >/dev/null 2>&1 || true
  timeout 60 openclaw plugins reload >/dev/null 2>&1 || true
  echo "Finanças desligado no WhatsApp"
fi
echo "os dados do Finanças ficaram em $FIN/db"
