# Workboard

Working with GitHub e-mails failed to work for me due to overload. Working with GitHub notifications doesn't tell me which PR requires which action. I need an overview. This is an overview dashboard for GitHub PRs. For each PR, you can decide to snooze it (and automatically bring it back to the top of the list on updates, or after some time), mark for your review, etc.

Technically, this is a very simple web application which makes cached calls to the [`gh` GitHub CLI](https://cli.github.com/) do read PR information.

## Running

```sh
# GitHub CLI setup (installation instructions: https://cli.github.com/)
gh auth login


# One-time setup
cp -i workboard.yaml.example workboard.yaml # and fill in your information into the configuration file
python3 -m venv .venv --prompt workboard
.venv/bin/pip install -r requirements.txt
```

## Usage

Use a full-sized monitor. This application is not meant for mobile devices because reviewing PRs on mobile is a rare corner case and not worth supporting.

The application runs locally. Use the "Running" instructions above. That's it – the application should be self-explanatory. Look at the terminal output in case of problems.

To add a GitHub PR manually, assign yourself to it. The "Assigned PRs" listing output is cached, so it may take a while for _workboard_ to list it.

The expected way of using the tool is to reload it every few hours when you want to concentrate for a while on PRs. Then you go through the list one-by-one. The last-clicked PR is highlighted so you know where you previously left the browser tab. Please left-click the PR links in the table to make this feature work.

## Project purpose / reporting problems / contributing to the application

This is a minor hobby project. It won't make money, and it won't raise a thriving community that I want to support long-term. Donations are welcome, but unrealistic to get for such a tool, and that's fine for me. I want the project to be helpful as-is, and get feedback about it in GitHub issues, in writing or by marking the repo with a GitHub star if you're actively using it.

That said, [I](https://github.com/AndiDog) am making this application **open source** and **open for minor contributions, issue reports and feature requests**. However, it's **closed for major contributions**. In short, that means I will block any PRs that contain feature development because I don't want to invest the time to fix other people's inconsistent code. Nor do I want to rewrite or accept a solution that somebody came up with in their own head without discussing it in an issue in advance – which may have led to a simpler solution, or not investing time at all. I'm happy to receive small bug fixes if the changes are very obvious and well-contained.

## Development

### Server

```sh
# Once
brew install protoc-gen-go protoc-gen-go-grpc
echo 'TEST_GITHUB_USER=FILL_IN_YOUR_USERNAME` > server/.env-local

# Server
make server-watch
```

### Client

Ensure your browser trusts the CA certificate (`test-pki/ca/ca.crt`) or else you'll get errors (gRPC request fails in browser, server logs something like `http: TLS handshake error from 127.0.0.1:57598: remote error: tls: unknown certificate authority`).

```sh
cd client

# Once
brew install protoc-gen-grpc-web # macOS (else get it from https://github.com/grpc/grpc-web)
npm install

make client-watch
```

## Possible future features

- GitHub issues
- GitLab (issues and MRs)
- Wild dream: optional GMail API integration to mark all PR-related notification e-mails as read

## License

The software is free to use. The code may be used freely, except for the creation of, or integration into, commercial products (in short: I don't want GitHub or other platforms to steal my idea without appropriate compensation).

A clearer legal license text may be added later.
