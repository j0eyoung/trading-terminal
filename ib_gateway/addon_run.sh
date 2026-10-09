#!/usr/bin/env bash
# Add-on options -> the environment variables the ib-gateway image expects, then start it.
# The image logs in with TWS_USERID/TWS_PASSWORD; in "both" mode those are the live login and
# TWS_USERID_PAPER/TWS_PASSWORD_PAPER the paper one.
set -euo pipefail
OPTS=/data/options.json
opt() { jq -r --arg k "$1" '.[$k] // empty' "$OPTS"; }
need() {  # need <option> <option>... : stop with a clear message if any are blank
    for k in "$@"; do
        if [ -z "$(opt "$k")" ]; then
            echo "[ib_gateway] trading_mode is '$MODE' but '$k' is empty. Fill it in on the Configuration tab, then restart." >&2
            exit 1
        fi
    done
}

MODE="$(opt trading_mode)"
case "$MODE" in
    paper)
        need paper_username paper_password
        export TWS_USERID="$(opt paper_username)" TWS_PASSWORD="$(opt paper_password)" ;;
    live)
        need live_username live_password
        export TWS_USERID="$(opt live_username)" TWS_PASSWORD="$(opt live_password)" ;;
    both)
        need live_username live_password paper_username paper_password
        export TWS_USERID="$(opt live_username)" TWS_PASSWORD="$(opt live_password)"
        export TWS_USERID_PAPER="$(opt paper_username)" TWS_PASSWORD_PAPER="$(opt paper_password)" ;;
    *)
        echo "[ib_gateway] Unknown trading_mode '$MODE'." >&2; exit 1 ;;
esac

export TRADING_MODE="$MODE"
export READ_ONLY_API="$([ "$(opt read_only_api)" = "true" ] && echo yes || echo no)"
export BYPASS_WARNING="$([ "$(opt skip_order_warnings)" = "true" ] && echo yes || echo no)"
export ALLOW_BLIND_TRADING="$([ "$(opt allow_trading_without_market_data)" = "true" ] && echo yes || echo no)"
export RELOGIN_AFTER_TWOFA_TIMEOUT="$([ "$(opt relogin_after_2fa_timeout)" = "true" ] && echo yes || echo no)"
export TWOFA_TIMEOUT_ACTION="$(opt twofa_timeout_action)"
export TWOFA_DEVICE="$(opt twofa_device)"
export AUTO_RESTART_TIME="$(opt auto_restart_time)"
export TIME_ZONE="$(opt time_zone)"
export TZ="$TIME_ZONE"
export HOME=/home/ibgateway

case "$MODE" in
    paper) ports="paper on port 4004" ;;
    live)  ports="live on port 4003" ;;
    both)  ports="paper on port 4004, live on port 4003" ;;
esac
echo "[ib_gateway] Starting IB Gateway: $ports."
exec setpriv --reuid=1000 --regid=1000 --init-groups /home/ibgateway/scripts/run.sh
