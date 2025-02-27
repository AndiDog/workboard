# Workboard

Working with GitHub e-mails failed to work for me due to overload. Working with GitHub notifications doesn't tell me which PR requires which action. I need an overview. This is an overview dashboard for GitHub PRs. For each PR, you can decide to snooze it (and automatically bring it back to the top of the list on updates, or after some time), mark for your review, etc.

Technically, this is a very simple web application plus backend server. The server uses the GitHub API to read PR information.

## Running

```sh
# One-time setup
cat > server/.env-local <<EOF
TEST_GITHUB_MENTION_TRIGGERS=@FillInYourGitHubUserName,@myorg/example-for-a-team
TEST_GITHUB_USER=FillInYourGitHubUserName
WORKBOARD_GITHUB_TOKEN=ghp_FILL_IN_YOUR_GITHUB_API_TOKEN
EOF

# Start these in separate terminals (only development mode; no one-liner available right now)
# and open http://localhost:5174
make proto-watch
make server-watch
make client-watch

# Or start with docker-compose and open http://localhost:5175
docker-compose up
docker-compose up --build -w # for development
```

## Usage

Use a full-sized monitor. This application is not meant for mobile devices because reviewing PRs on mobile is a rare corner case and not worth supporting.

The application runs locally. Use the "Running" instructions above. That's it – the application should be self-explanatory. Look at the terminal output in case of problems.

To add a GitHub PR manually, assign yourself to it. The "Assigned PRs" listing output is cached, so it may take a while for _workboard_ to list it.

The expected way of using the tool is to pin it as browser tab and regularly visit it. It will automatically refresh the list and each code review's state while you're actively looking at the web application (browser tab is active). You can go through the list one-by-one and perform the needed actions, for example "I reviewed or merged; delete once merged" after you submitted the review, so that the workboard entry gets unlisted automatically if the PR really gets merged, or comes back to the top of the list if it surprisingly doesn't get merged soon. The last-clicked PR is highlighted so you know where you previously left the browser tab. Please left-click the PR links in the table to make this feature work.

### Search

There's no hotkey yet, so click the button. Enter search terms to filter the list of code reviews. For example, search for `upd dep` to only show all code reviews similar to `Update dependency architect to v5.10.1`. All your search terms must be found in the code review description (URL etc.) in order to be listed. Press Escape or delete your search query to show all code reviews again.

## Project purpose / reporting problems / contributing to the application

This is a minor hobby project. It won't make money, and it won't raise a thriving community that I want to support long-term. Donations are welcome, but unrealistic to get for such a tool, and that's fine for me. I want the project to be helpful as-is, and get feedback about it in GitHub issues, in writing or by marking the repo with a GitHub star if you're actively using it.

That said, [I](https://github.com/AndiDog) am making this application **open source** and **open for minor contributions, issue reports and feature requests**. However, it's **closed for major contributions**. In short, that means I will block any PRs that contain feature development because I don't want to invest the time to fix other people's inconsistent code. Nor do I want to rewrite or accept a solution that somebody came up with in their own head without discussing it in an issue in advance – which may have led to a simpler solution, or not investing time at all. I'm happy to receive small bug fixes if the changes are very obvious and well-contained.

## Possible future features / known problems

- Search currently doesn't include GitHub teams of which you are a member, so PRs requesting review from those teams unfortunately aren't listed
- GitHub issues
- GitLab (issues and MRs)

## Development

### Server

```sh
# Once
brew install protoc-gen-go protoc-gen-go-grpc
# and create `server/.env-local` as shown above

# Server
make server-watch
```

To debug in Visual Studio Code, create a regular Go launch configuration with `"program": "server/main.go"`. Cancel the `make server-watch` command and instead run or debug the server from the editor.

### Client

Ensure your browser trusts the CA certificate (`test-pki/ca/ca.crt`) or else you'll get errors (gRPC request fails in browser, server logs something like `http: TLS handshake error from 127.0.0.1:57598: remote error: tls: unknown certificate authority`).

```sh
cd client

# Once
brew install protoc-gen-grpc-web # macOS (else get it from https://github.com/grpc/grpc-web)
npm install

make client-watch
```

### protobuf

Rather than having to restart the above `make` processes, you can watch protobuf file changes which should automatically rebuild in the above processes.

```sh
make proto-watch
```

## License

The software is free to use. The code may be used freely, except for the creation of, or integration into, commercial products (in short: I don't want GitHub or other platforms to steal my idea without appropriate compensation).

A clearer legal license text may be added later.

The following libraries and resources are used, thank you to the authors!

- IconDuck icons ([CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/deed.en))

  - [Dazzle UI Icon Library](https://iconduck.com/sets/dazzle-ui-icon-library)

- [SafeColor](https://github.com/jessuni/SafeColor) ([MIT license](./client/src/vendor/safecolor/LICENSE))
