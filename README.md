# Workboard

Working with GitHub e-mails failed to work for me due to overload. Working with GitHub notifications doesn't tell me which PR requires which action. I need an overview. This is an overview dashboard for GitHub PRs. For each PR, you can decide to snooze it (and automatically bring it back to the top of the list on updates, or after some time), mark for your review, etc.

Technically, this is a very simple web application which makes cached calls to the [`gh` GitHub CLI](https://cli.github.com/) do read PR information.

## Running

```sh
# One-time setup
python3 -m venv .venv --prompt workboard
.venv/bin/pip install -r requirements.txt

# Run
./watch
# or for development: LOGLEVEL=debug ./watch
open "http://localhost:16666/" # best pin this tab in your browser
```

## License

The software is free to use. The code may be used freely, except for the creation of, or integration into, commercial products (in short: I don't want GitHub or other platforms to steal my idea without appropriate compensation).

A clearer legal license text may be added later.
