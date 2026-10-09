# IB Gateway

## Selecting a two-factor authentication device

If IBKR offers more than one authentication method, the headless gateway needs
to know which method to select. Otherwise its log may stop at:

```text
You should specify the required second factor device using the SecondFactorDevice setting in config.ini.
```

In this add-on's **Configuration** tab, set `twofa_device` to the **exact name**
shown in IBKR's second-factor device selection dialog. For example, use:

```yaml
twofa_device: "IB Key"
```

Use this example only if your IBKR dialog actually lists `IB Key`. You can check
the available names by logging in through TWS or IB Gateway on your computer.
Save the configuration and restart this add-on after changing the value.

Leave `twofa_device` empty if IBKR does not ask you to select a device. The option
selects the authentication method; you must still approve the login on your
phone or complete the selected method when IBKR requests it.

The add-on passes this option as `TWOFA_DEVICE`, which its base image writes to
IBC's `SecondFactorDevice` setting. You do not need to edit the generated
`config.ini` inside the container.
