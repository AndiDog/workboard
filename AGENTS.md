# workboard

This project gets the list and details of GitHub PRs (pull requests) and displays relevant PRs to the user. It is meant for a developer to get an overview and follow up on reviewing or updating PRs.

## Code structure

- All data structures and RPC functions are defined in `proto/`. Changes to the structure must be done in there and tested using `make generate-server client-proto`. All `*.proto` files must be formatted using `clang-format -i --style=file` after any changes.
- State is read and written using `Get`, `Set` and `Delete` methods of `Database`. All PRs are stored in the key `code_reviews`.
- Changes to `client/` code must be checked with `make client-lint`.
- Changes to `server/` code must be checked with `make server-lint`.

## protobuf rules

- Fields in protobuf use snake case.
- Order messages and RPC functions alphabetically, but don't change the existing order.

## File rules

- Keep newlines at end of files.
