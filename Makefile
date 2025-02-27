.PHONY: client-lint
client-lint:
	cd client && npm run build

.PHONY: client-proto
client-proto:
	cd client && npm run proto

.PHONY: client-watch
client-watch: client-lint
	cd client && npm run dev

.PHONY: generate-server
generate-server: proto/workboard.proto server/proto/gen.go
	cd server && go generate ./...

.PHONY: proto-watch
proto-watch:
	ls -1 proto/workboard.proto server/proto/gen.go \
		| entr -ccr sh -c 'make client-proto generate-server && echo "Successfully regenerated from protobuf"'

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
			| entr -ccr sh -c 'go run main.go' \
	)
