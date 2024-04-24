# GitHub PR board

## Running

```sh
# One-time setup
python3 -m venv .venv --prompt workboard
.venv/bin/pip install -r requirements.txt

# Run
LOGLEVEL=debug ./watch
open "http://localhost:16666/"
```
