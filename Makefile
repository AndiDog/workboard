.PHONY: generate-server
generate-server: proto/workboard.proto server/proto/gen.go
	cd server && go generate ./...

.PHONY: server
server: generate-server server-lint
	cd server && go run main.go

.PHONY: server-lint
server-lint:
	cd server && go vet ./... && golangci-lint run -E gosec -E goconst --timeout 15s

.PHONY: server-watch
server-watch: generate-server server-lint
	cd server && ( \
		find . -name go.mod -o -name go.sum -o -name "*.go" \
			| entr -r sh -c '~/bin/cmd_k && go run main.go' \
	)
