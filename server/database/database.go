package database

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/rosedblabs/rosedb/v2"
)

type Database struct {
	roseDB *rosedb.DB
}

// OpenDatabase must only be called once since RoseDB doesn't work in parallel (i.e. use a singleton)
func OpenDatabase(dirOrFilePath string) (*Database, error) {
	options := rosedb.DefaultOptions
	options.DirPath = dirOrFilePath
	options.Sync = false // fine to lose newer writes, this is not a critical application
	options.AutoMergeCronExpr = "0 * * * *"

	roseDB, err := rosedb.Open(options)
	if err != nil {
		return nil, fmt.Errorf("failed to open RoseDB at %q: %w", dirOrFilePath, err)
	}

	return &Database{
		roseDB: roseDB,
	}, nil
}

func (db *Database) Close() error {
	err := db.roseDB.Close()
	db.roseDB = nil
	return err
}

// Get fills the pointer `value` with the value from the database. If the key
// does not exist in the database, `value` isn't changed and false is returned.
// If the key was found, true is returned. The caller should therefore initialize
// `value` with a reasonable default or check the return values with
// `ok, err := db.Get(...)`.
//
// Do not accidentally pass a value (wrong: `var s string; db.Get("mykey", s)`) since
// that can lead to an infinite call.
func (db *Database) Get(key string, value any) (bool, error) {
	dbValue, err := db.roseDB.Get([]byte(key))
	if err != nil {
		if errors.Is(err, rosedb.ErrKeyNotFound) {
			return false, nil
		}
		return false, err
	}
	// We use JSON format because protobuf is JSON-compatible and its generated
	// code automatically allows serialization/deserialization.
	// It's also easier to read for humans, should we ever need to debug inside
	// the key-value database files.
	err = json.Unmarshal(dbValue, value)
	if err != nil {
		return false, err
	}
	return true, nil
}

func (db *Database) Set(key string, value any) error {
	dbValue, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("failed to serialize as JSON: %w", err)
	}

	err = db.roseDB.Put([]byte(key), dbValue)
	if err != nil {
		return err
	}
	return nil
}
