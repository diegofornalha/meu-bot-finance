#!/usr/bin/env bash
# Testar conexão: o serviço responde com o token desta instalação e a licença libera o Finanças. Lista as ferramentas
# que o agente ganha (os subcomandos da CLI finance.mjs). Protocolo do meu-bot: `ferramenta\t…` e, no fim, `teste=…`.
set -u
PORTA=${FINANCAS_PORTA:-18795}
T=$(cat "${MODULO_PAGINA_TOKEN:-$HOME/.local/share/meu-bot/modulos/financas/pagina.token}" 2>/dev/null || true)
[ -n "$T" ] || { echo "teste=erro o módulo ainda não tem a chave de acesso (ligue de novo)"; exit 0; }
R=$(python3 - "$PORTA" "$T" <<'PY'
import json, sys, urllib.request
porta, tok = sys.argv[1], sys.argv[2]
try:
    req = urllib.request.Request(f"http://127.0.0.1:{porta}/v1/saude", headers={"Authorization": f"Bearer {tok}"})
    j = json.load(urllib.request.urlopen(req, timeout=15))
    print("ok" if j.get("licenca") else "sem-licenca")
except Exception as e:
    print(f"fora {e}")
PY
)
# As ferramentas são os subcomandos da CLI que a skill finance-api ensina ao agente.
for c in $(grep -o 'case "[a-z-]*"' "$HOME/.local/share/meu-bot/finance/finance.mjs" 2>/dev/null | cut -d'"' -f2 | sort -u); do printf 'ferramenta\t%s\tsubcomando da CLI finance.mjs\n' "$c"; done
case "$R" in
  ok) echo "teste=ok";;
  sem-licenca) echo "teste=erro o serviço está no ar, mas a licença desta máquina não tem o Finanças (add-on meu-bot-finance)";;
  *) echo "teste=erro o serviço do Finanças não respondeu: ${R#fora }";;
esac
