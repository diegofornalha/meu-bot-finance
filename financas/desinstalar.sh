#!/usr/bin/env bash
# Desliga o módulo Finanças: para o serviço e devolve o financeiro antigo (os arquivos guardados em finance/.antes e o
# fim do marcador finance/MODULO), para o app voltar a usar a página Finanças de antes. Os dados (finance/db) ficam.
set -uo pipefail
export PATH="$HOME/.openclaw/bin:$HOME/.local/bin:/opt/node/bin:/usr/local/bin:$PATH"
FIN=$HOME/.local/share/meu-bot/finance
if systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user disable --now meu-bot-financas.service >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/meu-bot-financas.service"; systemctl --user daemon-reload 2>/dev/null || true
fi
[ -n "${MODULO_DIR:-}" ] && [ -f "$MODULO_DIR/servico.pid" ] && { kill "$(cat "$MODULO_DIR/servico.pid")" 2>/dev/null || true; rm -f "$MODULO_DIR/servico.pid"; }
echo "serviço do Finanças parado"
if [ -d "$FIN/.antes" ]; then cp "$FIN/.antes/"* "$FIN/" 2>/dev/null || true; rm -rf "$FIN/.antes"; echo "financeiro antigo devolvido"; fi
rm -f "$FIN/MODULO"
command -v openclaw >/dev/null 2>&1 && timeout 60 openclaw plugins reload >/dev/null 2>&1 || true
echo "os dados do Finanças ficaram em $FIN/db"
