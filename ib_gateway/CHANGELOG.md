# Changelog

## 0.1.4 - 2026-10-09
- Added optional `twofa_device` to select the exact IBKR second-factor device when multiple methods are available. The value is passed to IBC through `TWOFA_DEVICE`; an empty value preserves the existing behavior. Phone approval is still required when requested by IBKR.

## 0.1.3 - 2026-10-02
- New switches, on by default: `skip_order_warnings`, `allow_trading_without_market_data` and `relogin_after_2fa_timeout`. With nobody at the screen, IBKR's warning pop-ups could hold API orders indefinitely; the Trading Terminal still asks you to review and submit every order.

## 0.1.2 - 2026-10-02
- Separate paper and live logins (`paper_username` / `paper_password`, `live_username` / `live_password`); `trading_mode` can also be `both`. Re-enter your login after updating.
- Default time zone is now America/Denver.

## 0.1.1 - 2026-10-02
- Fixed the build (Home Assistant was swapping in its own base image).

## 0.1.0 - 2026-10-02
- First release: headless IB Gateway built on gnzsnz/ib-gateway-docker.
